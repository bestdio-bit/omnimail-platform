const express = require('express');
const db = require('../db');
const { verifyToken } = require('../lib/unsubscribeToken');

const router = express.Router();

router.get('/:email/:token', async (req, res) => {
  const { email, token } = req.params;

  if (!verifyToken(email, token)) {
    return res.status(400).send('Invalid or expired unsubscribe link.');
  }

  const lower = email.toLowerCase();
  const now = Date.now();

  try {
    await db.prepare(`
      INSERT INTO suppressions (id, org_id, email, reason, detail, created_at)
      VALUES (?, 'org_default', ?, 'unsubscribe', NULL, ?)
    `).run(`sup_${Date.now()}`, lower, now);
  } catch (e) {}

  await db.prepare(`UPDATE contacts SET status = 'unsubscribed' WHERE LOWER(email) = ?`).run(lower);

  res.set('Content-Type', 'text/html');
  res.send(`<html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center">
    <h2>You're unsubscribed</h2>
    <p>${lower} won't receive any more emails from us.</p>
  </body></html>`);
});

module.exports = router;
