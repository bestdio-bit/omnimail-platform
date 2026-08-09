const db = require('../db');

/**
 * Authentication Middleware
 * Validates Authorization Bearer token against api_keys table
 * Attaches req.auth = { org_id, role, key_id, name }
 */
async function authenticateKey(req, res, next) {
  let token = null;

  // 1. Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1].trim();
  }

  // 2. Check Cookie header if no Bearer token
  if (!token && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const cookie of cookies) {
      const [name, val] = cookie.trim().split('=');
      if (name === 'omni_session' && val) {
        token = val;
        break;
      }
    }
  }

  if (!token) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid authentication token. Please provide a valid API key or login session.'
    });
  }

  const now = Date.now();

  // Check if token is a user session
  if (token.startsWith('tok_session_')) {
    const sessionRecord = await db.prepare(`
      SELECT s.id as session_id, s.user_id, s.org_id, s.expires_at, u.name, u.role, u.is_verified
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ?
    `).get(token);

    if (sessionRecord && sessionRecord.expires_at > now) {
      if (sessionRecord.is_verified === 0) {
        return res.status(403).json({
          error: 'email_not_verified',
          message: 'Email verification is required before accessing the dashboard.'
        });
      }

      req.auth = {
        key_id: 'session_' + sessionRecord.session_id,
        user_id: sessionRecord.user_id,
        org_id: sessionRecord.org_id,
        name: sessionRecord.name,
        role: sessionRecord.role,
        is_session: true
      };
      return next();
    }
  }

  // Otherwise, look up API key in SQLite
  const keyRecord = await db.prepare(`
    SELECT id, org_id, name, role, key_hash
    FROM api_keys
    WHERE key_hash = ?
  `).get(token);

  if (!keyRecord) {
    return res.status(401).json({
      error: 'invalid_api_key',
      message: 'The provided authentication token or API key does not exist or has expired.'
    });
  }

  // Update last_used_at timestamp asynchronously
  try {
    await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, keyRecord.id);
  } catch (err) {
    // Ignore timestamp update error
  }

  req.auth = {
    key_id: keyRecord.id,
    org_id: keyRecord.org_id,
    name: keyRecord.name,
    role: keyRecord.role,
    is_session: false
  };

  next();
}

module.exports = { authenticateKey };
