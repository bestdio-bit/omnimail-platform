const { nanoid } = require('nanoid');
const db = require('../db');

// Ensure clicks table exists without modifying db/index.js
try {
  db.exec(`CREATE TABLE IF NOT EXISTS clicks (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL,
    original_url TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0
  );`);
} catch (e) {}

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
