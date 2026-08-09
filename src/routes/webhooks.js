const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

// 1. Inbound Normalized Webhook Processor (No Bearer Token Required!)
// Receives bounce/complaint webhooks from external gateways and auto-suppresses addresses
router.post('/inbound/generic', express.json(), async (req, res) => {
  const { type, email, detail = {} } = req.body;
  if (!type || !email) {
    return res.status(400).json({ success: false, error: 'missing_fields', message: 'type and email are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const now = Date.now();

  // Find organization by looking up most recent email sent to this address
  const lastEmail = await db.prepare('SELECT org_id, id FROM emails WHERE LOWER(to_address) = ? ORDER BY queued_at DESC LIMIT 1').get(cleanEmail);
  const targetOrgId = lastEmail?.org_id || 'org_demo_omnimail_001';

  await db.transaction(async () => {
    // 1. Update email status if bounced
    if (lastEmail && (type === 'bounce' || type === 'complaint')) {
      await db.prepare("UPDATE emails SET status = ?, error_detail = ? WHERE id = ?").run(type === 'bounce' ? 'bounced' : 'sent', JSON.stringify(detail), lastEmail.id);
    }

    // 2. Add to suppressions table
    const reason = type === 'complaint' ? 'complaint' : 'bounce';
    await db.prepare(`
      INSERT OR REPLACE INTO suppressions (id, org_id, email, reason, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('sup_in_' + now + '_' + Math.random().toString(36).substring(2, 6), targetOrgId, cleanEmail, reason, JSON.stringify(detail), now);

    // 3. Emit event
    await db.prepare(`
      INSERT INTO events (id, org_id, email_id, name, type, payload_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('ev_in_' + now + '_' + Math.random().toString(36).substring(2, 6), targetOrgId, lastEmail?.id || null, `email.${type}`, type, JSON.stringify(detail), now);
  })();

  console.log(`📥 [Inbound Webhook] Processed '${type}' for address ${cleanEmail} -> Auto-suppressed.`);
  res.status(200).json({ success: true, message: 'Inbound webhook processed and address auto-suppressed.' });
});

// Apply authentication to management routes
router.use(authenticateKey);

/**
 * GET /api/webhooks
 */
router.get('/', requireRole('owner', 'admin', 'developer', 'read_only'), async (req, res) => {
  const webhooks = await db.prepare('SELECT * FROM webhooks WHERE org_id = ? ORDER BY created_at DESC').all(req.auth.org_id);
  for (const w of webhooks) w.events = JSON.parse(w.events_json || '[]');
  res.json({ success: true, data: webhooks });
});

/**
 * POST /api/webhooks
 */
router.post('/', requireRole('owner', 'admin', 'developer'), async (req, res) => {
  const { url, events = ['open', 'click', 'bounce', 'complaint'] } = req.body;
  if (!url) {
    return res.status(400).json({ success: false, error: 'missing_url', message: 'Webhook URL is required.' });
  }

  const now = Date.now();
  const id = 'wh_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const secret = 'whsec_omni_' + Math.random().toString(36).substring(2, 15);

  db.prepare(`
    INSERT INTO webhooks (id, org_id, url, events_json, secret, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(id, req.auth.org_id, url, JSON.stringify(events), secret, now);

  logAudit(req.auth.org_id, req.auth.key_id, 'webhook_created', 'webhook', id, { url, events });

  res.status(201).json({ success: true, data: { id, url, events, secret, status: 'active' }, message: 'Webhook registered successfully.' });
});

/**
 * DELETE /api/webhooks/:id
 */
router.delete('/:id', requireRole('owner', 'admin', 'developer'), async (req, res) => {
  const info = await db.prepare('DELETE FROM webhooks WHERE id = ? AND org_id = ?').run(req.params.id, req.auth.org_id);
  if (info.changes === 0) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Webhook not found.' });
  }
  logAudit(req.auth.org_id, req.auth.key_id, 'webhook_deleted', 'webhook', req.params.id);
  res.json({ success: true, message: 'Webhook deleted successfully.' });
});

module.exports = router;
