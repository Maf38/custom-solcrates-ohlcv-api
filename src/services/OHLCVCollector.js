const { Connection, PublicKey } = require('@solana/web3.js');
const fetch = require('cross-fetch');
const Token = require('../models/Token');
const logger = require('../config/logger');
const { writeOHLCV } = require('../config/influxdb');

class OHLCVCollector {
    constructor() {
        this.connection = null;
        this.priceData = new Map();
        this.updateInterval = parseInt(process.env.UPDATE_INTERVAL) || 60000;
        this.timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];
    }

    initialize() {
        const rpcUrl = process.env.RPC_URL;
        if (!rpcUrl) {
            throw new Error('RPC_URL is not defined in environment variables');
        }
        this.connection = new Connection(rpcUrl, process.env.RPC_COMMITMENT || 'confirmed');
        logger.info('OHLCVCollector initialisé avec RPC URL:', rpcUrl);
    }

    async start() {
        if (!this.connection) {
            this.initialize();
        }

        try {
            const activeTokens = await Token.getAllActive();
            for (const token of activeTokens) {
                this.initializeTokenData(token.contract_address);
                await this.startCollecting(token.contract_address);
            }
            logger.info('Collecteur OHLCV démarré');
        } catch (error) {
            logger.error('Erreur lors de l\'initialisation du collector:', error);
            throw error;
        }
    }

    initializeTokenData(contractAddress) {
        if (!this.priceData.has(contractAddress)) {
            this.priceData.set(contractAddress, {
                prices: [],
                volumes: [],
                lastUpdate: null
            });
        }
    }

    async startCollecting(contractAddress) {
        try {
            // Collecter le prix initial
            await this.collectPrice(contractAddress);
            
            // Configurer la collecte périodique
            setInterval(async () => {
                await this.collectPrice(contractAddress);
            }, this.updateInterval);
        } catch (error) {
            logger.error(`Erreur de collecte pour ${contractAddress}:`, error);
        }
    }

    async collectPrice(contractAddress) {
        try {
            // Récupérer le prix via Jupiter API V3
            const response = await fetch(
                `https://lite-api.jup.ag/price/v3?ids=${contractAddress}`
            );
            const data = await response.json();
            const price = data.data[contractAddress].usdPrice;

            // Stocker le prix
            const tokenData = this.priceData.get(contractAddress);
            if (tokenData) {
                tokenData.prices.push(price);
                tokenData.lastUpdate = new Date();

                // Créer une bougie si assez de données
                if (tokenData.prices.length >= 60) { // 1 minute de données
                    await this.createCandle(contractAddress, '1m', tokenData);
                }
            }

            // Mettre à jour le timestamp du token
            await Token.updateLastUpdate(contractAddress);
        } catch (error) {
            logger.error(`Erreur lors de la collecte des données pour ${contractAddress}:`, error);
        }
    }

    async createCandle(contractAddress, timeframe, data) {
        try {
            const token = await Token.findByAddress(contractAddress);
            if (!token) {
                logger.error(`Token non trouvé pour l'adresse ${contractAddress}`);
                return;
            }

            const ohlcv = {
                token_address: contractAddress,
                symbol: token.symbol,
                timeframe,
                open: data.prices[0],
                high: Math.max(...data.prices),
                low: Math.min(...data.prices),
                close: data.prices[data.prices.length - 1],
                volume: 0, // Le volume sera ajouté par le VolumeCollector
                quality_factor: data.prices.length / (60000 / this.updateInterval) // Ratio de points disponibles
            };

            await writeOHLCV(ohlcv);
            logger.debug(`Bougie ${timeframe} créée pour ${token.symbol}`);
            
            // Réinitialiser les données
            data.prices = [];
            data.volumes = [];
        } catch (error) {
            logger.error(`Erreur lors de la création de la bougie pour ${contractAddress}:`, error);
        }
    }

    stop() {
        // TODO: Implémenter l'arrêt propre du collecteur
        logger.info('Collecteur OHLCV arrêté');
    }
}

// Exporter la classe au lieu d'une instance
module.exports = OHLCVCollector;