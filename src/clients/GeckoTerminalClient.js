const fetch = require('cross-fetch');
const logger = require('../config/logger');

class GeckoTerminalClient {
    constructor() {
        this.baseUrl = 'https://api.geckoterminal.com/api/v2';
        this.requestDelay = 2000; // 2 secondes = 30 req/min
        this.lastRequestTime = 0;
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async rateLimitedRequest(url) {
        // Respecter le rate limit (30 req/min = 1 req/2s)
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.requestDelay) {
            const waitTime = this.requestDelay - timeSinceLastRequest;
            logger.debug(`Rate limit: attente de ${waitTime}ms...`);
            await this.sleep(waitTime);
        }

        this.lastRequestTime = Date.now();

        logger.debug(`Requête GeckoTerminal: ${url}`);
        const response = await fetch(url);

        if (response.status === 429) {
            logger.warn('Rate limit 429 atteint, attente de 60 secondes...');
            await this.sleep(60000);
            return this.rateLimitedRequest(url); // Retry
        }

        if (!response.ok) {
            throw new Error(`GeckoTerminal API error: ${response.status} ${response.statusText}`);
        }

        return response.json();
    }

    async getMainPoolId(tokenAddress) {
        logger.debug(`Recherche du pool principal pour ${tokenAddress}...`);

        const url = `${this.baseUrl}/networks/solana/tokens/${tokenAddress}`;
        const data = await this.rateLimitedRequest(url);

        if (!data.data || !data.data.relationships || !data.data.relationships.top_pools) {
            throw new Error(`Aucun pool trouvé pour le token ${tokenAddress}`);
        }

        const topPools = data.data.relationships.top_pools.data;

        if (topPools.length === 0) {
            throw new Error(`Aucun pool actif pour le token ${tokenAddress}`);
        }

        // Retourner le pool principal (le plus liquide)
        const mainPoolId = topPools[0].id.replace('solana_', '');

        logger.debug(`Pool principal trouvé: ${mainPoolId}`);
        return mainPoolId;
    }

    async fetchOHLCVHistory(poolId, daysBack = 30, onProgress = null) {
        logger.info(`Récupération de ${daysBack} jours d'historique pour le pool ${poolId}...`);

        const allCandles = [];
        const nowTimestamp = Math.floor(Date.now() / 1000);

        // On démarre la récupération depuis maintenant (les données les plus récentes disponibles)
        let beforeTimestamp = nowTimestamp;
        const targetTimestamp = nowTimestamp - (daysBack * 24 * 60 * 60);

        const minutesNeeded = daysBack * 24 * 60;
        const requestsNeeded = Math.ceil(minutesNeeded / 1000);
        let requestCount = 0;

        logger.info(`Période cible: ${new Date(targetTimestamp * 1000).toISOString()} → ${new Date(nowTimestamp * 1000).toISOString()}`);

        while (beforeTimestamp > targetTimestamp && requestCount < requestsNeeded) {
            const url = `${this.baseUrl}/networks/solana/pools/${poolId}/ohlcv/minute?aggregate=1&before_timestamp=${beforeTimestamp}&limit=1000`;

            logger.debug(`Requête ${requestCount + 1}/${requestsNeeded}: before_timestamp=${new Date(beforeTimestamp * 1000).toISOString()}`);

            const data = await this.rateLimitedRequest(url);
            const candles = data.data.attributes.ohlcv_list;

            if (candles.length === 0) {
                logger.info(`Plus de données historiques disponibles (${allCandles.length} candles récupérées)`);
                break;
            }

            allCandles.push(...candles);
            beforeTimestamp = candles[candles.length - 1][0]; // Dernier timestamp de ce batch
            requestCount++;

            // Callback de progression
            if (onProgress) {
                onProgress(requestCount, requestsNeeded);
            }

            logger.debug(`${candles.length} candles récupérées, total: ${allCandles.length}`);
        }

        // Trier les candles du plus ancien au plus récent
        const sortedCandles = allCandles.reverse();

        // Logger les timestamps de début et fin réels
        if (sortedCandles.length > 0) {
            const actualStartDate = new Date(sortedCandles[0][0] * 1000);
            const actualEndDate = new Date(sortedCandles[sortedCandles.length - 1][0] * 1000);
            const actualDays = (sortedCandles.length / 60 / 24).toFixed(1);

            logger.info(`✅ Récupération terminée: ${sortedCandles.length} candles (~${actualDays} jours)`);
            logger.info(`   Période réelle: ${actualStartDate.toISOString()} → ${actualEndDate.toISOString()}`);

            // Calculer le gap avec le moment présent
            const gapSeconds = nowTimestamp - sortedCandles[sortedCandles.length - 1][0];
            const gapMinutes = Math.floor(gapSeconds / 60);
            const gapHours = Math.floor(gapMinutes / 60);

            if (gapMinutes > 60) {
                logger.warn(`⚠️ Gap détecté: ${gapHours}h${gapMinutes % 60}m entre la fin des données historiques et maintenant`);
                logger.warn(`   Ce gap sera comblé par la collecte temps réel dès l'activation du token`);
            } else if (gapMinutes > 0) {
                logger.info(`ℹ️ Gap de ${gapMinutes}min avec le présent (normal pour l'API GeckoTerminal)`);
            }
        }

        return sortedCandles;
    }
}

module.exports = GeckoTerminalClient;
