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
const sqliteManager = require('./config/sqlite');
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
const corsOptions = {
    origin: function (origin, callback) {
        // En développement, autoriser toutes les origines et le port 3099
        if (process.env.NODE_ENV === 'development') {
            callback(null, true);
        } else {
            // En production, autoriser seulement les domaines spécifiques
            const allowedOrigins = ['http://192.168.1.82:3002', 'http://localhost:3002', 'http://localhost:3099'];
            if (!origin || allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        }
    },
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Middleware de logging
app.use((req, res, next) => {
    logger.http(`${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    next();
});

// Middleware de gestion d'erreurs de validation
const validationErrorHandler = (error, req, res, next) => {
    if (error && error.array) {
        logger.warn('Erreur de validation:', error.array());
        return res.status(400).json({
            status: 'error',
            message: 'Paramètres invalides',
            errors: error.array()
        });
    }
    next(error);
};

app.use(validationErrorHandler);

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
        // Étape 1: Initialiser SQLite
        logger.info('Initialisation de SQLite...');
        sqliteManager.initialize();
        
        // Étape 2: Récupérer les tokens actifs (nouvelle logique hybride)
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
    
    // Fermer SQLite
    sqliteManager.close();
    
    server.close(() => {
        process.exit(0);
    });
});

module.exports = app;