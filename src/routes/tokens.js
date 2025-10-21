const express = require('express');
const { body, validationResult } = require('express-validator');
const { PublicKey } = require('@solana/web3.js');
const Token = require('../models/Token');
const logger = require('../config/logger');

const router = express.Router();

// Stockage des collecteurs
let priceCollector = null;
let volumeCollector = null;
let candleBuilder = null;

// Initialisation des collecteurs
router.setCollectors = (price, volume, candle) => {
    priceCollector = price;
    volumeCollector = volume;
    candleBuilder = candle;
};

// Validation personnalisée pour l'adresse Solana
const validateSolanaAddress = value => {
    logger.debug('Validation de l\'adresse Solana:', value);
    try {
        new PublicKey(value);
        return true;
    } catch (error) {
        logger.error('Erreur de validation de l\'adresse:', error);
        return false;
    }
};

// Middleware de validation
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.error('Erreurs de validation:', errors.array());
        return res.status(400).json({
            status: 'error',
            message: 'Données invalides',
            errors: errors.array()
        });
    }
    next();
};

// GET /api/tokens - Liste tous les tokens actifs
router.get('/', async (req, res) => {
    try {
        const tokens = await Token.getAllActive();
        logger.info('GET /tokens - Tokens actifs récupérés:', tokens);
        res.json({
            status: 'success',
            data: tokens
        });
    } catch (error) {
        logger.error('GET /tokens - Erreur:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erreur lors de la récupération des tokens actifs'
        });
    }
});

// GET /api/tokens/all - Liste tous les tokens (actifs et inactifs)
router.get('/all', async (req, res) => {
    try {
        const tokens = await Token.getAllTokens();
        logger.info('GET /tokens/all - Tous les tokens récupérés:', tokens);
        res.json({
            status: 'success',
            data: tokens
        });
    } catch (error) {
        logger.error('GET /tokens/all - Erreur:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erreur lors de la récupération de tous les tokens'
        });
    }
});

// GET /api/tokens/:address - Récupère un token spécifique
router.get('/:address', async (req, res) => {
    try {
        const { address } = req.params;
        
        // Vérifier si l'adresse est valide
        if (!validateSolanaAddress(address)) {
            return res.status(400).json({
                status: 'error',
                message: 'Adresse Solana invalide'
            });
        }

        const token = await Token.findByAddress(address);
        
        if (!token) {
            return res.status(404).json({
                status: 'error',
                message: 'Token non trouvé'
            });
        }

        logger.info('GET /tokens/:address - Token récupéré:', token);
        res.json({
            status: 'success',
            data: token
        });
    } catch (error) {
        logger.error('GET /tokens/:address - Erreur:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erreur lors de la récupération du token'
        });
    }
});

// POST /api/tokens - Ajoute un nouveau token
router.post('/',
    [
        body('contract_address')
            .trim()
            .notEmpty()
            .withMessage('L\'adresse du contrat est requise')
            .custom(validateSolanaAddress)
            .withMessage('Adresse Solana invalide'),
        body('symbol')
            .trim()
            .notEmpty()
            .withMessage('Le symbole est requis')
    ],
    validate,
    async (req, res) => {
        try {
            const { contract_address, symbol } = req.body;
            logger.info('POST /tokens - Tentative d\'ajout:', { contract_address, symbol });

            // Vérifier si le token existe déjà
            const existingToken = await Token.findByAddress(contract_address);
            if (existingToken) {
                logger.info('POST /tokens - Token existant:', existingToken);
                return res.status(409).json({
                    status: 'error',
                    message: 'Ce token existe déjà'
                });
            }

            // Créer le nouveau token
            const newToken = await Token.create(contract_address, symbol);

            // Mettre à jour les collecteurs avec la nouvelle liste de tokens
            const activeTokens = await Token.getAllActive();
            if (priceCollector) {
                priceCollector.setTokens(activeTokens);
            }
            if (volumeCollector && process.env.VOLUME_ENABLED === 'true') {
                volumeCollector.setTokens(activeTokens);
            }
            if (candleBuilder) {
                candleBuilder.setTokens(activeTokens);
            }

            logger.info('POST /tokens - Token créé avec succès:', newToken);
            res.status(201).json({
                status: 'success',
                message: 'Token ajouté avec succès',
                data: newToken
            });

        } catch (error) {
            logger.error('POST /tokens - Erreur:', error);
            res.status(500).json({
                status: 'error',
                message: 'Erreur lors de la création du token',
                error: error.message
            });
        }
    }
);

// PATCH /api/tokens/:address/deactivate - Désactive un token
router.patch('/:address/deactivate', async (req, res) => {
    try {
        const { address } = req.params;
        logger.info('PATCH /tokens/:address/deactivate - Tentative de désactivation:', address);

        // Vérifier si l'adresse est valide
        if (!validateSolanaAddress(address)) {
            return res.status(400).json({
                status: 'error',
                message: 'Adresse Solana invalide'
            });
        }

        // Désactiver le token
        const result = await Token.update(address, {
            is_active: false
        });

        if (!result) {
            return res.status(404).json({
                status: 'error',
                message: 'Token non trouvé'
            });
        }

        // Mettre à jour les collecteurs avec la nouvelle liste de tokens
        const activeTokens = await Token.getAllActive();
        if (priceCollector) {
            priceCollector.setTokens(activeTokens);
        }
        if (volumeCollector && process.env.VOLUME_ENABLED === 'true') {
            volumeCollector.setTokens(activeTokens);
        }
        if (candleBuilder) {
            candleBuilder.setTokens(activeTokens);
        }

        logger.info('PATCH /tokens/:address/deactivate - Token désactivé:', result);
        res.json({
            status: 'success',
            message: 'Token désactivé avec succès - L\'acquisition des données est arrêtée',
            data: result
        });

    } catch (error) {
        logger.error('PATCH /tokens/:address/deactivate - Erreur:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erreur lors de la désactivation du token'
        });
    }
});

// PATCH /api/tokens/:address/activate - Réactive un token
router.patch('/:address/activate', async (req, res) => {
    try {
        const { address } = req.params;
        logger.info('PATCH /tokens/:address/activate - Tentative de réactivation:', address);

        // Vérifier si l'adresse est valide
        if (!validateSolanaAddress(address)) {
            return res.status(400).json({
                status: 'error',
                message: 'Adresse Solana invalide'
            });
        }

        // Réactiver le token
        const result = await Token.update(address, {
            is_active: true
        });

        if (!result) {
            return res.status(404).json({
                status: 'error',
                message: 'Token non trouvé'
            });
        }

        // Mettre à jour les collecteurs avec la nouvelle liste de tokens
        const activeTokens = await Token.getAllActive();
        if (priceCollector) {
            priceCollector.setTokens(activeTokens);
        }
        if (volumeCollector && process.env.VOLUME_ENABLED === 'true') {
            volumeCollector.setTokens(activeTokens);
        }
        if (candleBuilder) {
            candleBuilder.setTokens(activeTokens);
        }

        logger.info('PATCH /tokens/:address/activate - Token réactivé:', result);
        res.json({
            status: 'success',
            message: 'Token réactivé avec succès - L\'acquisition des données reprend',
            data: result
        });

    } catch (error) {
        logger.error('PATCH /tokens/:address/activate - Erreur:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erreur lors de la réactivation du token'
        });
    }
});

// DELETE /api/tokens/:address - Supprime définitivement un token
router.delete('/:address', async (req, res) => {
    try {
        const { address } = req.params;
        logger.info('DELETE /tokens/:address - Tentative de suppression définitive:', address);

        // Vérifier si l'adresse est valide
        if (!validateSolanaAddress(address)) {
            return res.status(400).json({
                status: 'error',
                message: 'Adresse Solana invalide'
            });
        }

        // Vérifier que le token existe avant suppression
        const existingToken = await Token.findByAddress(address);
        if (!existingToken) {
            return res.status(404).json({
                status: 'error',
                message: 'Token non trouvé'
            });
        }

        // Supprimer définitivement le token
        const success = await Token.delete(address);

        if (!success) {
            return res.status(500).json({
                status: 'error',
                message: 'Erreur lors de la suppression du token'
            });
        }

        // Mettre à jour les collecteurs avec la nouvelle liste de tokens
        const activeTokens = await Token.getAllActive();
        if (priceCollector) {
            priceCollector.setTokens(activeTokens);
        }
        if (volumeCollector && process.env.VOLUME_ENABLED === 'true') {
            volumeCollector.setTokens(activeTokens);
        }
        if (candleBuilder) {
            candleBuilder.setTokens(activeTokens);
        }

        logger.info('DELETE /tokens/:address - Token supprimé définitivement:', existingToken);
        res.json({
            status: 'success',
            message: 'Token supprimé définitivement - Les données historiques InfluxDB sont conservées',
            data: existingToken
        });

    } catch (error) {
        logger.error('DELETE /tokens/:address - Erreur:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erreur lors de la suppression définitive du token'
        });
    }
});

module.exports = router;