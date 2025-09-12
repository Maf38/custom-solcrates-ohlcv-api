const { InfluxDB } = require('@influxdata/influxdb-client');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Configuration InfluxDB
const token = process.env.INFLUXDB_TOKEN;
const url = 'http://localhost:8086'; // Utiliser localhost depuis l'extérieur du réseau Docker
const org = process.env.INFLUXDB_ORG || 'solcrates';
const bucket = process.env.INFLUXDB_BUCKET || 'ohlcv_data';

console.log('Configuration InfluxDB:');
console.log('URL:', url);
console.log('Org:', org);
console.log('Bucket:', bucket);
console.log('Token existe:', !!token);

const influxDB = new InfluxDB({ url, token });
const queryApi = influxDB.getQueryApi(org);

// Paramètres de test
const address = 'AnR1qNfefHwL8GY7C4iqzBjJZyKzw6Z7N9kXY81bpump'; // BROWNHOUSE
const currentTime = new Date('2025-09-12T19:00:00.000Z'); // Exemple de bougie
const endTime = new Date(currentTime);
endTime.setHours(endTime.getHours() + 1); // +1h

const rawQuery = `
    from(bucket: "${bucket}")
    |> range(start: ${currentTime.toISOString()}, stop: ${endTime.toISOString()})
    |> filter(fn: (r) => r["_measurement"] == "raw_prices")
    |> filter(fn: (r) => r["contract_address"] == "${address}")
    |> sort(columns: ["_time"], desc: false)
`;

console.log('\nRequête testée:');
console.log(rawQuery);
console.log('\nExécution de la requête...');

queryApi.collectRows(rawQuery)
    .then(rows => {
        console.log('\nRésultats:');
        console.log('Nombre de lignes:', rows.length);
        
        if (rows.length > 0) {
            console.log('\nPremières lignes:');
            rows.slice(0, 5).forEach((row, index) => {
                console.log(`${index + 1}:`, {
                    time: row._time,
                    value: row._value,
                    measurement: row._measurement,
                    contract_address: row.contract_address
                });
            });
        } else {
            console.log('Aucune donnée trouvée');
        }
    })
    .catch(error => {
        console.error('Erreur:', error);
    });
