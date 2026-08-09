const express = require('express');
const router = express.Router();
const db = require('../db');
const { signHmac, verifyHmac } = require('../lib/crypto');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

// Public Stateless Unsubscribe Verification Endpoint (No Bearer Token Required!)
router.get('/public-unsubscribe', async (req, res) => {
  const { contact_id, org_id, sig } = req.query;
  if (!contact_id || !org_id || !sig) {
    return res.status(400).send('<h1>Invalid Unsubscribe Link</h1><p>Missing parameters.</p>');
  }

  const secret = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production';
  const data = `${contact_id}:${org_id}`;
  if (!verifyHmac(data, sig, secret)) {
    return res.status(403).send('<h1>Signature Verification Failed</h1><p>This unsubscribe link is invalid or expired.</p>');
  }

  const contact = await db.prepare('SELECT email FROM contacts WHERE id = ? AND org_id = ?').get(contact_id, org_id);
  if (!contact) {
    return res.status(404).send('<h1>Contact Not Found</h1>');
  }

  // Add to suppressions table and update contact status
  const now = Date.now();
  await db.transaction(async () => {
    await db.prepare("UPDATE contacts SET status = 'unsubscribed' WHERE id = ?").run(contact_id);
    await db.prepare(`
      INSERT INTO suppressions (id, org_id, email, reason, detail, created_at)
      VALUES (?, ?, ?, 'unsubscribe', 'Stateless HMAC Unsubscribe Link Clicked', ?)
    `).run('sup_' + now + '_' + Math.random().toString(36).substring(2, 6), org_id, contact.email, now);
  })();

  res.send(`
    <div style="font-family: Inter, sans-serif; max-width: 500px; margin: 100px auto; padding: 40px; background: #11131c; color: #e6eaf3; border-radius: 12px; border: 1px solid #252940; text-align: center;">
      <h1 style="color: #6366f1; margin-bottom: 16px;">Unsubscribed Successfully</h1>
      <p style="color: #a0a8c0; line-height: 1.6;">The email address <strong>${contact.email}</strong> has been added to the suppression list. You will no longer receive automated emails from this sender.</p>
    </div>
  `);
});

// Apply authentication to all remaining management routes
router.use(authenticateKey);

/**
 * GET /api/contacts
 */
router.get('/', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const contacts = await db.prepare('SELECT * FROM contacts WHERE org_id = ? ORDER BY created_at DESC LIMIT 500').all(req.auth.org_id);
  for (const c of contacts) c.attributes = JSON.parse(c.attributes_json || '{}');
  res.json({ success: true, data: contacts });
});

/**
 * POST /api/contacts
 */
router.post('/', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const { email, first_name, last_name, attributes = {} } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, error: 'missing_email', message: 'Email address is required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const now = Date.now();
  const id = 'con_' + now + '_' + Math.random().toString(36).substring(2, 6);

  try {
    await db.prepare(`
      INSERT INTO contacts (id, org_id, email, first_name, last_name, attributes_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(id, req.auth.org_id, cleanEmail, first_name || null, last_name || null, JSON.stringify(attributes), now);

    logAudit(req.auth.org_id, req.auth.key_id, 'contact_created', 'contact', id, { email: cleanEmail });

    res.status(201).json({
      success: true,
      data: { id, email: cleanEmail, first_name, last_name, attributes, status: 'active' },
      message: 'Contact created successfully.'
    });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, error: 'contact_exists', message: 'Contact email already exists in this organization.' });
    }
    throw err;
  }
});

/**
 * POST /api/contacts/bulk-import
 * Import contacts via CSV string or JSON array
 */
router.post('/bulk-import', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const { csv_text, contacts: jsonContacts } = req.body;
  let itemsToImport = [];

  if (csv_text && typeof csv_text === 'string') {
    const lines = csv_text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
      const emailIdx = headers.indexOf('email');
      const fnameIdx = headers.indexOf('first_name') > -1 ? headers.indexOf('first_name') : headers.indexOf('firstname');
      const lnameIdx = headers.indexOf('last_name') > -1 ? headers.indexOf('last_name') : headers.indexOf('lastname');

      if (emailIdx === -1) {
        return res.status(400).json({ success: false, error: 'missing_email_header', message: 'CSV must contain an "email" column header.' });
      }

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim());
        if (cols[emailIdx]) {
          itemsToImport.push({
            email: cols[emailIdx],
            first_name: fnameIdx > -1 ? cols[fnameIdx] : null,
            last_name: lnameIdx > -1 ? cols[lnameIdx] : null
          });
        }
      }
    }
  } else if (Array.isArray(jsonContacts)) {
    itemsToImport = jsonContacts.filter(c => c && c.email);
  }

  if (itemsToImport.length === 0) {
    return res.status(400).json({ success: false, error: 'empty_import', message: 'No valid contact records found to import.' });
  }

  const now = Date.now();
  let importedCount = 0;
  let skippedCount = 0;

  const insertStmt = await db.prepare(`
    INSERT INTO contacts (id, org_id, email, first_name, last_name, attributes_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, '{}', 'active', ?)
  `);

  await db.transaction(async () => {
    for (const item of itemsToImport) {
      const cleanEmail = item.email.trim().toLowerCase();
      const id = 'con_' + now + '_' + Math.random().toString(36).substring(2, 6);
      const resInfo = insertStmt.run(id, req.auth.org_id, cleanEmail, item.first_name || null, item.last_name || null, now);
      if (resInfo.changes > 0) {
        importedCount++;
      } else {
        skippedCount++;
      }
    }
  })();

  logAudit(req.auth.org_id, req.auth.key_id, 'contacts_bulk_imported', 'contacts', `${importedCount} imported`);

  res.status(200).json({
    success: true,
    data: { imported_count: importedCount, skipped_count: skippedCount, total_processed: itemsToImport.length },
    message: `Successfully imported ${importedCount} contacts (${skippedCount} duplicates skipped).`
  });
});

/**
 * GET /api/contacts/:id/unsubscribe-link
 * Generate stateless HMAC-signed unsubscribe URL
 */
router.get('/:id/unsubscribe-link', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const contact = await db.prepare('SELECT id, email FROM contacts WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!contact) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Contact not found.' });
  }

  const secret = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production';
  const data = `${contact.id}:${req.auth.org_id}`;
  const sig = signHmac(data, secret);
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  const unsubscribeUrl = `${baseUrl}/api/contacts/public-unsubscribe?contact_id=${contact.id}&org_id=${req.auth.org_id}&sig=${sig}`;

  res.json({
    success: true,
    data: {
      contact_id: contact.id,
      email: contact.email,
      unsubscribe_url: unsubscribeUrl
    },
    message: 'Stateless HMAC unsubscribe URL generated.'
  });
});

/**
 * GET /api/contacts/suppressions
 */
router.get('/suppressions', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const suppressions = await db.prepare('SELECT * FROM suppressions WHERE org_id = ? ORDER BY created_at DESC').all(req.auth.org_id);
  res.json({ success: true, data: suppressions });
});

/**
 * POST /api/contacts/suppressions
 * Add manual suppression
 */
router.post('/suppressions', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const { email, reason = 'manual', detail = 'Manually suppressed by administrator' } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, error: 'missing_email', message: 'Email address is required.' });
  }

  const now = Date.now();
  const id = 'sup_' + now + '_' + Math.random().toString(36).substring(2, 6);

  db.prepare(`
    INSERT OR REPLACE INTO suppressions (id, org_id, email, reason, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.auth.org_id, email.trim().toLowerCase(), reason, detail, now);

  logAudit(req.auth.org_id, req.auth.key_id, 'suppression_added', 'suppression', id, { email, reason });

  res.status(201).json({ success: true, data: { id, email, reason, detail }, message: 'Email added to suppression list.' });
});

/**
 * DELETE /api/contacts/suppressions/:email
 */
router.delete('/suppressions/:email', requireRole('owner', 'admin'), async (req, res) => {
  const info = await db.prepare('DELETE FROM suppressions WHERE org_id = ? AND LOWER(email) = LOWER(?)').run(req.auth.org_id, req.params.email);
  if (info.changes === 0) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Suppression record not found.' });
  }
  logAudit(req.auth.org_id, req.auth.key_id, 'suppression_removed', 'suppression', req.params.email);
  res.json({ success: true, message: 'Email removed from suppression list.' });
});

module.exports = router;
