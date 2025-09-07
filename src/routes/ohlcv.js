const express = require('express');
const { param, query } = require('express-validator');
const { PublicKey } = require('@solana/web3.js');
const { queryApi } = require('../config/influxdb');
const Token = require('../models/Token');
const logger = require('../config/logger');

const router = express.Router();

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
        const start = req.query.start || '-1h';
        const end = req.query.end;

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
            |> range(start: ${start}${end ? `, stop: ${end}` : ''})
            |> filter(fn: (r) => r["_measurement"] == "raw_prices")
            |> filter(fn: (r) => r["token_address"] == "${address}")
            |> limit(n: ${limit})
        `;

        // Requête pour les volumes
        const volumeQuery = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: ${start}${end ? `, stop: ${end}` : ''})
            |> filter(fn: (r) => r["_measurement"] == "raw_volumes")
            |> filter(fn: (r) => r["token_address"] == "${address}")
            |> limit(n: ${limit})
        `;

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
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

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
        const { address, timeframe } = req.params;
        const limit = req.query.limit || 100;
        const start = req.query.start || '-1h';
        const end = req.query.end;

        // Vérifier si le token existe et est actif
        const token = await Token.findByAddress(address);
        if (!token || !token.is_active) {
            return res.status(404).json({
                status: 'error',
                message: 'Token non trouvé ou inactif'
            });
        }

        // Requête InfluxDB pour les bougies
        const query = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: ${start}${end ? `, stop: ${end}` : ''})
            |> filter(fn: (r) => r["_measurement"] == "ohlcv")
            |> filter(fn: (r) => r["token_address"] == "${address}")
            |> filter(fn: (r) => r["timeframe"] == "${timeframe}")
            |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
            |> limit(n: ${limit})
        `;

        const rows = await queryApi.collectRows(query);
        
        const ohlcv = rows.map(row => ({
            timestamp: new Date(row._time).toISOString(),
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
            quality_factor: row.quality_factor
        }));

        res.json({
            status: 'success',
            data: {
                token: token.symbol,
                timeframe,
                ohlcv
            }
        });

    } catch (error) {
        logger.error('Erreur lors de la récupération des données OHLCV:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

module.exports = router;