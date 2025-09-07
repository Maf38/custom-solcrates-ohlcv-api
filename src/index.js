const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./config/swagger');
const tokensRouter = require('./routes/tokens');
const ohlcvRouter = require('./routes/ohlcv');
const PriceCollector = require('./services/PriceCollector');
const VolumeCollector = require('./services/VolumeCollector');
const CandleBuilder = require('./services/CandleBuilder');
const Token = require('./models/Token');
const logger = require('./config/logger');

const app = express();
const PORT = process.env.PORT || 3002;

// Configuration des collecteurs
const VOLUME_ENABLED = process.env.VOLUME_ENABLED === 'true';

// Création des instances des collecteurs
const priceCollector = new PriceCollector();
const volumeCollector = VOLUME_ENABLED ? new VolumeCollector() : null;
const candleBuilder = new CandleBuilder({ includeVolume: VOLUME_ENABLED });

// Passer les collecteurs au routeur des tokens
tokensRouter.setCollectors(priceCollector, volumeCollector);

// Middleware pour parser le JSON
app.use(express.json());

// Configuration CORS
app.use(cors());

// Middleware de logging
app.use((req, res, next) => {
    logger.http(`${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    next();
});

// Gestionnaire d'erreurs global
app.use((err, req, res, next) => {
    logger.error('Erreur globale:', err);
    res.status(500).json({ status: 'error', message: 'Erreur interne du serveur' });
});

// Routes
app.use('/api/tokens', tokensRouter);
app.use('/api/ohlcv', ohlcvRouter);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Initialisation des collecteurs
async function initializeCollectors() {
    try {
        const tokens = await Token.getAllActive();
        logger.info(`Initialisation des collecteurs avec ${tokens.length} tokens actifs`);
        logger.info(`Collecte de volume: ${VOLUME_ENABLED ? 'activée' : 'désactivée'}`);
        
        // Initialiser le collecteur de prix
        priceCollector.setTokens(tokens);
        await priceCollector.start();
        
        // Initialiser le collecteur de volume si activé
        if (volumeCollector) {
            volumeCollector.setTokens(tokens);
            await volumeCollector.start();
        }
        
        // Initialiser le constructeur de bougies
        await candleBuilder.start(tokens);
        
        logger.info('Collecteurs initialisés avec succès');
    } catch (error) {
        logger.error('Erreur lors de l\'initialisation des collecteurs:', error);
        process.exit(1);
    }
}

// Démarrage du serveur
const server = app.listen(PORT, async () => {
    logger.info('Serveur démarré sur le port ' + PORT);
    logger.info('Documentation API disponible sur http://localhost:' + PORT + '/api-docs');
    
    // Initialiser les collecteurs après le démarrage du serveur
    await initializeCollectors();
});

// Gestion de l'arrêt propre
process.on('SIGTERM', () => {
    logger.info('Signal SIGTERM reçu. Arrêt propre...');
    
    // Arrêter les collecteurs
    priceCollector.stop();
    if (volumeCollector) {
        volumeCollector.stop();
    }
    candleBuilder.stop();
    
    server.close(() => {
        process.exit(0);
    });
});

module.exports = app;