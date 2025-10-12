FROM node:20-alpine

# Installation des dépendances système nécessaires pour better-sqlite3
RUN apk add --no-cache \
    python3 \
    py3-setuptools \
    make \
    g++ \
    wget \
    curl \
    vim

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