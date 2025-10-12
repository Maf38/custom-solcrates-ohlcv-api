#!/usr/bin/env node

/**
 * Test pour vérifier la structure exacte des tokens retournés
 */

// Configurer les variables d'environnement avant d'importer les modules
process.env.INFLUXDB_URL = 'http://localhost:8086';
process.env.INFLUXDB_ADMIN_USER = 'admin';
process.env.INFLUXDB_ADMIN_PASSWORD = 'adminpassword123';
process.env.INFLUXDB_ORG = 'solcrates';
process.env.INFLUXDB_BUCKET = 'ohlcv_data';
process.env.INFLUXDB_TOKEN = 'test-token';
process.env.LOG_LEVEL = 'error'; // Réduire les logs

const Token = require('./src/models/Token');
const sqliteManager = require('./src/config/sqlite');

async function testTokenStructure() {
    console.log('🔍 Test de la structure des tokens retournés\n');

    try {
        // Initialiser SQLite
        sqliteManager.initialize();

        // Créer un token de test
        const testAddress = 'So11111111111111111111111111111111111111112';
        const testSymbol = 'SOL';
        
        // Nettoyer si existe
        try {
            await Token.delete(testAddress);
        } catch (e) {}

        // Créer le token
        await Token.create(testAddress, testSymbol);

        // Tester getAllActive()
        console.log('📋 Structure retournée par Token.getAllActive():');
        const activeTokens = await Token.getAllActive();
        console.log(JSON.stringify(activeTokens, null, 2));
        console.log('');

        // Tester findByAddress()
        console.log('🔎 Structure retournée par Token.findByAddress():');
        const foundToken = await Token.findByAddress(testAddress);
        console.log(JSON.stringify(foundToken, null, 2));
        console.log('');

        // Tester getAllTokens()
        console.log('📚 Structure retournée par Token.getAllTokens():');
        const allTokens = await Token.getAllTokens();
        console.log(JSON.stringify(allTokens, null, 2));
        console.log('');

        // Tester la structure brute SQLite
        console.log('🗄️  Structure brute SQLite:');
        const rawTokens = sqliteManager.getAllActiveTokens();
        console.log(JSON.stringify(rawTokens, null, 2));

        // Nettoyer
        await Token.delete(testAddress);

    } catch (error) {
        console.error('❌ Erreur:', error);
    } finally {
        sqliteManager.close();
    }
}

testTokenStructure();
