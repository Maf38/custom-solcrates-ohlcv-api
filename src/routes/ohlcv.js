const express = require('express');
const { param, query } = require('express-validator');
const { PublicKey } = require('@solana/web3.js');
const { queryApi } = require('../config/influxdb');
const Token = require('../models/Token');
const logger = require('../config/logger');

const router = express.Router();

// Route racine pour documenter les endpoints
router.get('/', (req, res) => {
    res.json({
        message: "API OHLCV - Endpoints disponibles",
        endpoints: [
            {
                method: "GET",
                path: "/api/ohlcv/:address/:timeframe",
                description: "Récupère les bougies OHLCV pour un token",
                parameters: {
                    address: "Adresse Solana du token",
                    timeframe: `Timeframe valide: ${validTimeframes.join(', ')}`,
                    start: "Date de début optionnelle (ISO8601)",
                    end: "Date de fin optionnelle (ISO8601)",
                    limit: "Limite optionnelle (1-1000)"
                }
            },
            {
                method: "GET", 
                path: "/api/ohlcv/raw/:address",
                description: "Récupère les données brutes de prix pour un token",
                parameters: {
                    address: "Adresse Solana du token",
                    start: "Date de début optionnelle (ISO8601)",
                    end: "Date de fin optionnelle (ISO8601)",
                    limit: "Limite optionnelle (1-1000)"
                }
            }
        ]
    });
});

// Validation des timeframes
const validTimeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];

// Validation de l'adresse Solana
const validateSolanaAddress = value => {
    try {
        return PublicKey.isValid(value);
    } catch (error) {
        throw new Error('Adresse Solana invalide');
    }
};

// Convertir un timeframe en minutes
const getTimeframeMinutes = (timeframe) => {
    switch (timeframe) {
        case '1m': return 1;
        case '5m': return 5;
        case '15m': return 15;
        case '1h': return 60;
        case '4h': return 240;
        case '1d': return 1440;
        default: throw new Error('Timeframe non supporté');
    }
};

// Récupère les données brutes pour un token
router.get('/raw/:address', [
    param('address').custom(validateSolanaAddress),
    query('start').optional().isISO8601(),
    query('end').optional().isISO8601(),
    query('limit').optional().isInt({ min: 1, max: 1000 }).toInt()
], async (req, res) => {
    try {
        const { address } = req.params;
        const limit = req.query.limit || 100;
        const start = req.query.start ? `"${req.query.start}"` : '-1h';
        const end = req.query.end ? `, stop: "${req.query.end}"` : '';

        // Vérifier si le token existe et est actif
        const token = await Token.findByAddress(address);
        if (!token || !token.is_active) {
            return res.status(404).json({
                status: 'error',
                message: 'Token non trouvé ou inactif'
            });
        }

        // Requête pour les prix
        const priceQuery = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: ${start}${end})
            |> filter(fn: (r) => r["_measurement"] == "raw_prices")
            |> filter(fn: (r) => r["contract_address"] == "${address}")
            |> sort(columns: ["_time"], desc: true)
            |> limit(n: ${limit})
        `;

        // Requête pour les volumes
        const volumeQuery = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: ${start}${end})
            |> filter(fn: (r) => r["_measurement"] == "raw_volumes")
            |> filter(fn: (r) => r["contract_address"] == "${address}")
            |> sort(columns: ["_time"], desc: true)
            |> limit(n: ${limit})
        `;

        logger.debug('Requête prix:', priceQuery);
        logger.debug('Requête volume:', volumeQuery);

        const [prices, volumes] = await Promise.all([
            queryApi.collectRows(priceQuery),
            queryApi.collectRows(volumeQuery)
        ]);

        // Fusionner les données par timestamp
        const rawData = new Map();
        
        prices.forEach(row => {
            const timestamp = new Date(row._time);
            if (!rawData.has(timestamp.getTime())) {
                rawData.set(timestamp.getTime(), {
                    timestamp: timestamp.toISOString(),
                    price: row._value,
                    volume: 0
                });
            } else {
                rawData.get(timestamp.getTime()).price = row._value;
            }
        });

        volumes.forEach(row => {
            const timestamp = new Date(row._time);
            if (!rawData.has(timestamp.getTime())) {
                rawData.set(timestamp.getTime(), {
                    timestamp: timestamp.toISOString(),
                    price: null,
                    volume: row._value
                });
            } else {
                rawData.get(timestamp.getTime()).volume = row._value;
            }
        });

        // Convertir en tableau et trier par timestamp
        const data = Array.from(rawData.values())
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json({
            status: 'success',
            data: {
                token: token.symbol,
                raw_data: data
            }
        });

    } catch (error) {
        logger.error('Erreur lors de la récupération des données brutes:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// Récupère les données OHLCV pour un token
router.get('/:address/:timeframe', [
    param('address').custom(validateSolanaAddress),
    param('timeframe').isIn(validTimeframes),
    query('start').optional().isISO8601(),
    query('end').optional().isISO8601(),
    query('limit').optional().isInt({ min: 1, max: 1000 }).toInt()
], async (req, res) => {
    try {
        logger.debug('Début de la route OHLCV');
        
        const { address, timeframe } = req.params;
        const limit = req.query.limit || 100;
        const start = req.query.start ? `"${req.query.start}"` : '-24h';
        const end = req.query.end ? `, stop: "${req.query.end}"` : '';

        logger.debug('Paramètres reçus:', { address, timeframe, limit, start, end });

        logger.debug('Début récupération OHLCV:', { address, timeframe, limit, start, end });

        // Vérifier si le token existe et est actif
        const token = await Token.findByAddress(address);
        logger.debug('Résultat recherche token:', token);
        
        if (!token || !token.is_active) {
            logger.warn('Token non trouvé ou inactif:', address);
            return res.status(404).json({
                status: 'error',
                message: 'Token non trouvé ou inactif'
            });
        }

        logger.debug('Token trouvé et actif:', token.symbol);

        // Requête InfluxDB pour les bougies - version simplifiée
        const query = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: ${start}${end})
            |> filter(fn: (r) => r["_measurement"] == "ohlcv")
            |> filter(fn: (r) => r["contract_address"] == "${address}")
            |> filter(fn: (r) => r["timeframe"] == "${timeframe}")
            |> sort(columns: ["_time"], desc: true)
            |> limit(n: ${limit})
        `;

        logger.debug('Requête OHLCV à exécuter:', { query });
        
        try {
            const rows = await queryApi.collectRows(query);
            logger.debug('Requête OHLCV exécutée avec succès');
        
            logger.debug('Résultats bruts de la requête OHLCV:', { 
                nombreDeLignes: rows.length,
                premiereLigne: rows[0],
                exempleLignes: rows.slice(0, 3)
            });
            
            // Regrouper les données par timestamp
            const ohlcvData = new Map();
            
            rows.forEach((row, index) => {
                const timestamp = new Date(row._time).toISOString();
                if (!ohlcvData.has(timestamp)) {
                    ohlcvData.set(timestamp, {
                        timestamp,
                        open: null,
                        high: null,
                        low: null,
                        close: null,
                        volume: null,
                        quality_factor: null,
                        rsi: null,
                        rsi_quality: null,
                        ema: null
                    });
                }
                
                const data = ohlcvData.get(timestamp);
                switch (row._field) {
                    case 'open':
                        data.open = row._value;
                        break;
                    case 'high':
                        data.high = row._value;
                        break;
                    case 'low':
                        data.low = row._value;
                        break;
                    case 'close':
                        data.close = row._value;
                        break;
                    case 'volume':
                        data.volume = row._value;
                        break;
                    case 'quality_factor':
                        data.quality_factor = row._value;
                        break;
                    case 'rsi':
                        data.rsi = row._value;
                        break;
                    case 'rsi_quality':
                        data.rsi_quality = row._value;
                        break;
                    case 'ema':
                        data.ema = row._value;
                        break;
                    default:
                        logger.debug('Field non géré:', row._field);
                }
                
                // Log détaillé pour les premières lignes
                if (index < 5) {
                    logger.debug(`Ligne ${index}:`, { 
                        time: row._time, 
                        field: row._field, 
                        value: row._value,
                        measurement: row._measurement,
                        contract_address: row.contract_address,
                        timeframe: row.timeframe
                    });
                }
            });
            
            logger.debug('Données groupées:', { 
                nombreDeBougies: ohlcvData.size,
                exemplesBougies: Array.from(ohlcvData.entries()).slice(0, 3)
            });
            
            const ohlcv = Array.from(ohlcvData.values()).reverse();
            
            logger.debug('Données OHLCV finales:', { 
                nombreDeBougies: ohlcv.length,
                exemplesBougies: ohlcv.slice(0, 3)
            });

            res.json({
                status: 'success',
                data: {
                    token: token.symbol,
                    timeframe,
                    ohlcv
                }
            });
        } catch (influxError) {
            logger.error('Erreur lors de l\'exécution de la requête InfluxDB pour OHLCV:', influxError);
            res.status(500).json({
                status: 'error',
                message: influxError.message || 'Erreur InfluxDB'
            });
        }

    } catch (error) {
        logger.error('Erreur lors de la récupération des données OHLCV:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// Route pour l'analyse des performances basées sur le RSI
router.get('/rsi-performance/:address/:timeframe', [
    param('address').custom(validateSolanaAddress),
    param('timeframe').isIn(validTimeframes),
    query('rsi_target').isFloat({ min: 0, max: 100 }).toFloat(),
    query('operation').isIn(['achat', 'vente']),
    query('n').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('negative_offset').optional().isFloat({ min: 0, max: 50 }).toFloat(),
    query('positive_offset').optional().isFloat({ min: 0, max: 50 }).toFloat()
], async (req, res) => {
    try {
        const { address, timeframe } = req.params;
        const {
            rsi_target,
            operation,
            n = 10,
            negative_offset = 5,
            positive_offset = 10
        } = req.query;

        logger.debug('Paramètres RSI performance:', {
            address, timeframe, rsi_target, operation, n, negative_offset, positive_offset
        });

        // Vérifier si le token existe et est actif
        const token = await Token.findByAddress(address);
        if (!token || !token.is_active) {
            return res.status(404).json({
                status: 'error',
                message: 'Token non trouvé ou inactif'
            });
        }

        // Récupérer un grand nombre de bougies pour l'analyse
        const query = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: -30d)
            |> filter(fn: (r) => r["_measurement"] == "ohlcv")
            |> filter(fn: (r) => r["contract_address"] == "${address}")
            |> filter(fn: (r) => r["timeframe"] == "${timeframe}")
            |> sort(columns: ["_time"], desc: false)
            |> limit(n: 1000)
        `;

        const rows = await queryApi.collectRows(query);

        // Regrouper les données par timestamp
        const ohlcvData = new Map();
        
        rows.forEach(row => {
            const timestamp = new Date(row._time).toISOString();
            if (!ohlcvData.has(timestamp)) {
                ohlcvData.set(timestamp, {
                    timestamp,
                    open: null,
                    high: null,
                    low: null,
                    close: null,
                    volume: null,
                    quality_factor: null,
                    rsi: null,
                    rsi_quality: null,
                    ema: null
                });
            }
            
            const data = ohlcvData.get(timestamp);
            switch (row._field) {
                case 'open': data.open = row._value; break;
                case 'high': data.high = row._value; break;
                case 'low': data.low = row._value; break;
                case 'close': data.close = row._value; break;
                case 'volume': data.volume = row._value; break;
                case 'quality_factor': data.quality_factor = row._value; break;
                case 'rsi': data.rsi = row._value; break;
                case 'rsi_quality': data.rsi_quality = row._value; break;
                case 'ema': data.ema = row._value; break;
            }
        });

        // Convertir en tableau trié chronologiquement
        const candles = Array.from(ohlcvData.values())
            .filter(candle => candle.rsi !== null && candle.close !== null)
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        if (candles.length < 2) {
            return res.status(404).json({
                status: 'error',
                message: 'Pas assez de données pour l\'analyse'
            });
        }

        // Filtrer les bougies dont le RSI est dans la plage cible
        const targetCandles = candles.filter(candle => {
            const rsi = candle.rsi;
            return rsi >= (rsi_target - negative_offset) && 
                   rsi <= (rsi_target + positive_offset);
        });

        if (targetCandles.length === 0) {
            return res.status(404).json({
                status: 'error',
                message: 'Aucune bougie trouvée dans la plage RSI cible'
            });
        }

        // Prendre les N dernières bougies correspondantes
        const selectedCandles = targetCandles.slice(-n);

        // Analyser les performances avec les données brutes
        const variations = [];
        let bougiesValides = 0;

        for (let i = 0; i < selectedCandles.length; i++) {
            const currentCandle = selectedCandles[i];
            const currentTime = new Date(currentCandle.timestamp);
            
            // Calculer la fin de la période suivante
            const endTime = new Date(currentTime);
            const timeframeMinutes = getTimeframeMinutes(timeframe);
            endTime.setMinutes(endTime.getMinutes() + timeframeMinutes);

            // Requête pour les données brutes dans la période suivante
            const rawQuery = `
                from(bucket: "${process.env.INFLUXDB_BUCKET}")
                |> range(start: ${currentTime.toISOString()}, stop: ${endTime.toISOString()})
                |> filter(fn: (r) => r["_measurement"] == "raw_prices")
                |> filter(fn: (r) => r["contract_address"] == "${address}")
                |> sort(columns: ["_time"], desc: false)
            `;

            try {
                const rawRows = await queryApi.collectRows(rawQuery);
                
                logger.debug(`Données brutes récupérées pour ${currentCandle.timestamp}:`, {
                    nombreDePoints: rawRows.length,
                    periode: `${currentTime.toISOString()} -> ${endTime.toISOString()}`
                });
                
                if (rawRows.length > 0) {
                    // Extraire tous les prix de la période
                    const prices = rawRows.map(row => row._value);
                    
                    let targetPrice;
                    if (operation === 'achat') {
                        targetPrice = Math.max(...prices);
                    } else { // vente
                        targetPrice = Math.min(...prices);
                    }

                    // Calculer la variation en valeur décimale (0-1)
                    const variation = (targetPrice - currentCandle.close) / currentCandle.close;

                    logger.debug(`Analyse réussie pour ${currentCandle.timestamp}:`, {
                        prixInitial: currentCandle.close,
                        prixCible: targetPrice,
                        variation: variation,
                        operation: operation
                    });

                    variations.push({
                        timestamp: currentCandle.timestamp,
                        rsi: currentCandle.rsi,
                        price: currentCandle.close,
                        target_price: targetPrice,
                        variation: variation,
                        timeframe: timeframe,
                        raw_data_points: prices.length,
                        operation: operation
                    });
                    bougiesValides++;
                } else {
                    logger.debug(`Aucune donnée brute trouvée pour ${currentCandle.timestamp}`);
                }
            } catch (rawError) {
                logger.warn('Erreur lors de la récupération des données brutes:', rawError);
                continue;
            }
        }

        // Calculer la moyenne des variations
        const moyenneVariation = variations.length > 0
            ? variations.reduce((sum, v) => sum + v.variation, 0) / variations.length
            : 0;

        res.json({
            status: 'success',
            data: {
                token: token.symbol,
                rsi_target,
                operation,
                timeframe,
                total_bougies_trouvees: targetCandles.length,
                bougies_valides: bougiesValides,
                moyenne_variation: moyenneVariation,
                variations
            }
        });

    } catch (error) {
        logger.error('Erreur lors de l\'analyse RSI performance:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

module.exports = router;