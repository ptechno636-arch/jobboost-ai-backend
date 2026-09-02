// backend/lib/rateLimit.js
// Limiteur de débit simple, en mémoire, par IP. Suffisant pour une V1 sur
// une seule instance. Pour une charge plus importante, remplacer par un
// store partagé (Redis) — à prévoir en V2.

'use strict';

function rateLimit(maxRequests, windowMs) {
  const hits = new Map();

  return function (req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(ip) || { count: 0, resetAt: now + windowMs };

    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    hits.set(ip, entry);

    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Trop de requêtes. Réessayez dans un instant.' });
    }
    next();
  };
}

module.exports = rateLimit;
