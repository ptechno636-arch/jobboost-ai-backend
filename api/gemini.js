'use strict';

const express = require('express');
const { db, requireAuth } = require('../lib/firebaseAdmin');
const { GEMINI_MODEL } = require('../lib/config');

const router = express.Router();

const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

function buildGeminiPrompt(cvText, targetJob) {
  return `Tu es un expert international en recrutement, CV, ATS et rédaction professionnelle.

Analyse le CV fourni ci-dessous et améliore-le pour le poste recherché.

Poste recherché :
${targetJob}

CV :
"""
${cvText}
"""

Objectifs :
- corriger les fautes d'orthographe et de grammaire
- améliorer la clarté et la formulation
- professionnaliser les descriptions d'expérience
- conserver STRICTEMENT les faits fournis dans le CV original
- optimiser le CV pour le poste recherché (mots-clés ATS)
- améliorer la structure globale
- identifier les sections faibles et donner des recommandations concrètes
- calculer un score ATS estimé entre 0 et 100

INTERDICTION ABSOLUE D'INVENTER DES INFORMATIONS : aucun diplôme, aucune
expérience, aucune entreprise, aucune compétence, aucune certification,
aucune langue, aucun poste, aucune date, aucun numéro de téléphone, aucune
adresse et aucun résultat professionnel ne doit être inventé. Si une
information n'est pas présente dans le CV fourni, laisse le champ vide (""
ou []) ou indique la chaîne "[Information manquante]" dans le champ
concerné. Ne complète jamais un trou par une supposition.

Retourne UNIQUEMENT un objet JSON valide, sans texte autour, sans balises
Markdown, respectant exactement cette structure :

{
  "personal": {
    "fullName": "",
    "jobTitle": "",
    "email": "",
    "phone": "",
    "location": "",
    "linkedin": ""
  },
  "summary": "",
  "skills": [],
  "experiences": [
    {
      "company": "",
      "position": "",
      "startDate": "",
      "endDate": "",
      "description": []
    }
  ],
  "education": [
    {
      "institution": "",
      "degree": "",
      "field": "",
      "startDate": "",
      "endDate": ""
    }
  ],
  "languages": [],
  "certifications": [],
  "projects": [],
  "recommendations": [],
  "atsScore": 0
}`;
}

function extractJson(rawText) {
  let text = rawText.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('NO_JSON_FOUND');
  }
  const candidate = text.slice(firstBrace, lastBrace + 1);
  return JSON.parse(candidate);
}

async function callGeminiForJson(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw { status: 500, code: 'SERVER_MISCONFIGURED', message: 'Clé Gemini non configurée côté serveur.' };

  let geminiResponse;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    geminiResponse = await fetch(GEMINI_ENDPOINT(GEMINI_MODEL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
  } catch (networkErr) {
    if (networkErr.name === 'AbortError') throw { status: 504, code: 'TIMEOUT', message: 'Gemini a mis trop de temps à répondre. Réessayez.' };
    throw { status: 503, code: 'NETWORK_ERROR', message: 'Impossible de contacter Gemini. Vérifiez votre connexion.' };
  }

  if (geminiResponse.status === 429) throw { status: 429, code: 'QUOTA_EXCEEDED', message: 'Quota Gemini gratuit dépassé. Réessayez plus tard.' };
  if (geminiResponse.status === 401 || geminiResponse.status === 403) throw { status: 500, code: 'INVALID_KEY', message: 'Clé Gemini invalide côté serveur.' };
  if (!geminiResponse.ok) throw { status: 502, code: 'GEMINI_UNAVAILABLE', message: 'Gemini est indisponible pour le moment.' };

  const geminiJson = await geminiResponse.json();
  const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw { status: 502, code: 'EMPTY_RESPONSE', message: 'Gemini a renvoyé une réponse vide.' };

  try {
    return extractJson(rawText);
  } catch (e) {
    throw { status: 502, code: 'PARSE_ERROR', message: 'La réponse de l\'IA n\'a pas pu être analysée. Réessayez.' };
  }
}

function admin_FieldValueIncrement(n) {
  const { admin } = require('../lib/firebaseAdmin');
  return admin.firestore.FieldValue.increment(n);
}

router.post('/analyze', requireAuth, async (req, res) => {
  const { cvText, targetJob } = req.body || {};

  if (!cvText || !cvText.trim()) {
    return res.status(400).json({ error: 'EMPTY_CV', message: 'Le CV est vide.' });
  }
  if (!targetJob || !targetJob.trim()) {
    return res.status(400).json({ error: 'EMPTY_JOB', message: 'Le poste recherché est vide.' });
  }
  if (cvText.length > 20000) {
    return res.status(400).json({ error: 'CV_TOO_LONG', message: 'Le CV est trop long (max 20000 caractères).' });
  }

  if (!db) {
    return res.status(500).json({ error: 'SERVER_MISCONFIGURED', message: 'Base de données indisponible.' });
  }

  const userRef = db.collection('users').doc(req.uid);

  try {
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Profil utilisateur introuvable.' });
    }
    const userData = userSnap.data();
    const credits = typeof userData.credits === 'number' ? userData.credits : 0;

    if (credits <= 0) {
      return res.status(402).json({
        error: 'NO_CREDITS',
        message: 'Vous n\'avez plus de crédits d\'analyse. Passez à un plan payant.'
      });
    }

    const prompt = buildGeminiPrompt(cvText, targetJob);
    const structuredCv = await callGeminiForJson(prompt);

    await userRef.update({
      credits: admin_FieldValueIncrement(-1),
      updatedAt: new Date().toISOString()
    });

    const docRef = await db.collection('users').doc(req.uid).collection('documents').add({
      type: 'cv_analysis',
      targetJob,
      result: structuredCv,
      createdAt: new Date().toISOString()
    });

    return res.json({ success: true, result: structuredCv, documentId: docRef.id, creditsRemaining: credits - 1 });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    console.error('[gemini/analyze] Erreur inattendue:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Une erreur interne est survenue.' });
  }
});

function buildCoverLetterPrompt({ cvText, targetJob, company, jobOffer }) {
  return `Tu es un rédacteur professionnel spécialisé dans les lettres de motivation.

CV du candidat :
"""
${cvText}
"""

Poste recherché : ${targetJob}
Entreprise : ${company || '[Information manquante]'}
Offre d'emploi (si fournie) :
"""
${jobOffer || ''}
"""

Rédige une lettre de motivation professionnelle en français, en te basant
UNIQUEMENT sur les informations réellement présentes dans le CV. N'invente
aucune expérience, compétence, diplôme ou résultat qui ne figure pas dans le
CV fourni. Si une information nécessaire manque, reste général plutôt que
d'inventer.

Retourne UNIQUEMENT un JSON valide, sans texte autour :
{
  "subject": "",
  "body": "",
  "wordCount": 0
}`;
}

function buildMatchPrompt({ cvText, jobOffer }) {
  return `Tu es un expert en recrutement et systèmes ATS.

CV du candidat :
"""
${cvText}
"""

Offre d'emploi :
"""
${jobOffer}
"""

Compare le CV et l'offre d'emploi. N'invente aucune compétence : une
compétence ne peut être listée comme "présente" que si elle figure
explicitement dans le CV fourni.

Retourne UNIQUEMENT un JSON valide, sans texte autour :
{
  "matchScore": 0,
  "matchingSkills": [],
  "missingSkills": [],
  "importantKeywords": [],
  "recommendations": []
}`;
}

router.post('/cover-letter', requireAuth, async (req, res) => {
  const { cvText, targetJob, company, jobOffer } = req.body || {};
  if (!cvText || !cvText.trim()) return res.status(400).json({ error: 'EMPTY_CV', message: 'Le CV est vide.' });
  if (!targetJob || !targetJob.trim()) return res.status(400).json({ error: 'EMPTY_JOB', message: 'Le poste recherché est vide.' });

  const userRef = db.collection('users').doc(req.uid);
  try {
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Profil utilisateur introuvable.' });
    const letters = typeof userSnap.data().letters === 'number' ? userSnap.data().letters : 0;
    if (letters <= 0) {
      return res.status(402).json({ error: 'NO_LETTER_CREDITS', message: 'Vous n\'avez plus de crédits pour générer une lettre. Passez à un plan payant.' });
    }

    const result = await callGeminiForJson(buildCoverLetterPrompt({ cvText, targetJob, company, jobOffer }));

    await userRef.update({ letters: admin_FieldValueIncrement(-1), updatedAt: new Date().toISOString() });
    const docRef = await userRef.collection('documents').add({
      type: 'cover_letter', targetJob, company: company || '', result, createdAt: new Date().toISOString()
    });

    return res.json({ success: true, result, documentId: docRef.id, lettersRemaining: letters - 1 });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    console.error('[gemini/cover-letter] Erreur inattendue:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Une erreur interne est survenue.' });
  }
});

router.post('/match', requireAuth, async (req, res) => {
  const { cvText, jobOffer } = req.body || {};
  if (!cvText || !cvText.trim()) return res.status(400).json({ error: 'EMPTY_CV', message: 'Le CV est vide.' });
  if (!jobOffer || !jobOffer.trim()) return res.status(400).json({ error: 'EMPTY_JOB_OFFER', message: 'L\'offre d\'emploi est vide.' });

  const userRef = db.collection('users').doc(req.uid);
  try {
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Profil utilisateur introuvable.' });
    const credits = typeof userSnap.data().credits === 'number' ? userSnap.data().credits : 0;
    if (credits <= 0) {
      return res.status(402).json({ error: 'NO_CREDITS', message: 'Vous n\'avez plus de crédits d\'analyse. Passez à un plan payant.' });
    }

    const result = await callGeminiForJson(buildMatchPrompt({ cvText, jobOffer }));

    await userRef.update({ credits: admin_FieldValueIncrement(-1), updatedAt: new Date().toISOString() });
    const docRef = await userRef.collection('documents').add({
      type: 'job_match', result, createdAt: new Date().toISOString()
    });

    return res.json({ success: true, result, documentId: docRef.id, creditsRemaining: credits - 1 });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    console.error('[gemini/match] Erreur inattendue:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Une erreur interne est survenue.' });
  }
});

module.exports = router;
