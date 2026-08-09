const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateToken } = require('../lib/crypto');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

router.use(authenticateKey);

const ALLOWED_ROLES = ['owner', 'admin', 'developer', 'marketer', 'billing', 'read_only'];

/**
 * GET /api/keys
 * List API keys scoped by role with last-used timestamps
 */
router.get('/', requireRole('owner', 'admin', 'developer', 'billing', 'read_only'), async (req, res) => {
  const keys = await db.prepare('SELECT id, name, key_prefix, role, last_used_at, created_at FROM api_keys WHERE org_id = ? ORDER BY created_at DESC').all(req.auth.org_id);
  res.json({ success: true, data: keys });
});

/**
 * POST /api/keys
 * Create new API key scoped by RBAC role
 */
router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  const { name, role = 'developer' } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, error: 'missing_name', message: 'Key name is required.' });
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ success: false, error: 'invalid_role', message: `Role must be one of: [${ALLOWED_ROLES.join(', ')}]` });
  }

  // Security check: only owners can mint owner/admin keys
  if ((role === 'owner' || role === 'admin') && req.auth.role !== 'owner') {
    return res.status(403).json({ success: false, error: 'forbidden_role_elevation', message: 'Only an Owner can generate Admin or Owner API keys.' });
  }

  const now = Date.now();
  const id = 'key_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const rawToken = 'omni_live_' + generateToken(32);
  const prefix = rawToken.substring(0, 14);

  db.prepare(`
    INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.auth.org_id, name, rawToken, prefix, role, now);

  logAudit(req.auth.org_id, req.auth.key_id, 'api_key_created', 'api_key', id, { name, role });

  res.status(201).json({
    success: true,
    data: { id, name, role, token: rawToken, prefix, created_at: now },
    message: 'API key created successfully! Save the token now; it will never be displayed again.'
  });
});

/**
 * DELETE /api/keys/:id
 * Revoke API key
 */
router.delete('/:id', requireRole('owner', 'admin'), async (req, res) => {
  // Prevent deleting current key
  if (req.params.id === req.auth.key_id) {
    return res.status(400).json({ success: false, error: 'cannot_revoke_self', message: 'You cannot revoke the API key currently in use.' });
  }

  const info = await db.prepare('DELETE FROM api_keys WHERE id = ? AND org_id = ?').run(req.params.id, req.auth.org_id);
  if (info.changes === 0) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'API key not found.' });
  }

  logAudit(req.auth.org_id, req.auth.key_id, 'api_key_revoked', 'api_key', req.params.id);
  res.json({ success: true, message: 'API key revoked immediately.' });
});

module.exports = router;
