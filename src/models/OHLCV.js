const db = require('../config/database');

class OHLCV {
    static initTable() {
        const connection = db.getConnection();
        connection.exec(`
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
                rsi_14 DECIMAL,
                has_sufficient_data BOOLEAN DEFAULT false,
                FOREIGN KEY (contract_address) REFERENCES tokens(contract_address),
                UNIQUE(contract_address, timestamp, timeframe)
            );

            CREATE INDEX IF NOT EXISTS idx_ohlcv_contract_time 
            ON ohlcv(contract_address, timestamp);

            CREATE INDEX IF NOT EXISTS idx_ohlcv_timeframe 
            ON ohlcv(timeframe);
        `);
    }

    static create(data) {
        const connection = db.getConnection();
        try {
            connection.prepare('BEGIN TRANSACTION;').run();

            // Récupérer les 15 dernières bougies pour le calcul du RSI
            const previousCandles = this.getLatestByToken(
                data.contractAddress,
                data.timeframe,
                15
            );

            // Calculer le RSI si possible
            let rsi = null;
            let hasSufficientData = false;

            if (previousCandles.length >= 14) {
                const rsiData = this.calculateRSI14(previousCandles, data);
                rsi = rsiData.rsi;
                hasSufficientData = true;
            }

            const stmt = connection.prepare(`
                INSERT INTO ohlcv (
                    contract_address, timestamp, timeframe,
                    open, high, low, close, volume,
                    rsi_14, has_sufficient_data
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            const result = stmt.run(
                data.contractAddress,
                data.timestamp,
                data.timeframe,
                data.open,
                data.high,
                data.low,
                data.close,
                data.volume,
                rsi,
                hasSufficientData
            );

            connection.prepare('COMMIT;').run();
            return result;
        } catch (error) {
            connection.prepare('ROLLBACK;').run();
            throw error;
        }
    }

    static calculateRSI14(previousCandles, currentCandle) {
        // S'assurer que les données sont ordonnées chronologiquement
        const candles = [...previousCandles, currentCandle].sort(
            (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
        );

        // Calculer les variations de prix
        const changes = [];
        for (let i = 1; i < candles.length; i++) {
            changes.push(candles[i].close - candles[i-1].close);
        }

        // Pour le premier RSI (14 périodes initiales)
        if (previousCandles.length === 14) {
            const gains = changes.map(c => c > 0 ? c : 0);
            const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);

            const avgGain = gains.reduce((a, b) => a + b) / 14;
            const avgLoss = losses.reduce((a, b) => a + b) / 14;

            return {
                rsi: this.calculateRSIFromAverages(avgGain, avgLoss),
                avgGain,
                avgLoss
            };
        }

        // Pour les RSI suivants, utiliser le lissage exponentiel
        const prevRSI = previousCandles[previousCandles.length - 1].rsi_14;
        if (!prevRSI) {
            throw new Error('RSI précédent manquant');
        }

        const currentChange = changes[changes.length - 1];
        const currentGain = currentChange > 0 ? currentChange : 0;
        const currentLoss = currentChange < 0 ? Math.abs(currentChange) : 0;

        // Récupérer les moyennes précédentes
        const prevAvgGain = previousCandles[previousCandles.length - 1].avg_gain;
        const prevAvgLoss = previousCandles[previousCandles.length - 1].avg_loss;

        // Calculer les nouvelles moyennes avec le lissage exponentiel
        const avgGain = (prevAvgGain * 13 + currentGain) / 14;
        const avgLoss = (prevAvgLoss * 13 + currentLoss) / 14;

        return {
            rsi: this.calculateRSIFromAverages(avgGain, avgLoss),
            avgGain,
            avgLoss
        };
    }

    static calculateRSIFromAverages(avgGain, avgLoss) {
        if (avgLoss === 0) return 100;
        if (avgGain === 0) return 0;

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    static getLatestByToken(contractAddress, timeframe, limit = 100) {
        const connection = db.getConnection();
        const stmt = connection.prepare(`
            SELECT * FROM ohlcv 
            WHERE contract_address = ? AND timeframe = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `);
        return stmt.all(contractAddress, timeframe, limit);
    }
}

module.exports = OHLCV;