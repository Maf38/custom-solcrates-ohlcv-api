const Database = require('better-sqlite3');
const path = require('path');

function initializeDatabase() {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/ohlcv.db');
    const db = new Database(dbPath);

    // Activer les foreign keys
    db.pragma('foreign_keys = ON');

    // Créer la table des tokens
    db.exec(`
        CREATE TABLE IF NOT EXISTS tokens (
            contract_address TEXT PRIMARY KEY,
            symbol TEXT NOT NULL,
            is_active BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_update TIMESTAMP
        );
    `);

    // Créer la table OHLCV
    db.exec(`
        CREATE TABLE IF NOT EXISTS ohlcv (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contract_address TEXT NOT NULL,
            timestamp TIMESTAMP NOT NULL,
            timeframe TEXT NOT NULL,
            open DECIMAL NOT NULL,
            high DECIMAL NOT NULL,
            low DECIMAL NOT NULL,
            close DECIMAL NOT NULL,
            volume DECIMAL NOT NULL,
            FOREIGN KEY (contract_address) REFERENCES tokens(contract_address),
            UNIQUE(contract_address, timestamp, timeframe)
        );
    `);

    // Créer les index
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ohlcv_contract_time 
        ON ohlcv(contract_address, timestamp);

        CREATE INDEX IF NOT EXISTS idx_ohlcv_timeframe 
        ON ohlcv(timeframe);
    `);

    return db;
}

module.exports = { initializeDatabase };

