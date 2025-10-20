const { queryApi, writeOHLCV } = require('../config/influxdb');
const logger = require('../config/logger');

class CandleBuilder {
    constructor(options = {}) {
        this.timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];
        this.updateInterval = parseInt(process.env.UPDATE_INTERVAL) || 5000;
        this.isRunning = false;
        this.builderInterval = null;
        this.includeVolume = options.includeVolume || false;
        logger.info(`CandleBuilder initialisé avec volume ${this.includeVolume ? 'activé' : 'désactivé'}`);
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

    shouldBuildCandle(timestamp, timeframe) {
        const minutes = timestamp.getUTCMinutes();
        const hours = timestamp.getUTCHours();
        
        switch(timeframe) {
            case '1m':
                return true;
            case '5m':
                return minutes % 5 === 0;
            case '15m':
                return minutes % 15 === 0;
            case '1h':
                return minutes === 0;
            case '4h':
                return hours % 4 === 0 && minutes === 0;
            case '1d':
                return hours === 0 && minutes === 0;
            default:
                return false;
        }
    }

    async getVolume(token, startTime, endTime) {
        if (!this.includeVolume) return 0;

        try {
            const query = `
                from(bucket: "${process.env.INFLUXDB_BUCKET}")
                |> range(start: ${startTime.toISOString()}, stop: ${endTime.toISOString()})
                |> filter(fn: (r) => r["_measurement"] == "raw_volumes")
                |> filter(fn: (r) => r["contract_address"] == "${token.contract_address}")
                |> filter(fn: (r) => r["_field"] == "volume")
                |> sum()
            `;

            const volumes = await queryApi.collectRows(query);
            return volumes.length > 0 ? volumes[0]._value : 0;
        } catch (error) {
            logger.error(`Erreur lors de la récupération du volume pour ${token.symbol}:`, error);
            return 0;
        }
    }

    async getPreviousCandles(token, timeframe, endTime) {
        try {
            // Pour calculer correctement le RSI avec la méthode de Wilder, on a besoin de :
            // - Au moins 15 bougies (14 variations) pour calculer le RSI initial avec SMA
            // - Plus de bougies pour appliquer le lissage de Wilder
            // On récupère donc un historique plus large pour permettre le lissage
            const minutes = this.getTimeframeMinutes(timeframe);

            // Récupération de 30 périodes pour permettre le lissage de Wilder
            // (14 pour la SMA initiale + 16 pour le lissage progressif)
            const periodsToFetch = 30;
            const periodsInMinutes = periodsToFetch * minutes;
            const startTime = new Date(endTime.getTime() - (periodsInMinutes * 60 * 1000));

            logger.debug(`Recherche des bougies ${timeframe} pour ${token.symbol} entre ${startTime.toISOString()} et ${endTime.toISOString()} (${periodsToFetch} périodes = ${periodsInMinutes} minutes)`);

            const query = `
                from(bucket: "${process.env.INFLUXDB_BUCKET}")
                |> range(start: ${startTime.toISOString()}, stop: ${endTime.toISOString()})
                |> filter(fn: (r) => r["_measurement"] == "ohlcv")
                |> filter(fn: (r) => r.contract_address == "${token.contract_address}")
                |> filter(fn: (r) => r.timeframe == "${timeframe}")
                |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
                |> sort(columns: ["_time"], desc: false)
            `;

            const candles = await queryApi.collectRows(query);
            logger.debug(`${candles.length} bougies précédentes trouvées pour ${token.symbol} (${timeframe}) dans la plage de ${periodsToFetch} périodes`);
            return candles;
        } catch (error) {
            logger.error(`Erreur lors de la récupération des bougies précédentes pour ${token.symbol}:`, error);
            return [];
        }
    }

    calculateEMA(prices, periods = 14) {
        if (prices.length < periods) {
            logger.debug(`Pas assez de prix pour calculer l'EMA${periods} (${prices.length}/${periods})`);
            return null;
        }

        // Calcul de la moyenne simple pour la première valeur
        const sma = prices.slice(0, periods).reduce((sum, price) => sum + price, 0) / periods;
        
        // Calcul du multiplicateur pour l'EMA
        const multiplier = 2 / (periods + 1);

        // Calcul de l'EMA
        let ema = sma;
        for (let i = periods; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    calculateRSI(candles) {
        if (candles.length < 2) {
            logger.debug(`Pas assez de bougies pour calculer le RSI (${candles.length}/2 minimum)`);
            return { rsi: null, rsi_quality: 0 };
        }

        // Vérification des gaps (bougies manquantes)
        const minutes = this.getTimeframeMinutes(candles[0].timeframe);
        const expectedGap = minutes * 60 * 1000; // en millisecondes
        
        const changes = [];
        let gapCount = 0;
        let weightedQuality = 0;
        let totalWeight = 0;

        // Calcul des variations et détection des gaps
        for (let i = 1; i < candles.length; i++) {
            const currentTime = new Date(candles[i].timestamp).getTime();
            const prevTime = new Date(candles[i-1].timestamp).getTime();
            const actualGap = currentTime - prevTime;
            
            if (actualGap > expectedGap * 1.1) { // 10% de marge pour les délais réseau
                const missedCandles = Math.floor(actualGap / expectedGap) - 1;
                gapCount += missedCandles;
                logger.debug(`Gap détecté: ${missedCandles} bougies manquantes entre ${candles[i-1].timestamp} et ${candles[i].timestamp}`);
            }

            const change = candles[i].close - candles[i-1].close;
            changes.push({
                gain: change > 0 ? change : 0,
                loss: change < 0 ? -change : 0,
                quality: candles[i].quality_factor
            });

            // Plus de poids aux bougies récentes (2x plus important pour la dernière bougie)
            const weight = 1 + (i / candles.length);
            weightedQuality += candles[i].quality_factor * weight;
            totalWeight += weight;
        }

        // Méthode Wilder originale pour le RSI

        // 1. Calcul de la SMA initiale sur les 13 premières variations (pour obtenir l'avg à la période 14)
        // Wilder calcule la SMA sur n-1 périodes, puis applique le lissage sur la nième
        const periodsToUse = Math.min(14, changes.length);

        let avgGain, avgLoss;

        if (changes.length < 14) {
            // Cas où on a moins de 14 variations : on fait une SMA simple sur ce qu'on a
            avgGain = changes.reduce((sum, c) => sum + c.gain, 0) / changes.length;
            avgLoss = changes.reduce((sum, c) => sum + c.loss, 0) / changes.length;
        } else {
            // Cas normal (>= 14 variations) : méthode Wilder complète
            // Étape 1 : SMA sur les 14 premières variations
            avgGain = changes.slice(0, 14).reduce((sum, c) => sum + c.gain, 0) / 14;
            avgLoss = changes.slice(0, 14).reduce((sum, c) => sum + c.loss, 0) / 14;

            // Étape 2 : Application du lissage de Wilder pour les variations suivantes
            // Formule : avgGain = ((avgGain * 13) + gain_actuel) / 14
            for (let i = 14; i < changes.length; i++) {
                avgGain = ((avgGain * 13) + changes[i].gain) / 14;
                avgLoss = ((avgLoss * 13) + changes[i].loss) / 14;
            }
        }

        // 3. Calcul du RSI selon Wilder
        let rsi;
        if (avgGain === 0 && avgLoss === 0) {
            // Pas de mouvement = RSI neutre (50)
            rsi = 50;
        } else if (avgLoss === 0 && avgGain > 0) {
            // Que des hausses = Surachat maximal (100)
            rsi = 100;
        } else {
            // Formule standard : RSI = 100 - (100 / (1 + RS))
            const rs = avgGain / avgLoss;
            rsi = 100 - (100 / (1 + rs));
        }

        // Calcul de la qualité du RSI
        // - Prend en compte les gaps (bougies manquantes)
        // - Ajuste selon le nombre de bougies disponibles vs idéal (30 bougies précédentes + 1 actuelle = 31)
        // - Donne plus de poids aux bougies récentes
        // - Basé sur la qualité des bougies individuelles
        // Note: Pour un RSI14 avec lissage de Wilder complet, il faut 31 bougies (30 variations)
        const candleCountFactor = Math.min(1, candles.length / 31); // Facteur de réduction si moins de 31 bougies
        const gapPenalty = Math.max(0, 1 - (gapCount / 30)); // 1 = pas de gaps, 0 = que des gaps (sur 30 variations max)
        const weightedAverageQuality = weightedQuality / totalWeight;
        const rsi_quality = candleCountFactor * gapPenalty * weightedAverageQuality;

        logger.debug(`RSI qualité: ${(rsi_quality * 100).toFixed(1)}% (${gapCount} gaps, qualité moyenne pondérée: ${(weightedAverageQuality * 100).toFixed(1)}%)`);

        return { rsi, rsi_quality };
    }

    async buildCandle(token, timeframe, endTime) {
        try {
            logger.debug(`Début buildCandle pour ${token.symbol} (${timeframe}) à ${endTime.toISOString()}`);

            // Vérifier si la bougie existe déjà
            const existingQuery = `
                from(bucket: "${process.env.INFLUXDB_BUCKET}")
                |> range(start: ${endTime.toISOString()}, stop: ${new Date(endTime.getTime() + 1000).toISOString()})
                |> filter(fn: (r) => r["_measurement"] == "ohlcv")
                |> filter(fn: (r) => r.contract_address == "${token.contract_address}")
                |> filter(fn: (r) => r.timeframe == "${timeframe}")
                |> limit(n: 1)
            `;
            
            const existing = await queryApi.collectRows(existingQuery);
            if (existing.length > 0) {
                logger.debug(`Bougie ${timeframe} pour ${token.symbol} existe déjà à ${endTime.toISOString()}`);
                return;
            }

            const minutes = this.getTimeframeMinutes(timeframe);
            const startTime = new Date(endTime.getTime() - (minutes * 60 * 1000));
            logger.debug(`Période de la bougie: ${startTime.toISOString()} -> ${endTime.toISOString()}`);

            // Requête pour obtenir les prix dans l'intervalle
            const query = `
                from(bucket: "${process.env.INFLUXDB_BUCKET}")
                |> range(start: ${startTime.toISOString()}, stop: ${endTime.toISOString()})
                |> filter(fn: (r) => r["_measurement"] == "raw_prices")
                |> filter(fn: (r) => r.contract_address == "${token.contract_address}")
                |> filter(fn: (r) => r["_field"] == "price")
            `;

            logger.debug(`Exécution de la requête pour les prix...`);
            const prices = await queryApi.collectRows(query);
            logger.debug(`${prices.length} points de prix trouvés`);
            
            if (prices.length === 0) {
                logger.warn(`Pas de données pour ${token.symbol} sur ${timeframe} à ${endTime.toISOString()}`);
                return;
            }

            // Calcul du nombre de points attendus (basé uniquement sur les prix)
            const expectedPoints = (minutes * 60 * 1000) / this.updateInterval;
            let qualityFactor = prices.length / expectedPoints;
            
            // S'assurer que le quality_factor est entre 0 et 1
            qualityFactor = Math.max(0, Math.min(1, qualityFactor));
            
            logger.debug(`Points attendus: ${expectedPoints}, Points reçus: ${prices.length}, Qualité: ${(qualityFactor * 100).toFixed(1)}%`);

            // Récupération du volume si activé
            logger.debug(`Récupération du volume...`);
            const volume = await this.getVolume(token, startTime, endTime);
            logger.debug(`Volume récupéré: ${volume}`);

            // Construction de la bougie
            const values = prices.map(p => p._value);
            const candle = {
                token_address: token.contract_address,
                symbol: token.symbol,
                timeframe,
                open: values[0],
                high: Math.max(...values),
                low: Math.min(...values),
                close: values[values.length - 1],
                volume,
                quality_factor: qualityFactor,
                timestamp: endTime
            };

            // Calcul du RSI14 et de l'EMA14
            logger.debug(`Récupération des bougies précédentes...`);
            const previousCandles = await this.getPreviousCandles(token, timeframe, startTime);
            
            // Calcul du RSI
            const { rsi, rsi_quality } = this.calculateRSI([...previousCandles, candle]);
            if (rsi !== null) {
                candle.rsi = rsi;
                candle.rsi_quality = rsi_quality;
                logger.debug(`RSI calculé: ${rsi.toFixed(2)} (qualité: ${(rsi_quality * 100).toFixed(1)}%)`);
            } else {
                candle.rsi = null;
                candle.rsi_quality = 0;
                logger.debug(`RSI non calculé (pas assez d'historique)`);
            }

            // Calcul de l'EMA14
            const closePrices = [...previousCandles, candle].map(c => c.close);
            const ema = this.calculateEMA(closePrices);
            if (ema !== null) {
                candle.ema = ema;
                logger.debug(`EMA14 calculé: ${ema.toFixed(6)}`);
            } else {
                candle.ema = null;
                logger.debug(`EMA14 non calculé (pas assez d'historique)`);
            }

            logger.debug(`Écriture de la bougie dans InfluxDB...`);
            await writeOHLCV(candle);
            
            logger.info(`${token.symbol.padEnd(10)} | ${timeframe.padEnd(3)} | O:${candle.open.toString().padStart(10)} H:${candle.high.toString().padStart(10)} L:${candle.low.toString().padStart(10)} C:${candle.close.toString().padStart(10)} V:${candle.volume.toString().padStart(10)} | Qualité: ${(qualityFactor * 100).toFixed(1)}% | RSI: ${candle.rsi ? candle.rsi.toFixed(2).padStart(6) : 'N/A'.padStart(6)} (${(candle.rsi_quality * 100).toFixed(1)}%)`);
            logger.info('='.repeat(50));

        } catch (error) {
            logger.error(`Erreur lors de la construction de la bougie ${timeframe} pour ${token.contract_address}:`, error);
        }
    }

    async checkAndBuildCandles(tokens) {
        try {
            if (!tokens || tokens.length === 0) {
                logger.warn('checkAndBuildCandles appelé sans tokens');
                return;
            }
            logger.debug(`checkAndBuildCandles appelé avec ${tokens.length} tokens: ${tokens.map(t => t.symbol).join(', ')}`);

            const now = new Date();
            now.setSeconds(0, 0);  // Aligner sur la minute
            logger.debug(`Timestamp aligné: ${now.toISOString()}`);

            for (const timeframe of this.timeframes) {
                logger.debug(`Vérification du timeframe ${timeframe}`);
                
                if (this.shouldBuildCandle(now, timeframe)) {
                    logger.info(`\n=== Construction des bougies ${timeframe} ===`);
                    logger.debug(`Conditions remplies pour construire des bougies ${timeframe}`);
                    
                    for (const token of tokens) {
                        try {
                            logger.debug(`Tentative de construction de bougie ${timeframe} pour ${token.symbol}`);
                            await this.buildCandle(token, timeframe, now);
                        } catch (error) {
                            logger.error(`Erreur lors de la construction de la bougie ${timeframe} pour ${token.symbol}:`, error);
                            // On continue avec le token suivant
                        }
                    }
                } else {
                    logger.debug(`Conditions non remplies pour construire des bougies ${timeframe} à ${now.toISOString()}`);
                }
            }
        } catch (error) {
            logger.error('Erreur dans checkAndBuildCandles:', error);
        }
    }

    async start(tokens) {
        try {
            if (this.isRunning) {
                logger.warn('CandleBuilder déjà en cours d\'exécution');
                return;
            }

            if (!tokens || tokens.length === 0) {
                logger.warn('CandleBuilder démarré sans tokens');
                return;
            }

            this.isRunning = true;
            logger.info('\nDémarrage du CandleBuilder');
            logger.info(`Intervalle de mise à jour: ${this.updateInterval}ms`);
            logger.info(`Timeframes: ${this.timeframes.join(', ')}`);
            logger.info(`Tokens suivis: ${tokens.map(t => t.symbol).join(', ')}`);
            logger.info(`Volume: ${this.includeVolume ? 'activé' : 'désactivé'}`);
            logger.info('='.repeat(50));

            // Première construction
            logger.debug('Lancement de la première construction de bougies...');
            await this.checkAndBuildCandles(tokens);

            // Construction périodique
            logger.debug('Configuration de la construction périodique...');
            this.builderInterval = setInterval(async () => {
                try {
                    await this.checkAndBuildCandles(tokens);
                } catch (error) {
                    logger.error('Erreur dans l\'intervalle de construction:', error);
                }
            }, 60000);  // Vérification toutes les minutes
            logger.debug('Construction périodique configurée avec succès');
        } catch (error) {
            logger.error('Erreur lors du démarrage du CandleBuilder:', error);
            this.isRunning = false;
        }
    }

    stop() {
        if (this.builderInterval) {
            clearInterval(this.builderInterval);
            this.builderInterval = null;
        }
        this.isRunning = false;
        logger.info('\nCandleBuilder arrêté');
        logger.info('='.repeat(50));
    }
}

module.exports = CandleBuilder; 