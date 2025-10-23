# Spécification : Système d'initialisation historique des tokens

## Vue d'ensemble

Système permettant d'initialiser automatiquement les données OHLCV historiques (1 mois) pour les nouveaux tokens via l'API GeckoTerminal, avec gestion d'une file d'attente et respect du rate limit (30 req/min).

---

## 1. Modifications de la base de données SQLite

### 1.1 Ajout du statut "initializing"

Modifier la table `tokens` pour ajouter un nouveau statut et des métadonnées d'initialisation :

```sql
-- Migration à ajouter dans src/db-init.js

ALTER TABLE tokens ADD COLUMN initialization_status TEXT DEFAULT 'pending';
ALTER TABLE tokens ADD COLUMN initialization_started_at INTEGER;
ALTER TABLE tokens ADD COLUMN initialization_completed_at INTEGER;
ALTER TABLE tokens ADD COLUMN initialization_progress INTEGER DEFAULT 0;
ALTER TABLE tokens ADD COLUMN initialization_error TEXT;
ALTER TABLE tokens ADD COLUMN main_pool_id TEXT;

-- Valeurs possibles pour initialization_status:
-- 'pending'      : En attente d'initialisation
-- 'in_progress'  : Initialisation en cours
-- 'completed'    : Initialisation terminée avec succès
-- 'failed'       : Échec de l'initialisation (réessayable)
-- 'skipped'      : Pas d'initialisation nécessaire (token ajouté manuellement par exemple)
```

### 1.2 Nouveau schéma complet de la table

```javascript
// src/db-init.js - Nouveau schéma

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_address TEXT UNIQUE NOT NULL,
    symbol TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_update INTEGER,

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
```

---

## 2. Architecture du système

### 2.1 Composants

```
┌─────────────────────────────────────────────────────────────┐
│                    API Routes (tokens.js)                    │
│  POST /api/tokens → Crée token avec status 'pending'        │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ↓
┌─────────────────────────────────────────────────────────────┐
│                SQLite Database (tokens table)                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Status: pending → in_progress → completed           │   │
│  │  Queue: Tous les tokens avec status = 'pending'      │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ↓
┌─────────────────────────────────────────────────────────────┐
│         HistoricalDataInitializer (nouveau service)          │
│  - Traite 1 token à la fois                                 │
│  - Respect du rate limit (30 req/min)                       │
│  - Retry automatique en cas d'échec                         │
│  - Logging détaillé de la progression                       │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ↓
┌─────────────────────────────────────────────────────────────┐
│              GeckoTerminal API Client                        │
│  - getMainPoolId(tokenAddress)                              │
│  - fetchOHLCVHistory(poolId, daysBack)                      │
│  - Gestion des erreurs 429 (rate limit)                     │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ↓
┌─────────────────────────────────────────────────────────────┐
│                  InfluxDB (raw_prices + ohlcv)               │
│  - Insertion des raw prices historiques                     │
│  - Construction des bougies OHLCV selon vos règles métier   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Flux de traitement

```
1. POST /api/tokens (BROWNHOUSE)
   ↓
2. Token créé avec initialization_status = 'pending'
   ↓
3. HistoricalDataInitializer détecte le nouveau token
   ↓
4. Change status → 'in_progress'
   ↓
5. Appel GeckoTerminal API:
   a. Récupère le pool principal (1 requête)
   b. Récupère l'historique OHLCV (44 requêtes pour 1 mois)
      → Pause de 2s entre chaque requête (rate limit)
   c. Stocke dans InfluxDB
   d. Construit les bougies OHLCV
   ↓
6. Change status → 'completed'
   ↓
7. Token devient 'active' et rejoint les collecteurs temps réel
```

---

## 3. Implémentation détaillée

### 3.1 Service HistoricalDataInitializer

**Fichier :** `src/services/HistoricalDataInitializer.js`

**Responsabilités :**
- Détecter les tokens en attente d'initialisation
- Traiter un token à la fois
- Respecter le rate limit (30 req/min)
- Gérer les erreurs et retry
- Mettre à jour le statut et la progression

**Configuration :**
```javascript
const config = {
  // Nombre de jours d'historique à récupérer
  HISTORICAL_DAYS: 30,

  // Délai entre chaque requête GeckoTerminal (2s = 30 req/min)
  REQUEST_DELAY_MS: 2000,

  // Intervalle de vérification de la queue (toutes les 10 secondes)
  QUEUE_CHECK_INTERVAL_MS: 10000,

  // Nombre de retry en cas d'échec
  MAX_RETRIES: 3,

  // Délai avant retry (en minutes)
  RETRY_DELAY_MINUTES: 5
};
```

**Pseudo-code :**
```javascript
class HistoricalDataInitializer {
  constructor() {
    this.isProcessing = false;
    this.currentToken = null;
    this.queueInterval = null;
  }

  start() {
    // Vérifier la queue toutes les 10 secondes
    this.queueInterval = setInterval(async () => {
      await this.processQueue();
    }, config.QUEUE_CHECK_INTERVAL_MS);
  }

  async processQueue() {
    // Si déjà en train de traiter un token, skip
    if (this.isProcessing) {
      logger.debug('Traitement en cours, skip');
      return;
    }

    // Récupérer le prochain token en attente
    const token = await Token.getNextPendingInitialization();

    if (!token) {
      logger.debug('Aucun token en attente d\'initialisation');
      return;
    }

    // Traiter le token
    this.isProcessing = true;
    this.currentToken = token;

    try {
      await this.initializeToken(token);
    } catch (error) {
      logger.error(`Erreur lors de l'initialisation de ${token.symbol}:`, error);
    } finally {
      this.isProcessing = false;
      this.currentToken = null;
    }
  }

  async initializeToken(token) {
    logger.info(`🚀 Début initialisation historique: ${token.symbol} (${token.contract_address})`);

    // 1. Marquer comme "in_progress"
    await Token.updateInitializationStatus(token.contract_address, {
      initialization_status: 'in_progress',
      initialization_started_at: Date.now(),
      initialization_progress: 0,
      initialization_error: null
    });

    try {
      // 2. Récupérer le pool principal (1 requête)
      logger.info(`Recherche du pool principal pour ${token.symbol}...`);
      const poolId = await this.geckoTerminalClient.getMainPoolId(token.contract_address);

      await Token.update(token.contract_address, { main_pool_id: poolId });
      logger.info(`✅ Pool trouvé: ${poolId}`);

      // 3. Récupérer l'historique OHLCV (44 requêtes avec rate limit)
      logger.info(`Récupération de ${config.HISTORICAL_DAYS} jours d'historique...`);

      const onProgress = (current, total) => {
        const progress = Math.floor((current / total) * 100);
        Token.updateInitializationStatus(token.contract_address, {
          initialization_progress: progress
        });
        logger.info(`📊 Progression ${token.symbol}: ${current}/${total} requêtes (${progress}%)`);
      };

      const candles = await this.geckoTerminalClient.fetchOHLCVHistory(
        poolId,
        config.HISTORICAL_DAYS,
        onProgress
      );

      logger.info(`✅ ${candles.length} candles récupérées pour ${token.symbol}`);

      // 4. Stocker dans InfluxDB et construire les bougies
      await this.storeHistoricalData(token, candles);

      // 5. Marquer comme "completed"
      await Token.updateInitializationStatus(token.contract_address, {
        initialization_status: 'completed',
        initialization_completed_at: Date.now(),
        initialization_progress: 100,
        historical_data_start_date: candles[candles.length - 1][0], // Plus ancien
        historical_data_end_date: candles[0][0] // Plus récent
      });

      logger.info(`✅ Initialisation terminée avec succès: ${token.symbol}`);

    } catch (error) {
      // Gérer l'échec
      logger.error(`❌ Échec initialisation ${token.symbol}:`, error);

      await Token.updateInitializationStatus(token.contract_address, {
        initialization_status: 'failed',
        initialization_error: error.message,
        initialization_progress: 0
      });

      // TODO: Implémenter retry automatique après X minutes
    }
  }

  async storeHistoricalData(token, candles) {
    logger.info(`Stockage de ${candles.length} candles dans InfluxDB...`);

    // Les candles GeckoTerminal sont au format:
    // [timestamp, open, high, low, close, volume]

    // Étape 1: Stocker les raw prices (pour cohérence avec le système existant)
    for (const candle of candles) {
      const [timestamp, open, high, low, close, volume] = candle;

      await writeRawPrice({
        token_address: token.contract_address,
        symbol: token.symbol,
        price: close, // Prix de clôture
        timestamp: new Date(timestamp * 1000)
      });
    }

    logger.info(`✅ Raw prices stockées`);

    // Étape 2: Construire les bougies OHLCV selon vos règles métier
    // Regrouper par timeframe (1m, 5m, 15m, 1h, 4h, 1d)
    await this.buildOHLCVCandles(token, candles);

    logger.info(`✅ Bougies OHLCV construites`);
  }

  async buildOHLCVCandles(token, rawCandles) {
    const timeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];

    for (const timeframe of timeframes) {
      logger.info(`Construction des bougies ${timeframe} pour ${token.symbol}...`);

      // Agréger les candles minute selon le timeframe
      const aggregatedCandles = this.aggregateCandles(rawCandles, timeframe);

      // Calculer RSI et EMA pour chaque bougie
      for (let i = 0; i < aggregatedCandles.length; i++) {
        const candle = aggregatedCandles[i];

        // Calculer RSI et EMA avec l'historique précédent
        const previousCandles = aggregatedCandles.slice(0, i);
        const { rsi, rsi_quality } = this.calculateRSI([...previousCandles, candle]);
        const ema = this.calculateEMA([...previousCandles, candle].map(c => c.close));

        // Stocker dans InfluxDB
        await writeOHLCV({
          token_address: token.contract_address,
          symbol: token.symbol,
          timeframe,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          quality_factor: 1.0, // Données historiques = qualité maximale
          timestamp: new Date(candle.timestamp * 1000),
          rsi: rsi || null,
          rsi_quality: rsi_quality || 0,
          ema: ema || null
        });
      }

      logger.info(`✅ ${aggregatedCandles.length} bougies ${timeframe} créées`);
    }
  }

  aggregateCandles(minuteCandles, timeframe) {
    // Convertir timeframe en minutes
    const timeframeMinutes = {
      '1m': 1,
      '5m': 5,
      '15m': 15,
      '1h': 60,
      '4h': 240,
      '1d': 1440
    }[timeframe];

    // Regrouper les candles par période
    const aggregated = [];
    const candlesByPeriod = {};

    for (const candle of minuteCandles) {
      const [timestamp, open, high, low, close, volume] = candle;

      // Arrondir le timestamp à la période
      const periodStart = Math.floor(timestamp / (timeframeMinutes * 60)) * (timeframeMinutes * 60);

      if (!candlesByPeriod[periodStart]) {
        candlesByPeriod[periodStart] = [];
      }

      candlesByPeriod[periodStart].push({ timestamp, open, high, low, close, volume });
    }

    // Agréger chaque période
    for (const [periodStart, candles] of Object.entries(candlesByPeriod)) {
      aggregated.push({
        timestamp: parseInt(periodStart),
        open: candles[0].open,
        high: Math.max(...candles.map(c => c.high)),
        low: Math.min(...candles.map(c => c.low)),
        close: candles[candles.length - 1].close,
        volume: candles.reduce((sum, c) => sum + c.volume, 0)
      });
    }

    return aggregated.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Réutiliser les méthodes existantes de CandleBuilder
  calculateRSI(candles) {
    // Copier la logique de src/services/CandleBuilder.js
    // ...
  }

  calculateEMA(prices) {
    // Copier la logique de src/services/CandleBuilder.js
    // ...
  }

  stop() {
    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }
    logger.info('HistoricalDataInitializer arrêté');
  }
}

module.exports = HistoricalDataInitializer;
```

---

### 3.2 Client GeckoTerminal API

**Fichier :** `src/clients/GeckoTerminalClient.js`

```javascript
const fetch = require('cross-fetch');
const logger = require('../config/logger');

class GeckoTerminalClient {
  constructor() {
    this.baseUrl = 'https://api.geckoterminal.com/api/v2';
    this.requestDelay = 2000; // 2 secondes = 30 req/min
    this.lastRequestTime = 0;
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async rateLimitedRequest(url) {
    // Respecter le rate limit (30 req/min = 1 req/2s)
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.requestDelay) {
      const waitTime = this.requestDelay - timeSinceLastRequest;
      logger.debug(`Rate limit: attente de ${waitTime}ms...`);
      await this.sleep(waitTime);
    }

    this.lastRequestTime = Date.now();

    const response = await fetch(url);

    if (response.status === 429) {
      logger.warn('Rate limit 429 atteint, attente de 60 secondes...');
      await this.sleep(60000);
      return this.rateLimitedRequest(url); // Retry
    }

    if (!response.ok) {
      throw new Error(`GeckoTerminal API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async getMainPoolId(tokenAddress) {
    logger.debug(`Recherche du pool principal pour ${tokenAddress}...`);

    const url = `${this.baseUrl}/networks/solana/tokens/${tokenAddress}`;
    const data = await this.rateLimitedRequest(url);

    if (!data.data || !data.data.relationships || !data.data.relationships.top_pools) {
      throw new Error(`Aucun pool trouvé pour le token ${tokenAddress}`);
    }

    const topPools = data.data.relationships.top_pools.data;

    if (topPools.length === 0) {
      throw new Error(`Aucun pool actif pour le token ${tokenAddress}`);
    }

    // Retourner le pool principal (le plus liquide)
    const mainPoolId = topPools[0].id.replace('solana_', '');

    logger.debug(`Pool principal trouvé: ${mainPoolId}`);
    return mainPoolId;
  }

  async fetchOHLCVHistory(poolId, daysBack = 30, onProgress = null) {
    logger.info(`Récupération de ${daysBack} jours d'historique pour le pool ${poolId}...`);

    const allCandles = [];
    let beforeTimestamp = Math.floor(Date.now() / 1000);
    const targetTimestamp = beforeTimestamp - (daysBack * 24 * 60 * 60);

    const minutesNeeded = daysBack * 24 * 60;
    const requestsNeeded = Math.ceil(minutesNeeded / 1000);
    let requestCount = 0;

    while (beforeTimestamp > targetTimestamp) {
      const url = `${this.baseUrl}/networks/solana/pools/${poolId}/ohlcv/minute?aggregate=1&before_timestamp=${beforeTimestamp}&limit=1000`;

      logger.debug(`Requête ${requestCount + 1}/${requestsNeeded}: ${url}`);

      const data = await this.rateLimitedRequest(url);
      const candles = data.data.attributes.ohlcv_list;

      if (candles.length === 0) {
        logger.info(`Plus de données historiques disponibles (${allCandles.length} candles récupérées)`);
        break;
      }

      allCandles.push(...candles);
      beforeTimestamp = candles[candles.length - 1][0]; // Dernier timestamp de ce batch
      requestCount++;

      // Callback de progression
      if (onProgress) {
        onProgress(requestCount, requestsNeeded);
      }

      logger.debug(`${candles.length} candles récupérées, total: ${allCandles.length}`);
    }

    logger.info(`✅ Récupération terminée: ${allCandles.length} candles sur ${(allCandles.length / 60 / 24).toFixed(1)} jours`);

    return allCandles.reverse(); // Du plus ancien au plus récent
  }
}

module.exports = GeckoTerminalClient;
```

---

### 3.3 Modifications du modèle Token

**Fichier :** `src/models/Token.js`

Ajouter les méthodes suivantes :

```javascript
// Récupérer le prochain token en attente d'initialisation
static getNextPendingInitialization() {
  const db = sqliteManager.getDb();
  const stmt = db.prepare(`
    SELECT * FROM tokens
    WHERE initialization_status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `);
  return stmt.get();
}

// Mettre à jour le statut d'initialisation
static updateInitializationStatus(address, updates) {
  const db = sqliteManager.getDb();

  const fields = [];
  const values = [];

  Object.entries(updates).forEach(([key, value]) => {
    fields.push(`${key} = ?`);
    values.push(value);
  });

  values.push(address);

  const stmt = db.prepare(`
    UPDATE tokens
    SET ${fields.join(', ')}
    WHERE contract_address = ?
  `);

  stmt.run(...values);
  logger.debug(`Token ${address} mis à jour:`, updates);
}

// Récupérer les statistiques d'initialisation
static getInitializationStats() {
  const db = sqliteManager.getDb();
  const stmt = db.prepare(`
    SELECT
      initialization_status,
      COUNT(*) as count
    FROM tokens
    GROUP BY initialization_status
  `);
  return stmt.all();
}
```

---

### 3.4 Modifications des routes

**Fichier :** `src/routes/tokens.js`

Modifier la route POST pour créer le token en mode "initializing" :

```javascript
// POST /api/tokens - Ajoute un nouveau token
router.post('/',
    [/* ... validations ... */],
    validate,
    async (req, res) => {
        try {
            const { contract_address, symbol } = req.body;
            logger.info('POST /tokens - Tentative d\'ajout:', { contract_address, symbol });

            // Vérifier si le token existe déjà
            const existingToken = await Token.findByAddress(contract_address);
            if (existingToken) {
                logger.info('POST /tokens - Token existant:', existingToken);
                return res.status(409).json({
                    status: 'error',
                    message: 'Ce token existe déjà'
                });
            }

            // Créer le nouveau token avec status 'pending'
            const newToken = await Token.create(contract_address, symbol, {
                initialization_status: 'pending' // ⬅️ NOUVEAU
            });

            // NE PAS ajouter aux collecteurs temps réel tout de suite
            // Ils seront ajoutés automatiquement après l'initialisation

            logger.info('POST /tokens - Token créé, initialisation historique en attente:', newToken);
            res.status(201).json({
                status: 'success',
                message: 'Token ajouté avec succès. Initialisation historique en cours...',
                data: newToken
            });

        } catch (error) {
            logger.error('POST /tokens - Erreur:', error);
            res.status(500).json({
                status: 'error',
                message: 'Erreur lors de la création du token',
                error: error.message
            });
        }
    }
);
```

**Nouvelle route pour suivre la progression :**

```javascript
// GET /api/tokens/:address/initialization-status
router.get('/:address/initialization-status', async (req, res) => {
    try {
        const { address } = req.params;

        const token = await Token.findByAddress(address);

        if (!token) {
            return res.status(404).json({
                status: 'error',
                message: 'Token non trouvé'
            });
        }

        res.json({
            status: 'success',
            data: {
                initialization_status: token.initialization_status,
                initialization_progress: token.initialization_progress,
                initialization_started_at: token.initialization_started_at,
                initialization_completed_at: token.initialization_completed_at,
                initialization_error: token.initialization_error,
                historical_data_start_date: token.historical_data_start_date,
                historical_data_end_date: token.historical_data_end_date
            }
        });

    } catch (error) {
        logger.error('GET /tokens/:address/initialization-status - Erreur:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erreur lors de la récupération du statut'
        });
    }
});
```

---

### 3.5 Intégration dans index.js

**Fichier :** `src/index.js`

```javascript
const HistoricalDataInitializer = require('./services/HistoricalDataInitializer');

// Création de l'instance
const historicalInitializer = new HistoricalDataInitializer();

// Démarrage après l'initialisation des collecteurs
async function initializeCollectors() {
    try {
        // ... code existant ...

        // Démarrer l'initialisateur historique
        logger.info('Démarrage du HistoricalDataInitializer...');
        await historicalInitializer.start();

        logger.info('Collecteurs initialisés avec succès');
    } catch (error) {
        logger.error('Erreur lors de l\'initialisation des collecteurs:', error);
        process.exit(1);
    }
}

// Gestion de l'arrêt propre
process.on('SIGTERM', () => {
    // ... code existant ...

    // Arrêter l'initialisateur
    historicalInitializer.stop();

    // ... code existant ...
});
```

---

## 4. Gestion des tokens "completed"

### 4.1 Activation automatique après initialisation

Une fois l'initialisation terminée (`status = 'completed'`), ajouter automatiquement le token aux collecteurs temps réel :

```javascript
// Dans HistoricalDataInitializer.js, après avoir marqué comme 'completed'

// Activer le token et l'ajouter aux collecteurs
await Token.update(token.contract_address, { is_active: true });

// Récupérer la liste des tokens actifs
const activeTokens = await Token.getAllActive();

// Mettre à jour tous les collecteurs
if (priceCollector) {
  priceCollector.setTokens(activeTokens);
}
if (volumeCollector) {
  volumeCollector.setTokens(activeTokens);
}
if (candleBuilder) {
  candleBuilder.setTokens(activeTokens);
}

logger.info(`✅ Token ${token.symbol} activé et ajouté aux collecteurs temps réel`);
```

### 4.2 Requête pour ne récupérer que les tokens "active"

Modifier `Token.getAllActive()` pour ne retourner que les tokens avec `is_active = true` ET `initialization_status = 'completed'` :

```javascript
static getAllActive() {
  const db = sqliteManager.getDb();
  const stmt = db.prepare(`
    SELECT * FROM tokens
    WHERE is_active = 1
      AND (initialization_status = 'completed' OR initialization_status = 'skipped')
    ORDER BY created_at DESC
  `);
  return stmt.all();
}
```

---

## 5. Alternative : File RabbitMQ (si vraiment nécessaire)

### 5.1 Quand utiliser RabbitMQ ?

Uniquement si vous avez besoin de :
- **Haute disponibilité** : Plusieurs workers en parallèle
- **Scalabilité horizontale** : Ajouter des workers dynamiquement
- **Clustering** : Distribuer la charge sur plusieurs serveurs

### 5.2 Architecture avec RabbitMQ

```
┌────────────────────┐
│   API Routes       │
│  POST /tokens      │
└────────┬───────────┘
         │
         ↓
┌────────────────────┐         ┌────────────────────┐
│   RabbitMQ Queue   │ ──────> │  Worker 1          │
│  "token_init"      │         │  HistoricalInit    │
└────────────────────┘         └────────────────────┘
         │
         ├──────────────────────┬────────────────────┐
         ↓                      ↓                    ↓
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│  Worker 2          │  │  Worker 3          │  │  Worker N          │
│  HistoricalInit    │  │  HistoricalInit    │  │  HistoricalInit    │
└────────────────────┘  └────────────────────┘  └────────────────────┘
```

**docker-compose.yml :**
```yaml
services:
  rabbitmq:
    image: rabbitmq:3-management
    container_name: ohlcv-rabbitmq
    ports:
      - "5672:5672"   # AMQP
      - "15672:15672" # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: admin
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_PASSWORD}
    networks:
      - default
    restart: unless-stopped
```

**Coût supplémentaire :**
- Mémoire : ~150-200MB
- CPU : Léger overhead
- Complexité : Configuration, monitoring

---

## 6. Monitoring et observabilité

### 6.1 Logs

Tous les logs doivent être structurés avec le module `winston` existant :

```javascript
logger.info('📊 Initialisation historique démarrée', {
  token: token.symbol,
  address: token.contract_address,
  daysBack: 30
});

logger.info('⏳ Progression', {
  token: token.symbol,
  progress: '45%',
  candles: 12000,
  requestsCompleted: 20,
  requestsTotal: 44
});

logger.info('✅ Initialisation terminée', {
  token: token.symbol,
  candles: 26500,
  duration: '92s',
  dataRange: '2025-09-22 → 2025-10-22'
});
```

### 6.2 Dashboard (optionnel)

Créer une route pour afficher les statistiques :

```javascript
// GET /api/tokens/initialization-stats
router.get('/initialization-stats', async (req, res) => {
  const stats = await Token.getInitializationStats();

  res.json({
    status: 'success',
    data: {
      stats: stats,
      currentlyProcessing: historicalInitializer.currentToken || null
    }
  });
});
```

**Exemple de réponse :**
```json
{
  "status": "success",
  "data": {
    "stats": [
      { "initialization_status": "pending", "count": 3 },
      { "initialization_status": "in_progress", "count": 1 },
      { "initialization_status": "completed", "count": 18 },
      { "initialization_status": "failed", "count": 2 }
    ],
    "currentlyProcessing": {
      "symbol": "HARAMBE",
      "progress": 67
    }
  }
}
```

---

## 7. Gestion des erreurs et retry

### 7.1 Types d'erreurs

| Erreur | Cause | Action |
|--------|-------|--------|
| **429 Too Many Requests** | Rate limit dépassé | Attendre 60s et retry |
| **404 Not Found** | Token/pool introuvable | Marquer comme 'failed', ne pas retry |
| **Network error** | Timeout, DNS, etc. | Retry après 5 minutes |
| **InfluxDB error** | Écriture échouée | Retry après 1 minute |

### 7.2 Stratégie de retry

```javascript
const RETRY_CONFIG = {
  maxRetries: 3,
  retryDelayMinutes: 5,
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']
};

async initializeToken(token) {
  let retries = 0;

  while (retries < RETRY_CONFIG.maxRetries) {
    try {
      await this._doInitialize(token);
      return; // Succès

    } catch (error) {
      retries++;

      if (!this.isRetryable(error) || retries >= RETRY_CONFIG.maxRetries) {
        // Échec définitif
        await Token.updateInitializationStatus(token.contract_address, {
          initialization_status: 'failed',
          initialization_error: error.message
        });
        throw error;
      }

      // Retry
      const delayMs = RETRY_CONFIG.retryDelayMinutes * 60 * 1000;
      logger.warn(`Retry ${retries}/${RETRY_CONFIG.maxRetries} dans ${RETRY_CONFIG.retryDelayMinutes} minutes...`);
      await this.sleep(delayMs);
    }
  }
}

isRetryable(error) {
  return RETRY_CONFIG.retryableErrors.some(code => error.code === code);
}
```

---

## 8. Tests et validation

### 8.1 Test manuel

```bash
# 1. Ajouter un nouveau token
curl -X POST http://localhost:3002/api/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "contract_address": "AnR1qNfefHwL8GY7C4iqzBjJZyKzw6Z7N9kXY81bpump",
    "symbol": "BROWNHOUSE"
  }'

# 2. Vérifier le statut d'initialisation
curl http://localhost:3002/api/tokens/AnR1qNfefHwL8GY7C4iqzBjJZyKzw6Z7N9kXY81bpump/initialization-status

# 3. Surveiller les logs
docker logs -f ohlcv-api | grep -i "brownhouse\|initialisation"

# 4. Vérifier les données dans InfluxDB
# (via l'UI InfluxDB ou requête API)
```

### 8.2 Validation des données

Après initialisation, vérifier que :
- ✅ Les raw_prices sont présents dans InfluxDB
- ✅ Les bougies OHLCV sont créées pour tous les timeframes
- ✅ Le RSI et l'EMA sont calculés correctement
- ✅ Le token est actif et collecte en temps réel

---

## 9. Timeline d'implémentation (ce week-end)

### Samedi matin (2-3h)
1. ✅ Migration SQLite (ajout des colonnes)
2. ✅ Modification du modèle Token
3. ✅ Création du GeckoTerminalClient

### Samedi après-midi (3-4h)
4. ✅ Implémentation du HistoricalDataInitializer
5. ✅ Intégration dans index.js
6. ✅ Tests unitaires du client GeckoTerminal

### Dimanche matin (2-3h)
7. ✅ Modification des routes (POST /tokens)
8. ✅ Tests d'intégration avec un token réel
9. ✅ Debugging et ajustements

### Dimanche après-midi (1-2h)
10. ✅ Documentation finale
11. ✅ Monitoring et logs
12. ✅ Validation complète sur plusieurs tokens

**Total estimé : 8-12 heures**

---

## 10. Améliorations futures (post-MVP)

### Phase 2 (optionnel)
- 🔄 Ré-initialisation automatique si données incomplètes
- 📊 Dashboard de monitoring dans le frontend
- 🔔 Notifications Slack/Email en cas d'échec
- 🚀 Parallélisation (plusieurs tokens en même temps avec rate limit partagé)
- 💾 Cache des pool IDs dans Redis pour performances

### Phase 3 (si nécessaire)
- 🐰 Migration vers RabbitMQ pour haute disponibilité
- 📈 Métriques Prometheus pour observabilité
- 🔍 Healthcheck HTTP pour l'initialisateur
- 🌐 Support de multiples sources de données (Birdeye en fallback)

---

## 11. Conclusion

### Pourquoi cette architecture ?

✅ **Simple** : Pas de RabbitMQ, utilise SQLite déjà présent
✅ **Fiable** : Persistance des états, retry automatique
✅ **Performant** : Respect strict du rate limit, pas de blocage
✅ **Observable** : Logs structurés, progression trackable
✅ **Scalable** : Facile de passer à RabbitMQ plus tard si besoin

### Risques et mitigations

| Risque | Probabilité | Impact | Mitigation |
|--------|-------------|--------|------------|
| Rate limit dépassé | Faible | Moyen | Délai de 2s entre requêtes |
| Pool introuvable | Moyen | Faible | Marquer comme 'failed' |
| Données incomplètes | Moyen | Moyen | Logger l'historique réel disponible |
| Crash pendant init | Faible | Faible | Status 'in_progress' permet de reprendre |

---

**Auteur :** Claude Code
**Date :** 2025-10-22
**Version :** 1.0
