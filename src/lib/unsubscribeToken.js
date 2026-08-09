const crypto = require('crypto');

async function getSecret() {
  const secret = process.env.UNSUBSCRIBE_SECRET || process.env.ADMIN_SECRET || 'default_omnimail_secret_key';
  return secret;
}

async function makeToken(email) {
  return crypto.createHmac('sha256', getSecret()).update(email.toLowerCase()).digest('hex').slice(0, 32);
}

async function verifyToken(email, token) {
  const expected = makeToken(email);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function unsubscribeUrl(baseUrl, email) {
  const token = makeToken(email);
  return `${baseUrl}/api/unsubscribe/${encodeURIComponent(email)}/${token}`;
}

module.exports = { makeToken, verifyToken, unsubscribeUrl };
