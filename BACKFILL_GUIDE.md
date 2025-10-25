# Guide d'utilisation du système de Backfill

## Vue d'ensemble

Le système de backfill permet de combler intelligemment les lacunes de données historiques en 2 étapes:

### Étape 1: Récupération des raw_prices manquantes
- Récupère les bougies minutes depuis GeckoTerminal
- Vérifie quelles raw_prices existent déjà en base
- **Insère uniquement les données manquantes** (pas de doublons)

### Étape 2: Recalcul intelligent des bougies
- Parcourt chaque période de chaque timeframe (1m, 5m, 15m, 1h, 4h, 1d)
- **Skip si bougie n'existe pas** → recalcule
- **Skip si quality_factor < 90%** → recalcule
- **Skip si rsi_quality < 90%** → recalcule
- **Skip sinon** → conserve la bougie existante

## API Endpoints

### 1. Backfill pour un token spécifique

**POST `/api/backfill/token`**

#### Option A: Période explicite
```bash
curl -X POST http://localhost:3002/api/backfill/token \
  -H "Content-Type: application/json" \
  -d '{
    "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "startDate": "2025-10-20T00:00:00Z",
    "endDate": "2025-10-22T23:59:59Z"
  }'
```

#### Option B: Durée relative (heures)
```bash
curl -X POST http://localhost:3002/api/backfill/token \
  -H "Content-Type: application/json" \
  -d '{
    "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "hours": 24
  }'
```

#### Option C: Durée relative (jours)
```bash
curl -X POST http://localhost:3002/api/backfill/token \
  -H "Content-Type: application/json" \
  -d '{
    "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "days": 7
  }'
```

#### Réponse
```json
{
  "status": "success",
  "message": "Backfill terminé",
  "data": {
    "token": "FROGG",
    "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "period": {
      "start": "2025-10-20T00:00:00.000Z",
      "end": "2025-10-22T23:59:59.000Z"
    },
    "step1": {
      "candlesFromGecko": 2880,
      "rawPricesInserted": 1456,
      "rawPricesSkipped": 1424
    },
    "step2": {
      "totalPeriods": 8640,
      "candlesRecalculated": 234,
      "candlesSkipped": 7892,
      "candlesCreated": 514
    },
    "success": true
  }
}
```

### 2. Backfill pour tous les tokens (rupture de service)

**POST `/api/backfill/all`**

#### Exemple: Rattraper une panne de 6 heures
```bash
curl -X POST http://localhost:3002/api/backfill/all \
  -H "Content-Type: application/json" \
  -d '{
    "hours": 6
  }'
```

#### Exemple: Rattraper une période spécifique
```bash
curl -X POST http://localhost:3002/api/backfill/all \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2025-10-23T12:00:00Z",
    "endDate": "2025-10-23T18:00:00Z"
  }'
```

#### Réponse
```json
{
  "status": "success",
  "message": "Backfill global terminé",
  "data": {
    "totalTokens": 15,
    "successful": 14,
    "failed": 1,
    "period": {
      "start": "2025-10-23T12:00:00.000Z",
      "end": "2025-10-23T18:00:00.000Z"
    },
    "results": [
      {
        "token": "FROGG",
        "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
        "step1": {...},
        "step2": {...},
        "success": true
      },
      ...
    ]
  }
}
```

### 3. Vérifier le statut

**GET `/api/backfill/status`**

```bash
curl http://localhost:3002/api/backfill/status
```

```json
{
  "status": "success",
  "data": {
    "isProcessing": false,
    "qualityThreshold": 0.9
  }
}
```

## Cas d'usage

### Cas 1: Panne du service
```bash
# Le service était arrêté du 23 oct 12h au 23 oct 18h
curl -X POST http://localhost:3002/api/backfill/all \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2025-10-23T12:00:00Z",
    "endDate": "2025-10-23T18:00:00Z"
  }'
```

### Cas 2: Token avec données de mauvaise qualité
```bash
# Rattraper les 7 derniers jours pour améliorer la qualité RSI
curl -X POST http://localhost:3002/api/backfill/token \
  -H "Content-Type: application/json" \
  -d '{
    "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "days": 7
  }'
```

### Cas 3: Problème détecté sur une période spécifique
```bash
# Recalculer uniquement les dernières 3 heures
curl -X POST http://localhost:3002/api/backfill/token \
  -H "Content-Type: application/json" \
  -d '{
    "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
    "hours": 3
  }'
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   DataBackfillService                    │
│                                                           │
│  1️⃣ ÉTAPE 1: Raw Prices                                 │
│     ├─ Récupération GeckoTerminal                       │
│     ├─ Détection des raw_prices existantes              │
│     └─ Insertion intelligente (pas de doublons)         │
│                                                           │
│  2️⃣ ÉTAPE 2: Recalcul des bougies                       │
│     ├─ Parcours de chaque période                       │
│     ├─ Vérification qualité (< 90% ?)                   │
│     └─ Recalcul sélectif                                │
│                                                           │
└─────────────────────────────────────────────────────────┘
          │                                    │
          ↓                                    ↓
┌──────────────────┐              ┌────────────────────┐
│ GeckoTerminal    │              │  InfluxDB          │
│ (source externe) │              │  (base de données) │
└──────────────────┘              └────────────────────┘
```

## Optimisations

### 1. Pas de doublons
- Vérifie l'existence avant insertion
- Skip les raw_prices déjà présentes

### 2. Recalcul sélectif
- Skip les bougies avec qualité ≥ 90%
- Recalcule uniquement ce qui en a besoin

### 3. Logs détaillés
```
📥 ÉTAPE 1: Récupération des raw_prices pour FROGG
   ✅ 9000 candles depuis GeckoTerminal
   ✅ 4500 raw_prices insérées, 4500 skippées (déjà existantes)

🔄 ÉTAPE 2: Recalcul intelligent des bougies
   1m: 234 recalculées, 142 créées, 2504 skippées
   5m: 45 recalculées, 28 créées, 507 skippées
   15m: 12 recalculées, 9 créées, 149 skippées
   1h: 3 recalculées, 2 créées, 43 skippées
   4h: 1 recalculée, 0 créées, 11 skippées
   1d: 0 recalculées, 0 créées, 2 skippées
```

## Limitations

1. **Un seul backfill à la fois**: `isProcessing` empêche les conflits
2. **Dépendant de GeckoTerminal**: Si leurs données ont des gaps, on ne peut pas les combler
3. **Temps d'exécution**: Peut prendre plusieurs minutes pour de longues périodes sur plusieurs tokens

## Notes

- Les bougies sont **écrasées** lors du recalcul (pas de duplication)
- Le seuil de qualité est configurable: `QUALITY_THRESHOLD = 0.90`
- Les logs sont visibles dans les logs du service
