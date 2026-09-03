// backend/lib/config.js
// SOURCE UNIQUE DE VÉRITÉ pour le modèle Gemini, les plans tarifaires et les
// limites gratuites. Ne jamais dupliquer ces valeurs ailleurs.

'use strict';

// Change le modèle Gemini ici UNIQUEMENT. Tout le reste du code l'importe
// depuis ce fichier.
const GEMINI_MODEL = 'gemini-2.5-flash-lite';

const PLANS = {
  FREE: {
    id: 'free',
    label: 'FREE',
    price: 0,
    currency: 'EUR',
    credits: 1,
    letters: 0,
    cvGold: 0,
    durationDays: null // illimité dans le temps, limité en crédits
  },
  PRO: {
    id: 'pro',
    label: 'PRO',
    price: 1,
    currency: 'EUR',
    credits: 5,
    letters: 2,
    cvGold: 0,
    durationDays: null // achat unique de crédits
  },
  PREMIUM: {
    id: 'premium',
    label: 'PREMIUM',
    price: 4,
    currency: 'EUR',
    credits: 20,
    letters: 10,
    cvGold: 1,
    durationDays: 30 // abonnement mensuel
  },
  GOLD: {
    id: 'gold',
    label: 'GOLD',
    price: 8,
    currency: 'EUR',
    credits: 999999, // "illimité" en pratique mais jamais promis comme tel à l'utilisateur
    letters: 999999,
    cvGold: 999999,
    durationDays: 365 // abonnement annuel
  }
};

const FREE_LIMITS = {
  cvAnalyses: 1,
  letters: 0,
  cvGold: 0
};

// Canaux de paiement CinetPay proposés au Togo.
const CINETPAY_CHANNELS = 'ALL'; // CinetPay route automatiquement TMoney / Flooz / Visa / Mastercard selon le pays

module.exports = {
  GEMINI_MODEL,
  PLANS,
  FREE_LIMITS,
  CINETPAY_CHANNELS
};
