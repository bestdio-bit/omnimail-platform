const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

router.use(authenticateKey);

/**
 * GET /api/campaigns
 */
router.get('/', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const campaigns = await db.prepare(`
    SELECT c.*, t.name as template_name
    FROM campaigns c
    LEFT JOIN templates t ON c.template_id = t.id
    WHERE c.org_id = ?
    ORDER BY c.created_at DESC
  `).all(req.auth.org_id);

  res.json({ success: true, data: campaigns });
});

/**
 * POST /api/campaigns
 * Create bulk broadcast campaign
 */
router.post('/', requireRole('owner', 'admin', 'marketer'), async (req, res) => {
  const { name, template_id, list_id = 'all', rate_limit_per_hour = 10000 } = req.body;
  if (!name || !template_id) {
    return res.status(400).json({ success: false, error: 'missing_fields', message: 'name and template_id are required.' });
  }

  const template = await db.prepare('SELECT id, current_published_version_id FROM templates WHERE id = ? AND org_id = ?').get(template_id, req.auth.org_id);
  if (!template || !template.current_published_version_id) {
    return res.status(400).json({ success: false, error: 'template_invalid', message: 'Target template is missing or has no published version.' });
  }

  // Count target recipients
  let totalRecipients = 0;
  if (list_id === 'all') {
    const countRes = await db.prepare("SELECT COUNT(*) as count FROM contacts WHERE org_id = ? AND status = 'active'").get(req.auth.org_id);
    totalRecipients = countRes.count || 0;
  } else {
    const countRes = await db.prepare("SELECT COUNT(*) as count FROM list_subscribers ls JOIN contacts c ON ls.contact_id = c.id WHERE ls.list_id = ? AND c.status = 'active'").get(list_id);
    totalRecipients = countRes?.count || 0;
  }

  const now = Date.now();
  const id = 'cam_' + now + '_' + Math.random().toString(36).substring(2, 6);

  await db.prepare(`
    INSERT INTO campaigns (id, org_id, name, template_id, list_id, status, rate_limit_per_hour, total_recipients, created_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(id, req.auth.org_id, name, template_id, list_id, rate_limit_per_hour, totalRecipients, now);

  logAudit(req.auth.org_id, req.auth.key_id, 'campaign_created', 'campaign', id, { name, total_recipients: totalRecipients });

  res.status(201).json({
    success: true,
    data: { id, name, template_id, list_id, status: 'draft', total_recipients: totalRecipients, rate_limit_per_hour },
    message: 'Campaign created in DRAFT status.'
  });
});

/**
 * POST /api/campaigns/:id/schedule
 * Enqueue bulk broadcast emails for active subscribers
 */
router.post('/:id/schedule', requireRole('owner', 'admin', 'marketer'), async (req, res) => {
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!campaign) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Campaign not found.' });
  }
  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    return res.status(400).json({ success: false, error: 'invalid_status', message: `Cannot schedule campaign in status '${campaign.status}'.` });
  }

  // Retrieve published template version
  const template = await db.prepare('SELECT current_published_version_id FROM templates WHERE id = ?').get(campaign.template_id);
  const version = await db.prepare('SELECT html_source FROM template_versions WHERE id = ?').get(template?.current_published_version_id);

  if (!version) {
    return res.status(500).json({ success: false, error: 'missing_template_data', message: 'Published template version source missing.' });
  }

  // Get recipients
  let contacts = [];
  if (campaign.list_id === 'all') {
    contacts = await db.prepare("SELECT * FROM contacts WHERE org_id = ? AND status = 'active'").all(req.auth.org_id);
  } else {
    contacts = await db.prepare("SELECT c.* FROM list_subscribers ls JOIN contacts c ON ls.contact_id = c.id WHERE ls.list_id = ? AND c.status = 'active'").all(campaign.list_id);
  }

  const now = Date.now();
  let queuedCount = 0;

  await db.transaction(async () => {
    for (const contact of contacts) {
      // Check suppression list
      const suppressed = await db.prepare('SELECT id FROM suppressions WHERE org_id = ? AND LOWER(email) = LOWER(?)').get(req.auth.org_id, contact.email);
      if (suppressed) continue;

      // Substitute variables
      let htmlBody = version.html_source;
      htmlBody = htmlBody.replace(/{{\s*FIRST_NAME\s*}}/g, contact.first_name || 'Subscriber');
      htmlBody = htmlBody.replace(/{{\s*LAST_NAME\s*}}/g, contact.last_name || '');
      htmlBody = htmlBody.replace(/{{\s*EMAIL\s*}}/g, contact.email);

      const emailId = 'em_cam_' + now + '_' + Math.random().toString(36).substring(2, 6);
      db.prepare(`
        INSERT INTO emails (id, org_id, campaign_id, template_id, to_address, from_address, subject, html_body, text_body, status, queued_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'queued', ?)
      `).run(emailId, req.auth.org_id, campaign.id, campaign.template_id, contact.email, process.env.SMTP_FROM_DEFAULT || 'notifications@omnimail.local', campaign.name, htmlBody, now);
      
      queuedCount++;
    }

    await db.prepare("UPDATE campaigns SET status = 'sending', scheduled_at = ?, total_recipients = ? WHERE id = ?").run(now, queuedCount, campaign.id);
  })();

  logAudit(req.auth.org_id, req.auth.key_id, 'campaign_scheduled', 'campaign', campaign.id, { queued_count: queuedCount });

  res.json({
    success: true,
    data: { campaign_id: campaign.id, status: 'sending', queued_recipients: queuedCount },
    message: `Campaign scheduled! Enqueued ${queuedCount} emails into background worker queue.`
  });
});

/**
 * POST /api/campaigns/:id/pause
 */
router.post('/:id/pause', requireRole('owner', 'admin', 'marketer'), async (req, res) => {
  await db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ? AND org_id = ?").run(req.params.id, req.auth.org_id);
  res.json({ success: true, message: 'Campaign sending paused.' });
});

module.exports = router;
