const { queryApi } = require('./src/config/influxdb');
const logger = require('./src/config/logger');

async function checkData() {
    try {
        // Vérifier les mesures disponibles
        const measuresQuery = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: -1h)
            |> distinct(column: "_measurement")
        `;
        const measures = await queryApi.collectRows(measuresQuery);
        logger.info('Mesures disponibles:', measures.map(m => m._value));

        // Vérifier les données raw_prices
        const pricesQuery = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: -1h)
            |> filter(fn: (r) => r["_measurement"] == "raw_prices")
            |> filter(fn: (r) => r["_field"] == "price")
            |> sort(columns: ["_time"])
        `;
        const prices = await queryApi.collectRows(pricesQuery);
        logger.info('Points de prix:', prices.map(p => ({
            time: p._time,
            value: p._value,
            token: p.token_address
        })));

        // Vérifier les données ohlcv
        const ohlcvQuery = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: -1h)
            |> filter(fn: (r) => r["_measurement"] == "ohlcv")
            |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        `;
        const ohlcv = await queryApi.collectRows(ohlcvQuery);
        logger.info('Nombre de bougies OHLCV:', ohlcv.length);
        if (ohlcv.length > 0) {
            logger.info('Dernière bougie:', ohlcv[ohlcv.length - 1]);
        }

        // Vérifier les tags utilisés
        const tagsQuery = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: -1h)
            |> keys()
            |> keep(columns: ["_value"])
            |> distinct()
        `;
        const tags = await queryApi.collectRows(tagsQuery);
        logger.info('Tags disponibles:', tags.map(t => t._value));

    } catch (error) {
        logger.error('Erreur:', error);
    }
}

checkData();