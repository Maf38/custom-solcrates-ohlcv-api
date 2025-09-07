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

## API Routes

Documentation complète disponible via Swagger UI : http://localhost:3002/api-docs

### Tokens

- `POST /api/tokens` : Ajouter un nouveau token
- `GET /api/tokens` : Liste tous les tokens
- `DELETE /api/tokens/:address` : Désactive un token

### OHLCV

- `GET /api/ohlcv/:address/:timeframe` : Récupère les données OHLCV
- `GET /api/ohlcv/raw/:address` : Récupère les données brutes (prix + volume)