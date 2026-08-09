const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

// Apply authentication and role check to specific send endpoints

/**
 * Helper: Process single send request object
 */
async function processSendRequest(orgId, reqBody) {
  const { to, from, subject, html, text, template_id, variables = {}, campaign_id } = reqBody;

  if (!to) {
    throw { status: 400, error: 'missing_recipient', message: 'The "to" field is required.' };
  }

  // 1. Check Suppression List First (Critical Rule)
  const suppression = await db.prepare(`
    SELECT id, reason, detail, created_at
    FROM suppressions
    WHERE org_id = ? AND LOWER(email) = LOWER(?)
  `).get(orgId, to.trim());

  if (suppression) {
    throw {
      status: 422,
      error: 'recipient_suppressed',
      message: `Cannot send email: recipient '${to}' is on the suppression list due to '${suppression.reason}'.`,
      suppression: {
        reason: suppression.reason,
        detail: suppression.detail,
        suppressed_at: suppression.created_at
      }
    };
  }

  let finalSubject = subject || 'No Subject';
  let finalHtml = html;
  let finalText = text;

  // 2. If template_id provided, render published version
  if (template_id && !html) {
    const template = await db.prepare(`
      SELECT id, name, current_published_version_id
      FROM templates
      WHERE id = ? AND org_id = ?
    `).get(template_id, orgId);

    if (!template || !template.current_published_version_id) {
      throw { status: 400, error: 'template_not_published', message: `Template '${template_id}' is either missing or has no published version.` };
    }

    const version = await db.prepare(`
      SELECT html_source, variables_json
      FROM template_versions
      WHERE id = ?
    `).get(template.current_published_version_id);

    if (!version) {
      throw { status: 500, error: 'template_version_missing', message: 'Published template version data not found.' };
    }

    finalHtml = version.html_source;

    // Substitute variables {{VAR_NAME}}
    for (const [key, val] of Object.entries(variables)) {
      const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
      finalHtml = finalHtml.replace(regex, String(val));
    }
  }

  if (!finalHtml && !finalText) {
    throw { status: 400, error: 'missing_content', message: 'You must provide either "html", "text", or a valid "template_id".' };
  }

  const emailId = 'em_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  const now = Date.now();
  const fromAddr = from || process.env.SMTP_FROM_DEFAULT || 'notifications@omnimail.local';

  // 3. Enqueue into emails table with status='queued'
  db.prepare(`
    INSERT INTO emails (id, org_id, campaign_id, template_id, to_address, from_address, subject, html_body, text_body, status, queued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
  `).run(
    emailId,
    orgId,
    campaign_id || null,
    template_id || null,
    to.trim(),
    fromAddr.trim(),
    finalSubject,
    finalHtml || '',
    finalText || '',
    now
  );

  return {
    id: emailId,
    status: 'queued',
    to: to.trim(),
    from: fromAddr.trim(),
    subject: finalSubject,
    queued_at: now
  };
}

/**
 * POST /api/send
 * Asynchronous Transactional Email Send API
 * Returns 202 Accepted instantly
 */
router.post('/send', authenticateKey, requireRole('owner', 'admin', 'developer'), async (req, res) => {
  try {
    const result = await processSendRequest(req.auth.org_id, req.body);
    await logAudit(req.auth.org_id, req.auth.key_id, 'send_email_queued', 'email', result.id, { to: result.to });
    return res.status(202).json({
      success: true,
      data: result,
      message: 'Email accepted and queued for asynchronous delivery by worker.'
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, error: err.error, message: err.message, ...err });
    }
    console.error('❌ [SendAPI] Error processing send:', err);
    return res.status(500).json({ success: false, error: 'internal_error', message: 'Failed to queue email.' });
  }
});

/**
 * POST /api/batch-send
 * Enqueues up to 500 emails in a single SQLite transaction
 */
router.post('/batch-send', authenticateKey, requireRole('owner', 'admin', 'developer'), async (req, res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ success: false, error: 'invalid_batch', message: 'You must provide an "emails" array.' });
  }
  if (emails.length > 500) {
    return res.status(400).json({ success: false, error: 'batch_limit_exceeded', message: 'Maximum 500 emails per batch request.' });
  }

  const results = [];
  const errors = [];

  const runBatch = await db.transaction(async () => {
    for (let i = 0; i < emails.length; i++) {
      try {
        const item = await processSendRequest(req.auth.org_id, emails[i]);
        results.push(item);
      } catch (err) {
        errors.push({ index: i, error: err.error || 'error', message: err.message });
      }
    }
  });

  try {
    await runBatch();
    await logAudit(req.auth.org_id, req.auth.key_id, 'batch_send_queued', 'email_batch', 'batch_' + Date.now(), { queued: results.length, failed: errors.length });
    return res.status(202).json({
      success: true,
      data: {
        queued_count: results.length,
        failed_count: errors.length,
        queued: results,
        errors: errors.length > 0 ? errors : undefined
      },
      message: `Batch processed: ${results.length} queued, ${errors.length} rejected.`
    });
  } catch (err) {
    console.error('❌ [BatchSendAPI] Transaction failed:', err);
    return res.status(500).json({ success: false, error: 'transaction_error', message: 'Batch queue transaction failed.' });
  }
});

module.exports = router;
