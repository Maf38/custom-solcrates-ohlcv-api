const swaggerDefinition = {
    openapi: '3.0.0',
    info: {
        title: 'Custom Solcrates OHLCV API',
        version: '1.0.0',
        description: 'API de collecte de données OHLCV pour tokens Solana'
    },
    servers: [
        {
            url: 'http://localhost:3099',
            description: 'Serveur de développement (debug)'
        },
        {
            url: 'http://192.168.1.82:3002',
            description: 'Serveur de développement'
        }
    ],
    components: {
        schemas: {
            Token: {
                type: 'object',
                properties: {
                    contract_address: {
                        type: 'string',
                        description: 'Adresse du contrat Solana'
                    },
                    symbol: {
                        type: 'string',
                        description: 'Symbole du token'
                    },
                    is_active: {
                        type: 'boolean',
                        description: 'État de suivi du token'
                    },
                    created_at: {
                        type: 'string',
                        format: 'date-time'
                    },
                    last_update: {
                        type: 'string',
                        format: 'date-time'
                    }
                }
            },
            OHLCV: {
                type: 'object',
                properties: {
                    timestamp: {
                        type: 'string',
                        format: 'date-time'
                    },
                    open: {
                        type: 'number',
                        description: 'Prix d\'ouverture'
                    },
                    high: {
                        type: 'number',
                        description: 'Prix le plus haut'
                    },
                    low: {
                        type: 'number',
                        description: 'Prix le plus bas'
                    },
                    close: {
                        type: 'number',
                        description: 'Prix de fermeture'
                    },
                    volume: {
                        type: 'number',
                        description: 'Volume total'
                    },
                    quality_factor: {
                        type: 'number',
                        description: 'Facteur de qualité des données (0-1)',
                        minimum: 0,
                        maximum: 1
                    }
                }
            },
            RawData: {
                type: 'object',
                properties: {
                    timestamp: {
                        type: 'string',
                        format: 'date-time'
                    },
                    price: {
                        type: 'number',
                        description: 'Prix instantané'
                    },
                    volume: {
                        type: 'number',
                        description: 'Volume instantané'
                    }
                }
            },
            RSIPerformance: {
                type: 'object',
                properties: {
                    timestamp: {
                        type: 'string',
                        format: 'date-time'
                    },
                    rsi: {
                        type: 'number',
                        description: 'Valeur RSI de la bougie',
                        minimum: 0,
                        maximum: 100
                    },
                    price: {
                        type: 'number',
                        description: 'Prix de clôture de la bougie'
                    },
                    next_price: {
                        type: 'number',
                        description: 'Prix de clôture de la bougie suivante'
                    },
                    variation: {
                        type: 'number',
                        description: 'Variation en pourcentage'
                    },
                    timeframe: {
                        type: 'string',
                        description: 'Timeframe de la bougie'
                    }
                }
            }
        }
    },
    paths: {
        '/api/tokens': {
            get: {
                summary: 'Liste tous les tokens actifs',
                description: 'Récupère la liste des tokens actuellement suivis pour l\'acquisition de données',
                responses: {
                    '200': {
                        description: 'Liste des tokens actifs',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string' },
                                        data: {
                                            type: 'array',
                                            items: {
                                                $ref: '#/components/schemas/Token'
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            post: {
                summary: 'Ajoute un nouveau token à suivre',
                description: 'Ajoute un token dans SQLite et démarre automatiquement l\'acquisition des données',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['contract_address', 'symbol'],
                                properties: {
                                    contract_address: {
                                        type: 'string',
                                        description: 'Adresse du contrat Solana'
                                    },
                                    symbol: {
                                        type: 'string',
                                        description: 'Symbole du token'
                                    }
                                }
                            }
                        }
                    }
                },
                responses: {
                    '201': {
                        description: 'Token ajouté avec succès',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: {
                                            type: 'string',
                                            example: 'success'
                                        },
                                        message: {
                                            type: 'string',
                                            example: 'Token ajouté avec succès'
                                        },
                                        data: {
                                            $ref: '#/components/schemas/Token'
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '400': {
                        description: 'Données invalides'
                    },
                    '409': {
                        description: 'Token déjà existant'
                    },
                    '500': {
                        description: 'Erreur serveur'
                    }
                }
            }
        },
        '/api/tokens/all': {
            get: {
                summary: 'Liste tous les tokens (actifs et inactifs)',
                description: 'Récupère la liste complète des tokens dans SQLite',
                responses: {
                    '200': {
                        description: 'Liste complète des tokens',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string' },
                                        data: {
                                            type: 'array',
                                            items: {
                                                $ref: '#/components/schemas/Token'
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/api/tokens/{address}': {
            get: {
                summary: 'Récupère un token spécifique',
                parameters: [
                    {
                        in: 'path',
                        name: 'address',
                        required: true,
                        schema: {
                            type: 'string'
                        },
                        description: 'Adresse du contrat Solana'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Token trouvé',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string' },
                                        data: {
                                            $ref: '#/components/schemas/Token'
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '404': {
                        description: 'Token non trouvé'
                    }
                }
            },
            delete: {
                summary: 'Supprime définitivement un token',
                description: 'Supprime le token de SQLite (les données InfluxDB sont conservées)',
                parameters: [
                    {
                        in: 'path',
                        name: 'address',
                        required: true,
                        schema: {
                            type: 'string'
                        },
                        description: 'Adresse du contrat Solana'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Token supprimé définitivement',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string' },
                                        message: { type: 'string' },
                                        data: {
                                            $ref: '#/components/schemas/Token'
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '404': {
                        description: 'Token non trouvé'
                    }
                }
            }
        },
        '/api/tokens/{address}/deactivate': {
            patch: {
                summary: 'Désactive un token',
                description: 'Désactive le token dans SQLite (arrête l\'acquisition des données)',
                parameters: [
                    {
                        in: 'path',
                        name: 'address',
                        required: true,
                        schema: {
                            type: 'string'
                        },
                        description: 'Adresse du contrat Solana'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Token désactivé avec succès',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string' },
                                        message: { type: 'string' },
                                        data: {
                                            $ref: '#/components/schemas/Token'
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '404': {
                        description: 'Token non trouvé'
                    }
                }
            }
        },
        '/api/tokens/{address}/activate': {
            patch: {
                summary: 'Réactive un token',
                description: 'Réactive le token dans SQLite (reprend l\'acquisition des données)',
                parameters: [
                    {
                        in: 'path',
                        name: 'address',
                        required: true,
                        schema: {
                            type: 'string'
                        },
                        description: 'Adresse du contrat Solana'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Token réactivé avec succès',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string' },
                                        message: { type: 'string' },
                                        data: {
                                            $ref: '#/components/schemas/Token'
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '404': {
                        description: 'Token non trouvé'
                    }
                }
            }
        },
        '/api/ohlcv/raw/{address}': {
            get: {
                summary: 'Récupère les données brutes d\'un token',
                parameters: [
                    {
                        in: 'path',
                        name: 'address',
                        required: true,
                        schema: {
                            type: 'string'
                        },
                        description: 'Adresse du contrat Solana'
                    },
                    {
                        in: 'query',
                        name: 'start',
                        schema: {
                            type: 'string',
                            format: 'date-time'
                        },
                        description: 'Date de début (optionnel)'
                    },
                    {
                        in: 'query',
                        name: 'end',
                        schema: {
                            type: 'string',
                            format: 'date-time'
                        },
                        description: 'Date de fin (optionnel)'
                    },
                    {
                        in: 'query',
                        name: 'limit',
                        schema: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 1000,
                            default: 100
                        },
                        description: 'Nombre maximum de résultats'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Données brutes',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: {
                                            type: 'string',
                                            example: 'success'
                                        },
                                        data: {
                                            type: 'array',
                                            items: {
                                                $ref: '#/components/schemas/RawData'
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/api/ohlcv/{address}/{timeframe}': {
            get: {
                summary: 'Récupère les données OHLCV d\'un token',
                parameters: [
                    {
                        in: 'path',
                        name: 'address',
                        required: true,
                        schema: {
                            type: 'string'
                        },
                        description: 'Adresse du contrat Solana'
                    },
                    {
                        in: 'path',
                        name: 'timeframe',
                        required: true,
                        schema: {
                            type: 'string',
                            enum: ['1m', '5m', '15m', '1h', '4h', '1d']
                        },
                        description: 'Intervalle de temps'
                    },
                    {
                        in: 'query',
                        name: 'start',
                        schema: {
                            type: 'string',
                            format: 'date-time'
                        },
                        description: 'Date de début (optionnel)'
                    },
                    {
                        in: 'query',
                        name: 'end',
                        schema: {
                            type: 'string',
                            format: 'date-time'
                        },
                        description: 'Date de fin (optionnel)'
                    },
                    {
                        in: 'query',
                        name: 'limit',
                        schema: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 1000,
                            default: 100
                        },
                        description: 'Nombre maximum de résultats'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Données OHLCV',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: {
                                            type: 'string',
                                            example: 'success'
                                        },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                token: {
                                                    type: 'string'
                                                },
                                                timeframe: {
                                                    type: 'string'
                                                },
                                                ohlcv: {
                                                    type: 'array',
                                                    items: {
                                                        $ref: '#/components/schemas/OHLCV'
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/api/ohlcv/rsi-performance/{address}/{timeframe}': {
            get: {
                summary: 'Analyse des performances basées sur le RSI',
                description: 'Calcule la performance moyenne des bougies selon leur RSI et le type d\'opération',
                parameters: [
                    {
                        in: 'path',
                        name: 'address',
                        required: true,
                        schema: {
                            type: 'string'
                        },
                        description: 'Adresse du contrat Solana'
                    },
                    {
                        in: 'path',
                        name: 'timeframe',
                        required: true,
                        schema: {
                            type: 'string',
                            enum: ['1m', '5m', '15m', '1h', '4h', '1d']
                        },
                        description: 'Intervalle de temps'
                    },
                    {
                        in: 'query',
                        name: 'rsi_target',
                        required: true,
                        schema: {
                            type: 'number',
                            minimum: 0,
                            maximum: 100
                        },
                        description: 'Valeur RSI cible'
                    },
                    {
                        in: 'query',
                        name: 'operation',
                        required: true,
                        schema: {
                            type: 'string',
                            enum: ['achat', 'vente']
                        },
                        description: 'Type d\'opération (achat ou vente)'
                    },
                    {
                        in: 'query',
                        name: 'n',
                        schema: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 100,
                            default: 10
                        },
                        description: 'Nombre de bougies à analyser'
                    },
                    {
                        in: 'query',
                        name: 'negative_offset',
                        schema: {
                            type: 'number',
                            minimum: 0,
                            maximum: 50,
                            default: 5
                        },
                        description: 'Offset négatif pour la plage RSI'
                    },
                    {
                        in: 'query',
                        name: 'positive_offset',
                        schema: {
                            type: 'number',
                            minimum: 0,
                            maximum: 50,
                            default: 10
                        },
                        description: 'Offset positif pour la plage RSI'
                    }
                ],
                responses: {
                    '200': {
                        description: 'Analyse RSI performance',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: {
                                            type: 'string',
                                            example: 'success'
                                        },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                token: {
                                                    type: 'string'
                                                },
                                                rsi_target: {
                                                    type: 'number'
                                                },
                                                operation: {
                                                    type: 'string'
                                                },
                                                timeframe: {
                                                    type: 'string'
                                                },
                                                total_bougies_trouvees: {
                                                    type: 'integer',
                                                    description: 'Nombre total de bougies dans la plage RSI'
                                                },
                                                bougies_valides: {
                                                    type: 'integer',
                                                    description: 'Nombre de bougies avec performance valide'
                                                },
                                                moyenne_variation: {
                                                    type: 'number',
                                                    description: 'Variation moyenne en pourcentage'
                                                },
                                                variations: {
                                                    type: 'array',
                                                    items: {
                                                        $ref: '#/components/schemas/RSIPerformance'
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '404': {
                        description: 'Token non trouvé ou pas assez de données'
                    },
                    '500': {
                        description: 'Erreur serveur'
                    }
                }
            }
        },
        '/api/backfill/token': {
            post: {
                tags: ['Backfill'],
                summary: 'Rattrapage de données pour un token spécifique',
                description: 'Récupère et recalcule intelligemment les données manquantes pour un token sur une période donnée. Utilise 2 étapes: (1) Récupération des raw_prices manquantes depuis GeckoTerminal, (2) Recalcul sélectif des bougies avec qualité < 90%.',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                oneOf: [
                                    {
                                        type: 'object',
                                        required: ['tokenAddress', 'startDate', 'endDate'],
                                        properties: {
                                            tokenAddress: {
                                                type: 'string',
                                                description: 'Adresse du contrat du token',
                                                example: 'ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon'
                                            },
                                            startDate: {
                                                type: 'string',
                                                format: 'date-time',
                                                description: 'Date de début (ISO 8601)',
                                                example: '2025-10-20T00:00:00Z'
                                            },
                                            endDate: {
                                                type: 'string',
                                                format: 'date-time',
                                                description: 'Date de fin (ISO 8601)',
                                                example: '2025-10-22T23:59:59Z'
                                            }
                                        }
                                    },
                                    {
                                        type: 'object',
                                        required: ['tokenAddress', 'hours'],
                                        properties: {
                                            tokenAddress: {
                                                type: 'string',
                                                description: 'Adresse du contrat du token',
                                                example: 'ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon'
                                            },
                                            hours: {
                                                type: 'integer',
                                                description: 'Nombre d\'heures à rattraper (relatif à maintenant)',
                                                example: 24
                                            }
                                        }
                                    },
                                    {
                                        type: 'object',
                                        required: ['tokenAddress', 'days'],
                                        properties: {
                                            tokenAddress: {
                                                type: 'string',
                                                description: 'Adresse du contrat du token',
                                                example: 'ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon'
                                            },
                                            days: {
                                                type: 'integer',
                                                description: 'Nombre de jours à rattraper (relatif à maintenant)',
                                                example: 7
                                            }
                                        }
                                    }
                                ]
                            }
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'Backfill terminé avec succès',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: {
                                            type: 'string',
                                            example: 'success'
                                        },
                                        message: {
                                            type: 'string',
                                            example: 'Backfill terminé'
                                        },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                token: {
                                                    type: 'string',
                                                    example: 'FROGG'
                                                },
                                                tokenAddress: {
                                                    type: 'string',
                                                    example: 'ADSXPGwP3riuvqYtwqogCD4Rfn1a6NASqaSpThpsmoon'
                                                },
                                                period: {
                                                    type: 'object',
                                                    properties: {
                                                        start: { type: 'string', format: 'date-time' },
                                                        end: { type: 'string', format: 'date-time' }
                                                    }
                                                },
                                                step1: {
                                                    type: 'object',
                                                    properties: {
                                                        candlesFromGecko: { type: 'integer', description: 'Candles récupérées depuis GeckoTerminal' },
                                                        rawPricesInserted: { type: 'integer', description: 'Raw prices insérées (nouvelles)' },
                                                        rawPricesSkipped: { type: 'integer', description: 'Raw prices skippées (déjà existantes)' }
                                                    }
                                                },
                                                step2: {
                                                    type: 'object',
                                                    properties: {
                                                        totalPeriods: { type: 'integer', description: 'Nombre total de périodes vérifiées' },
                                                        candlesRecalculated: { type: 'integer', description: 'Bougies recalculées (qualité < 90%)' },
                                                        candlesSkipped: { type: 'integer', description: 'Bougies skippées (qualité OK)' },
                                                        candlesCreated: { type: 'integer', description: 'Bougies créées (manquantes)' }
                                                    }
                                                },
                                                success: { type: 'boolean' }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '400': {
                        description: 'Paramètres invalides'
                    },
                    '500': {
                        description: 'Erreur serveur'
                    }
                }
            }
        },
        '/api/backfill/all': {
            post: {
                tags: ['Backfill'],
                summary: 'Rattrapage de données pour tous les tokens (rupture de service)',
                description: 'Récupère et recalcule intelligemment les données manquantes pour TOUS les tokens actifs sur une période donnée. Utile après une panne ou interruption du service.',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                oneOf: [
                                    {
                                        type: 'object',
                                        required: ['startDate', 'endDate'],
                                        properties: {
                                            startDate: {
                                                type: 'string',
                                                format: 'date-time',
                                                description: 'Date de début (ISO 8601)',
                                                example: '2025-10-23T12:00:00Z'
                                            },
                                            endDate: {
                                                type: 'string',
                                                format: 'date-time',
                                                description: 'Date de fin (ISO 8601)',
                                                example: '2025-10-23T18:00:00Z'
                                            }
                                        }
                                    },
                                    {
                                        type: 'object',
                                        required: ['hours'],
                                        properties: {
                                            hours: {
                                                type: 'integer',
                                                description: 'Nombre d\'heures à rattraper (relatif à maintenant)',
                                                example: 6
                                            }
                                        }
                                    },
                                    {
                                        type: 'object',
                                        required: ['days'],
                                        properties: {
                                            days: {
                                                type: 'integer',
                                                description: 'Nombre de jours à rattraper (relatif à maintenant)',
                                                example: 1
                                            }
                                        }
                                    }
                                ]
                            }
                        }
                    }
                },
                responses: {
                    '200': {
                        description: 'Backfill global terminé',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string', example: 'success' },
                                        message: { type: 'string', example: 'Backfill global terminé' },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                totalTokens: { type: 'integer' },
                                                successful: { type: 'integer' },
                                                failed: { type: 'integer' },
                                                period: {
                                                    type: 'object',
                                                    properties: {
                                                        start: { type: 'string', format: 'date-time' },
                                                        end: { type: 'string', format: 'date-time' }
                                                    }
                                                },
                                                results: {
                                                    type: 'array',
                                                    items: {
                                                        type: 'object',
                                                        properties: {
                                                            token: { type: 'string' },
                                                            tokenAddress: { type: 'string' },
                                                            step1: { type: 'object' },
                                                            step2: { type: 'object' },
                                                            success: { type: 'boolean' }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    '400': {
                        description: 'Paramètres invalides'
                    },
                    '500': {
                        description: 'Erreur serveur'
                    }
                }
            }
        },
        '/api/backfill/status': {
            get: {
                tags: ['Backfill'],
                summary: 'Vérifier le statut du système de backfill',
                description: 'Retourne si un backfill est en cours et le seuil de qualité configuré',
                responses: {
                    '200': {
                        description: 'Statut du backfill',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string', example: 'success' },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                isProcessing: {
                                                    type: 'boolean',
                                                    description: 'True si un backfill est en cours'
                                                },
                                                qualityThreshold: {
                                                    type: 'number',
                                                    description: 'Seuil de qualité (0.9 = 90%)',
                                                    example: 0.9
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};

module.exports = swaggerDefinition;