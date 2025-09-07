const express = require('express');
const { body, validationResult } = require('express-validator');
const { PublicKey } = require('@solana/web3.js');
const Token = require('../models/Token');
const logger = require('../config/logger');

const router = express.Router();

// Stockage des collecteurs
let priceCollector = null;
let volumeCollector = null;

// Initialisation des collecteurs
router.setCollectors = (price, volume) => {
    priceCollector = price;
    volumeCollector = volume;
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

// GET /api/tokens - Liste tous les tokens
router.get('/', async (req, res) => {
    try {
        const tokens = await Token.getAllActive();
        logger.info('GET /tokens - Tokens récupérés:', tokens);
        res.json({
            status: 'success',
            data: tokens
        });
    } catch (error) {
        logger.error('GET /tokens - Erreur:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erreur lors de la récupération des tokens'
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

// DELETE /api/tokens/:address - Désactive un token
router.delete('/:address',
    async (req, res) => {
        try {
            const { address } = req.params;
            logger.info('DELETE /tokens/:address - Tentative de suppression:', address);

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

            logger.info('DELETE /tokens/:address - Token désactivé:', result);
            res.json({
                status: 'success',
                message: 'Token désactivé avec succès',
                data: result
            });

        } catch (error) {
            logger.error('DELETE /tokens/:address - Erreur:', error);
            res.status(500).json({
                status: 'error',
                message: 'Erreur lors de la désactivation du token'
            });
        }
    }
);

module.exports = router;