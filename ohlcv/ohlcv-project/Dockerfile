FROM node:18-alpine

WORKDIR /app

# Installer git et les dépendances système
RUN apk add --no-cache git sqlite sqlite-dev python3 make g++

# Cloner le repo
RUN git clone https://github.com/Solcrates-Labs/ohlcvcreator .

# Installer les dépendances Node.js
COPY package.json .
RUN npm install
RUN npm install sqlite3 better-sqlite3

# Créer le répertoire pour la base de données
RUN mkdir -p /app/data

# Définir les variables d'environnement par défaut
ENV RPC_URL=https://solana-mainnet.rpc.publicnode.com \
    PORT=3002 \
    DB_PATH=/app/data/ohlcv.db

# Volume pour persister la base de données
VOLUME /app/data

# Exposer le port
EXPOSE 3002

# Démarrer l'application
CMD ["node", "./src/index.js"]