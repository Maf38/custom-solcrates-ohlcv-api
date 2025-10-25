const { queryApi } = require('./src/config/influxdb');

async function testAllMeasurements() {
    const contractAddress = 'Fch1oixTPri8zxBnmdCEADoJW2toyFHxqDZacQkwdvSP'; // HARAMBE

    console.log('Checking all measurements for HARAMBE...\n');

    // Test 1: Vérifier raw_prices
    console.log('=== TEST 1: raw_prices ===');
    const rawQuery = `
        from(bucket: "${process.env.INFLUXDB_BUCKET}")
          |> range(start: -30d)
          |> filter(fn: (r) => r._measurement == "raw_prices")
          |> filter(fn: (r) => r.contract_address == "${contractAddress}")
          |> count()
    `;

    let rawCount = 0;
    await new Promise((resolve, reject) => {
        queryApi.queryRows(rawQuery, {
            next(row, tableMeta) {
                const obj = tableMeta.toObject(row);
                rawCount = obj._value || 0;
            },
            error: reject,
            complete: resolve
        });
    });
    console.log(`Raw prices found: ${rawCount}\n`);

    // Test 2: Lister tous les measurements disponibles
    console.log('=== TEST 2: All measurements in bucket ===');
    const measurementsQuery = `
        import "influxdata/influxdb/schema"
        schema.measurements(bucket: "${process.env.INFLUXDB_BUCKET}")
    `;

    const measurements = [];
    await new Promise((resolve, reject) => {
        queryApi.queryRows(measurementsQuery, {
            next(row, tableMeta) {
                const obj = tableMeta.toObject(row);
                measurements.push(obj._value);
            },
            error: reject,
            complete: resolve
        });
    });
    console.log('All measurements:', measurements.join(', '), '\n');

    // Test 3: Pour chaque measurement ohlcv_*, compter les entrées HARAMBE
    console.log('=== TEST 3: HARAMBE candles per timeframe ===');
    const timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];

    for (const tf of timeframes) {
        const query = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
              |> range(start: -30d)
              |> filter(fn: (r) => r._measurement == "ohlcv_${tf}")
              |> filter(fn: (r) => r.contract_address == "${contractAddress}")
              |> count()
        `;

        let count = 0;
        await new Promise((resolve, reject) => {
            queryApi.queryRows(query, {
                next(row, tableMeta) {
                    const obj = tableMeta.toObject(row);
                    count = obj._value || 0;
                },
                error: reject,
                complete: resolve
            });
        });

        console.log(`  ${tf}: ${count} candles`);
    }
}

testAllMeasurements()
    .then(() => {
        console.log('\n✅ Test completed');
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Test failed:', err);
        process.exit(1);
    });
