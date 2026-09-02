// backend/api/webhook.js
// Route Express : POST /api/payment/webhook
// Reçoit la notification serveur-à-serveur de CinetPay (notify_url).
// C'est le canal FIABLE de confirmation (indépendant du retour navigateur).
// CinetPay peut appeler cette route même si l'utilisateur ferme son
// navigateur avant de revenir sur success.html.

'use strict';

const express = require('express');
const { db } = require('../lib/firebaseAdmin');
const { applyConfirmedPayment, checkWithCinetpay } = require('./verify-payment');
const { PLANS } = require('../lib/config');

const router = express.Router();

router.post('/webhook', express.urlencoded({ extended: true }), async (req, res) => {
  // CinetPay envoie généralement cet appel en x-www-form-urlencoded avec au
  // minimum cpm_trans_id (transaction_id).
  const transactionId = req.body.cpm_trans_id || req.body.transaction_id;

  if (!transactionId) {
    return res.status(400).send('MISSING_TRANSACTION_ID');
  }

  try {
    const txRef = db.collection('transactions').doc(transactionId);
    const txSnap = await txRef.get();
    if (!txSnap.exists) {
      console.warn(`[webhook] Transaction inconnue reçue: ${transactionId}`);
      return res.status(404).send('TRANSACTION_NOT_FOUND');
    }
    const tx = txSnap.data();

    // Toujours re-vérifier directement auprès de CinetPay : ne jamais faire
    // confiance au seul contenu du webhook (peut être falsifié).
    const cinetpayResult = await checkWithCinetpay(transactionId);

    if (cinetpayResult.code === '00' || cinetpayResult.data?.status === 'ACCEPTED') {
      const plan = PLANS[tx.planId.toUpperCase()];
      const paidAmount = Number(cinetpayResult.data?.amount);
      const paidCurrency = cinetpayResult.data?.currency;

      if (plan && (paidAmount !== plan.price || paidCurrency !== plan.currency)) {
        await txRef.update({ status: 'amount_mismatch' });
        return res.status(409).send('AMOUNT_MISMATCH');
      }

      await applyConfirmedPayment(transactionId);
      return res.status(200).send('OK');
    }

    if (cinetpayResult.data?.status !== 'PENDING') {
      await txRef.update({ status: 'failed', updatedAt: new Date().toISOString() });
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('[webhook] Erreur inattendue:', err);
    // Renvoyer 500 pour que CinetPay retente l'envoi du webhook plus tard.
    return res.status(500).send('INTERNAL_ERROR');
  }
});

module.exports = router;
