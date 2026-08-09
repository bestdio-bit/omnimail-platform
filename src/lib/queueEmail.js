const { nanoid } = require('nanoid');
const db = require('../db');
const { render } = require('../routes/templates');

async function resolveContent({ subject, html, text, template_id, variables, subjectOverride }) {
  if (template_id) {
    const template = await await db.prepare('SELECT * FROM templates WHERE id = ?').get(template_id);
    if (!template) return { error: 'template_id does not match any template.' };

    let htmlBody = template.html_body || '';
    let textBody = template.text_body || '';
    if (template.current_published_version_id) {
      const ver = await db.prepare('SELECT * FROM template_versions WHERE id = ?').get(template.current_published_version_id);
      if (ver) {
        htmlBody = ver.html_source || ver.html_body || '';
        textBody = ver.text_body || '';
      }
    } else {
      const ver = await db.prepare("SELECT * FROM template_versions WHERE template_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 1").get(template_id);
      if (ver) {
        htmlBody = ver.html_source || ver.html_body || '';
        textBody = ver.text_body || '';
      } else {
        const anyVer = await db.prepare('SELECT id FROM template_versions WHERE template_id = ? LIMIT 1').get(template_id);
        if (anyVer) {
          return { error: `Template ${template_id} has no published version. Promote a draft to published before sending live email.` };
        }
      }
    }

    const vars = variables || {};
    return {
      subject: subjectOverride ? render(subjectOverride, vars) : render(template.subject, vars),
      html: render(htmlBody, vars),
      text: render(textBody, vars),
    };
  }

  if (!subject || (!html && !text)) {
    return { error: 'Required fields: subject, and one of html/text (or use template_id).' };
  }
  return { subject, html: html || null, text: text || null };
}

async function queueEmail({ apiKeyId, orgId, campaignId, variantId, from, to, subject, html, text, template_id, variables, subjectOverride }) {
  const suppressed = await db.prepare('SELECT reason FROM suppressions WHERE email = ?').get(String(to).toLowerCase());
  if (suppressed) {
    return { error: `Recipient is suppressed (${suppressed.reason}) and will not be sent to.`, suppressed: true };
  }

  const resolved = resolveContent({ subject, html, text, template_id, variables, subjectOverride });
  if (resolved.error) {
    return { error: resolved.error };
  }

  const id = `email_${nanoid(20)}`;
  const finalOrgId = orgId || 'org_default';
  const now = Date.now();

  db.prepare(`
    INSERT INTO emails (id, org_id, campaign_id, template_id, to_address, from_address, subject, html_body, text_body, status, queued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
  `).run(id, finalOrgId, campaignId || null, template_id || null, to, from || 'agent@omnimail.local', resolved.subject || '', resolved.html || null, resolved.text || null, now);

  try {
    db.prepare(`INSERT INTO events (id, org_id, email_id, name, type, received_at) VALUES (?, ?, ?, 'email.queued', 'custom', ?)`)
      .run(`evt_${nanoid(20)}`, finalOrgId, id, now);
  } catch (e) {}

  return { id };
}

module.exports = { queueEmail, resolveContent };
