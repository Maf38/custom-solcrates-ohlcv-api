FROM node:18-alpine

# Installation des dépendances système nécessaires
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    wget \
    curl \
    vim  # Pour l'édition en ligne de commande

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

# Démarrage de l'application avec débogage activé
CMD ["node", "--inspect=0.0.0.0:9229", "src/index.js"]