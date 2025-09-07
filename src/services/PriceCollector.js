const { writeRawPrice } = require('../config/influxdb');
const logger = require('../config/logger');

class PriceCollector {
    constructor() {
        this.tokens = [];
        this.updateInterval = parseInt(process.env.UPDATE_INTERVAL) || 5000;
        this.isRunning = false;
        this.collectorInterval = null;
    }

    setTokens(tokens) {
        this.tokens = tokens;
        logger.info(`Liste des tokens pour la collecte de prix: ${tokens.map(t => `${t.symbol} (${t.contract_address})`).join(', ')}`);
    }

    async collectPrices() {
        if (this.tokens.length === 0) {
            logger.warn('Aucun token configuré pour la collecte de prix');
            return;
        }

        try {
            // Construire la chaîne d'IDs pour l'API Jupiter
            const tokenIds = this.tokens.map(t => encodeURIComponent(t.contract_address)).join(',');
            
            // Appel à l'API Jupiter V3
            const url = `https://lite-api.jup.ag/price/v3?ids=${tokenIds}`;
            logger.debug(`Appel API Jupiter: ${url}`);
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0'
                }
            });
            if (!response.ok) {
                throw new Error(`Jupiter API error: ${response.status} ${response.statusText}`);
            }
            const priceData = await response.json();
            logger.debug('Réponse API Jupiter:', priceData);

            // Timestamp unique pour ce cycle de collecte
            const timestamp = new Date();
            logger.info(`\n[${timestamp.toISOString()}] === Collecte de prix ===`);

            // Traitement des données pour chaque token
            for (const token of this.tokens) {
                const tokenData = priceData[token.contract_address];
                
                if (tokenData?.usdPrice) {
                    // Écriture dans InfluxDB
                    await writeRawPrice({
                        token_address: token.contract_address,
                        symbol: token.symbol,
                        price: tokenData.usdPrice,
                        timestamp
                    });
                    
                    // Log détaillé pour chaque token
                    logger.info(`${token.symbol.padEnd(10)} | ${token.contract_address.slice(0, 8)}... | Prix: ${tokenData.usdPrice.toString().padStart(10)}$`);
                } else {
                    logger.warn(`${token.symbol.padEnd(10)} | ${token.contract_address.slice(0, 8)}... | Pas de données de prix`);
                }
            }

            // Log de séparation pour meilleure lisibilité
            logger.info('='.repeat(50));

        } catch (error) {
            logger.error('Erreur lors de la collecte des prix:', error);
        }
    }

    async start() {
        if (this.isRunning) {
            logger.warn('Collecteur de prix déjà en cours d\'exécution');
            return;
        }

        logger.info(`\nDémarrage du collecteur de prix`);
        logger.info(`Intervalle de collecte: ${this.updateInterval}ms`);
        logger.info(`Tokens suivis: ${this.tokens.map(t => t.symbol).join(', ')}`);
        logger.info('='.repeat(50));
        
        this.isRunning = true;
        
        // Première collecte immédiate
        await this.collectPrices();
        
        // Puis à intervalle régulier
        this.collectorInterval = setInterval(async () => {
            await this.collectPrices();
        }, this.updateInterval);
    }

    stop() {
        if (this.collectorInterval) {
            clearInterval(this.collectorInterval);
            this.collectorInterval = null;
        }
        this.isRunning = false;
        logger.info('\nCollecteur de prix arrêté');
        logger.info('='.repeat(50));
    }
}

module.exports = PriceCollector;