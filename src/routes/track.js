const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');

const router = express.Router();

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7',
  'base64'
);

router.get('/open/:emailId.gif', async (req, res) => {
  const { emailId } = req.params;

  const email = await db.prepare('SELECT id, org_id FROM emails WHERE id = ?').get(emailId);
  if (email) {
    await db.prepare(`INSERT INTO events (id, org_id, email_id, name, type, meta_json, received_at) VALUES (?, ?, ?, 'email.opened', 'open', ?, ?)`)
      .run(`evt_${nanoid(20)}`, email.org_id || 'org_default', emailId, JSON.stringify({ ip: req.ip, ua: req.headers['user-agent'] }), Date.now());
  }

  res.set('Content-Type', 'image/gif');
  res.send(PIXEL);
});

router.get('/click/:clickId', async (req, res) => {
  const click = await db.prepare('SELECT * FROM clicks WHERE id = ?').get(req.params.clickId);
  if (!click) return res.status(404).send('Not found');

  const email = await db.prepare('SELECT id, org_id FROM emails WHERE id = ?').get(click.email_id);
  if (email) {
    db.prepare(`INSERT INTO events (id, org_id, email_id, name, type, meta_json, received_at) VALUES (?, ?, ?, 'email.clicked', 'click', ?, ?)`)
      .run(`evt_${nanoid(20)}`, email.org_id || 'org_default', click.email_id, JSON.stringify({
        url: click.original_url,
        ip: req.ip,
        ua: req.headers['user-agent'],
      }), Date.now());
  }

  res.redirect(302, click.original_url);
});

module.exports = router;
