// backend/server.js
// Point d'entrée du backend JobBoost AI.
// Déployable gratuitement sur Render.com, Railway, Fly.io ou Cloud Run
// (offres gratuites/à quota gratuit). GitHub Pages ne peut PAS exécuter ce
// backend car il ne sert que des fichiers statiques et ne peut pas cacher
// de clé secrète.

'use strict';

const express = require('express');
const cors = require('cors');

const geminiRoutes = require('./api/gemini');
const createPaymentRoutes = require('./api/create-payment');
const { router: verifyPaymentRoutes } = require('./api/verify-payment');
const webhookRoutes = require('./api/webhook');

const app = express();

// CORS restreint au domaine du frontend uniquement.
const allowedOrigin = process.env.APP_BASE_URL || '*';
app.use(cors({ origin: allowedOrigin }));

app.use(express.json({ limit: '1mb' }));

// Limite basique de débit par IP pour éviter les abus sur les routes coûteuses.
const rateLimit = require('./lib/rateLimit');
app.use('/api/gemini', rateLimit(10, 60_000)); // 10 requêtes / minute / IP
app.use('/api/payment', rateLimit(20, 60_000));

app.use('/api/gemini', geminiRoutes);
app.use('/api/payment', createPaymentRoutes);
app.use('/api/payment', verifyPaymentRoutes);
app.use('/api/payment', webhookRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Erreur serveur inattendue.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`JobBoost AI backend démarré sur le port ${PORT}`));

module.exports = app;
