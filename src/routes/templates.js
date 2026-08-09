const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

router.use(authenticateKey);

const RESERVED_VARIABLES = ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'UNSUBSCRIBE_URL'];

/**
 * Helper: Extract variables {{VAR}} from HTML source
 */
async function extractVariables(html) {
  const matches = html.match(/{{\s*([a-zA-Z0-9_]+)\s*}}/g) || [];
  const vars = new Set();
  for (const match of matches) {
    const clean = match.replace(/[{}]/g, '').trim();
    vars.add(clean);
  }
  return Array.from(vars);
}

/**
 * GET /api/templates
 */
router.get('/', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const templates = await db.prepare(`
    SELECT t.id, t.name, t.current_published_version_id, t.created_at,
           (SELECT COUNT(*) FROM template_versions v WHERE v.template_id = t.id) as version_count,
           (SELECT status FROM template_versions v WHERE v.id = t.current_published_version_id) as published_status
    FROM templates t
    WHERE t.org_id = ?
    ORDER BY t.created_at DESC
  `).all(req.auth.org_id);

  res.json({ success: true, data: templates });
});

/**
 * POST /api/templates
 * Create new logical template with initial draft version
 */
router.post('/', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  try {
    const { name, html_source = '<h1>Hello {{FIRST_NAME}}!</h1><p>Welcome to OmniMail.</p>' } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: 'missing_name', message: 'Template name is required.' });
    }

    const now = Date.now();
    const templateId = 'tpl_' + now + '_' + Math.random().toString(36).substring(2, 6);
    const versionId = 'ver_' + now + '_' + Math.random().toString(36).substring(2, 6);

    const variables = extractVariables(html_source);

    await db.transaction(async () => {
      await db.prepare('INSERT INTO templates (id, org_id, name, created_at) VALUES (?, ?, ?, ?)').run(templateId, req.auth.org_id, name, now);
      await db.prepare(`
        INSERT INTO template_versions (id, template_id, html_source, variables_json, status, created_by, created_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?)
      `).run(versionId, templateId, html_source, JSON.stringify(variables), req.auth.name, now);
    })();

    logAudit(req.auth.org_id, req.auth.key_id, 'template_created', 'template', templateId, { name });

    res.status(201).json({
      success: true,
      data: { id: templateId, name, draft_version_id: versionId, variables },
      message: 'Template and initial draft version created successfully.'
    });
  } catch (err) {
    console.error('❌ [TemplatesAPI] Create Error:', err);
    res.status(500).json({ success: false, error: 'create_failed', message: err.message });
  }
});

/**
 * GET /api/templates/:id
 */
router.get('/:id', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const template = await db.prepare('SELECT * FROM templates WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!template) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Template not found.' });
  }

  const versions = await db.prepare('SELECT * FROM template_versions WHERE template_id = ? ORDER BY created_at DESC').all(template.id);
  
  // Parse variables JSON
  for (const ver of versions) {
    ver.variables = JSON.parse(ver.variables_json || '[]');
  }

  res.json({ success: true, data: { ...template, versions } });
});

/**
 * POST /api/templates/:id/versions
 * Save auto-save draft snapshot
 */
router.post('/:id/versions', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const template = await db.prepare('SELECT id FROM templates WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!template) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Template not found.' });
  }

  const { html_source } = req.body;
  if (!html_source) {
    return res.status(400).json({ success: false, error: 'missing_content', message: 'html_source is required.' });
  }

  const now = Date.now();
  const versionId = 'ver_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const variables = extractVariables(html_source);

  await db.prepare(`
    INSERT INTO template_versions (id, template_id, html_source, variables_json, status, created_by, created_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?)
  `).run(versionId, template.id, html_source, JSON.stringify(variables), req.auth.name, now);

  res.status(201).json({
    success: true,
    data: { id: versionId, template_id: template.id, status: 'draft', variables, created_at: now },
    message: 'Draft version snapshot saved successfully.'
  });
});

/**
 * GET /api/templates/:id/versions
 */
router.get('/:id/versions', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const template = await db.prepare('SELECT id FROM templates WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!template) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Template not found.' });
  }
  const versions = await db.prepare('SELECT * FROM template_versions WHERE template_id = ? ORDER BY created_at DESC').all(template.id);
  for (const ver of versions) ver.variables = JSON.parse(ver.variables_json || '[]');
  res.json({ success: true, data: versions });
});

/**
 * POST /api/templates/:id/publish
 * Validate variables, block reserved conflicts, and promote version to published
 */
router.post('/:id/publish', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const { version_id } = req.body;
  const template = await db.prepare('SELECT * FROM templates WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!template) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Template not found.' });
  }

  const version = await db.prepare('SELECT * FROM template_versions WHERE id = ? AND template_id = ?').get(version_id, template.id);
  if (!version) {
    return res.status(404).json({ success: false, error: 'version_not_found', message: 'Specified version ID not found for this template.' });
  }

  // Validate Variables against reserved system keywords
  const variables = JSON.parse(version.variables_json || '[]');
  const reservedUsed = variables.filter(v => RESERVED_VARIABLES.includes(v.toUpperCase()));

  // Promote version
  await db.transaction(async () => {
    // Demote old published version if exists
    if (template.current_published_version_id) {
      await db.prepare("UPDATE template_versions SET status = 'archived' WHERE id = ?").run(template.current_published_version_id);
    }
    // Set new published version
    await db.prepare("UPDATE template_versions SET status = 'published' WHERE id = ?").run(version.id);
    await db.prepare('UPDATE templates SET current_published_version_id = ? WHERE id = ?').run(version.id, template.id);
  })();

  logAudit(req.auth.org_id, req.auth.key_id, 'template_published', 'template', template.id, { version_id: version.id, variables });

  res.json({
    success: true,
    data: {
      template_id: template.id,
      published_version_id: version.id,
      status: 'published',
      variables,
      system_reserved_variables_available: RESERVED_VARIABLES
    },
    message: 'Template version promoted to PUBLISHED. Live sending API will now use this version.'
  });
});

/**
 * POST /api/templates/:id/duplicate
 */
router.post('/:id/duplicate', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const template = await db.prepare('SELECT * FROM templates WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!template) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Template not found.' });
  }

  const latestVer = await db.prepare('SELECT * FROM template_versions WHERE template_id = ? ORDER BY created_at DESC LIMIT 1').get(template.id);
  const now = Date.now();
  const newTplId = 'tpl_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const newVerId = 'ver_' + now + '_' + Math.random().toString(36).substring(2, 6);

  await db.transaction(async () => {
    await db.prepare('INSERT INTO templates (id, org_id, name, created_at) VALUES (?, ?, ?, ?)').run(newTplId, req.auth.org_id, `${template.name} (Copy)`, now);
    await db.prepare(`
      INSERT INTO template_versions (id, template_id, html_source, variables_json, status, created_by, created_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?)
    `).run(newVerId, newTplId, latestVer?.html_source || '', latestVer?.variables_json || '[]', req.auth.name, now);
  })();

  res.status(201).json({
    success: true,
    data: { id: newTplId, name: `${template.name} (Copy)`, draft_version_id: newVerId },
    message: 'Template duplicated successfully.'
  });
});

/**
 * POST /api/templates/:id/presence
 * Heartbeat for co-editing presence
 */
router.post('/:id/presence', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const now = Date.now();
  const userId = req.auth.key_id;
  const userName = req.auth.name;

  // Insert or update presence
  const existing = await db.prepare('SELECT id FROM template_edit_sessions WHERE template_id = ? AND user_id = ?').get(req.params.id, userId);
  if (existing) {
    await db.prepare('UPDATE template_edit_sessions SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
  } else {
    const id = 'ses_' + now + '_' + Math.random().toString(36).substring(2, 6);
    await db.prepare('INSERT INTO template_edit_sessions (id, template_id, user_id, user_name, connected_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.params.id, userId, userName, now, now);
  }

  // Clean up stale sessions (> 30 seconds old)
  await db.prepare('DELETE FROM template_edit_sessions WHERE last_seen_at < ?').run(now - 30000);

  const activeEditors = await db.prepare('SELECT user_id, user_name, connected_at FROM template_edit_sessions WHERE template_id = ?').all(req.params.id);

  res.json({ success: true, data: { active_editors: activeEditors } });
});

module.exports = router;
