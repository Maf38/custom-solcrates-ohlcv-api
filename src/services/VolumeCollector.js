const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../config/logger');
const { writeRawVolume } = require('../config/influxdb');

// Fonction utilitaire pour attendre
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class VolumeCollector {
    constructor() {
        this.connection = null;
        this.tokens = new Map();
        this.updateInterval = parseInt(process.env.UPDATE_INTERVAL) || 5000;
        this.isRunning = false;
    }

    initialize() {
        const rpcUrl = process.env.RPC_URL;
        if (!rpcUrl) {
            throw new Error('RPC_URL is not defined in environment variables');
        }
        this.connection = new Connection(rpcUrl, process.env.RPC_COMMITMENT || 'confirmed');
        logger.info('VolumeCollector initialisé avec RPC URL:', rpcUrl);
    }

    setTokens(tokens) {
        this.tokens.clear();  // Nettoyer la map existante
        tokens.forEach(token => {
            this.tokens.set(token.contract_address, {
                pubkey: new PublicKey(token.contract_address),
                lastSignature: null,
                symbol: token.symbol
            });
        });
        logger.info(`Liste des tokens pour la collecte de volume: ${tokens.map(t => `${t.symbol} (${t.contract_address})`).join(', ')}`);
    }

    async start() {
        if (this.isRunning) {
            logger.warn('Collecteur de volume déjà en cours d\'exécution');
            return;
        }

        if (!this.connection) {
            this.initialize();
        }

        this.isRunning = true;
        logger.info(`\nDémarrage du collecteur de volume`);
        logger.info(`Intervalle de collecte: ${this.updateInterval}ms`);
        logger.info(`Tokens suivis: ${Array.from(this.tokens.values()).map(t => t.symbol).join(', ')}`);
        logger.info('='.repeat(50));

        // Premier run pour obtenir les dernières signatures
        for (const [address, tokenData] of this.tokens) {
            try {
                const signatures = await this.connection.getSignaturesForAddress(
                    tokenData.pubkey,
                    { limit: 1 }
                );
                if (signatures.length > 0) {
                    tokenData.lastSignature = signatures[0].signature;
                    logger.debug(`Signature initiale pour ${tokenData.symbol}: ${signatures[0].signature}`);
                }
                // Attendre 1 seconde entre chaque requête pour éviter le rate limiting
                await sleep(1000);
            } catch (error) {
                logger.error(`Error getting initial signature for ${tokenData.symbol}:`, error);
            }
        }

        // Démarrer la collecte périodique
        this.collectorInterval = setInterval(() => this.collectVolumes(), this.updateInterval);
    }

    async collectVolumes() {
        if (this.tokens.size === 0) {
            logger.warn('Aucun token configuré pour la collecte de volume');
            return;
        }

        const timestamp = new Date();
        logger.info(`\n[${timestamp.toISOString()}] === Collecte de volume ===`);

        for (const [address, tokenData] of this.tokens) {
            try {
                // Attendre 1 seconde entre chaque token pour éviter le rate limiting
                await sleep(1000);

                // Récupérer les nouvelles signatures depuis la dernière connue
                const signatures = await this.connection.getSignaturesForAddress(
                    tokenData.pubkey,
                    {
                        limit: 10,
                        until: tokenData.lastSignature
                    }
                );

                if (signatures.length > 0) {
                    // Mettre à jour la dernière signature connue
                    tokenData.lastSignature = signatures[0].signature;

                    // Récupérer les transactions
                    let totalVolume = 0;
                    for (const sig of signatures) {
                        // Attendre 200ms entre chaque requête de transaction
                        await sleep(200);
                        
                        const tx = await this.connection.getTransaction(sig.signature, {
                            maxSupportedTransactionVersion: 0
                        });

                        if (!tx || !tx.meta) continue;

                        const postBalances = tx.meta.postTokenBalances
                            .filter(b => b.mint === address);
                        const preBalances = tx.meta.preTokenBalances
                            .filter(b => b.mint === address);

                        for (let i = 0; i < postBalances.length; i++) {
                            const post = postBalances[i];
                            const pre = preBalances[i] || { uiTokenAmount: { amount: "0" } };
                            const change = Math.abs(
                                Number(post.uiTokenAmount.amount) - 
                                Number(pre.uiTokenAmount.amount)
                            );
                            totalVolume += change;
                        }
                    }

                    if (totalVolume > 0) {
                        // Écriture dans InfluxDB
                        await writeRawVolume({
                            token_address: address,
                            symbol: tokenData.symbol,
                            volume: totalVolume,
                            timestamp
                        });
                        
                        logger.info(`${tokenData.symbol.padEnd(10)} | ${address.slice(0, 8)}... | Volume: ${totalVolume.toString().padStart(10)}`);
                    } else {
                        logger.debug(`${tokenData.symbol.padEnd(10)} | ${address.slice(0, 8)}... | Pas de volume`);
                    }
                }
            } catch (error) {
                logger.error(`Error collecting volume for ${tokenData.symbol}:`, error);
            }
        }

        // Log de séparation pour meilleure lisibilité
        logger.info('='.repeat(50));
    }

    stop() {
        if (this.collectorInterval) {
            clearInterval(this.collectorInterval);
            this.collectorInterval = null;
        }
        this.isRunning = false;
        logger.info('\nCollecteur de volume arrêté');
        logger.info('='.repeat(50));
    }
}

module.exports = VolumeCollector;