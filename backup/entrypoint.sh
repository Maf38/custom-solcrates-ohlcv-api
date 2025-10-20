#!/bin/bash

echo "=========================================="
echo "  Service de Backup Automatique OHLCV API"
echo "=========================================="
echo "Démarrage du service de backup..."
echo "- Backup quotidien programmé à 2h00"
echo "- Conservation: 30 jours"
echo "- Backups: InfluxDB + SQLite"
echo ""

# Créer le fichier de log s'il n'existe pas
touch /var/log/backup.log

# Afficher les informations de configuration
echo "Configuration:"
echo "- InfluxDB URL: ${INFLUXDB_URL}"
echo "- InfluxDB Org: ${INFLUXDB_ORG}"
echo "- InfluxDB Bucket: ${INFLUXDB_BUCKET}"
echo "- Répertoire backups: /backups"
echo ""

# Exécuter un premier backup au démarrage
echo "Exécution du premier backup au démarrage..."
/scripts/backup.sh

# Démarrer crond en foreground
echo ""
echo "Service de backup démarré. Prochaine sauvegarde: 2h00"
echo "Logs disponibles dans /var/log/backup.log"
echo "=========================================="

# Afficher les logs en temps réel et garder cron en foreground
crond -f -l 2 &
CRON_PID=$!

# Suivre les logs
tail -f /var/log/backup.log &

# Attendre que cron se termine (jamais dans des conditions normales)
wait $CRON_PID

