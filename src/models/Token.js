const { Point } = require('@influxdata/influxdb-client');
const { queryApi, writeApi } = require('../config/influxdb');
const logger = require('../config/logger');

class Token {
    static async create(contractAddress, symbol) {
        try {
            logger.debug('Tentative de création du token:', { contractAddress, symbol });

            const point = new Point('tokens')
                .tag('contract_address', contractAddress)
                .tag('symbol', symbol)
                .stringField('is_active', 'true')
                .timestamp(new Date());

            logger.debug('Point InfluxDB créé:', point);

            await writeApi.writePoint(point);
            logger.debug('Point écrit dans InfluxDB');

            await writeApi.flush();
            logger.debug('Données InfluxDB flushées');

            // Vérifier immédiatement que le token a été créé
            const createdToken = await this.findByAddress(contractAddress);
            logger.debug('Vérification post-création:', createdToken);

            if (!createdToken) {
                throw new Error('Token non trouvé après création');
            }

            logger.info(`Token créé avec succès: ${symbol} (${contractAddress})`);
            return createdToken;
        } catch (error) {
            logger.error('Erreur lors de la création du token:', error);
            throw error;
        }
    }

    static async findByAddress(contractAddress) {
        try {
            logger.debug('Recherche du token:', contractAddress);

            const query = `
                from(bucket: "${process.env.INFLUXDB_BUCKET}")
                |> range(start: -30d)
                |> filter(fn: (r) => r["_measurement"] == "tokens")
                |> filter(fn: (r) => r["contract_address"] == "${contractAddress}")
                |> filter(fn: (r) => r["_field"] == "is_active")
                |> last()
            `;

            logger.debug('Requête InfluxDB:', query);

            const result = await queryApi.collectRows(query);
            logger.debug('Résultat de la requête:', result);

            if (result.length === 0) {
                logger.debug('Token non trouvé');
                return null;
            }

            const token = {
                contract_address: contractAddress,
                symbol: result[0].symbol,
                is_active: result[0]._value === 'true'
            };

            logger.debug('Token trouvé:', token);
            return token;
        } catch (error) {
            logger.error('Erreur lors de la recherche du token:', error);
            throw error;
        }
    }

    static async getAllActive() {
        try {
            logger.debug('Récupération de tous les tokens actifs');

            const query = `
                from(bucket: "${process.env.INFLUXDB_BUCKET}")
                |> range(start: -30d)
                |> filter(fn: (r) => r["_measurement"] == "tokens")
                |> filter(fn: (r) => r["_field"] == "is_active")
                |> filter(fn: (r) => r["_value"] == "true")
                |> keep(columns: ["contract_address", "symbol", "_value"])
                |> group(columns: ["contract_address", "symbol"])
                |> last()
            `;

            logger.debug('Requête InfluxDB:', query);

            const results = await queryApi.collectRows(query);
            logger.debug('Résultats bruts:', results);

            if (!results || results.length === 0) {
                logger.warn('Aucun token actif trouvé dans la base de données');
                return [];
            }

            const tokens = results.map(row => ({
                contract_address: row.contract_address,
                symbol: row.symbol,
                is_active: true
            }));

            logger.info(`${tokens.length} tokens actifs trouvés:`, tokens);
            return tokens;
        } catch (error) {
            logger.error('Erreur lors de la récupération des tokens actifs:', error);
            throw error;
        }
    }

    static async update(contractAddress, updates) {
        try {
            logger.debug('Tentative de mise à jour du token:', { contractAddress, updates });

            // D'abord récupérer le token existant pour avoir le symbol
            const existingToken = await this.findByAddress(contractAddress);
            if (!existingToken) {
                logger.error('Token non trouvé pour la mise à jour:', contractAddress);
                throw new Error('Token non trouvé');
            }

            const point = new Point('tokens')
                .tag('contract_address', contractAddress)
                .tag('symbol', existingToken.symbol);

            // Ajouter les champs à mettre à jour
            if (updates.is_active !== undefined) {
                point.stringField('is_active', updates.is_active.toString());
            }

            point.timestamp(new Date());

            logger.debug('Point InfluxDB créé pour la mise à jour:', point);

            await writeApi.writePoint(point);
            logger.debug('Point écrit dans InfluxDB');

            await writeApi.flush();
            logger.debug('Données InfluxDB flushées');

            // Vérifier la mise à jour
            const updatedToken = await this.findByAddress(contractAddress);
            logger.debug('Token après mise à jour:', updatedToken);

            return updatedToken;
        } catch (error) {
            logger.error('Erreur lors de la mise à jour du token:', error);
            throw error;
        }
    }
}

module.exports = Token;