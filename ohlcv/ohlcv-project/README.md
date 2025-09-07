# OHLCV Creator

## Description
Service de collecte et stockage de données OHLCV (Open, High, Low, Close, Volume) pour les tokens Solana avec persistance SQLite.

## Structure du Projet
```
ohlcv-project/
├── data/               # Dossier pour la base SQLite
├── docs/              # Documentation
│   └── SPECIFICATIONS.md
├── src/               # Code source
│   ├── db-init.js     # Initialisation SQLite
│   └── index.js       # Point d'entrée
├── Dockerfile         # Configuration Docker
├── package.json       # Dépendances Node.js
└── README.md          # Ce fichier
```

## Installation

```bash
# Construire l'image
docker build -t ohlcv-creator .

# Lancer le conteneur
docker run -d \
  --name ohlcv-service \
  -p 3002:3002 \
  -v $(pwd)/data:/app/data \
  ohlcv-creator
```

## Variables d'Environnement
- `RPC_URL` : URL du RPC Solana (défaut: PublicNode)
- `PORT` : Port d'écoute de l'API (défaut: 3002)
- `DB_PATH` : Chemin de la base SQLite (défaut: /app/data/ohlcv.db)

## Documentation
Voir le fichier [SPECIFICATIONS.md](docs/SPECIFICATIONS.md) pour :
- Architecture détaillée
- Schéma de base de données
- API Endpoints
- TODO List

