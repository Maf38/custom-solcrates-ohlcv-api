const { InfluxDB, Point } = require('@influxdata/influxdb-client');
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

/**
 * Écrit un point de prix brut dans InfluxDB
 * @param {Object} data Les données à écrire
 * @param {string} data.token_address L'adresse du token
 * @param {string} data.symbol Le symbole du token
 * @param {number} data.price Le prix du token
 */
async function writeRawPrice({ token_address, symbol, price }) {
    const point = new Point('raw_prices')
        .tag('contract_address', token_address)
        .tag('symbol', symbol)
        .floatField('price', price)
        .timestamp(new Date());
    
    await writeApi.writePoint(point);
}

/**
 * Écrit un point de volume brut dans InfluxDB
 * @param {Object} data Les données à écrire
 * @param {string} data.token_address L'adresse du token
 * @param {string} data.symbol Le symbole du token
 * @param {number} data.volume Le volume de la transaction
 * @param {Date} data.timestamp Le timestamp de la transaction
 */
async function writeRawVolume({ token_address, symbol, volume, timestamp }) {
    const point = new Point('raw_volumes')
        .tag('contract_address', token_address)
        .tag('symbol', symbol)
        .floatField('volume', volume)
        .timestamp(timestamp);
    
    await writeApi.writePoint(point);
}

/**
 * Écrit une bougie OHLCV dans InfluxDB
 * @param {Object} data Les données à écrire
 * @param {string} data.token_address L'adresse du token
 * @param {string} data.symbol Le symbole du token
 * @param {string} data.timeframe Le timeframe de la bougie (1m, 5m, 15m, 1h, 4h, 1d)
 * @param {number} data.open Prix d'ouverture
 * @param {number} data.high Prix le plus haut
 * @param {number} data.low Prix le plus bas
 * @param {number} data.close Prix de fermeture
 * @param {number} data.volume Volume total
 * @param {number} data.quality_factor Facteur de qualité des données (0-1)
 * @param {number|null} data.rsi RSI14 calculé (null si pas assez d'historique)
 * @param {number} data.rsi_quality Facteur de qualité du RSI (0-1)
 * @param {number|null} data.ema EMA14 calculé (null si pas assez d'historique)
 * @param {Date} data.timestamp Le timestamp de la bougie
 */
async function writeOHLCV({ token_address, symbol, timeframe, open, high, low, close, volume, quality_factor, rsi, rsi_quality, ema, timestamp }) {
    const point = new Point('ohlcv')
        .tag('contract_address', token_address)
        .tag('symbol', symbol)
        .tag('timeframe', timeframe)
        .floatField('open', open)
        .floatField('high', high)
        .floatField('low', low)
        .floatField('close', close)
        .floatField('volume', volume)
        .floatField('quality_factor', quality_factor)
        .floatField('rsi', rsi === null ? 0 : rsi)
        .floatField('rsi_quality', rsi_quality)
        .floatField('ema', ema === null ? 0 : ema)
        .timestamp(timestamp);
    
    await writeApi.writePoint(point);
}

module.exports = {
    writeApi,
    queryApi,
    writeRawPrice,
    writeRawVolume,
    writeOHLCV
};