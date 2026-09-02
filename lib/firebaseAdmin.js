// backend/lib/firebaseAdmin.js
// Initialise Firebase Admin côté serveur. Utilise les identifiants d'un
// compte de service (jamais exposés au frontend).

'use strict';

const admin = require('firebase-admin');

if (!admin.apps.length) {
  // En production (Render, Railway, Fly.io, Cloud Run...), stocke le JSON du
  // compte de service dans la variable d'environnement FIREBASE_SERVICE_ACCOUNT
  // (le contenu complet du fichier JSON, en une seule ligne).
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    console.error(
      '[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT manquant. ' +
      'Le backend ne peut pas vérifier les utilisateurs ni écrire dans Firestore.'
    );
  } else {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
}

const db = admin.apps.length ? admin.firestore() : null;
const auth = admin.apps.length ? admin.auth() : null;

/**
 * Middleware Express : vérifie le token Firebase ID envoyé par le frontend
 * dans l'en-tête Authorization: Bearer <token>.
 * Ne fait JAMAIS confiance à un uid envoyé dans le corps de la requête.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Utilisateur non connecté.' });
    }

    if (!auth) {
      return res.status(500).json({ error: 'SERVER_MISCONFIGURED', message: 'Firebase Admin non initialisé.' });
    }

    const decoded = await auth.verifyIdToken(token);
    req.uid = decoded.uid;
    req.userEmail = decoded.email || null;
    next();
  } catch (err) {
    console.error('[requireAuth] Token invalide:', err.message);
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Session invalide ou expirée.' });
  }
}

module.exports = { admin, db, auth, requireAuth };
