const { queryApi } = require('./src/config/influxdb');

async function testCandleQuery() {
    const contractAddress = 'Fch1oixTPri8zxBnmdCEADoJW2toyFHxqDZacQkwdvSP'; // HARAMBE
    const timeframe = '1m';
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = new Date();

    console.log('Testing candle query...');
    console.log('Contract:', contractAddress);
    console.log('Timeframe:', timeframe);
    console.log('Start:', startDate.toISOString());
    console.log('End:', endDate.toISOString());
    console.log('---');

    const query = `
        from(bucket: "${process.env.INFLUXDB_BUCKET}")
          |> range(start: ${startDate.toISOString()}, stop: ${endDate.toISOString()})
          |> filter(fn: (r) => r._measurement == "ohlcv_${timeframe}")
          |> filter(fn: (r) => r.contract_address == "${contractAddress}")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> keep(columns: ["_time", "quality_factor", "rsi_quality"])
    `;

    console.log('Query:', query);
    console.log('---');

    let count = 0;
    const results = [];

    return new Promise((resolve, reject) => {
        queryApi.queryRows(query, {
            next(row, tableMeta) {
                const obj = tableMeta.toObject(row);
                count++;
                if (count <= 5) {
                    results.push({
                        time: obj._time,
                        quality_factor: obj.quality_factor,
                        rsi_quality: obj.rsi_quality
                    });
                }
            },
            error(error) {
                console.error('❌ Query error:', error);
                reject(error);
            },
            complete() {
                console.log(`✅ Query completed: ${count} candles found`);
                if (results.length > 0) {
                    console.log('First 5 results:');
                    console.log(JSON.stringify(results, null, 2));
                }
                resolve(count);
            }
        });
    });
}

testCandleQuery()
    .then(() => {
        console.log('✅ Test completed');
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Test failed:', err);
        process.exit(1);
    });
