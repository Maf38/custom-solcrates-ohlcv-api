# Spécifications OHLCV Creator
Repo de l'éaquipe qui a créé le code source de base https://github.com/Solcrates-Labs/ohlcvcreator

## Description
Service de collecte et stockage de données OHLCV (Open, High, Low, Close, Volume) pour les tokens Solana.

## Fonctionnalités
1. Collecte dynamique des données OHLCV pour plusieurs tokens
2. Stockage persistant dans SQLite
3. API REST pour la gestion des tokens et l'accès aux données
4. Support de différents timeframes (1m, 5m, 15m, 1h, 4h)

## Architecture Technique

### Base de Données
#### MCD (Modèle Conceptuel de Données)
```
TOKEN (contract_address, symbol, is_active, created_at, last_update)
OHLCV (id, #contract_address, timestamp, timeframe, open, high, low, close, volume)
```

#### Tables SQLite
```sql
CREATE TABLE tokens (
    contract_address TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_update TIMESTAMP
);

CREATE TABLE ohlcv (
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
```

### API Endpoints

#### Gestion des Tokens
- `POST /tokens/add` - Ajouter un nouveau token
  ```json
  {
    "contract_address": "string",
    "symbol": "string"
  }
  ```
- `DELETE /tokens/{contract_address}` - Supprimer un token
- `PUT /tokens/{contract_address}/activate` - Activer la collecte
- `PUT /tokens/{contract_address}/deactivate` - Désactiver la collecte
- `GET /tokens` - Liste des tokens
- `GET /tokens/{contract_address}` - Détails d'un token

#### Données OHLCV
- `GET /ohlcv/{contract_address}/{timeframe}` - Données OHLCV
  - Paramètres : `from`, `to` (timestamps)
  - Timeframes : 1m, 5m, 15m, 1h, 4h

### Sources de Données
- Prix : API Jupiter (`https://api.jup.ag/price/v2`)
- Volume : Transactions Solana via RPC public
- RPC par défaut : PublicNode (`https://solana-mainnet.rpc.publicnode.com`)

## TODO List
- [ ] Configuration du projet
  - [x] Structure des dossiers
  - [x] Dockerfile
  - [x] package.json
  - [x] Scripts d'initialisation DB

- [ ] Base de données
  - [x] Schéma SQLite
  - [ ] Migration system
  - [ ] Tests unitaires DB

- [ ] API REST
  - [ ] Routes tokens
  - [ ] Routes OHLCV
  - [ ] Validation des entrées
  - [ ] Documentation OpenAPI/Swagger

- [ ] Collecteur de données
  - [ ] Support multi-tokens
  - [ ] Gestion des timeframes
  - [ ] Persistance SQLite
  - [ ] Gestion des erreurs

- [ ] Tests et Documentation
  - [ ] Tests d'intégration
  - [ ] Documentation API
  - [ ] Guide de déploiement
  - [ ] Monitoring et logs

## Variables d'Environnement
```env
# RPC Solana (défaut: PublicNode)
RPC_URL=https://solana-mainnet.rpc.publicnode.com

# Port d'écoute API (défaut: 3002)
PORT=3002

# Chemin de la base SQLite
DB_PATH=/app/data/ohlcv.db
```

