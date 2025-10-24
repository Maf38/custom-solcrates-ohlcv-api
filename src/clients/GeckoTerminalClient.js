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
        let beforeTimestamp = Math.floor(Date.now() / 1000);
        const targetTimestamp = beforeTimestamp - (daysBack * 24 * 60 * 60);

        const minutesNeeded = daysBack * 24 * 60;
        const requestsNeeded = Math.ceil(minutesNeeded / 1000);
        let requestCount = 0;

        while (beforeTimestamp > targetTimestamp && requestCount < requestsNeeded) {
            const url = `${this.baseUrl}/networks/solana/pools/${poolId}/ohlcv/minute?aggregate=1&before_timestamp=${beforeTimestamp}&limit=1000`;

            logger.debug(`Requête ${requestCount + 1}/${requestsNeeded}: before_timestamp=${beforeTimestamp}`);

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

        logger.info(`Récupération terminée: ${allCandles.length} candles sur ${(allCandles.length / 60 / 24).toFixed(1)} jours`);

        return allCandles.reverse(); // Du plus ancien au plus récent
    }
}

module.exports = GeckoTerminalClient;
