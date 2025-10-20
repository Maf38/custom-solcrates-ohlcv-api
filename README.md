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

## API Routes

Documentation complète disponible via Swagger UI : http://localhost:3002/api-docs

### Gestion des tokens

- `POST /api/tokens` : Ajouter un nouveau token (démarre l'acquisition)
- `GET /api/tokens` : Liste tous les tokens actifs
- `GET /api/tokens/all` : Liste tous les tokens (actifs et inactifs)
- `GET /api/tokens/:address` : Récupère un token spécifique
- `PATCH /api/tokens/:address/activate` : Réactive un token (reprend l'acquisition)
- `PATCH /api/tokens/:address/deactivate` : Désactive un token (arrête l'acquisition)
- `DELETE /api/tokens/:address` : Supprime définitivement un token (conserve les données InfluxDB)

### Données OHLCV

- `GET /api/ohlcv/:address/:timeframe` : Récupère les données OHLCV
- `GET /api/ohlcv/raw/:address` : Récupère les données brutes (prix + volume)

## Service de Backup Automatique

### 🔄 **Fonctionnement**

Le service de backup automatique sauvegarde quotidiennement vos données :

- **Horaire** : Tous les jours à 2h00 du matin
- **Rétention** : 30 jours (suppression automatique des anciens backups)
- **Localisation** : `/workspace/backupBDD/` sur l'hôte

### 📊 **Données sauvegardées**

1. **InfluxDB** : Toutes les données temporelles (prix, volumes, bougies OHLCV, RSI)
2. **SQLite** : Configuration des tokens et leur statut actif/inactif

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