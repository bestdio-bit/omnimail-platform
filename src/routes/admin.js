const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const { authenticateKey } = require('../middleware/auth');
const { requireSuperAdmin, logAudit } = require('../middleware/rbac');

router.use(authenticateKey);
router.use(requireSuperAdmin);

/**
 * GET /api/admin/orgs
 * List all organizations globally
 */
router.get('/orgs', async (req, res) => {
  const orgs = await db.prepare('SELECT * FROM orgs ORDER BY created_at DESC').all();
  // Get user counts for each org
  for (const org of orgs) {
    org.user_count = (await (await db.prepare('SELECT COUNT(*) as count FROM users WHERE org_id = ?').get(org.id))).count;
  }
  res.json({ success: true, data: orgs });
});

/**
 * PUT /api/admin/orgs/:id
 * Update organization plan or volume
 */
router.put('/orgs/:id', async (req, res) => {
  const { plan_tier, custom_send_volume } = req.body;
  const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.params.id);
  
  if (!org) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Organization not found.' });
  }

  const newTier = plan_tier || org.plan_tier;
  const newVolume = custom_send_volume !== undefined ? custom_send_volume : org.custom_send_volume;

  await db.prepare('UPDATE orgs SET plan_tier = ?, custom_send_volume = ? WHERE id = ?').run(newTier, newVolume, org.id);
  
  logAudit(org.id, req.auth.key_id, 'org_overridden_by_admin', 'org', org.id, { plan_tier: newTier, custom_send_volume: newVolume });

  res.json({ success: true, message: 'Organization updated successfully.' });
});

/**
 * POST /api/admin/orgs
 * Provision a new free business organization with an owner user
 */
router.post('/orgs', async (req, res) => {
  const { name, email, plan_tier = 'enterprise', custom_send_volume = 1000000 } = req.body;
  if (!name || !email) {
    return res.status(400).json({ success: false, error: 'missing_fields', message: 'Name and email are required.' });
  }

  const now = Date.now();
  const orgId = 'org_biz_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const userId = 'usr_biz_' + now + '_' + Math.random().toString(36).substring(2, 6);
  
  await db.transaction(async () => {
    // Create org
    await db.prepare(`
      INSERT INTO orgs (id, name, plan_tier, custom_send_volume, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(orgId, name, plan_tier, custom_send_volume, now);

    // Create user (default password: 'changeme123')
    const pwdHash = crypto.scryptSync('changeme123', 'omni_salt_demo', 64).toString('hex');
    await db.prepare(`
      INSERT INTO users (id, org_id, email, name, role, password_hash, is_verified, created_at)
      VALUES (?, ?, ?, ?, 'owner', ?, 1, ?)
    `).run(userId, orgId, email, 'Business Admin', pwdHash, now);

    // Create master API key for the new org
    const rawKey = 'omni_live_' + crypto.randomBytes(16).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    
    await db.prepare(`
      INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, role, created_at)
      VALUES (?, ?, ?, ?, ?, 'owner', ?)
    `).run('key_biz_' + now, orgId, 'Master Business Key', keyHash, rawKey.substring(0, 10), now);
    
    return { orgId, userId, rawKey };
  })();

  res.status(201).json({
    success: true,
    data: { org_id: orgId, admin_email: email, plan_tier },
    message: 'Business organization provisioned successfully. Default password is changeme123.'
  });
});

/**
 * GET /api/admin/billing
 * List all global checkout orders
 */
router.get('/billing', async (req, res) => {
  const orders = await db.prepare('SELECT * FROM checkout_orders ORDER BY created_at DESC').all();
  res.json({ success: true, data: orders });
});

/**
 * GET /api/admin/stats
 * Get high-level site progress statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const totalOrgs = await ((await db.prepare('SELECT COUNT(*) as count FROM orgs').get())).count;
    const totalUsers = await (await (await db.prepare('SELECT COUNT(*) as count FROM users').get())).count;
    const totalEmailsSent = await (await (await db.prepare("SELECT COUNT(*) as count FROM emails WHERE status = 'sent' OR status = 'delivered'").get())).count;
    const totalEmailsQueued = await (await (await db.prepare("SELECT COUNT(*) as count FROM emails WHERE status = 'queued'").get())).count;
    const totalOrders = await (await (await db.prepare('SELECT COUNT(*) as count FROM checkout_orders').get())).count;

    res.json({
      success: true,
      data: {
        total_orgs: totalOrgs,
        total_users: totalUsers,
        total_emails_sent: totalEmailsSent,
        total_emails_queued: totalEmailsQueued,
        total_orders: totalOrders
      }
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ success: false, message: 'Failed to load stats' });
  }
});

module.exports = router;
