const GeckoTerminalClient = require('../clients/GeckoTerminalClient');
const Token = require('../models/Token');
const { writeRawPrice, writeOHLCV } = require('../config/influxdb');
const logger = require('../config/logger');

class HistoricalDataInitializer {
    constructor() {
        this.geckoTerminalClient = new GeckoTerminalClient();
        this.isProcessing = false;
        this.currentToken = null;
        this.queueInterval = null;

        // Collecteurs à notifier
        this.priceCollector = null;
        this.volumeCollector = null;
        this.candleBuilder = null;

        // Configuration
        this.config = {
            HISTORICAL_DAYS: 30,
            REQUEST_DELAY_MS: 2000,
            QUEUE_CHECK_INTERVAL_MS: 10000,
            MAX_RETRIES: 3,
            RETRY_DELAY_MINUTES: 5
        };
    }

    setCollectors(priceCollector, volumeCollector, candleBuilder) {
        this.priceCollector = priceCollector;
        this.volumeCollector = volumeCollector;
        this.candleBuilder = candleBuilder;
    }

    start() {
        logger.info('Démarrage de HistoricalDataInitializer...');

        // Vérifier la queue toutes les 10 secondes
        this.queueInterval = setInterval(async () => {
            await this.processQueue();
        }, this.config.QUEUE_CHECK_INTERVAL_MS);

        // Traiter immédiatement s'il y a des tokens en attente
        this.processQueue();
    }

    async processQueue() {
        // Si déjà en train de traiter un token, skip
        if (this.isProcessing) {
            logger.debug('Traitement en cours, skip');
            return;
        }

        // Récupérer le prochain token en attente
        const token = Token.getNextPendingInitialization();

        if (!token) {
            logger.debug('Aucun token en attente d\'initialisation');
            return;
        }

        // Traiter le token
        this.isProcessing = true;
        this.currentToken = token;

        try {
            await this.initializeToken(token);
        } catch (error) {
            logger.error(`Erreur lors de l'initialisation de ${token.symbol}:`, error);
        } finally {
            this.isProcessing = false;
            this.currentToken = null;
        }
    }

    async initializeToken(token) {
        logger.info(`🚀 Début initialisation historique: ${token.symbol} (${token.contract_address})`);

        // 1. Marquer comme "in_progress"
        Token.updateInitializationStatus(token.contract_address, {
            initialization_status: 'in_progress',
            initialization_started_at: Date.now(),
            initialization_progress: 0,
            initialization_error: null
        });

        try {
            // 2. Récupérer le pool principal (1 requête)
            logger.info(`Recherche du pool principal pour ${token.symbol}...`);
            const poolId = await this.geckoTerminalClient.getMainPoolId(token.contract_address);

            Token.updateInitializationStatus(token.contract_address, {
                main_pool_id: poolId
            });
            logger.info(`✅ Pool trouvé: ${poolId}`);

            // 3. Récupérer l'historique OHLCV (44 requêtes avec rate limit)
            logger.info(`Récupération de ${this.config.HISTORICAL_DAYS} jours d'historique...`);

            const onProgress = (current, total) => {
                const progress = Math.floor((current / total) * 100);
                Token.updateInitializationStatus(token.contract_address, {
                    initialization_progress: progress
                });
                logger.info(`📊 Progression ${token.symbol}: ${current}/${total} requêtes (${progress}%)`);
            };

            const candles = await this.geckoTerminalClient.fetchOHLCVHistory(
                poolId,
                this.config.HISTORICAL_DAYS,
                onProgress
            );

            logger.info(`✅ ${candles.length} candles récupérées pour ${token.symbol}`);

            // 4. Stocker dans InfluxDB et construire les bougies
            await this.storeHistoricalData(token, candles);

            // 5. Marquer comme "completed"
            Token.updateInitializationStatus(token.contract_address, {
                initialization_status: 'completed',
                initialization_completed_at: Date.now(),
                initialization_progress: 100,
                historical_data_start_date: candles.length > 0 ? candles[0][0] : null,
                historical_data_end_date: candles.length > 0 ? candles[candles.length - 1][0] : null
            });

            logger.info(`✅ Initialisation terminée avec succès: ${token.symbol}`);

            // 6. Activer le token
            await Token.update(token.contract_address, { is_active: true });
            logger.info(`✅ Token ${token.symbol} activé`);

            // 7. Notifier les collecteurs pour ajouter le token
            await this.updateCollectors();

        } catch (error) {
            // Gérer l'échec
            logger.error(`❌ Échec initialisation ${token.symbol}:`, error);

            Token.updateInitializationStatus(token.contract_address, {
                initialization_status: 'failed',
                initialization_error: error.message,
                initialization_progress: 0
            });

            throw error;
        }
    }

    async storeHistoricalData(token, candles) {
        logger.info(`Stockage de ${candles.length} candles dans InfluxDB...`);

        if (candles.length === 0) {
            logger.warn(`Aucune candle à stocker pour ${token.symbol}`);
            return;
        }

        // Les candles GeckoTerminal sont au format:
        // [timestamp, open, high, low, close, volume]

        // Étape 1: Stocker les raw prices (pour cohérence avec le système existant)
        logger.info(`Stockage des raw prices pour ${token.symbol}...`);
        for (const candle of candles) {
            const [timestamp, open, high, low, close, volume] = candle;

            await writeRawPrice({
                token_address: token.contract_address,
                symbol: token.symbol,
                price: close, // Prix de clôture
                timestamp: new Date(timestamp * 1000)
            });
        }

        logger.info(`✅ ${candles.length} raw prices stockées`);

        // Étape 2: Construire les bougies OHLCV selon les timeframes
        await this.buildOHLCVCandles(token, candles);

        logger.info(`✅ Bougies OHLCV construites pour ${token.symbol}`);
    }

    async buildOHLCVCandles(token, rawCandles) {
        const timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];

        for (const timeframe of timeframes) {
            logger.info(`Construction des bougies ${timeframe} pour ${token.symbol}...`);

            // Agréger les candles minute selon le timeframe
            const aggregatedCandles = this.aggregateCandles(rawCandles, timeframe);

            logger.debug(`${aggregatedCandles.length} bougies ${timeframe} agrégées`);

            // Calculer RSI et EMA pour chaque bougie
            for (let i = 0; i < aggregatedCandles.length; i++) {
                const candle = aggregatedCandles[i];

                // Calculer RSI et EMA avec l'historique précédent
                const previousCandles = aggregatedCandles.slice(0, i + 1);
                const { rsi, rsi_quality } = this.calculateRSI(previousCandles);
                const ema = this.calculateEMA(previousCandles.map(c => c.close));

                // Stocker dans InfluxDB
                await writeOHLCV({
                    token_address: token.contract_address,
                    symbol: token.symbol,
                    timeframe,
                    open: candle.open,
                    high: candle.high,
                    low: candle.low,
                    close: candle.close,
                    volume: candle.volume,
                    quality_factor: 1.0, // Données historiques = qualité maximale
                    timestamp: new Date(candle.timestamp * 1000),
                    rsi: rsi,
                    rsi_quality: rsi_quality,
                    ema: ema
                });
            }

            logger.info(`✅ ${aggregatedCandles.length} bougies ${timeframe} créées`);
        }
    }

    aggregateCandles(minuteCandles, timeframe) {
        // Convertir timeframe en minutes
        const timeframeMinutes = {
            '1m': 1,
            '5m': 5,
            '15m': 15,
            '1h': 60,
            '4h': 240,
            '1d': 1440
        }[timeframe];

        if (timeframe === '1m') {
            // Pas besoin d'agrégation pour 1m
            return minuteCandles.map(candle => ({
                timestamp: candle[0],
                open: candle[1],
                high: candle[2],
                low: candle[3],
                close: candle[4],
                volume: candle[5]
            }));
        }

        // Regrouper les candles par période
        const candlesByPeriod = {};

        for (const candle of minuteCandles) {
            const [timestamp, open, high, low, close, volume] = candle;

            // Arrondir le timestamp à la période
            const periodStart = Math.floor(timestamp / (timeframeMinutes * 60)) * (timeframeMinutes * 60);

            if (!candlesByPeriod[periodStart]) {
                candlesByPeriod[periodStart] = [];
            }

            candlesByPeriod[periodStart].push({ timestamp, open, high, low, close, volume });
        }

        // Agréger chaque période
        const aggregated = [];
        for (const [periodStart, candles] of Object.entries(candlesByPeriod)) {
            // Trier les candles par timestamp pour être sûr de l'ordre
            candles.sort((a, b) => a.timestamp - b.timestamp);

            aggregated.push({
                timestamp: parseInt(periodStart),
                open: candles[0].open,
                high: Math.max(...candles.map(c => c.high)),
                low: Math.min(...candles.map(c => c.low)),
                close: candles[candles.length - 1].close,
                volume: candles.reduce((sum, c) => sum + c.volume, 0)
            });
        }

        return aggregated.sort((a, b) => a.timestamp - b.timestamp);
    }

    calculateRSI(candles) {
        if (candles.length < 15) {
            return { rsi: null, rsi_quality: 0 };
        }

        const period = 14;
        const closes = candles.map(c => c.close);

        // Calculer les variations
        const changes = [];
        for (let i = 1; i < closes.length; i++) {
            changes.push(closes[i] - closes[i - 1]);
        }

        if (changes.length < period) {
            return { rsi: null, rsi_quality: 0 };
        }

        // Séparer gains et pertes
        const gains = changes.map(change => change > 0 ? change : 0);
        const losses = changes.map(change => change < 0 ? Math.abs(change) : 0);

        // Calculer la moyenne initiale (SMA)
        let avgGain = gains.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
        let avgLoss = losses.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

        // Appliquer le lissage de Wilder pour les périodes suivantes
        for (let i = period; i < changes.length; i++) {
            avgGain = ((avgGain * (period - 1)) + gains[i]) / period;
            avgLoss = ((avgLoss * (period - 1)) + losses[i]) / period;
        }

        // Calculer le RSI
        if (avgLoss === 0) {
            return { rsi: 100, rsi_quality: 1.0 };
        }

        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        // Calculer la qualité en fonction du nombre de périodes disponibles
        const rsi_quality = Math.min(1.0, (changes.length - period) / period);

        return { rsi, rsi_quality };
    }

    calculateEMA(prices) {
        if (prices.length < 14) {
            return null;
        }

        const period = 14;
        const multiplier = 2 / (period + 1);

        // Calculer la SMA initiale
        let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;

        // Calculer l'EMA pour les prix restants
        for (let i = period; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    async updateCollectors() {
        try {
            // Récupérer la liste des tokens actifs
            const activeTokens = await Token.getAllActive();
            logger.info(`Mise à jour des collecteurs avec ${activeTokens.length} tokens actifs`);

            // Mettre à jour tous les collecteurs
            if (this.priceCollector) {
                this.priceCollector.setTokens(activeTokens);
                logger.debug('PriceCollector mis à jour');
            }
            if (this.volumeCollector) {
                this.volumeCollector.setTokens(activeTokens);
                logger.debug('VolumeCollector mis à jour');
            }
            if (this.candleBuilder) {
                this.candleBuilder.setTokens(activeTokens);
                logger.debug('CandleBuilder mis à jour');
            }
        } catch (error) {
            logger.error('Erreur lors de la mise à jour des collecteurs:', error);
        }
    }

    stop() {
        if (this.queueInterval) {
            clearInterval(this.queueInterval);
            this.queueInterval = null;
        }
        logger.info('HistoricalDataInitializer arrêté');
    }
}

module.exports = HistoricalDataInitializer;
