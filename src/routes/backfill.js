const express = require('express');
const router = express.Router();
const backfillService = require('../services/DataBackfillService');
const logger = require('../config/logger');

/**
 * POST /api/backfill/token
 *
 * Rattrapage de données pour un token spécifique
 *
 * Body:
 * {
 *   "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
 *   "startDate": "2025-10-20T00:00:00Z",
 *   "endDate": "2025-10-22T23:59:59Z"
 * }
 *
 * Ou avec durée relative:
 * {
 *   "tokenAddress": "ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon",
 *   "hours": 24  // Rattraper les dernières 24h
 * }
 */
router.post('/token', async (req, res) => {
    try {
        const { tokenAddress, startDate, endDate, hours, days } = req.body;

        if (!tokenAddress) {
            return res.status(400).json({
                status: 'error',
                message: 'tokenAddress requis'
            });
        }

        let start, end;

        // Option 1: Dates explicites
        if (startDate && endDate) {
            start = new Date(startDate);
            end = new Date(endDate);

            if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Format de date invalide (utilisez ISO 8601)'
                });
            }
        }
        // Option 2: Durée relative (hours ou days)
        else if (hours || days) {
            end = new Date();
            start = new Date();

            if (hours) {
                start.setHours(start.getHours() - hours);
            } else if (days) {
                start.setDate(start.getDate() - days);
            }
        }
        // Aucune période spécifiée
        else {
            return res.status(400).json({
                status: 'error',
                message: 'Spécifiez soit (startDate + endDate) soit (hours ou days)'
            });
        }

        // Validation
        if (start >= end) {
            return res.status(400).json({
                status: 'error',
                message: 'startDate doit être antérieur à endDate'
            });
        }

        // Lancer le backfill (asynchrone)
        logger.info(`API: Démarrage backfill token ${tokenAddress} (${start.toISOString()} → ${end.toISOString()})`);

        const results = await backfillService.backfillToken(tokenAddress, start, end);

        // Vérifier si le backfill a réussi ou échoué
        if (results.success) {
            res.json({
                status: 'success',
                message: 'Backfill terminé avec succès',
                data: results
            });
        } else {
            // Le backfill a échoué après tous les retries
            res.status(500).json({
                status: 'error',
                message: `Backfill échoué: ${results.error}`,
                data: results
            });
        }

    } catch (error) {
        logger.error('Erreur dans /api/backfill/token:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * POST /api/backfill/all
 *
 * Rattrapage de données pour tous les tokens (rupture de service)
 *
 * Body:
 * {
 *   "startDate": "2025-10-20T00:00:00Z",
 *   "endDate": "2025-10-22T23:59:59Z"
 * }
 *
 * Ou avec durée relative:
 * {
 *   "hours": 6  // Rattraper les dernières 6h pour tous les tokens
 * }
 */
router.post('/all', async (req, res) => {
    try {
        const { startDate, endDate, hours, days } = req.body;

        let start, end;

        // Option 1: Dates explicites
        if (startDate && endDate) {
            start = new Date(startDate);
            end = new Date(endDate);

            if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Format de date invalide (utilisez ISO 8601)'
                });
            }
        }
        // Option 2: Durée relative
        else if (hours || days) {
            end = new Date();
            start = new Date();

            if (hours) {
                start.setHours(start.getHours() - hours);
            } else if (days) {
                start.setDate(start.getDate() - days);
            }
        }
        // Aucune période spécifiée
        else {
            return res.status(400).json({
                status: 'error',
                message: 'Spécifiez soit (startDate + endDate) soit (hours ou days)'
            });
        }

        // Validation
        if (start >= end) {
            return res.status(400).json({
                status: 'error',
                message: 'startDate doit être antérieur à endDate'
            });
        }

        // Lancer le backfill global (asynchrone)
        logger.info(`API: Démarrage backfill global (${start.toISOString()} → ${end.toISOString()})`);

        const results = await backfillService.backfillAllTokens(start, end);

        res.json({
            status: 'success',
            message: 'Backfill global terminé',
            data: results
        });

    } catch (error) {
        logger.error('Erreur dans /api/backfill/all:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * GET /api/backfill/status
 *
 * Vérifier si un backfill est en cours
 */
router.get('/status', (req, res) => {
    res.json({
        status: 'success',
        data: {
            isProcessing: backfillService.isProcessing,
            qualityThreshold: backfillService.QUALITY_THRESHOLD
        }
    });
});

module.exports = router;
