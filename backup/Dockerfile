FROM alpine:3.18

# Installation des dépendances
RUN apk add --no-cache \
    bash \
    curl \
    sqlite \
    tar \
    gzip \
    tzdata \
    && rm -rf /var/cache/apk/*

# Installer InfluxDB CLI pour les backups
RUN wget https://dl.influxdata.com/influxdb/releases/influxdb2-client-2.7.3-linux-amd64.tar.gz && \
    tar xvzf influxdb2-client-2.7.3-linux-amd64.tar.gz && \
    mv influx /usr/local/bin/ && \
    chmod +x /usr/local/bin/influx && \
    rm influxdb2-client-2.7.3-linux-amd64.tar.gz

# Configurer le timezone
ENV TZ=Europe/Paris
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Créer les répertoires
RUN mkdir -p /backups/influxdb /backups/sqlite /scripts

# Copier le script de backup
COPY backup.sh /scripts/backup.sh
RUN chmod +x /scripts/backup.sh

# Créer un fichier crontab pour exécuter le backup quotidiennement à 2h du matin
RUN echo "0 2 * * * /scripts/backup.sh >> /var/log/backup.log 2>&1" > /etc/crontabs/root

# Script d'entrée pour lancer cron et faire un premier backup
COPY entrypoint.sh /scripts/entrypoint.sh
RUN chmod +x /scripts/entrypoint.sh

WORKDIR /scripts

CMD ["/scripts/entrypoint.sh"]

