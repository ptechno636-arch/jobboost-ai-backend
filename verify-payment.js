// backend/api/verify-payment.js
// Route Express : POST /api/payment/verify
// Vérifie une transaction RÉELLEMENT auprès de CinetPay (jamais sur la seule
// foi du retour navigateur sur success.html). Met à jour Firestore de façon
// idempotente pour éviter les doubles crédits.

'use strict';

const express = require('express');
const { db, admin, requireAuth } = require('../lib/firebaseAdmin');
const { PLANS } = require('../lib/config');

const router = express.Router();

const CINETPAY_CHECK_URL = 'https://api-checkout.cinetpay.com/v2/payment/check';

async function checkWithCinetpay(transactionId) {
  const apiKey = process.env.CINETPAY_API_KEY;
  const siteId = process.env.CINETPAY_SITE_ID;

  const cinetpayRes = await fetch(CINETPAY_CHECK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: apiKey, site_id: siteId, transaction_id: transactionId })
  });

  if (!cinetpayRes.ok) {
    throw new Error('CINETPAY_UNAVAILABLE');
  }
  return cinetpayRes.json();
}

/**
 * Applique un paiement confirmé au compte utilisateur, de façon idempotente
 * (transaction Firestore atomique : ne crédite jamais deux fois la même
 * transaction).
 */
async function applyConfirmedPayment(transactionId) {
  return db.runTransaction(async (t) => {
    const txRef = db.collection('transactions').doc(transactionId);
    const txSnap = await t.get(txRef);

    if (!txSnap.exists) {
      throw new Error('TRANSACTION_NOT_FOUND');
    }
    const tx = txSnap.data();

    if (tx.status === 'confirmed') {
      // Déjà traité : ne rien refaire (protection anti double-crédit)
      return { alreadyProcessed: true, tx };
    }

    const plan = PLANS[tx.planId.toUpperCase()];
    if (!plan) {
      throw new Error('UNKNOWN_PLAN');
    }

    const userRef = db.collection('users').doc(tx.uid);
    const userSnap = await t.get(userRef);
    if (!userSnap.exists) {
      throw new Error('USER_NOT_FOUND');
    }

    const now = new Date();
    const expiresAt = plan.durationDays
      ? new Date(now.getTime() + plan.durationDays * 86400000).toISOString()
      : null;

    t.update(userRef, {
      plan: plan.id,
      credits: admin.firestore.FieldValue.increment(plan.credits),
      letters: admin.firestore.FieldValue.increment(plan.letters),
      cvGold: admin.firestore.FieldValue.increment(plan.cvGold),
      planExpiresAt: expiresAt,
      updatedAt: now.toISOString()
    });

    t.update(txRef, {
      status: 'confirmed',
      confirmedAt: now.toISOString()
    });

    return { alreadyProcessed: false, tx: { ...tx, status: 'confirmed' } };
  });
}

router.post('/verify', requireAuth, async (req, res) => {
  const { transactionId } = req.body || {};
  if (!transactionId) {
    return res.status(400).json({ error: 'MISSING_TRANSACTION_ID', message: 'Identifiant de transaction manquant.' });
  }

  try {
    const txRef = db.collection('transactions').doc(transactionId);
    const txSnap = await txRef.get();
    if (!txSnap.exists) {
      return res.status(404).json({ error: 'TRANSACTION_NOT_FOUND', message: 'Transaction introuvable.' });
    }
    const tx = txSnap.data();

    // Un utilisateur ne peut vérifier que SA PROPRE transaction.
    if (tx.uid !== req.uid) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Cette transaction ne vous appartient pas.' });
    }

    const cinetpayResult = await checkWithCinetpay(transactionId);

    // CinetPay renvoie code "00" pour un paiement accepté.
    if (cinetpayResult.code === '00' || cinetpayResult.data?.status === 'ACCEPTED') {
      // Vérifier le montant et la devise avant de créditer.
      const plan = PLANS[tx.planId.toUpperCase()];
      const paidAmount = Number(cinetpayResult.data?.amount);
      const paidCurrency = cinetpayResult.data?.currency;

      if (plan && (paidAmount !== plan.price || paidCurrency !== plan.currency)) {
        await txRef.update({ status: 'amount_mismatch', updatedAt: new Date().toISOString() });
        return res.status(409).json({ error: 'AMOUNT_MISMATCH', message: 'Le montant payé ne correspond pas au plan choisi.' });
      }

      const result = await applyConfirmedPayment(transactionId);
      return res.json({
        success: true,
        status: 'confirmed',
        plan: tx.planId,
        amount: tx.amount,
        currency: tx.currency,
        alreadyProcessed: result.alreadyProcessed
      });
    }

    if (cinetpayResult.data?.status === 'PENDING') {
      return res.json({ success: false, status: 'pending', message: 'Paiement en attente de confirmation.' });
    }

    // Refusé, annulé, ou tout autre statut
    await txRef.update({ status: 'failed', updatedAt: new Date().toISOString() });
    return res.json({ success: false, status: 'failed', message: 'Le paiement n\'a pas été finalisé.' });
  } catch (err) {
    console.error('[payment/verify] Erreur inattendue:', err);
    if (err.message === 'CINETPAY_UNAVAILABLE') {
      return res.status(503).json({ error: 'CINETPAY_UNAVAILABLE', message: 'CinetPay est indisponible pour le moment.' });
    }
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Impossible de vérifier ce paiement pour le moment.' });
  }
});

module.exports = { router, applyConfirmedPayment, checkWithCinetpay };
