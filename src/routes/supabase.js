const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { authenticateKey } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateKey);
router.use((req, res, next) => {
  req.apiKey = req.auth || {};
  next();
});

async function fetchSupabaseRows({ supabase_url, supabase_key, table, email_column, first_name_column, last_name_column, filter }) {
  const baseUrl = supabase_url.replace(/\/+$/, '');
  let url = `${baseUrl}/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(email_column)}`;

  if (first_name_column) url += `,${encodeURIComponent(first_name_column)}`;
  if (last_name_column) url += `,${encodeURIComponent(last_name_column)}`;

  if (filter) url += `&${filter}`;

  const allRows = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const pageUrl = `${url}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(pageUrl, {
      headers: {
        'apikey': supabase_key,
        'Authorization': `Bearer ${supabase_key}`,
        'Accept': 'application/json',
        'Prefer': 'count=exact',
      },
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Supabase API error ${res.status}: ${errBody || res.statusText}`);
    }

    const rows = await res.json();
    if (!Array.isArray(rows)) {
      throw new Error('Unexpected response from Supabase — expected an array of rows.');
    }

    allRows.push(...rows);

    if (rows.length < pageSize) break;
    offset += pageSize;

    if (allRows.length >= 100000) break;
  }

  return allRows;
}

router.post('/import', async (req, res) => {
  const {
    supabase_url, supabase_key, table,
    email_column = 'email',
    first_name_column, last_name_column,
    filter,
  } = req.body || {};

  if (!supabase_url || !supabase_key || !table) {
    return res.status(400).json({ error: 'Required: supabase_url, supabase_key, table.' });
  }

  try {
    const rows = await fetchSupabaseRows({
      supabase_url, supabase_key, table,
      email_column, first_name_column, last_name_column, filter,
    });

    if (rows.length === 0) {
      return res.json({ fetched: 0, imported: 0, skipped: 0 });
    }

    const orgId = req.apiKey.org_id || 'org_default';
    const now = Date.now();
    const insertStmt = await db.prepare(
      'INSERT INTO contacts (id, org_id, email, first_name, last_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    let imported = 0;
    let skipped = 0;

    for (const row of rows) {
      const email = (row[email_column] || '').toLowerCase().trim();
      if (!email || !email.includes('@')) { skipped++; continue; }

      const firstName = first_name_column ? (row[first_name_column] || null) : null;
      const lastName = last_name_column ? (row[last_name_column] || null) : null;

      try {
        insertStmt.run(`contact_${nanoid(16)}`, orgId, email, firstName, lastName, 'active', now);
        imported++;
      } catch (err) {
        skipped++;
      }
    }

    res.json({ fetched: rows.length, imported, skipped });
  } catch (err) {
    res.status(502).json({ error: `Supabase fetch failed: ${err.message}` });
  }
});

router.post('/send', async (req, res) => {
  const {
    supabase_url, supabase_key, table,
    email_column = 'email',
    first_name_column, last_name_column,
    filter,
    campaign_name, from, template_id, variables,
  } = req.body || {};

  if (!supabase_url || !supabase_key || !table) {
    return res.status(400).json({ error: 'Required: supabase_url, supabase_key, table.' });
  }
  if (!campaign_name || !from || !template_id) {
    return res.status(400).json({ error: 'Required: campaign_name, from, template_id.' });
  }

  const template = await db.prepare('SELECT id FROM templates WHERE id = ?').get(template_id);
  if (!template) return res.status(400).json({ error: 'template_id does not match any template.' });

  try {
    const rows = await fetchSupabaseRows({
      supabase_url, supabase_key, table,
      email_column, first_name_column, last_name_column, filter,
    });

    if (rows.length === 0) {
      return res.json({ fetched: 0, imported: 0, campaign: null });
    }

    const orgId = req.apiKey.org_id || 'org_default';
    const now = Date.now();
    const insertStmt = db.prepare(
      'INSERT INTO contacts (id, org_id, email, first_name, last_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    let imported = 0;

    for (const row of rows) {
      const email = (row[email_column] || '').toLowerCase().trim();
      if (!email || !email.includes('@')) continue;

      const firstName = first_name_column ? (row[first_name_column] || null) : null;
      const lastName = last_name_column ? (row[last_name_column] || null) : null;

      try {
        insertStmt.run(`contact_${nanoid(16)}`, orgId, email, firstName, lastName, 'active', now);
        imported++;
      } catch {}
    }

    const recipients = rows
      .map(r => (r[email_column] || '').toLowerCase().trim())
      .filter(e => e && e.includes('@'));

    const { queueEmail } = require('../lib/queueEmail');
    const campaignId = `campaign_${nanoid(16)}`;

    db.prepare(`
      INSERT INTO campaigns (id, org_id, name, template_id, list_id, status, total_recipients, created_at)
      VALUES (?, ?, ?, ?, 'supabase', 'sending', ?, ?)
    `).run(campaignId, orgId, campaign_name, template_id, recipients.length, now);

    let queued = 0;
    let skippedSend = 0;

    for (const email of recipients) {
      const srcRow = rows.find(r => (r[email_column] || '').toLowerCase().trim() === email);
      const perVars = {
        ...variables,
        email,
        ...(first_name_column && srcRow?.[first_name_column] ? { first_name: srcRow[first_name_column] } : {}),
        ...(last_name_column && srcRow?.[last_name_column] ? { last_name: srcRow[last_name_column] } : {}),
      };

      const result = queueEmail({
        apiKeyId: req.apiKey.id || req.apiKey.key_id,
        orgId,
        campaignId,
        from,
        to: email,
        template_id,
        variables: perVars,
      });
      if (result.error) skippedSend++; else queued++;
    }

    db.prepare("UPDATE campaigns SET sent_count = ?, scheduled_at = ? WHERE id = ?")
      .run(queued, Date.now(), campaignId);

    res.status(201).json({
      fetched: rows.length,
      imported,
      campaign: {
        id: campaignId,
        status: 'sending',
        total_recipients: recipients.length,
        queued,
        skipped_suppressed: skippedSend,
      },
    });
  } catch (err) {
    res.status(502).json({ error: `Supabase integration failed: ${err.message}` });
  }
});

module.exports = router;
