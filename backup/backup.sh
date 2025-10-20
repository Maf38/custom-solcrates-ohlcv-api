#!/bin/bash

# Script de sauvegarde automatique pour InfluxDB et SQLite
# Exécuté quotidiennement via cron

set -e

BACKUP_DIR="/backups"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30

# Couleurs pour les logs
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

# Créer les répertoires de backup s'ils n'existent pas
mkdir -p "${BACKUP_DIR}/influxdb"
mkdir -p "${BACKUP_DIR}/sqlite"

log_info "=== Début de la sauvegarde ==="

# 1. Backup InfluxDB
log_info "Sauvegarde d'InfluxDB en cours..."

INFLUXDB_BACKUP_PATH="${BACKUP_DIR}/influxdb/influxdb_backup_${DATE}"
INFLUXDB_COMPRESSED="${BACKUP_DIR}/influxdb/influxdb_backup_${DATE}.tar.gz"

# Utiliser l'API InfluxDB pour créer un backup
if influx backup "${INFLUXDB_BACKUP_PATH}" \
    --host "${INFLUXDB_URL}" \
    --token "${INFLUXDB_TOKEN}" \
    --org "${INFLUXDB_ORG}" \
    --bucket "${INFLUXDB_BUCKET}"; then
    
    log_info "Backup InfluxDB créé avec succès"
    
    # Compresser le backup
    log_info "Compression du backup InfluxDB..."
    tar -czf "${INFLUXDB_COMPRESSED}" -C "${BACKUP_DIR}/influxdb" "influxdb_backup_${DATE}"
    
    # Supprimer le répertoire non compressé
    rm -rf "${INFLUXDB_BACKUP_PATH}"
    
    INFLUXDB_SIZE=$(du -h "${INFLUXDB_COMPRESSED}" | cut -f1)
    log_info "Backup InfluxDB compressé : ${INFLUXDB_COMPRESSED} (${INFLUXDB_SIZE})"
else
    log_error "Échec du backup InfluxDB"
fi

# 2. Backup SQLite
log_info "Sauvegarde des bases SQLite en cours..."

SQLITE_BACKUP_DIR="${BACKUP_DIR}/sqlite/sqlite_backup_${DATE}"
mkdir -p "${SQLITE_BACKUP_DIR}"

# Copier et compresser les bases SQLite
if [ -d "/app/data" ]; then
    for db_file in /app/data/*.db; do
        if [ -f "$db_file" ]; then
            db_name=$(basename "$db_file")
            log_info "Sauvegarde de ${db_name}..."
            
            # Utiliser sqlite3 pour faire un backup propre
            sqlite3 "$db_file" ".backup '${SQLITE_BACKUP_DIR}/${db_name}'"
            
            if [ $? -eq 0 ]; then
                log_info "Backup de ${db_name} réussi"
            else
                log_error "Échec du backup de ${db_name}"
            fi
        fi
    done
    
    # Compresser tous les backups SQLite
    SQLITE_COMPRESSED="${BACKUP_DIR}/sqlite/sqlite_backup_${DATE}.tar.gz"
    tar -czf "${SQLITE_COMPRESSED}" -C "${BACKUP_DIR}/sqlite" "sqlite_backup_${DATE}"
    
    # Supprimer le répertoire non compressé
    rm -rf "${SQLITE_BACKUP_DIR}"
    
    SQLITE_SIZE=$(du -h "${SQLITE_COMPRESSED}" | cut -f1)
    log_info "Backup SQLite compressé : ${SQLITE_COMPRESSED} (${SQLITE_SIZE})"
else
    log_warning "Répertoire /app/data introuvable, aucun backup SQLite effectué"
fi

# 3. Nettoyage des anciens backups (conservation : RETENTION_DAYS jours)
log_info "Nettoyage des backups de plus de ${RETENTION_DAYS} jours..."

find "${BACKUP_DIR}/influxdb" -name "*.tar.gz" -mtime +${RETENTION_DAYS} -delete
find "${BACKUP_DIR}/sqlite" -name "*.tar.gz" -mtime +${RETENTION_DAYS} -delete

REMAINING_INFLUX=$(find "${BACKUP_DIR}/influxdb" -name "*.tar.gz" | wc -l)
REMAINING_SQLITE=$(find "${BACKUP_DIR}/sqlite" -name "*.tar.gz" | wc -l)

log_info "Backups restants - InfluxDB: ${REMAINING_INFLUX}, SQLite: ${REMAINING_SQLITE}"

# 4. Afficher l'espace disque utilisé
TOTAL_SIZE=$(du -sh "${BACKUP_DIR}" | cut -f1)
log_info "Espace total utilisé par les backups : ${TOTAL_SIZE}"

log_info "=== Sauvegarde terminée avec succès ==="

exit 0

