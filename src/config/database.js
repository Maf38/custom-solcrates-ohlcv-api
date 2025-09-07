const { InfluxDB } = require('@influxdata/influxdb-client');
const logger = require('./logger');

const url = process.env.INFLUXDB_URL || 'http://localhost:8086';
const token = process.env.INFLUXDB_TOKEN;
const org = process.env.INFLUXDB_ORG;
const bucket = process.env.INFLUXDB_BUCKET;

if (!token || !org || !bucket) {
    logger.error('Configuration InfluxDB manquante. Veuillez vérifier les variables d\'environnement.');
    process.exit(1);
}

const influxDB = new InfluxDB({ url, token });

// Client pour l'écriture
const writeApi = influxDB.getWriteApi(org, bucket, 'ns');

// Client pour la lecture
const queryApi = influxDB.getQueryApi(org);

logger.info('Connexion InfluxDB établie');
logger.debug('Configuration InfluxDB:', { url, org, bucket });

module.exports = {
    writeApi,
    queryApi
};