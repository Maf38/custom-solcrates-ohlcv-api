const GeckoTerminalClient = require('../clients/GeckoTerminalClient');
const Token = require('../models/Token');
const { queryApi, writeRawPrice, writeOHLCV } = require('../config/influxdb');
const logger = require('../config/logger');

/**
 * Service de rattrapage intelligent de données
 *
 * Stratégie en 2 étapes:
 * 1. Récupération et insertion intelligente des raw_prices manquantes (pas de doublons)
 * 2. Recalcul sélectif des bougies avec qualité < 90%
 */
class DataBackfillService {
    constructor() {
        this.geckoTerminalClient = new GeckoTerminalClient();
        this.QUALITY_THRESHOLD = 0.90;
        this.isProcessing = false;
        this.MAX_RETRIES = 3;
        this.RETRY_DELAY_MS = 5000; // 5 secondes de base
    }

    /**
     * Retry avec backoff exponentiel
     */
    async retryWithBackoff(fn, context = '', attempt = 1) {
        try {
            return await fn();
        } catch (error) {
            if (attempt >= this.MAX_RETRIES) {
                logger.error(`❌ Échec après ${this.MAX_RETRIES} tentatives: ${context}`);
                throw error;
            }

            const delay = this.RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Backoff exponentiel: 5s, 10s, 20s
            logger.warn(`⚠️ Erreur ${context} (tentative ${attempt}/${this.MAX_RETRIES}): ${error.message}`);
            logger.info(`   Nouvelle tentative dans ${delay}ms...`);

            await new Promise(resolve => setTimeout(resolve, delay));

            return this.retryWithBackoff(fn, context, attempt + 1);
        }
    }

    /**
     * ÉTAPE 1: Récupérer et insérer les raw_prices manquantes
     */
    async fetchAndInsertMissingRawPrices(token, startDate, endDate) {
        logger.info(`📥 ÉTAPE 1: Récupération des raw_prices pour ${token.symbol} (${startDate.toISOString()} → ${endDate.toISOString()})`);

        // Vérifier le pool_id
        let poolId = token.main_pool_id;
        if (!poolId) {
            logger.info(`Recherche du pool ID pour ${token.symbol}...`);
            poolId = await this.retryWithBackoff(
                () => this.geckoTerminalClient.getMainPoolId(token.contract_address),
                `getMainPoolId pour ${token.symbol}`
            );
            logger.info(`Pool ID trouvé: ${poolId}`);
        }

        // Calculer le nombre de jours
        const daysToFetch = Math.ceil((endDate - startDate) / (24 * 60 * 60 * 1000));
        logger.info(`Récupération de ${daysToFetch} jours de données...`);

        // Récupérer les candles depuis GeckoTerminal avec retry
        const candles = await this.retryWithBackoff(
            () => this.geckoTerminalClient.fetchOHLCVHistory(
                poolId,
                daysToFetch,
                (current, total) => {
                    logger.debug(`Progression: ${current}/${total} requêtes`);
                }
            ),
            `fetchOHLCVHistory pour ${token.symbol}`
        );

        // Filtrer les candles dans la période demandée
        const startTimestamp = Math.floor(startDate.getTime() / 1000);
        const endTimestamp = Math.floor(endDate.getTime() / 1000);
        const filteredCandles = candles.filter(candle => {
            const ts = candle[0];
            return ts >= startTimestamp && ts <= endTimestamp;
        });

        logger.info(`${filteredCandles.length} candles dans la période cible`);

        // Vérifier quelles raw_prices existent déjà
        logger.info(`Vérification des raw_prices existantes...`);
        const existingTimestamps = await this.getExistingRawPrices(token.contract_address, startDate, endDate);
        logger.debug(`${existingTimestamps.size} raw_prices déjà existantes`);

        // Insérer seulement les raw_prices manquantes
        let insertedCount = 0;
        let skippedCount = 0;

        for (const candle of filteredCandles) {
            const [timestamp, open, high, low, close, volume] = candle;
            const timestampMs = timestamp * 1000;

            // Skip si déjà existant
            if (existingTimestamps.has(timestampMs)) {
                skippedCount++;
                continue;
            }

            // Insérer la raw_price
            await writeRawPrice({
                token_address: token.contract_address,
                symbol: token.symbol,
                price: close,
                timestamp: new Date(timestampMs)
            });
            insertedCount++;
        }

        logger.info(`✅ ÉTAPE 1 terminée: ${insertedCount} raw_prices insérées, ${skippedCount} skippées (déjà existantes)`);

        return {
            candlesFromGecko: filteredCandles.length,
            rawPricesInserted: insertedCount,
            rawPricesSkipped: skippedCount
        };
    }

    /**
     * Récupère les timestamps des raw_prices existantes pour un token sur une période
     */
    async getExistingRawPrices(contractAddress, startDate, endDate) {
        const query = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: ${startDate.toISOString()}, stop: ${endDate.toISOString()})
            |> filter(fn: (r) => r["_measurement"] == "raw_prices")
            |> filter(fn: (r) => r.contract_address == "${contractAddress}")
            |> filter(fn: (r) => r["_field"] == "price")
            |> keep(columns: ["_time"])
        `;

        const rows = await queryApi.collectRows(query);
        const timestamps = new Set();

        for (const row of rows) {
            // _time est en ISO string, convertir en timestamp ms
            timestamps.add(new Date(row._time).getTime());
        }

        return timestamps;
    }

    /**
     * ÉTAPE 2: Recalcul intelligent des bougies
     * Parcourt chaque période de timeframe et:
     * - Si bougie n'existe pas → recalcule
     * - Si bougie existe avec quality < 90% OU rsi_quality < 90% → recalcule
     * - Sinon → skip
     */
    async recalculateCandlesIntelligently(token, startDate, endDate) {
        logger.info(`🔄 ÉTAPE 2: Recalcul intelligent des bougies pour ${token.symbol}`);

        const timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];
        const stats = {
            totalPeriods: 0,
            candlesRecalculated: 0,
            candlesSkipped: 0,
            candlesCreated: 0
        };

        for (const timeframe of timeframes) {
            logger.info(`Traitement du timeframe ${timeframe}...`);
            const tfStats = await this.recalculateTimeframe(token, timeframe, startDate, endDate);

            stats.totalPeriods += tfStats.periodsChecked;
            stats.candlesRecalculated += tfStats.recalculated;
            stats.candlesSkipped += tfStats.skipped;
            stats.candlesCreated += tfStats.created;

            logger.info(`  ${timeframe}: ${tfStats.recalculated} recalculées, ${tfStats.created} créées, ${tfStats.skipped} skippées`);
        }

        logger.info(`✅ ÉTAPE 2 terminée: ${stats.candlesRecalculated} recalculées, ${stats.candlesCreated} créées, ${stats.candlesSkipped} skippées`);

        return stats;
    }

    /**
     * Recalcule les bougies d'un timeframe spécifique
     */
    async recalculateTimeframe(token, timeframe, startDate, endDate) {
        const stats = {
            periodsChecked: 0,
            recalculated: 0,
            created: 0,
            skipped: 0
        };

        // Calculer les périodes à vérifier
        const periods = this.generatePeriods(timeframe, startDate, endDate);
        stats.periodsChecked = periods.length;

        for (const periodEnd of periods) {
            // Vérifier si la bougie existe et sa qualité
            const existingCandle = await this.getCandleAt(token.contract_address, timeframe, periodEnd);

            let shouldRecalculate = false;

            if (!existingCandle) {
                // Bougie n'existe pas → créer
                shouldRecalculate = true;
                stats.created++;
            } else {
                // Bougie existe → vérifier qualité
                const qualityOk = existingCandle.quality_factor >= this.QUALITY_THRESHOLD;
                const rsiQualityOk = existingCandle.rsi_quality >= this.QUALITY_THRESHOLD;

                if (!qualityOk || !rsiQualityOk) {
                    shouldRecalculate = true;
                    stats.recalculated++;
                    logger.debug(`Bougie ${timeframe} à ${periodEnd.toISOString()}: qualité=${(existingCandle.quality_factor * 100).toFixed(1)}%, rsi_quality=${(existingCandle.rsi_quality * 100).toFixed(1)}% → recalcul`);
                } else {
                    stats.skipped++;
                }
            }

            if (shouldRecalculate) {
                await this.buildCandle(token, timeframe, periodEnd);
            }
        }

        return stats;
    }

    /**
     * Génère la liste des timestamps de fin de période pour un timeframe
     */
    generatePeriods(timeframe, startDate, endDate) {
        const periods = [];
        const timeframeMinutes = this.getTimeframeMinutes(timeframe);
        const intervalMs = timeframeMinutes * 60 * 1000;

        // Aligner le start sur la grille du timeframe
        let current = new Date(startDate);
        current = this.alignToTimeframe(current, timeframe);

        while (current <= endDate) {
            periods.push(new Date(current));
            current = new Date(current.getTime() + intervalMs);
        }

        return periods;
    }

    /**
     * Aligne un timestamp sur la grille d'un timeframe
     */
    alignToTimeframe(date, timeframe) {
        const d = new Date(date);
        d.setSeconds(0, 0);

        switch (timeframe) {
            case '1m':
                return d;
            case '5m':
                d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
                return d;
            case '15m':
                d.setMinutes(Math.floor(d.getMinutes() / 15) * 15);
                return d;
            case '1h':
                d.setMinutes(0);
                return d;
            case '4h':
                d.setMinutes(0);
                d.setHours(Math.floor(d.getHours() / 4) * 4);
                return d;
            case '1d':
                d.setMinutes(0);
                d.setHours(0);
                return d;
            default:
                return d;
        }
    }

    getTimeframeMinutes(timeframe) {
        const units = {
            'm': 1,
            'h': 60,
            'd': 1440
        };
        const value = parseInt(timeframe);
        const unit = timeframe.slice(-1);
        return value * units[unit];
    }

    /**
     * Récupère une bougie existante à un timestamp précis
     */
    async getCandleAt(contractAddress, timeframe, timestamp) {
        const query = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: ${timestamp.toISOString()}, stop: ${new Date(timestamp.getTime() + 1000).toISOString()})
            |> filter(fn: (r) => r["_measurement"] == "ohlcv")
            |> filter(fn: (r) => r.contract_address == "${contractAddress}")
            |> filter(fn: (r) => r.timeframe == "${timeframe}")
            |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
            |> limit(n: 1)
        `;

        const rows = await queryApi.collectRows(query);
        return rows.length > 0 ? rows[0] : null;
    }

    /**
     * Construit/recalcule une bougie (réutilise la logique de CandleBuilder)
     */
    async buildCandle(token, timeframe, endTime) {
        const minutes = this.getTimeframeMinutes(timeframe);
        const startTime = new Date(endTime.getTime() - (minutes * 60 * 1000));

        // Requête pour obtenir les raw_prices dans l'intervalle
        const query = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: ${startTime.toISOString()}, stop: ${endTime.toISOString()})
            |> filter(fn: (r) => r["_measurement"] == "raw_prices")
            |> filter(fn: (r) => r.contract_address == "${token.contract_address}")
            |> filter(fn: (r) => r["_field"] == "price")
        `;

        const prices = await queryApi.collectRows(query);

        if (prices.length === 0) {
            logger.debug(`Pas de raw_prices pour ${token.symbol} ${timeframe} à ${endTime.toISOString()}`);
            return;
        }

        // Calculer quality_factor
        const updateInterval = parseInt(process.env.UPDATE_INTERVAL) || 5000;
        const expectedPoints = (minutes * 60 * 1000) / updateInterval;
        let qualityFactor = Math.min(1, Math.max(0, prices.length / expectedPoints));

        // Construire la bougie OHLCV
        const values = prices.map(p => p._value);
        const candle = {
            token_address: token.contract_address,
            symbol: token.symbol,
            timeframe,
            open: values[0],
            high: Math.max(...values),
            low: Math.min(...values),
            close: values[values.length - 1],
            volume: 0, // Volume pas utilisé pour l'instant
            quality_factor: qualityFactor,
            timestamp: endTime
        };

        // Récupérer les bougies précédentes pour calculer RSI et EMA
        const previousCandles = await this.getPreviousCandles(token, timeframe, startTime);

        // Calculer RSI
        const { rsi, rsi_quality } = this.calculateRSI([...previousCandles, candle], timeframe);
        candle.rsi = rsi;
        candle.rsi_quality = rsi_quality;

        // Calculer EMA
        const closePrices = [...previousCandles, candle].map(c => c.close);
        const ema = this.calculateEMA(closePrices);
        candle.ema = ema;

        // Écrire dans InfluxDB (écrase si existe déjà)
        await writeOHLCV(candle);
    }

    async getPreviousCandles(token, timeframe, endTime) {
        const minutes = this.getTimeframeMinutes(timeframe);
        const periodsToFetch = 30;
        const periodsInMinutes = periodsToFetch * minutes;
        const startTime = new Date(endTime.getTime() - (periodsInMinutes * 60 * 1000));

        const query = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: ${startTime.toISOString()}, stop: ${endTime.toISOString()})
            |> filter(fn: (r) => r["_measurement"] == "ohlcv")
            |> filter(fn: (r) => r.contract_address == "${token.contract_address}")
            |> filter(fn: (r) => r.timeframe == "${timeframe}")
            |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
            |> sort(columns: ["_time"], desc: false)
        `;

        return await queryApi.collectRows(query);
    }

    // Réutilisation des méthodes de calcul de CandleBuilder
    calculateRSI(candles, timeframe) {
        if (candles.length < 2) {
            return { rsi: null, rsi_quality: 0 };
        }

        const minutes = this.getTimeframeMinutes(timeframe);
        const expectedGap = minutes * 60 * 1000;

        const changes = [];
        let gapCount = 0;
        let weightedQuality = 0;
        let totalWeight = 0;

        for (let i = 1; i < candles.length; i++) {
            const currentTime = new Date(candles[i].timestamp || candles[i]._time).getTime();
            const prevTime = new Date(candles[i-1].timestamp || candles[i-1]._time).getTime();
            const actualGap = currentTime - prevTime;

            if (actualGap > expectedGap * 1.1) {
                const missedCandles = Math.floor(actualGap / expectedGap) - 1;
                gapCount += missedCandles;
            }

            const change = candles[i].close - candles[i-1].close;
            changes.push({
                gain: change > 0 ? change : 0,
                loss: change < 0 ? -change : 0,
                quality: candles[i].quality_factor || 1
            });

            const weight = 1 + (i / candles.length);
            weightedQuality += (candles[i].quality_factor || 1) * weight;
            totalWeight += weight;
        }

        let avgGain, avgLoss;

        if (changes.length < 14) {
            avgGain = changes.reduce((sum, c) => sum + c.gain, 0) / changes.length;
            avgLoss = changes.reduce((sum, c) => sum + c.loss, 0) / changes.length;
        } else {
            avgGain = changes.slice(0, 14).reduce((sum, c) => sum + c.gain, 0) / 14;
            avgLoss = changes.slice(0, 14).reduce((sum, c) => sum + c.loss, 0) / 14;

            for (let i = 14; i < changes.length; i++) {
                avgGain = ((avgGain * 13) + changes[i].gain) / 14;
                avgLoss = ((avgLoss * 13) + changes[i].loss) / 14;
            }
        }

        let rsi;
        if (avgGain === 0 && avgLoss === 0) {
            rsi = 50;
        } else if (avgLoss === 0 && avgGain > 0) {
            rsi = 100;
        } else {
            const rs = avgGain / avgLoss;
            rsi = 100 - (100 / (1 + rs));
        }

        const candleCountFactor = Math.min(1, candles.length / 31);
        const gapPenalty = Math.max(0, 1 - (gapCount / 30));
        const weightedAverageQuality = weightedQuality / totalWeight;
        const rsi_quality = candleCountFactor * gapPenalty * weightedAverageQuality;

        return { rsi, rsi_quality };
    }

    calculateEMA(prices, periods = 14) {
        if (prices.length < periods) {
            return null;
        }

        const sma = prices.slice(0, periods).reduce((sum, price) => sum + price, 0) / periods;
        const multiplier = 2 / (periods + 1);

        let ema = sma;
        for (let i = periods; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    /**
     * API publique: Backfill pour un token sur une période
     */
    async backfillToken(tokenAddress, startDate, endDate) {
        if (this.isProcessing) {
            throw new Error('Un backfill est déjà en cours');
        }

        this.isProcessing = true;
        const startTime = Date.now();

        try {
            logger.info(`\n${'='.repeat(80)}`);
            logger.info(`🔧 BACKFILL DÉMARRÉ: ${tokenAddress}`);
            logger.info(`   Période: ${startDate.toISOString()} → ${endDate.toISOString()}`);
            logger.info('='.repeat(80));

            const token = await Token.getByAddress(tokenAddress);
            if (!token) {
                throw new Error(`Token ${tokenAddress} non trouvé`);
            }

            // Étape 1: Récupérer et insérer raw_prices (avec retry)
            const step1Results = await this.retryWithBackoff(
                () => this.fetchAndInsertMissingRawPrices(token, startDate, endDate),
                `Étape 1 pour ${token.symbol}`
            );

            // Étape 2: Recalculer les bougies (avec retry)
            const step2Results = await this.retryWithBackoff(
                () => this.recalculateCandlesIntelligently(token, startDate, endDate),
                `Étape 2 pour ${token.symbol}`
            );

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            const results = {
                token: token.symbol,
                tokenAddress,
                period: {
                    start: startDate.toISOString(),
                    end: endDate.toISOString()
                },
                step1: step1Results,
                step2: step2Results,
                duration: `${duration}s`,
                success: true
            };

            logger.info('='.repeat(80));
            logger.info('✅ BACKFILL TERMINÉ AVEC SUCCÈS');
            logger.info(`   Raw prices insérées: ${step1Results.rawPricesInserted}`);
            logger.info(`   Bougies recalculées: ${step2Results.candlesRecalculated}`);
            logger.info(`   Bougies créées: ${step2Results.candlesCreated}`);
            logger.info(`   Durée totale: ${duration}s`);
            logger.info('='.repeat(80));

            return results;

        } catch (error) {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            logger.error('='.repeat(80));
            logger.error('❌ BACKFILL ÉCHOUÉ');
            logger.error(`   Token: ${tokenAddress}`);
            logger.error(`   Erreur: ${error.message}`);
            logger.error(`   Durée avant échec: ${duration}s`);
            logger.error('='.repeat(80));

            // Retourner une erreur structurée
            return {
                token: tokenAddress,
                tokenAddress,
                period: {
                    start: startDate.toISOString(),
                    end: endDate.toISOString()
                },
                duration: `${duration}s`,
                success: false,
                error: error.message,
                errorType: error.constructor.name
            };

        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * API publique: Backfill pour tous les tokens sur une période (rupture de service)
     */
    async backfillAllTokens(startDate, endDate) {
        if (this.isProcessing) {
            throw new Error('Un backfill est déjà en cours');
        }

        this.isProcessing = true;

        try {
            logger.info(`\n${'='.repeat(80)}`);
            logger.info('🔧 BACKFILL GLOBAL DÉMARRÉ (tous les tokens)');
            logger.info(`   Période: ${startDate.toISOString()} → ${endDate.toISOString()}`);
            logger.info('='.repeat(80));

            const activeTokens = await Token.getAllActive();
            logger.info(`${activeTokens.length} tokens actifs à traiter`);

            const results = [];

            for (const token of activeTokens) {
                logger.info(`\n--- Traitement de ${token.symbol} ---`);

                try {
                    // Étape 1
                    const step1Results = await this.fetchAndInsertMissingRawPrices(token, startDate, endDate);

                    // Étape 2
                    const step2Results = await this.recalculateCandlesIntelligently(token, startDate, endDate);

                    results.push({
                        token: token.symbol,
                        tokenAddress: token.contract_address,
                        step1: step1Results,
                        step2: step2Results,
                        success: true
                    });

                } catch (error) {
                    logger.error(`❌ Erreur pour ${token.symbol}: ${error.message}`);
                    results.push({
                        token: token.symbol,
                        tokenAddress: token.contract_address,
                        success: false,
                        error: error.message
                    });
                }
            }

            const summary = {
                totalTokens: activeTokens.length,
                successful: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length,
                period: {
                    start: startDate.toISOString(),
                    end: endDate.toISOString()
                },
                results
            };

            logger.info('='.repeat(80));
            logger.info('✅ BACKFILL GLOBAL TERMINÉ');
            logger.info(`   Succès: ${summary.successful}/${summary.totalTokens}`);
            logger.info(`   Échecs: ${summary.failed}`);
            logger.info('='.repeat(80));

            return summary;

        } finally {
            this.isProcessing = false;
        }
    }
}

module.exports = DataBackfillService;
