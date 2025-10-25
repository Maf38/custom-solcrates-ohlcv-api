require('dotenv').config();
const GeckoTerminalClient = require('./src/clients/GeckoTerminalClient');
const fs = require('fs');

const client = new GeckoTerminalClient();

async function testFetchACT() {
    console.log('Test de récupération des données ACT depuis GeckoTerminal\n');
    console.log('='.repeat(80));

    const contractAddress = 'GJAFwWjJ3vnTsrQVabjBVK2TYB1YtRCQXRDfDgUnpump';
    const daysBack = 32;

    try {
        // 1. Récupérer le pool ID
        console.log(`\n1. Récupération du pool ID pour ACT...`);
        const poolId = await client.getMainPoolId(contractAddress);
        console.log(`   Pool ID: ${poolId}`);

        // 2. Récupérer l'historique
        console.log(`\n2. Récupération de ${daysBack} jours d'historique...`);
        console.log(`   Cela devrait faire ${daysBack * 24 * 60} candles (${Math.ceil(daysBack * 24 * 60 / 1000)} requêtes)\n`);

        const startTime = Date.now();
        let requestCount = 0;

        const onProgress = (current, total, progress) => {
            requestCount = current;
            console.log(`   📊 Requête ${current}/${total} (${progress}%)`);
        };

        const candles = await client.fetchOHLCVHistory(poolId, daysBack, onProgress);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`\n3. Résultats:`);
        console.log(`   ✅ ${candles.length} candles récupérées en ${duration}s`);
        console.log(`   ✅ ${requestCount} requêtes effectuées`);

        if (candles.length > 0) {
            const firstCandle = candles[0];
            const lastCandle = candles[candles.length - 1];
            const firstDate = new Date(firstCandle[0] * 1000);
            const lastDate = new Date(lastCandle[0] * 1000);
            const daysRetrieved = (candles.length / 60 / 24).toFixed(1);

            console.log(`\n4. Détails:`);
            console.log(`   Première bougie: ${firstDate.toISOString()}`);
            console.log(`   Dernière bougie: ${lastDate.toISOString()}`);
            console.log(`   Jours couverts: ~${daysRetrieved} jours`);
            console.log(`   Prix (première): O:${firstCandle[1]} H:${firstCandle[2]} L:${firstCandle[3]} C:${firstCandle[4]}`);
            console.log(`   Prix (dernière): O:${lastCandle[1]} H:${lastCandle[2]} L:${lastCandle[3]} C:${lastCandle[4]}`);
        }

        // 5. Écrire dans un fichier
        console.log(`\n5. Écriture dans le fichier...`);
        const outputData = {
            contractAddress,
            daysRequested: daysBack,
            requestsExpected: Math.ceil(daysBack * 24 * 60 / 1000),
            requestsActual: requestCount,
            candlesExpected: daysBack * 24 * 60,
            candlesReceived: candles.length,
            coveragePercent: ((candles.length / (daysBack * 24 * 60)) * 100).toFixed(2),
            duration: `${duration}s`,
            firstCandle: candles.length > 0 ? {
                timestamp: candles[0][0],
                date: new Date(candles[0][0] * 1000).toISOString(),
                open: candles[0][1],
                high: candles[0][2],
                low: candles[0][3],
                close: candles[0][4]
            } : null,
            lastCandle: candles.length > 0 ? {
                timestamp: candles[candles.length - 1][0],
                date: new Date(candles[candles.length - 1][0] * 1000).toISOString(),
                open: candles[candles.length - 1][1],
                high: candles[candles.length - 1][2],
                low: candles[candles.length - 1][3],
                close: candles[candles.length - 1][4]
            } : null,
            allCandles: candles.map(c => ({
                timestamp: c[0],
                date: new Date(c[0] * 1000).toISOString(),
                open: c[1],
                high: c[2],
                low: c[3],
                close: c[4],
                volume: c[5]
            }))
        };

        fs.writeFileSync('gecko-act-test-result.json', JSON.stringify(outputData, null, 2));
        console.log(`   ✅ Données écrites dans gecko-act-test-result.json`);

        // 6. Analyse par jour
        console.log(`\n6. Analyse par jour:`);
        const candlesByDay = {};
        candles.forEach(c => {
            const date = new Date(c[0] * 1000);
            const day = date.toISOString().split('T')[0];
            if (!candlesByDay[day]) {
                candlesByDay[day] = 0;
            }
            candlesByDay[day]++;
        });

        const days = Object.keys(candlesByDay).sort();
        console.log(`   Nombre de jours avec données: ${days.length}`);
        days.forEach(day => {
            const count = candlesByDay[day];
            const expected = 24 * 60; // 1440 candles par jour
            const percent = ((count / expected) * 100).toFixed(1);
            console.log(`   ${day}: ${count} candles (${percent}% de couverture)`);
        });

        fs.writeFileSync('gecko-act-days-analysis.json', JSON.stringify(candlesByDay, null, 2));
        console.log(`\n   ✅ Analyse par jour écrite dans gecko-act-days-analysis.json`);

        console.log('\n' + '='.repeat(80));
        console.log('Test terminé avec succès!\n');

    } catch (error) {
        console.error('\n❌ Erreur:', error.message);
        console.error(error.stack);
    }
}

testFetchACT();
