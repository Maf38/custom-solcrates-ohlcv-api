# Spécification : Système de Rattrapage de Données (Data Backfill)

## Vue d'ensemble

Système permettant de combler les lacunes de données historiques pour les tokens existants, en réutilisant l'infrastructure d'initialisation historique existante.

**Date** : 2025-10-24
**Version** : 1.0
**Statut** : 📋 Conception (à implémenter)

---

## 1. Cas d'usage

### 1.1 Scénarios nécessitant un rattrapage

| Scénario | Description | Priorité |
|----------|-------------|----------|
| **Panne système** | L'API était arrêtée pendant plusieurs heures/jours | 🔴 Haute |
| **Erreur de collecte** | Des données manquantes dues à des erreurs API | 🟠 Moyenne |
| **Token ajouté avant la feature** | Tokens existants sans historique (status 'skipped') | 🟡 Moyenne |
| **Extension d'historique** | Ajouter plus de 30 jours d'historique si disponible | 🟢 Basse |
| **Données corrompues** | Besoin de recharger une période spécifique | 🟠 Moyenne |

### 1.2 Exemple concret

**Situation** : L'API était en panne du 20 au 22 octobre (2 jours)

**Sans rattrapage** :
```
15 oct. ████████████
16 oct. ████████████
17 oct. ████████████
18 oct. ████████████
19 oct. ████████████
20 oct. ░░░░░░░░░░░░  ← Lacune
21 oct. ░░░░░░░░░░░░  ← Lacune
22 oct. ░░░░░░░░░░░░  ← Lacune
23 oct. ████████████
24 oct. ████████████
```

**Avec rattrapage** :
```
15 oct. ████████████
16 oct. ████████████
17 oct. ████████████
18 oct. ████████████
19 oct. ████████████
20 oct. ████████████  ← Rattrapé via GeckoTerminal
21 oct. ████████████  ← Rattrapé via GeckoTerminal
22 oct. ████████████  ← Rattrapé via GeckoTerminal
23 oct. ████████████
24 oct. ████████████
```

---

## 2. Architecture proposée

### 2.1 Réutilisation de l'existant

```
┌─────────────────────────────────────────────────────────────┐
│              GeckoTerminalClient (existant)                  │
│  - fetchOHLCVHistory(poolId, daysBack, onProgress)          │
│  - getMainPoolId(tokenAddress)                              │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ↓
┌─────────────────────────────────────────────────────────────┐
│         HistoricalDataInitializer (existant)                 │
│  - storeHistoricalData(token, candles)                      │
│  - buildOHLCVCandles(token, rawCandles)                     │
│  - aggregateCandles(minuteCandles, timeframe)               │
│  - calculateRSI(candles)                                    │
│  - calculateEMA(prices)                                     │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ↓
┌─────────────────────────────────────────────────────────────┐
│           DataBackfillService (NOUVEAU)                      │
│  - detectGaps(tokenAddress, startDate, endDate)             │
│  - backfillToken(tokenAddress, startDate, endDate)          │
│  - backfillAllTokens(startDate, endDate)                    │
│  - getBackfillStatus(tokenAddress)                          │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Nouvelle table SQLite

```sql
-- Table pour tracker les opérations de rattrapage
CREATE TABLE IF NOT EXISTS backfill_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    start_date INTEGER NOT NULL,      -- Timestamp de début de la période à rattraper
    end_date INTEGER NOT NULL,        -- Timestamp de fin de la période à rattraper
    status TEXT DEFAULT 'pending',    -- 'pending', 'in_progress', 'completed', 'failed'
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    started_at INTEGER,
    completed_at INTEGER,
    progress INTEGER DEFAULT 0,
    candles_filled INTEGER DEFAULT 0,
    error_message TEXT,
    FOREIGN KEY (token_address) REFERENCES tokens(contract_address)
);

CREATE INDEX idx_backfill_status ON backfill_jobs(status);
CREATE INDEX idx_backfill_token ON backfill_jobs(token_address);
```

---

## 3. Détection des lacunes

### 3.1 Algorithme de détection

```javascript
async function detectGaps(tokenAddress, startDate, endDate) {
    // 1. Requête InfluxDB pour obtenir toutes les bougies 1m de la période
    const query = `
        from(bucket: "${bucket}")
        |> range(start: ${startDate}, stop: ${endDate})
        |> filter(fn: (r) => r["_measurement"] == "ohlcv")
        |> filter(fn: (r) => r.contract_address == "${tokenAddress}")
        |> filter(fn: (r) => r.timeframe == "1m")
        |> keep(columns: ["_time"])
    `;

    const existingCandles = await queryInflux(query);

    // 2. Générer la liste complète des timestamps attendus (1 minute = 60s)
    const expectedTimestamps = [];
    for (let ts = startDate; ts < endDate; ts += 60) {
        expectedTimestamps.push(ts);
    }

    // 3. Identifier les timestamps manquants
    const existingTimestamps = new Set(existingCandles.map(c => c._time));
    const gaps = expectedTimestamps.filter(ts => !existingTimestamps.has(ts));

    // 4. Regrouper les lacunes consécutives en plages
    const gapRanges = groupConsecutiveGaps(gaps);

    return gapRanges; // [{start: timestamp, end: timestamp, duration: minutes}]
}

function groupConsecutiveGaps(gaps) {
    if (gaps.length === 0) return [];

    const ranges = [];
    let rangeStart = gaps[0];
    let rangeEnd = gaps[0];

    for (let i = 1; i < gaps.length; i++) {
        if (gaps[i] === rangeEnd + 60) {
            // Timestamp consécutif
            rangeEnd = gaps[i];
        } else {
            // Nouvelle plage
            ranges.push({
                start: rangeStart,
                end: rangeEnd,
                duration: (rangeEnd - rangeStart) / 60 + 1
            });
            rangeStart = gaps[i];
            rangeEnd = gaps[i];
        }
    }

    // Ajouter la dernière plage
    ranges.push({
        start: rangeStart,
        end: rangeEnd,
        duration: (rangeEnd - rangeStart) / 60 + 1
    });

    return ranges;
}
```

### 3.2 Exemple de détection

**Données existantes** :
```
10:00 ✅
10:01 ✅
10:02 ❌  ← Gap
10:03 ❌  ← Gap
10:04 ❌  ← Gap
10:05 ✅
10:06 ✅
10:07 ❌  ← Gap
10:08 ✅
```

**Résultat** :
```javascript
[
  { start: "10:02", end: "10:04", duration: 3 },  // Plage de 3 minutes
  { start: "10:07", end: "10:07", duration: 1 }   // Plage de 1 minute
]
```

---

## 4. Service DataBackfillService

### 4.1 Fichier : `src/services/DataBackfillService.js`

```javascript
const GeckoTerminalClient = require('../clients/GeckoTerminalClient');
const HistoricalDataInitializer = require('./HistoricalDataInitializer');
const Token = require('../models/Token');
const { queryApi } = require('../config/influxdb');
const logger = require('../config/logger');

class DataBackfillService {
    constructor() {
        this.geckoClient = new GeckoTerminalClient();
        this.historicalInit = new HistoricalDataInitializer();
        this.isProcessing = false;
        this.currentJob = null;
    }

    /**
     * Détecter les lacunes de données pour un token
     * @param {string} tokenAddress
     * @param {Date} startDate
     * @param {Date} endDate
     * @returns {Array} Liste des plages manquantes
     */
    async detectGaps(tokenAddress, startDate, endDate) {
        logger.info(`Détection des lacunes pour ${tokenAddress} entre ${startDate} et ${endDate}`);

        // Implémentation de l'algorithme ci-dessus
        // ...

        return gaps;
    }

    /**
     * Rattraper les données d'un token pour une période spécifique
     * @param {string} tokenAddress
     * @param {Date} startDate
     * @param {Date} endDate
     */
    async backfillToken(tokenAddress, startDate, endDate) {
        logger.info(`🔄 Rattrapage de données: ${tokenAddress} du ${startDate} au ${endDate}`);

        const token = await Token.findByAddress(tokenAddress);
        if (!token) {
            throw new Error('Token non trouvé');
        }

        // 1. Créer un job de rattrapage
        const jobId = await this.createBackfillJob(tokenAddress, startDate, endDate);

        try {
            // 2. Marquer comme en cours
            await this.updateJobStatus(jobId, 'in_progress', { started_at: Date.now() });

            // 3. Récupérer le pool ID (depuis SQLite si existe, sinon GeckoTerminal)
            let poolId = token.main_pool_id;
            if (!poolId) {
                poolId = await this.geckoClient.getMainPoolId(tokenAddress);
                await Token.updateInitializationStatus(tokenAddress, { main_pool_id: poolId });
            }

            // 4. Calculer le nombre de jours à récupérer
            const daysDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));

            // 5. Récupérer les données de GeckoTerminal
            logger.info(`Récupération de ${daysDiff} jours de données...`);

            const onProgress = (current, total) => {
                const progress = Math.floor((current / total) * 100);
                this.updateJobStatus(jobId, 'in_progress', { progress });
            };

            // Utiliser beforeTimestamp = endDate pour récupérer l'historique
            const candles = await this.geckoClient.fetchOHLCVHistory(
                poolId,
                daysDiff,
                onProgress
            );

            // 6. Filtrer les candles pour garder uniquement la période demandée
            const startTimestamp = Math.floor(startDate.getTime() / 1000);
            const endTimestamp = Math.floor(endDate.getTime() / 1000);

            const filteredCandles = candles.filter(candle => {
                const [timestamp] = candle;
                return timestamp >= startTimestamp && timestamp <= endTimestamp;
            });

            logger.info(`${filteredCandles.length} candles filtrées pour la période`);

            // 7. Détecter les données déjà existantes pour éviter les doublons
            const existingTimestamps = await this.getExistingTimestamps(
                tokenAddress,
                startDate,
                endDate
            );

            const newCandles = filteredCandles.filter(candle => {
                const [timestamp] = candle;
                return !existingTimestamps.has(timestamp);
            });

            logger.info(`${newCandles.length} nouvelles candles à insérer (${filteredCandles.length - newCandles.length} doublons évités)`);

            // 8. Stocker les données (réutilisation du code existant)
            if (newCandles.length > 0) {
                await this.historicalInit.storeHistoricalData(token, newCandles);
            }

            // 9. Marquer comme terminé
            await this.updateJobStatus(jobId, 'completed', {
                completed_at: Date.now(),
                progress: 100,
                candles_filled: newCandles.length
            });

            logger.info(`✅ Rattrapage terminé: ${newCandles.length} candles ajoutées`);

        } catch (error) {
            logger.error(`❌ Erreur lors du rattrapage:`, error);
            await this.updateJobStatus(jobId, 'failed', {
                error_message: error.message
            });
            throw error;
        }
    }

    /**
     * Rattraper les données de tous les tokens actifs
     * @param {Date} startDate
     * @param {Date} endDate
     */
    async backfillAllTokens(startDate, endDate) {
        const tokens = await Token.getAllActive();
        logger.info(`Rattrapage de ${tokens.length} tokens du ${startDate} au ${endDate}`);

        for (const token of tokens) {
            try {
                await this.backfillToken(token.contract_address, startDate, endDate);
            } catch (error) {
                logger.error(`Erreur pour ${token.symbol}:`, error);
                // Continue avec le prochain token
            }
        }

        logger.info(`✅ Rattrapage terminé pour tous les tokens`);
    }

    /**
     * Récupérer les timestamps déjà présents dans InfluxDB
     */
    async getExistingTimestamps(tokenAddress, startDate, endDate) {
        const query = `
            from(bucket: "${process.env.INFLUXDB_BUCKET}")
            |> range(start: ${startDate.toISOString()}, stop: ${endDate.toISOString()})
            |> filter(fn: (r) => r["_measurement"] == "raw_prices")
            |> filter(fn: (r) => r.contract_address == "${tokenAddress}")
            |> keep(columns: ["_time"])
        `;

        const results = await queryApi.collectRows(query);
        const timestamps = new Set(results.map(r => Math.floor(new Date(r._time).getTime() / 1000)));

        return timestamps;
    }

    /**
     * Créer un job de rattrapage
     */
    async createBackfillJob(tokenAddress, startDate, endDate) {
        const db = require('../config/sqlite').getDb();
        const stmt = db.prepare(`
            INSERT INTO backfill_jobs (token_address, start_date, end_date, status)
            VALUES (?, ?, ?, 'pending')
        `);

        const result = stmt.run(
            tokenAddress,
            Math.floor(startDate.getTime() / 1000),
            Math.floor(endDate.getTime() / 1000)
        );

        return result.lastInsertRowid;
    }

    /**
     * Mettre à jour le statut d'un job
     */
    async updateJobStatus(jobId, status, updates = {}) {
        const db = require('../config/sqlite').getDb();

        const fields = ['status = ?'];
        const values = [status];

        Object.entries(updates).forEach(([key, value]) => {
            fields.push(`${key} = ?`);
            values.push(value);
        });

        values.push(jobId);

        const stmt = db.prepare(`
            UPDATE backfill_jobs
            SET ${fields.join(', ')}
            WHERE id = ?
        `);

        stmt.run(...values);
    }

    /**
     * Obtenir le statut d'un job de rattrapage
     */
    async getBackfillStatus(tokenAddress) {
        const db = require('../config/sqlite').getDb();
        const stmt = db.prepare(`
            SELECT * FROM backfill_jobs
            WHERE token_address = ?
            ORDER BY created_at DESC
        `);

        return stmt.all(tokenAddress);
    }
}

module.exports = DataBackfillService;
```

---

## 5. Routes API

### 5.1 Fichier : `src/routes/backfill.js`

```javascript
const express = require('express');
const router = express.Router();
const DataBackfillService = require('../services/DataBackfillService');
const logger = require('../config/logger');

const backfillService = new DataBackfillService();

/**
 * POST /api/backfill/detect-gaps
 * Détecter les lacunes de données pour un token
 */
router.post('/detect-gaps', async (req, res) => {
    try {
        const { token_address, start_date, end_date } = req.body;

        const gaps = await backfillService.detectGaps(
            token_address,
            new Date(start_date),
            new Date(end_date)
        );

        res.json({
            status: 'success',
            data: {
                token_address,
                period: { start_date, end_date },
                gaps_found: gaps.length,
                gaps: gaps,
                total_missing_minutes: gaps.reduce((sum, g) => sum + g.duration, 0)
            }
        });
    } catch (error) {
        logger.error('Erreur détection lacunes:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * POST /api/backfill/token
 * Rattraper les données d'un token spécifique
 */
router.post('/token', async (req, res) => {
    try {
        const { token_address, start_date, end_date } = req.body;

        // Validation
        if (!token_address || !start_date || !end_date) {
            return res.status(400).json({
                status: 'error',
                message: 'Paramètres manquants: token_address, start_date, end_date requis'
            });
        }

        // Lancer le rattrapage en arrière-plan
        backfillService.backfillToken(
            token_address,
            new Date(start_date),
            new Date(end_date)
        ).catch(err => logger.error('Erreur rattrapage:', err));

        res.json({
            status: 'success',
            message: 'Rattrapage démarré en arrière-plan',
            data: {
                token_address,
                start_date,
                end_date
            }
        });
    } catch (error) {
        logger.error('Erreur lancement rattrapage:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * POST /api/backfill/all-tokens
 * Rattraper les données de tous les tokens actifs
 */
router.post('/all-tokens', async (req, res) => {
    try {
        const { start_date, end_date } = req.body;

        if (!start_date || !end_date) {
            return res.status(400).json({
                status: 'error',
                message: 'Paramètres manquants: start_date, end_date requis'
            });
        }

        // Lancer le rattrapage en arrière-plan
        backfillService.backfillAllTokens(
            new Date(start_date),
            new Date(end_date)
        ).catch(err => logger.error('Erreur rattrapage global:', err));

        res.json({
            status: 'success',
            message: 'Rattrapage global démarré en arrière-plan',
            data: { start_date, end_date }
        });
    } catch (error) {
        logger.error('Erreur lancement rattrapage global:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * GET /api/backfill/status/:token_address
 * Obtenir le statut des jobs de rattrapage pour un token
 */
router.get('/status/:token_address', async (req, res) => {
    try {
        const { token_address } = req.params;

        const jobs = await backfillService.getBackfillStatus(token_address);

        res.json({
            status: 'success',
            data: {
                token_address,
                jobs
            }
        });
    } catch (error) {
        logger.error('Erreur récupération statut:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * GET /api/backfill/jobs
 * Lister tous les jobs de rattrapage
 */
router.get('/jobs', async (req, res) => {
    try {
        const db = require('../config/sqlite').getDb();
        const stmt = db.prepare(`
            SELECT b.*, t.symbol
            FROM backfill_jobs b
            JOIN tokens t ON b.token_address = t.contract_address
            ORDER BY b.created_at DESC
            LIMIT 100
        `);

        const jobs = stmt.all();

        res.json({
            status: 'success',
            data: { jobs }
        });
    } catch (error) {
        logger.error('Erreur récupération jobs:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

module.exports = router;
```

---

## 6. Exemples d'utilisation

### 6.1 Détecter les lacunes

```bash
# Détecter les lacunes pour FROGG entre le 20 et le 24 octobre
curl -X POST http://localhost:3002/api/backfill/detect-gaps \
  -H "Content-Type: application/json" \
  -d '{
    "token_address": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "start_date": "2025-10-20T00:00:00Z",
    "end_date": "2025-10-24T00:00:00Z"
  }'

# Réponse :
{
  "status": "success",
  "data": {
    "token_address": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "period": {
      "start_date": "2025-10-20T00:00:00Z",
      "end_date": "2025-10-24T00:00:00Z"
    },
    "gaps_found": 2,
    "gaps": [
      {
        "start": 1729411200,
        "end": 1729584000,
        "duration": 2880
      },
      {
        "start": 1729670400,
        "end": 1729670460,
        "duration": 1
      }
    ],
    "total_missing_minutes": 2881
  }
}
```

### 6.2 Rattraper un token spécifique

```bash
# Rattraper les données de FROGG pour la période manquante
curl -X POST http://localhost:3002/api/backfill/token \
  -H "Content-Type: application/json" \
  -d '{
    "token_address": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "start_date": "2025-10-20T00:00:00Z",
    "end_date": "2025-10-22T23:59:59Z"
  }'

# Réponse :
{
  "status": "success",
  "message": "Rattrapage démarré en arrière-plan",
  "data": {
    "token_address": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "start_date": "2025-10-20T00:00:00Z",
    "end_date": "2025-10-22T23:59:59Z"
  }
}
```

### 6.3 Rattraper tous les tokens

```bash
# Rattraper tous les tokens actifs pour une panne de 2 jours
curl -X POST http://localhost:3002/api/backfill/all-tokens \
  -H "Content-Type: application/json" \
  -d '{
    "start_date": "2025-10-20T00:00:00Z",
    "end_date": "2025-10-22T23:59:59Z"
  }'

# Réponse :
{
  "status": "success",
  "message": "Rattrapage global démarré en arrière-plan",
  "data": {
    "start_date": "2025-10-20T00:00:00Z",
    "end_date": "2025-10-22T23:59:59Z"
  }
}
```

### 6.4 Suivre la progression

```bash
# Voir le statut des jobs de rattrapage pour un token
curl http://localhost:3002/api/backfill/status/ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon

# Réponse :
{
  "status": "success",
  "data": {
    "token_address": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "jobs": [
      {
        "id": 1,
        "token_address": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
        "start_date": 1729382400,
        "end_date": 1729641599,
        "status": "completed",
        "created_at": 1729756800,
        "started_at": 1729756801,
        "completed_at": 1729756925,
        "progress": 100,
        "candles_filled": 2880,
        "error_message": null
      }
    ]
  }
}

# Voir tous les jobs
curl http://localhost:3002/api/backfill/jobs
```

---

## 7. Gestion des doublons

### 7.1 Stratégie anti-doublons

**Problème** : Éviter d'insérer des données déjà présentes dans InfluxDB

**Solution** :
1. Avant l'insertion, requêter InfluxDB pour obtenir tous les timestamps existants de la période
2. Filtrer les nouvelles candles pour exclure celles déjà présentes
3. N'insérer que les candles manquantes

```javascript
// Pseudo-code
const existingTimestamps = await getExistingTimestamps(token, startDate, endDate);
const newCandles = fetchedCandles.filter(c => !existingTimestamps.has(c.timestamp));
await storeHistoricalData(token, newCandles);  // Insert uniquement les nouvelles
```

### 7.2 Gestion des conflits

Si des données existent déjà mais sont corrompues :

**Option 1 : Skip (défaut)**
```javascript
// Ignorer les timestamps existants
const newCandles = candles.filter(c => !existingTimestamps.has(c.timestamp));
```

**Option 2 : Overwrite (paramètre optionnel)**
```javascript
// Supprimer les anciennes données et réinsérer
await deleteCandles(token, startDate, endDate);
await storeHistoricalData(token, allCandles);
```

---

## 8. Limitations et considérations

### 8.1 Rate Limit GeckoTerminal

- **Limite** : 30 requêtes / minute
- **Impact** : Pour 30 jours d'historique = ~44 requêtes = ~2 minutes
- **Mitigation** : File d'attente si plusieurs tokens

### 8.2 Performance InfluxDB

- **Écriture** : ~9000 candles en quelques secondes
- **Lecture** : Détection des lacunes peut être lente sur de grandes périodes
- **Optimisation** : Limiter la détection à des périodes raisonnables (<90 jours)

### 8.3 Disponibilité des données

- **GeckoTerminal** : Historique limité (variable selon le token)
- **Token récent** : Peut ne pas avoir 30 jours d'historique
- **Solution** : Utiliser `fetchOHLCVHistory` qui s'arrête quand plus de données

### 8.4 Cohérence des données

- **RSI/EMA** : Calculés avec l'historique disponible
- **Quality Factor** : 1.0 pour les données de rattrapage (comme l'initialisation)
- **Gaps restants** : Certaines périodes peuvent rester manquantes si GeckoTerminal n'a pas les données

---

## 9. Tests recommandés

### 9.1 Tests unitaires

```javascript
describe('DataBackfillService', () => {
    describe('detectGaps', () => {
        it('devrait détecter une lacune de 3 minutes', async () => {
            const gaps = await service.detectGaps(token, start, end);
            expect(gaps).toHaveLength(1);
            expect(gaps[0].duration).toBe(3);
        });

        it('devrait regrouper les lacunes consécutives', async () => {
            const gaps = await service.detectGaps(token, start, end);
            expect(gaps[0].start).toBe(timestamp1);
            expect(gaps[0].end).toBe(timestamp5);
        });
    });

    describe('backfillToken', () => {
        it('devrait éviter les doublons', async () => {
            await service.backfillToken(token, start, end);
            const inserted = await getInsertedCount();
            expect(inserted).toBe(expectedNewCandles);
        });
    });
});
```

### 9.2 Tests d'intégration

1. **Scénario panne système**
   - Arrêter l'API pendant 2 heures
   - Redémarrer
   - Lancer le rattrapage
   - Vérifier que toutes les données sont présentes

2. **Scénario token existant**
   - Prendre un token avec status 'skipped'
   - Lancer le rattrapage sur 30 jours
   - Vérifier les données historiques

---

## 10. Timeline d'implémentation

### Phase 1 : Fondations (2-3h)
- ✅ Créer la table `backfill_jobs`
- ✅ Créer `DataBackfillService` de base
- ✅ Implémenter `detectGaps`
- ✅ Tests unitaires

### Phase 2 : Rattrapage simple (3-4h)
- ✅ Implémenter `backfillToken`
- ✅ Gestion des doublons
- ✅ Routes API `/detect-gaps` et `/token`
- ✅ Tests d'intégration

### Phase 3 : Rattrapage global (2-3h)
- ✅ Implémenter `backfillAllTokens`
- ✅ Queue management pour éviter rate limit
- ✅ Route `/all-tokens`
- ✅ Monitoring et logs

### Phase 4 : Interface & monitoring (2-3h)
- ✅ Route `/status` et `/jobs`
- ✅ Documentation README
- ✅ Exemples d'utilisation
- ✅ Tests en production

**Total estimé : 9-13 heures**

---

## 11. Améliorations futures (optionnel)

### 11.1 Détection automatique

Ajouter un cron job qui détecte automatiquement les lacunes :

```javascript
// Tous les jours à 3h00
cron.schedule('0 3 * * *', async () => {
    const yesterday = new Date(Date.now() - 24*60*60*1000);
    const today = new Date();

    const tokens = await Token.getAllActive();
    for (const token of tokens) {
        const gaps = await backfillService.detectGaps(token.contract_address, yesterday, today);
        if (gaps.length > 0) {
            logger.warn(`Lacunes détectées pour ${token.symbol}`);
            await backfillService.backfillToken(token.contract_address, yesterday, today);
        }
    }
});
```

### 11.2 Notifications

- Email/Slack quand des lacunes sont détectées
- Rapport quotidien de l'état des données
- Alertes si rattrapage échoue

### 11.3 Interface web

Dashboard pour :
- Visualiser les lacunes
- Lancer des rattrapages en un clic
- Voir l'historique des jobs

### 11.4 Modes avancés

- **Mode "preview"** : Détecter sans rattraper
- **Mode "dry-run"** : Simuler le rattrapage
- **Mode "aggressive"** : Overwrite les données existantes

---

## 12. Conclusion

### Avantages du système proposé

✅ **Réutilisation maximale** : 90% du code existant
✅ **Simplicité** : API REST intuitive
✅ **Flexibilité** : Token unique ou tous les tokens
✅ **Traçabilité** : Table `backfill_jobs` pour l'audit
✅ **Robustesse** : Gestion des doublons et erreurs
✅ **Performance** : Filtrage côté client pour éviter doublons

### Risques et mitigations

| Risque | Probabilité | Impact | Mitigation |
|--------|-------------|--------|------------|
| Rate limit dépassé | Moyenne | Moyen | Queue avec délais |
| Doublons dans InfluxDB | Faible | Faible | Vérification avant insert |
| Données GeckoTerminal manquantes | Élevée | Moyen | Logger et continuer |
| Performance InfluxDB | Faible | Moyen | Limiter période de détection |

---

**Auteur** : Claude Code
**Date de création** : 2025-10-24
**Dernière mise à jour** : 2025-10-24
**Statut** : 📋 Prêt pour implémentation
