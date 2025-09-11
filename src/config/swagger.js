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
            }
        }
    },
    paths: {
        '/api/tokens': {
            get: {
                summary: 'Liste tous les tokens suivis',
                responses: {
                    '200': {
                        description: 'Liste des tokens',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'array',
                                    items: {
                                        $ref: '#/components/schemas/Token'
                                    }
                                }
                            }
                        }
                    }
                }
            },
            post: {
                summary: 'Ajoute un nouveau token à suivre',
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
        '/api/tokens/{address}': {
            delete: {
                summary: 'Désactive le suivi d\'un token',
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
                                        status: {
                                            type: 'string',
                                            example: 'success'
                                        },
                                        message: {
                                            type: 'string',
                                            example: 'Token désactivé avec succès'
                                        },
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
                    },
                    '500': {
                        description: 'Erreur serveur'
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
        }
    }
};

module.exports = swaggerDefinition;