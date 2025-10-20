#!/usr/bin/env node

const { queryApi, writeApi } = require('../src/config/influxdb');
const Token = require('../src/models/Token');
const logger = require('../src/config/logger');

class RSIHistoricalFixer {
    constructor() {
        this.timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];
        this.batchSize = 100; // Traiter par lots pour éviter les timeouts
    }

    // Calcul RSI avec la méthode de Wilder (copié du CandleBuilder corrigé)
    calculateRSI(candles) {
        if (candles.length < 15) { // Need at least 15 candles (14 changes)
            logger.debug(`Pas assez de bougies pour calculer le RSI (${candles.length}/15)`);
            return { rsi: null, rsi_quality: 0 };
        }

        const changes = [];

        // Calcul des variations
        for (let i = 1; i < candles.length; i++) {
            const change = candles[i].close - candles[i-1].close;
            changes.push({
                gain: change > 0 ? change : 0,
                loss: change < 0 ? -change : 0,
                quality: candles[i].quality_factor || 1
            });
        }

        if (changes.length < 14) {
            return { rsi: null, rsi_quality: 0 };
        }

        // Méthode Wilder originale pour le RSI
        // 1. Calcul de la moyenne simple (SMA) pour les 14 premières périodes
        let avgGain = changes.slice(0, 14).reduce((sum, c) => sum + c.gain, 0) / 14;
        let avgLoss = changes.slice(0, 14).reduce((sum, c) => sum + c.loss, 0) / 14;

        // 2. Application de la méthode de lissage de Wilder pour les périodes suivantes
        for (let i = 14; i < changes.length; i++) {
            avgGain = ((avgGain * 13) + changes[i].gain) / 14;
            avgLoss = ((avgLoss * 13) + changes[i].loss) / 14;
        }

        // 3. Calcul du RSI selon Wilder
        let rsi;
        if (avgGain === 0 && avgLoss === 0) {
            rsi = 50; // Pas de mouvement = RSI neutre
        } else if (avgLoss === 0 && avgGain > 0) {
            rsi = 100; // Que des hausses = Surachat maximal
        } else {
            const rs = avgGain / avgLoss;
            rsi = 100 - (100 / (1 + rs));
        }

        // Calculer la qualité moyenne
        const avgQuality = changes.reduce((sum, c) => sum + c.quality, 0) / changes.length;

        return { rsi, rsi_quality: avgQuality };
    }

    async getCandlesForToken(tokenAddress, timeframe, limit = 1000) {
        try {
            const query = `
                from(bucket: "${process.env.INFLUXDB_BUCKET}")
                |> range(start: -30d)
                |> filter(fn: (r) => r["_measurement"] == "ohlcv")
                |> filter(fn: (r) => r["contract_address"] == "${tokenAddress}")
                |> filter(fn: (r) => r["timeframe"] == "${timeframe}")
                |> sort(columns: ["_time"], desc: false)
                |> limit(n: ${limit})
            `;

            const rows = await queryApi.collectRows(query);

            // Regrouper les données par timestamp
            const candleMap = new Map();

            rows.forEach(row => {
                const timestamp = new Date(row._time).toISOString();
                if (!candleMap.has(timestamp)) {
                    candleMap.set(timestamp, {
                        timestamp,
                        open: null,
                        high: null,
                        low: null,
                        close: null,
                        volume: null,
                        quality_factor: null
                    });
                }

                const candle = candleMap.get(timestamp);
                switch (row._field) {
                    case 'open': candle.open = row._value; break;
                    case 'high': candle.high = row._value; break;
                    case 'low': candle.low = row._value; break;
                    case 'close': candle.close = row._value; break;
                    case 'volume': candle.volume = row._value; break;
                    case 'quality_factor': candle.quality_factor = row._value; break;
                }
            });

            // Convertir en tableau et filtrer les bougies complètes
            const candles = Array.from(candleMap.values())
                .filter(candle =>
                    candle.open !== null &&
                    candle.high !== null &&
                    candle.low !== null &&
                    candle.close !== null
                )
                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            return candles;
        } catch (error) {
            logger.error(`Erreur lors de la récupération des bougies pour ${tokenAddress}:`, error);
            return [];
        }
    }

    async updateCandleRSI(tokenAddress, timeframe, timestamp, rsi, rsiQuality) {
        try {
            const point = {
                measurement: 'ohlcv',
                tags: {
                    contract_address: tokenAddress,
                    timeframe: timeframe
                },
                fields: {
                    rsi: rsi,
                    rsi_quality: rsiQuality
                },
                timestamp: new Date(timestamp)
            };

            writeApi.writePoint(point);
            logger.debug(`RSI mis à jour pour ${tokenAddress} ${timeframe} à ${timestamp}: ${rsi.toFixed(2)}`);
        } catch (error) {
            logger.error(`Erreur lors de la mise à jour RSI pour ${tokenAddress}:`, error);
        }
    }

    async processTokenTimeframe(token, timeframe) {
        try {
            logger.info(`🔄 Traitement ${token.symbol} (${timeframe})`);

            const candles = await this.getCandlesForToken(token.contract_address, timeframe);

            if (candles.length < 15) {
                logger.warn(`❌ Pas assez de bougies pour ${token.symbol} (${timeframe}): ${candles.length}`);
                return { processed: 0, updated: 0 };
            }

            let processed = 0;
            let updated = 0;

            // Recalculer le RSI pour chaque bougie avec suffisamment d'historique
            for (let i = 14; i < candles.length; i++) {
                const candleSlice = candles.slice(0, i + 1);
                const { rsi, rsi_quality } = this.calculateRSI(candleSlice);

                if (rsi !== null) {
                    await this.updateCandleRSI(
                        token.contract_address,
                        timeframe,
                        candles[i].timestamp,
                        rsi,
                        rsi_quality
                    );
                    updated++;
                }
                processed++;

                // Flush par batch pour éviter les problèmes de mémoire
                if (processed % this.batchSize === 0) {
                    await writeApi.flush();
                    logger.debug(`  📊 Batch traité: ${processed}/${candles.length - 14}`);
                }
            }

            // Flush final
            await writeApi.flush();

            logger.info(`✅ ${token.symbol} (${timeframe}): ${updated}/${processed} bougies mises à jour`);
            return { processed, updated };

        } catch (error) {
            logger.error(`Erreur lors du traitement de ${token.symbol} (${timeframe}):`, error);
            return { processed: 0, updated: 0 };
        }
    }

    async fixAllHistoricalRSI() {
        try {
            logger.info('🚀 Début de la correction des RSI historiques');

            // Récupérer tous les tokens actifs
            const tokens = await Token.getAllActive();
            logger.info(`📋 ${tokens.length} tokens actifs trouvés`);

            let totalProcessed = 0;
            let totalUpdated = 0;

            for (const token of tokens) {
                logger.info(`\n🎯 Token: ${token.symbol} (${token.contract_address})`);

                for (const timeframe of this.timeframes) {
                    const result = await this.processTokenTimeframe(token, timeframe);
                    totalProcessed += result.processed;
                    totalUpdated += result.updated;
                }
            }

            logger.info('\n🎉 Correction terminée !');
            logger.info(`📊 Total: ${totalUpdated}/${totalProcessed} bougies mises à jour`);

            return { totalProcessed, totalUpdated };

        } catch (error) {
            logger.error('Erreur lors de la correction des RSI historiques:', error);
            throw error;
        }
    }

    async fixSingleToken(tokenAddress, timeframe = null) {
        try {
            const token = await Token.findByAddress(tokenAddress);
            if (!token || !token.is_active) {
                throw new Error(`Token non trouvé ou inactif: ${tokenAddress}`);
            }

            const timeframesToProcess = timeframe ? [timeframe] : this.timeframes;

            logger.info(`🎯 Correction RSI pour ${token.symbol}`);

            let totalProcessed = 0;
            let totalUpdated = 0;

            for (const tf of timeframesToProcess) {
                const result = await this.processTokenTimeframe(token, tf);
                totalProcessed += result.processed;
                totalUpdated += result.updated;
            }

            logger.info(`✅ ${token.symbol}: ${totalUpdated}/${totalProcessed} bougies mises à jour`);
            return { totalProcessed, totalUpdated };

        } catch (error) {
            logger.error(`Erreur lors de la correction RSI pour ${tokenAddress}:`, error);
            throw error;
        }
    }
}

// Fonction d'aide pour l'utilisation en ligne de commande
async function main() {
    const args = process.argv.slice(2);
    const fixer = new RSIHistoricalFixer();

    try {
        if (args.length === 0) {
            // Corriger tous les tokens
            await fixer.fixAllHistoricalRSI();
        } else if (args.length === 1) {
            // Corriger un token spécifique
            await fixer.fixSingleToken(args[0]);
        } else if (args.length === 2) {
            // Corriger un token et timeframe spécifique
            await fixer.fixSingleToken(args[0], args[1]);
        } else {
            console.log('Usage:');
            console.log('  node scripts/fix-rsi-historical.js                    # Tous les tokens');
            console.log('  node scripts/fix-rsi-historical.js <token_address>    # Un token');
            console.log('  node scripts/fix-rsi-historical.js <token_address> <timeframe>  # Token + timeframe');
        }

        process.exit(0);
    } catch (error) {
        logger.error('Erreur fatale:', error);
        process.exit(1);
    }
}

// Exporter la classe pour utilisation dans d'autres scripts
module.exports = RSIHistoricalFixer;

// Si appelé directement, exécuter main()
if (require.main === module) {
    main();
}