const { InfluxDB, Point } = require('@influxdata/influxdb-client');
require('dotenv').config();

const url = 'http://localhost:8086';
const token = process.env.INFLUXDB_TOKEN;
const org = process.env.INFLUXDB_ORG;
const bucket = process.env.INFLUXDB_BUCKET;

console.log('Configuration InfluxDB:', { url, org, bucket });

const influxDB = new InfluxDB({ url, token });
const queryApi = influxDB.getQueryApi(org);
const writeApi = influxDB.getWriteApi(org, bucket, 'ns');

async function testConnection() {
    try {
        // 1. Test d'écriture
        console.log('\n=== Test d\'écriture ===');
        const point = new Point('test')
            .tag('test_tag', 'test_value')
            .stringField('test_field', 'test_data')
            .timestamp(new Date());

        await writeApi.writePoint(point);
        await writeApi.flush();
        console.log('Point de test écrit avec succès');

        // 2. Attendre un peu que les données soient disponibles
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 3. Vérifier que le point est lisible
        console.log('\n=== Vérification de lecture ===');
        const query = `
            from(bucket: "${bucket}")
            |> range(start: -1m)
            |> filter(fn: (r) => r["_measurement"] == "test")
        `;
        const results = await queryApi.collectRows(query);
        console.log('Données de test:', results);

        // 4. Vérifier les buckets disponibles
        console.log('\n=== Buckets disponibles ===');
        const bucketsApi = influxDB.getBucketsApi();
        const buckets = await bucketsApi.getBuckets();
        console.log('Buckets:', buckets.buckets.map(b => ({
            name: b.name,
            id: b.id,
            retentionRules: b.retentionRules
        })));

        // 5. Vérifier l'organisation
        console.log('\n=== Organisation ===');
        const orgsApi = influxDB.getOrgsApi();
        const orgs = await orgsApi.getOrgs();
        console.log('Organisations:', orgs.orgs.map(o => ({
            name: o.name,
            id: o.id
        })));

    } catch (error) {
        console.error('Erreur:', error);
    } finally {
        await writeApi.close();
    }
}

testConnection();