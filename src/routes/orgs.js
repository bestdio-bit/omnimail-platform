const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

router.use(authenticateKey);

/**
 * GET /api/orgs
 * Get current organization details and team members
 */
router.get('/', requireRole('owner', 'admin', 'developer', 'marketer', 'billing', 'read_only'), async (req, res) => {
  const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.auth.org_id);
  const users = await db.prepare('SELECT id, email, name, role, created_at FROM users WHERE org_id = ?').all(req.auth.org_id);
  
  res.json({ success: true, data: { ...org, team_members: users } });
});

/**
 * POST /api/orgs/sub-accounts
 * Create sub-account organization billed to one parent invoice
 */
router.post('/sub-accounts', requireRole('owner', 'admin'), async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, error: 'missing_name', message: 'Sub-account organization name is required.' });
  }

  const parentOrg = await db.prepare('SELECT plan_tier FROM orgs WHERE id = ?').get(req.auth.org_id);
  const now = Date.now();
  const subOrgId = 'org_sub_' + now + '_' + Math.random().toString(36).substring(2, 6);

  await db.transaction(async () => {
    await db.prepare(`
      INSERT INTO orgs (id, name, plan_tier, custom_send_volume, created_at)
      VALUES (?, ?, ?, 50000, ?)
    `).run(subOrgId, `${name} (Sub-account of ${req.auth.org_id})`, parentOrg?.plan_tier || 'entry', now);

    await db.prepare(`
      INSERT INTO users (id, org_id, email, name, role, created_at)
      VALUES (?, ?, ?, ?, 'owner', ?)
    `).run('usr_' + now, subOrgId, `admin+${subOrgId}@omnimail.local`, 'Sub-account Admin', now);
  })();

  logAudit(req.auth.org_id, req.auth.key_id, 'sub_account_created', 'org', subOrgId, { name });

  res.status(201).json({
    success: true,
    data: { id: subOrgId, name, parent_org_id: req.auth.org_id, plan_tier: parentOrg?.plan_tier },
    message: 'Sub-account organization created! Billed to parent organization invoice.'
  });
});

/**
 * GET /api/orgs/audit-logs
 * Exportable audit logs for enterprise compliance teams
 */
router.get('/audit-logs', requireRole('owner', 'admin', 'read_only'), async (req, res) => {
  const logs = await db.prepare('SELECT * FROM audit_logs WHERE org_id = ? ORDER BY created_at DESC LIMIT 500').all(req.auth.org_id);
  for (const l of logs) l.details = JSON.parse(l.details_json || '{}');
  res.json({ success: true, data: logs });
});

/**
 * GET /api/orgs/sso-saml
 * SAML SSO readiness endpoint (Bundled FREE in Enterprise tier, no separate charge!)
 */
router.get('/sso-saml', requireRole('owner', 'admin'), async (req, res) => {
  const org = await db.prepare('SELECT plan_tier FROM orgs WHERE id = ?').get(req.auth.org_id);
  
  res.json({
    success: true,
    data: {
      org_id: req.auth.org_id,
      plan_tier: org?.plan_tier || 'free',
      sso_enabled: org?.plan_tier === 'enterprise',
      saml_metadata_url: `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/saml/metadata`,
      acs_url: `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/saml/acs`,
      pricing_advantage: 'SAML SSO is included FREE by default in the Enterprise tier without any separate add-on charge!'
    }
  });
});

module.exports = router;
