const Database = require('better-sqlite3');
const path = require('path');
const logger = require('./logger');

class SQLiteManager {
    constructor() {
        this.db = null;
        this.dbPath = path.join(__dirname, '../../data/tokens.db');
    }

    initialize() {
        try {
            // Créer le répertoire data s'il n'existe pas
            const fs = require('fs');
            const dataDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            // Initialiser la base de données
            this.db = new Database(this.dbPath);
            
            // Activer les contraintes de clé étrangère
            this.db.pragma('foreign_keys = ON');
            
            // Créer la table des tokens si elle n'existe pas
            this.createTables();
            
            logger.info('SQLite initialisé avec succès');
            return true;
        } catch (error) {
            logger.error('Erreur lors de l\'initialisation SQLite:', error);
            throw error;
        }
    }

    createTables() {
        // Table principale des tokens
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tokens (
                contract_address TEXT PRIMARY KEY,
                symbol TEXT NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

                -- Nouveaux champs pour l'initialisation historique
                initialization_status TEXT DEFAULT 'pending',
                initialization_started_at INTEGER,
                initialization_completed_at INTEGER,
                initialization_progress INTEGER DEFAULT 0,
                initialization_error TEXT,
                main_pool_id TEXT,
                historical_data_start_date INTEGER,
                historical_data_end_date INTEGER
            )
        `);

        // Migrer les données existantes si nécessaire
        this.migrateExistingTokens();

        // Index pour améliorer les performances
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(is_active);
            CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON tokens(symbol);
            CREATE INDEX IF NOT EXISTS idx_tokens_init_status ON tokens(initialization_status);
        `);

        logger.info('Tables SQLite créées avec succès');
    }

    migrateExistingTokens() {
        try {
            // Vérifier si les nouvelles colonnes existent déjà
            const tableInfo = this.db.prepare("PRAGMA table_info(tokens)").all();
            const columnNames = tableInfo.map(col => col.name);

            if (!columnNames.includes('initialization_status')) {
                // Ajouter les nouvelles colonnes
                logger.info('Migration: ajout des colonnes d\'initialisation historique');

                this.db.exec(`
                    ALTER TABLE tokens ADD COLUMN initialization_status TEXT DEFAULT 'pending';
                    ALTER TABLE tokens ADD COLUMN initialization_started_at INTEGER;
                    ALTER TABLE tokens ADD COLUMN initialization_completed_at INTEGER;
                    ALTER TABLE tokens ADD COLUMN initialization_progress INTEGER DEFAULT 0;
                    ALTER TABLE tokens ADD COLUMN initialization_error TEXT;
                    ALTER TABLE tokens ADD COLUMN main_pool_id TEXT;
                    ALTER TABLE tokens ADD COLUMN historical_data_start_date INTEGER;
                    ALTER TABLE tokens ADD COLUMN historical_data_end_date INTEGER;
                `);

                // Marquer les tokens existants comme 'skipped' (pas besoin d'initialisation)
                this.db.exec(`
                    UPDATE tokens
                    SET initialization_status = 'skipped'
                    WHERE initialization_status = 'pending'
                `);

                logger.info('Migration terminée avec succès');
            }
        } catch (error) {
            logger.warn('Erreur lors de la migration (probablement déjà effectuée):', error.message);
        }
    }

    // Méthodes CRUD
    createToken(contractAddress, symbol, isActive = true) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO tokens (contract_address, symbol, is_active, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `);
        
        const result = stmt.run(contractAddress, symbol, isActive ? 1 : 0);
        return result.changes > 0;
    }

    getTokenByAddress(contractAddress) {
        const stmt = this.db.prepare(`
            SELECT contract_address, symbol, is_active, created_at, updated_at
            FROM tokens
            WHERE contract_address = ?
        `);
        
        return stmt.get(contractAddress);
    }

    getAllActiveTokens() {
        const stmt = this.db.prepare(`
            SELECT contract_address, symbol, is_active, created_at, updated_at
            FROM tokens
            WHERE is_active = 1
              AND (initialization_status = 'completed' OR initialization_status = 'skipped')
            ORDER BY symbol
        `);

        return stmt.all();
    }

    getAllTokens() {
        const stmt = this.db.prepare(`
            SELECT contract_address, symbol, is_active, created_at, updated_at
            FROM tokens
            ORDER BY symbol
        `);
        
        return stmt.all();
    }

    updateToken(contractAddress, updates) {
        const fields = [];
        const values = [];
        
        if (updates.symbol !== undefined) {
            fields.push('symbol = ?');
            values.push(updates.symbol);
        }
        
        if (updates.is_active !== undefined) {
            fields.push('is_active = ?');
            values.push(updates.is_active ? 1 : 0);
        }
        
        fields.push('updated_at = CURRENT_TIMESTAMP');
        
        const stmt = this.db.prepare(`
            UPDATE tokens
            SET ${fields.join(', ')}
            WHERE contract_address = ?
        `);
        
        values.push(contractAddress);
        const result = stmt.run(...values);
        return result.changes > 0;
    }

    deleteToken(contractAddress) {
        const stmt = this.db.prepare(`
            DELETE FROM tokens
            WHERE contract_address = ?
        `);
        
        const result = stmt.run(contractAddress);
        return result.changes > 0;
    }

    // Méthodes utilitaires
    tokenExists(contractAddress) {
        const stmt = this.db.prepare(`
            SELECT COUNT(*) as count
            FROM tokens
            WHERE contract_address = ?
        `);
        
        const result = stmt.get(contractAddress);
        return result.count > 0;
    }

    getTokenCount() {
        const stmt = this.db.prepare(`
            SELECT COUNT(*) as count
            FROM tokens
        `);

        return stmt.get().count;
    }

    // Méthodes pour l'initialisation historique
    getNextPendingInitialization() {
        const stmt = this.db.prepare(`
            SELECT *
            FROM tokens
            WHERE initialization_status = 'pending'
            ORDER BY created_at ASC
            LIMIT 1
        `);

        return stmt.get();
    }

    updateInitializationStatus(contractAddress, updates) {
        const fields = [];
        const values = [];

        Object.entries(updates).forEach(([key, value]) => {
            fields.push(`${key} = ?`);
            values.push(value);
        });

        if (fields.length === 0) {
            return false;
        }

        values.push(contractAddress);

        const stmt = this.db.prepare(`
            UPDATE tokens
            SET ${fields.join(', ')}
            WHERE contract_address = ?
        `);

        const result = stmt.run(...values);
        return result.changes > 0;
    }

    getInitializationStats() {
        const stmt = this.db.prepare(`
            SELECT
                initialization_status,
                COUNT(*) as count
            FROM tokens
            GROUP BY initialization_status
        `);

        return stmt.all();
    }

    close() {
        if (this.db) {
            this.db.close();
            logger.info('Connexion SQLite fermée');
        }
    }

    getDb() {
        return this.db;
    }
}

// Singleton
const sqliteManager = new SQLiteManager();

module.exports = sqliteManager;