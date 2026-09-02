// backend/api/create-payment.js
// Route Express : POST /api/payment/create
// Crée une VRAIE transaction CinetPay. Aucune clé secrète n'est jamais
// envoyée au frontend : le backend appelle CinetPay et ne renvoie que
// l'URL de paiement.

'use strict';

const express = require('express');
const crypto = require('crypto');
const { db, requireAuth } = require('../lib/firebaseAdmin');
const { PLANS, CINETPAY_CHANNELS } = require('../lib/config');

const router = express.Router();

const CINETPAY_INIT_URL = 'https://api-checkout.cinetpay.com/v2/payment';

router.post('/create', requireAuth, async (req, res) => {
  const { planId } = req.body || {};
  const plan = planId && PLANS[planId.toUpperCase()];

  if (!plan || plan.id === 'free') {
    return res.status(400).json({ error: 'INVALID_PLAN', message: 'Plan invalide.' });
  }

  const apiKey = process.env.CINETPAY_API_KEY;
  const siteId = process.env.CINETPAY_SITE_ID;
  const appBaseUrl = process.env.APP_BASE_URL; // ex: https://jobboost-ai.example.com

  if (!apiKey || !siteId || !appBaseUrl) {
    return res.status(500).json({ error: 'SERVER_MISCONFIGURED', message: 'CinetPay non configuré côté serveur.' });
  }

  const transactionId = `JB-${req.uid.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  try {
    // 1. Enregistrer la transaction en attente AVANT d'appeler CinetPay,
    //    pour pouvoir la retrouver et la vérifier plus tard (anti-fraude).
    await db.collection('transactions').doc(transactionId).set({
      transactionId,
      uid: req.uid,
      planId: plan.id,
      amount: plan.price,
      currency: plan.currency,
      status: 'pending',
      createdAt: new Date().toISOString()
    });

    // 2. Demander à CinetPay de créer le paiement
    const payload = {
      apikey: apiKey,
      site_id: siteId,
      transaction_id: transactionId,
      amount: plan.price,
      currency: plan.currency,
      description: `JobBoost AI - Plan ${plan.label}`,
      notify_url: `${appBaseUrl}/api/payment/webhook`,
      return_url: `${appBaseUrl}/success.html?tx=${transactionId}`,
      cancel_url: `${appBaseUrl}/cancel.html?tx=${transactionId}`,
      channels: CINETPAY_CHANNELS,
      metadata: JSON.stringify({ uid: req.uid, planId: plan.id }),
      customer_id: req.uid
    };

    const cinetpayRes = await fetch(CINETPAY_INIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!cinetpayRes.ok) {
      return res.status(502).json({ error: 'CINETPAY_UNAVAILABLE', message: 'CinetPay est indisponible pour le moment.' });
    }

    const cinetpayJson = await cinetpayRes.json();

    if (cinetpayJson.code !== '201' && cinetpayJson.code !== 201) {
      return res.status(502).json({
        error: 'CINETPAY_ERROR',
        message: cinetpayJson.message || 'CinetPay a refusé la demande de paiement.'
      });
    }

    return res.json({
      success: true,
      transactionId,
      paymentUrl: cinetpayJson.data.payment_url
    });
  } catch (err) {
    console.error('[payment/create] Erreur inattendue:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Impossible de créer le paiement pour le moment.' });
  }
});

module.exports = router;
