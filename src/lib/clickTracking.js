const { nanoid } = require('nanoid');
const db = require('../db');



async function rewriteLinksForTracking(html, emailId, baseUrl) {
  if (!html) return html;

  return html.replace(/href=(["'])(.*?)\1/gi, (match, quote, url) => {
    const trimmed = url.trim();
    if (!trimmed || /^(mailto:|tel:|#|\{)/i.test(trimmed)) {
      return match;
    }

    const clickId = `click_${nanoid(16)}`;
    try {
      db.prepare(`INSERT INTO clicks (id, email_id, original_url, created_at) VALUES (?, ?, ?, ?)`)
        .run(clickId, emailId, trimmed, Date.now());
    } catch (e) {}

    const redirectUrl = `${baseUrl}/api/track/click/${clickId}`;
    return `href=${quote}${redirectUrl}${quote}`;
  });
}

module.exports = { rewriteLinksForTracking };
