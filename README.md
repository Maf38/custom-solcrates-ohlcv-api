# Custom Solcrates OHLCV API

API personnalisée pour la collecte et l'analyse des données OHLCV (Open, High, Low, Close, Volume) des tokens Solana.

## Configuration

### Variables d'environnement

Créez un fichier `.env` à la racine du projet avec les variables suivantes :

```env
# Server Configuration
PORT=3002

# Update Interval (in milliseconds)
UPDATE_INTERVAL=5000

# InfluxDB Configuration
INFLUXDB_URL=http://influxdb:8086
INFLUXDB_ADMIN_USER=admin
INFLUXDB_ADMIN_PASSWORD=adminpassword123
INFLUXDB_ORG=solcrates
INFLUXDB_BUCKET=ohlcv_data
INFLUXDB_TOKEN=my-super-secret-auth-token

# Logging Configuration
LOG_LEVEL=debug  # error, warn, info, http, verbose, debug, silly
LOG_FORMAT=json  # json ou simple
```

Ces variables sont utilisées à la fois pour :
- L'initialisation d'InfluxDB
- La configuration de l'API OHLCV
- La communication entre les services

⚠️ En production, utilisez des mots de passe et tokens sécurisés et ne les committez pas dans Git.

## Démarrage

1. Créez votre fichier `.env` basé sur le template ci-dessus
2. Démarrez les services :
   ```bash
   docker-compose up -d
   ```
3. Vérifiez que tout fonctionne :
   - Interface InfluxDB : http://localhost:8086
   - API OHLCV : http://localhost:3002
   - Documentation API : http://localhost:3002/api-docs

## Structure des données

### Measurements InfluxDB

1. `raw_prices`
   - Fields:
     * price: float
   - Tags:
     * token_address: string
     * symbol: string

2. `raw_volumes`
   - Fields:
     * volume: float
   - Tags:
     * token_address: string
     * symbol: string

3. `ohlcv`
   - Fields:
     * open: float
     * high: float
     * low: float
     * close: float
     * volume: float
     * quality_factor: float
     * rsi_14: float (optionnel)
   - Tags:
     * token_address: string
     * symbol: string
     * timeframe: string (1m, 5m, 15m, 1h, 4h, 1d)

## Mécanisme de mise à jour

1. **Données brutes** : 
   - Collecte toutes les X secondes (défini par UPDATE_INTERVAL)
   - Prix via Jupiter API V3
   - Volumes via Solana RPC

2. **Construction des bougies** :
   - Déclenchée à chaque minute
   - Utilise le modulo du timestamp pour déterminer quelles bougies construire
   - Exemple : 
     * Minute 0 : toutes les timeframes
     * Minute 5 : 1m, 5m
     * Minute 15 : 1m, 5m, 15m
     * etc.

3. **Facteur de qualité** :
   - Calculé pour chaque bougie
   - Représente le ratio de données disponibles vs attendues
   - Exemple pour 1m avec UPDATE_INTERVAL=5000 :
     * Attendu : 12 points (60s/5s)
     * Si 10 points disponibles : qualité = 0.83

## Calcul du RSI (Relative Strength Index)

### Méthode de Wilder

Le RSI14 est calculé selon la méthode originale de J. Welles Wilder (1978), qui utilise un **lissage exponentiel** plutôt qu'une simple moyenne mobile.

### ⚠️ Important : Pourquoi 30 périodes pour un RSI14 ?

Contrairement à l'intuition, un **RSI14 nécessite 30 périodes de données** pour être calculé correctement selon la méthode de Wilder :

1. **Périodes 1-14** : Calcul de la moyenne simple (SMA) initiale
   - `avgGain = somme(gains sur 14 périodes) / 14`
   - `avgLoss = somme(pertes sur 14 périodes) / 14`

2. **Périodes 15-30** : Application du lissage exponentiel de Wilder
   - `avgGain = ((avgGain_précédent × 13) + gain_actuel) / 14`
   - `avgLoss = ((avgLoss_précédent × 13) + perte_actuelle) / 14`

3. **Calcul final du RSI** :
   - `RS = avgGain / avgLoss`
   - `RSI = 100 - (100 / (1 + RS))`

### Exemples concrets

- **RSI14 sur 1h** : Nécessite 30 heures d'historique (30 bougies 1h)
- **RSI14 sur 4h** : Nécessite 120 heures d'historique (30 bougies 4h)
- **RSI14 sur 1d** : Nécessite 30 jours d'historique (30 bougies 1d)

### Facteur de qualité du RSI

Le `rsi_quality` reflète la fiabilité du calcul RSI :

- **Qualité = 100%** : 31 bougies disponibles (30 précédentes + actuelle), aucun gap
- **Qualité < 100%** : Pénalités appliquées si :
  - Moins de 31 bougies disponibles (ex: 20/31 = 64.5%)
  - Bougies manquantes détectées (gaps temporels)
  - Qualité individuelle des bougies faible

### Gestion des données insuffisantes

- **Minimum absolu** : 2 bougies (1 variation) → RSI calculé mais qualité très basse
- **Données partielles** : Si moins de 14 variations → utilise SMA simple (pas de lissage)
- **Données complètes** : 30+ variations → lissage de Wilder complet appliqué

## Architecture des données

### SQLite (Source de vérité pour les tokens)
- **Base de données** : `data/tokens.db`
- **Table principale** : `tokens` (contract_address, symbol, is_active, created_at, updated_at)
- **Rôle** : Détermine quels tokens sont suivis pour l'acquisition des données

### InfluxDB (Stockage des données temporelles)
- **Measurements** :
  - `raw_prices` : Prix bruts collectés
  - `raw_volumes` : Volumes bruts collectés  
  - `ohlcv` : Bougies OHLCV calculées avec RSI
- **Rôle** : Stockage pur des données temporelles, pas de logique métier

### Flux de données
1. **Ajout d'un token** → SQLite → Démarrage automatique de l'acquisition
2. **Acquisition** → Données brutes dans InfluxDB
3. **Construction des bougies** → Calcul OHLCV + RSI → InfluxDB
4. **API** → SQLite pour la liste des tokens, InfluxDB pour les données

## 🆕 Système d'Initialisation Historique

### Vue d'ensemble

Lorsqu'un nouveau token est ajouté, le système initialise **automatiquement** 30 jours de données historiques via l'API GeckoTerminal avant de démarrer la collecte en temps réel.

### Flux d'initialisation

```
1. POST /api/tokens (nouveau token)
   ↓
2. Status: 'pending' → Token créé mais pas encore actif
   ↓
3. HistoricalDataInitializer démarre
   - Recherche du pool principal sur GeckoTerminal
   - Téléchargement de 30 jours de bougies 1m (~43,200 bougies)
   - Respect du rate limit (30 req/min = 1 req/2s)
   ↓
4. Traitement des données historiques
   - Conversion des bougies en raw_prices (prix de clôture)
   - Agrégation pour tous les timeframes (1m, 5m, 15m, 1h, 4h, 1d)
   - Calcul du RSI et EMA pour chaque bougie
   ↓
5. Status: 'completed' → Token activé automatiquement
   ↓
6. Collecte en temps réel démarre
```

### Architecture des données historiques

#### Étape 1 : Récupération depuis GeckoTerminal
- **Format reçu** : Bougies 1 minute `[timestamp, open, high, low, close, volume]`
- **Quantité** : ~43,200 bougies pour 30 jours
- **Rate limit** : 30 requêtes/minute (2 secondes entre chaque requête)
- **Durée** : ~2-3 minutes pour récupérer tout l'historique

#### Étape 2 : Conversion en raw_prices
Pour chaque bougie 1m reçue :
```javascript
await writeRawPrice({
    token_address: "...",
    symbol: "...",
    price: close,  // Prix de clôture de la bougie
    timestamp: new Date(timestamp * 1000)
});
```

**Pourquoi ?** Maintenir la cohérence avec le système de collecte en temps réel qui utilise des raw_prices comme base.

#### Étape 3 : Construction des bougies OHLCV
Les bougies 1 minute sont agrégées pour créer tous les timeframes :

| Timeframe | Agrégation | Bougies créées (30j) |
|-----------|------------|---------------------|
| 1m | Directe | ~43,200 |
| 5m | 5 bougies 1m | ~8,640 |
| 15m | 15 bougies 1m | ~2,880 |
| 1h | 60 bougies 1m | ~720 |
| 4h | 240 bougies 1m | ~180 |
| 1d | 1,440 bougies 1m | ~30 |

Pour chaque bougie agrégée :
- **OHLC** : Open (première), High (max), Low (min), Close (dernière)
- **Volume** : Somme des volumes
- **RSI** : Calculé avec l'historique précédent (méthode de Wilder)
- **EMA** : Calculé avec l'historique précédent
- **Quality Factor** : 1.0 (données historiques = qualité maximale)

### États d'initialisation

| Status | Description |
|--------|-------------|
| `pending` | En attente de traitement |
| `in_progress` | Initialisation en cours |
| `completed` | Terminé avec succès, token actif |
| `failed` | Échec (erreur stockée) |
| `skipped` | Pas d'initialisation nécessaire (tokens existants) |

### Schéma de la table tokens

```sql
CREATE TABLE tokens (
    -- Colonnes de base
    contract_address TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- Colonnes d'initialisation historique
    initialization_status TEXT DEFAULT 'pending',
    initialization_started_at INTEGER,
    initialization_completed_at INTEGER,
    initialization_progress INTEGER DEFAULT 0,
    initialization_error TEXT,
    main_pool_id TEXT,
    historical_data_start_date INTEGER,
    historical_data_end_date INTEGER
);
```

### Configuration

Dans `src/services/HistoricalDataInitializer.js` :

```javascript
config = {
    HISTORICAL_DAYS: 30,              // Jours d'historique à récupérer
    REQUEST_DELAY_MS: 2000,           // Délai entre requêtes (rate limit)
    QUEUE_CHECK_INTERVAL_MS: 10000,   // Vérification de la queue
    MAX_RETRIES: 3,                   // Tentatives en cas d'échec
    RETRY_DELAY_MINUTES: 5            // Délai avant retry
};
```

### Gestion des erreurs

| Erreur | Action |
|--------|--------|
| 429 Too Many Requests | Attente de 60s puis retry automatique |
| 404 Pool Not Found | Status 'failed', pas de retry |
| Network timeout | Retry après 5 minutes (max 3 fois) |
| InfluxDB error | Retry après 1 minute |

## API Routes

Documentation complète disponible via Swagger UI : http://localhost:3002/api-docs

### Gestion des tokens

- `POST /api/tokens` : Ajouter un nouveau token (démarre l'initialisation historique puis l'acquisition)
- `GET /api/tokens` : Liste tous les tokens actifs (uniquement ceux avec status 'completed' ou 'skipped')
- `GET /api/tokens/all` : Liste tous les tokens (actifs et inactifs)
- `GET /api/tokens/:address` : Récupère un token spécifique
- `GET /api/tokens/:address/initialization-status` : Récupère le statut d'initialisation d'un token
- `GET /api/tokens/initialization-stats` : Récupère les statistiques globales d'initialisation
- `PATCH /api/tokens/:address/activate` : Réactive un token (reprend l'acquisition)
- `PATCH /api/tokens/:address/deactivate` : Désactive un token (arrête l'acquisition)
- `DELETE /api/tokens/:address` : Supprime définitivement un token (conserve les données InfluxDB)

### Données OHLCV

- `GET /api/ohlcv/:address/:timeframe` : Récupère les données OHLCV
- `GET /api/ohlcv/raw/:address` : Récupère les données brutes (prix + volume)

### Exemples d'utilisation

#### Ajouter un token et suivre l'initialisation

```bash
# 1. Ajouter le token
curl -X POST http://localhost:3002/api/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "contract_address": "AnR1qNfefHwL8GY7C4iqzBjJZyKzw6Z7N9kXY81bpump",
    "symbol": "BROWNHOUSE"
  }'

# 2. Vérifier le statut d'initialisation
curl http://localhost:3002/api/tokens/AnR1qNfefHwL8GY7C4iqzBjJZyKzw6Z7N9kXY81bpump/initialization-status

# Réponse :
{
  "status": "success",
  "data": {
    "initialization_status": "in_progress",
    "initialization_progress": 45,
    "initialization_started_at": 1729740000000,
    "initialization_completed_at": null,
    "initialization_error": null,
    "historical_data_start_date": null,
    "historical_data_end_date": null,
    "main_pool_id": "abc123..."
  }
}

# 3. Voir les statistiques globales
curl http://localhost:3002/api/tokens/initialization-stats

# Réponse :
{
  "status": "success",
  "data": {
    "stats": [
      { "initialization_status": "pending", "count": 2 },
      { "initialization_status": "in_progress", "count": 1 },
      { "initialization_status": "completed", "count": 15 },
      { "initialization_status": "failed", "count": 1 }
    ]
  }
}
```

#### Surveiller les logs

```bash
# Logs de l'initialisation historique
docker logs ohlcv-api -f | grep -i "initialisation\|historical"

# Exemple de logs :
# 🚀 Début initialisation historique: BROWNHOUSE (AnR1q...)
# Recherche du pool principal pour BROWNHOUSE...
# ✅ Pool trouvé: abc123...
# Récupération de 30 jours d'historique...
# 📊 Progression BROWNHOUSE: 10/44 requêtes (22%)
# 📊 Progression BROWNHOUSE: 20/44 requêtes (45%)
# ✅ 43200 candles récupérées pour BROWNHOUSE
# Stockage de 43200 candles dans InfluxDB...
# ✅ 43200 raw prices stockées
# Construction des bougies 1m pour BROWNHOUSE...
# ✅ 43200 bougies 1m créées
# Construction des bougies 5m pour BROWNHOUSE...
# ✅ 8640 bougies 5m créées
# ...
# ✅ Initialisation terminée avec succès: BROWNHOUSE
# ✅ Token BROWNHOUSE activé
# Mise à jour des collecteurs avec 16 tokens actifs
```

## Service de Backup Automatique

### 🔄 **Fonctionnement**

Le service de backup automatique sauvegarde quotidiennement vos données :

- **Horaire** : Tous les jours à 2h00 du matin
- **Rétention** : 30 jours (suppression automatique des anciens backups)
- **Localisation** : `/workspace/backupBDD/` sur l'hôte

### 📊 **Données sauvegardées**

1. **InfluxDB** : Toutes les données temporelles
   - Raw prices (prix bruts collectés)
   - Raw volumes (si activé)
   - Bougies OHLCV (tous timeframes : 1m, 5m, 15m, 1h, 4h, 1d)
   - RSI et EMA calculés
   - Données historiques initialisées (30 jours par token)

2. **SQLite** : Configuration des tokens
   - Informations de base (adresse, symbole, statut actif/inactif)
   - État d'initialisation historique (status, progression, dates)
   - Pool IDs GeckoTerminal
   - Métadonnées de traçabilité

### 🚀 **Démarrage du service**

```bash
# Démarrer le service de backup
docker compose up backup -d

# Vérifier l'état
docker ps --filter "name=backup"

# Voir les logs
docker logs ohlcv-backup-service -f
```

### 💾 **Backup manuel**

```bash
# Exécuter un backup immédiat
docker exec ohlcv-backup-service /scripts/backup.sh

# Voir la liste des backups
ls -la /workspace/backupBDD/influxdb/
ls -la /workspace/backupBDD/sqlite/
```

### 🔧 **Configuration**

Le service utilise les mêmes variables d'environnement que l'API :

```bash
INFLUXDB_URL=http://influxdb:8086
INFLUXDB_TOKEN=my-super-secret-auth-token
INFLUXDB_ORG=solcrates
INFLUXDB_BUCKET=ohlcv_data
```

### 🔄 **Restauration**

En cas de problème, vous pouvez restaurer vos données :

```bash
# Lister les backups disponibles
ls /workspace/backupBDD/influxdb/

# Restaurer InfluxDB (choisir le backup souhaité)
docker exec ohlcv-backup-service influx restore \
  /backups/influxdb/influxdb_backup_YYYYMMDD_HHMMSS.tar.gz \
  --host http://influxdb:8086 \
  --token $INFLUXDB_TOKEN \
  --org $INFLUXDB_ORG

# Restaurer SQLite
tar -xzf /workspace/backupBDD/sqlite/sqlite_backup_YYYYMMDD_HHMMSS.tar.gz -C ./data/
```

### 📈 **Surveillance**

```bash
# Voir les logs du service backup
docker logs ohlcv-backup-service

# Voir l'espace utilisé par les backups
docker exec ohlcv-backup-service du -sh /backups

# Voir les backups récents
docker exec ohlcv-backup-service find /backups -name "*.tar.gz" -mtime -7
```

### ⚠️ **Important**

- Le service s'arrête automatiquement si InfluxDB n'est pas accessible
- Les backups sont compressés pour économiser l'espace disque
- En cas de problème, vérifiez les logs et les variables d'environnement

---

## Système d'Initialisation Historique

Lorsqu'un nouveau token est ajouté, le système récupère automatiquement **30 jours d'historique** depuis GeckoTerminal.

### Fonctionnement

1. **Ajout d'un token** via `POST /api/tokens`
   - Créé avec `is_active = false` et `initialization_status = 'pending'`
   - Placé dans la queue d'initialisation

2. **Traitement automatique** par `HistoricalDataInitializer`
   - Récupère le pool principal sur GeckoTerminal
   - Télécharge les bougies minute des 30 derniers jours
   - Convertit en raw_prices pour cohérence avec la collecte temps réel
   - Construit les bougies OHLCV pour tous les timeframes (1m, 5m, 15m, 1h, 4h, 1d)
   - Calcule RSI et EMA pour chaque bougie
   - Active le token (`is_active = true`)

3. **Collecte temps réel** démarre automatiquement après initialisation

### Surveillance

```bash
# Voir les stats d'initialisation
curl http://localhost:3002/api/tokens/initialization-stats

# Voir le statut d'un token spécifique
curl http://localhost:3002/api/tokens/{address}/initialization-status
```

### Résultats attendus

- **Gros tokens** (ex: MOODENG): ~40-50% de complétude (beaucoup de transactions)
- **Petits tokens** (ex: SWOGE): ~5-10% de complétude (peu de transactions)

**Note**: GeckoTerminal ne retourne que les minutes avec activité. Les gaps sont normaux pour les tokens peu liquides.

---

## Système de Rattrapage de Données (Backfill)

Le backfill permet de combler intelligemment les lacunes de données en 2 étapes :

### Stratégie

**Étape 1 : Raw Prices**
- Récupère les bougies minute depuis GeckoTerminal
- Vérifie quelles raw_prices existent déjà en InfluxDB
- **Insère uniquement les données manquantes** (pas de doublons)

**Étape 2 : Recalcul Sélectif**
- Parcourt chaque période de chaque timeframe
- **Skip si qualité OK** (quality_factor ≥ 90% ET rsi_quality ≥ 90%)
- **Recalcule** si qualité insuffisante
- **Crée** si bougie manquante

### Gestion d'Erreurs Robuste

- **Retry automatique** avec backoff exponentiel (5s, 10s, 20s)
- **3 tentatives maximum** par opération
- **Logs détaillés** de chaque tentative
- **Nettoyage automatique** du flag `isProcessing` même en cas d'erreur

### API Endpoints

#### 1. Backfill d'un token

```bash
# Option A: Période explicite
curl -X POST http://localhost:3002/api/backfill/token \
  -H "Content-Type: application/json" \
  -d '{
    "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "startDate": "2025-10-20T00:00:00Z",
    "endDate": "2025-10-22T23:59:59Z"
  }'

# Option B: Durée relative (heures)
curl -X POST http://localhost:3002/api/backfill/token \
  -H "Content-Type: application/json" \
  -d '{
    "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "hours": 24
  }'

# Option C: Durée relative (jours)
curl -X POST http://localhost:3002/api/backfill/token \
  -H "Content-Type: application/json" \
  -d '{
    "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "days": 7
  }'
```

#### 2. Backfill global (rupture de service)

```bash
# Rattraper les 6 dernières heures pour TOUS les tokens
curl -X POST http://localhost:3002/api/backfill/all \
  -H "Content-Type: application/json" \
  -d '{"hours": 6}'

# Période spécifique
curl -X POST http://localhost:3002/api/backfill/all \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2025-10-23T12:00:00Z",
    "endDate": "2025-10-23T18:00:00Z"
  }'
```

#### 3. Vérifier le statut

```bash
curl http://localhost:3002/api/backfill/status
```

### Cas d'usage

**Panne du service**
```bash
# Le service était arrêté du 23/10 12h au 23/10 18h
curl -X POST http://localhost:3002/api/backfill/all \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2025-10-23T12:00:00Z",
    "endDate": "2025-10-23T18:00:00Z"
  }'
```

**Token avec données de mauvaise qualité**
```bash
# Améliorer la qualité RSI des 7 derniers jours
curl -X POST http://localhost:3002/api/backfill/token \
  -H "Content-Type: application/json" \
  -d '{
    "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "days": 7
  }'
```

### Réponse type

```json
{
  "status": "success",
  "message": "Backfill terminé avec succès",
  "data": {
    "token": "EMULITES",
    "period": {
      "start": "2025-10-25T06:16:14.957Z",
      "end": "2025-10-25T07:16:14.957Z"
    },
    "step1": {
      "candlesFromGecko": 45,
      "rawPricesInserted": 38,
      "rawPricesSkipped": 7
    },
    "step2": {
      "totalPeriods": 83,
      "candlesRecalculated": 64,
      "candlesSkipped": 16,
      "candlesCreated": 3
    },
    "duration": "8.5s",
    "success": true
  }
}
```

### Limitations

- **Un seul backfill à la fois** (`isProcessing` empêche les conflits)
- **Dépendant de GeckoTerminal** (si leurs données ont des gaps, on ne peut pas les combler)
- **Rate limiting** géré automatiquement (retry en cas de 429)

---