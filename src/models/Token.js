const sqliteManager = require('../config/sqlite');
const { queryApi, writeApi } = require('../config/influxdb');
const logger = require('../config/logger');
const { Point } = require('@influxdata/influxdb-client');

class TokenFinal {
    static async create(contractAddress, symbol) {
        try {
            logger.debug('Tentative de création du token dans SQLite:', { contractAddress, symbol });

            // Créer uniquement dans SQLite (source principale)
            const success = sqliteManager.createToken(contractAddress, symbol, true);
            
            if (!success) {
                throw new Error('Échec de la création du token dans SQLite');
            }

            // Vérifier la création
            const createdToken = await this.findByAddress(contractAddress);
            logger.debug('Vérification post-création:', createdToken);

            if (!createdToken) {
                throw new Error('Token non trouvé après création');
            }

            logger.info(`Token créé avec succès dans SQLite: ${symbol} (${contractAddress})`);
            return createdToken;
        } catch (error) {
            logger.error('Erreur lors de la création du token:', error);
            throw error;
        }
    }

    static async findByAddress(contractAddress) {
        try {
            logger.debug('Recherche du token dans SQLite:', contractAddress);

            // Rechercher uniquement dans SQLite (source principale)
            const token = sqliteManager.getTokenByAddress(contractAddress);
            
            if (!token) {
                logger.debug('Token non trouvé dans SQLite');
                return null;
            }

            logger.debug('Token trouvé dans SQLite:', token);
            return {
                contract_address: token.contract_address,
                symbol: token.symbol,
                is_active: Boolean(token.is_active) // Convertir 1/0 en true/false
            };
        } catch (error) {
            logger.error('Erreur lors de la recherche du token:', error);
            throw error;
        }
    }

    static async getAllActive() {
        try {
            logger.debug('Récupération de tous les tokens actifs depuis SQLite');

            // LOGIQUE SIMPLE : Récupérer tous les tokens actifs depuis SQLite
            // Pas de filtre temporel, pas de dépendance InfluxDB
            const activeTokens = sqliteManager.getAllActiveTokens();
            
            // Formater pour maintenir la compatibilité avec l'ancienne API
            const formattedTokens = activeTokens.map(token => ({
                contract_address: token.contract_address,
                symbol: token.symbol,
                is_active: Boolean(token.is_active) // Convertir 1/0 en true/false
            }));
            
            logger.info(`${formattedTokens.length} tokens actifs trouvés dans SQLite`);
            return formattedTokens;
            
        } catch (error) {
            logger.error('Erreur lors de la récupération des tokens actifs:', error);
            throw error;
        }
    }

    static async getAllTokens() {
        try {
            logger.debug('Récupération de tous les tokens depuis SQLite');

            // Récupérer tous les tokens (actifs et inactifs) depuis SQLite
            const tokens = sqliteManager.getAllTokens();
            
            logger.info(`${tokens.length} tokens trouvés dans SQLite`);
            
            return tokens.map(token => ({
                contract_address: token.contract_address,
                symbol: token.symbol,
                is_active: Boolean(token.is_active), // Convertir 1/0 en true/false
                created_at: token.created_at,
                updated_at: token.updated_at
            }));
        } catch (error) {
            logger.error('Erreur lors de la récupération des tokens depuis SQLite:', error);
            throw error;
        }
    }

    static async update(contractAddress, updates) {
        try {
            logger.debug('Tentative de mise à jour du token dans SQLite:', { contractAddress, updates });

            // Mise à jour uniquement dans SQLite (source principale)
            const success = sqliteManager.updateToken(contractAddress, updates);
            
            if (!success) {
                throw new Error('Token non trouvé pour la mise à jour');
            }

            // Vérifier la mise à jour
            const updatedToken = await this.findByAddress(contractAddress);
            logger.debug('Token après mise à jour:', updatedToken);

            return updatedToken;
        } catch (error) {
            logger.error('Erreur lors de la mise à jour du token:', error);
            throw error;
        }
    }

    static async tokenExists(contractAddress) {
        return sqliteManager.tokenExists(contractAddress);
    }

    static async getTokenCount() {
        return sqliteManager.getTokenCount();
    }

    // Méthode pour supprimer définitivement un token
    static async delete(contractAddress) {
        try {
            logger.debug('Tentative de suppression définitive du token:', contractAddress);

            // Supprimer définitivement de SQLite
            const success = sqliteManager.deleteToken(contractAddress);

            if (!success) {
                throw new Error('Token non trouvé pour la suppression');
            }

            logger.info(`Token supprimé définitivement: ${contractAddress}`);
            return true;
        } catch (error) {
            logger.error('Erreur lors de la suppression du token:', error);
            throw error;
        }
    }

    // Méthodes pour l'initialisation historique
    static getNextPendingInitialization() {
        return sqliteManager.getNextPendingInitialization();
    }

    static updateInitializationStatus(contractAddress, updates) {
        return sqliteManager.updateInitializationStatus(contractAddress, updates);
    }

    static getInitializationStats() {
        return sqliteManager.getInitializationStats();
    }

    // Alias pour compatibilité
    static async getByAddress(contractAddress) {
        return this.findByAddress(contractAddress);
    }
}

module.exports = TokenFinal;
