FROM node:18-alpine

# Installation des dépendances système nécessaires
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    wget

# Création du répertoire de l'application
WORKDIR /app

# Copie des fichiers de dépendances
COPY package*.json ./

# Installation des dépendances
RUN npm install

# Copie du reste des fichiers
COPY . .

# Expose l'API
EXPOSE 3002

# Démarrage de l'application
CMD ["node", "src/index.js"]