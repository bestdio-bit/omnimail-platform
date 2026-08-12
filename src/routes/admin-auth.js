const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// In-memory admin sessions store
const adminSessions = new Map();

/**
 * POST /api/admin-auth/login
 * Authenticate the site owner using ADMIN_EMAIL + ADMIN_PASSWORD env vars
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'missing_credentials',
      message: 'Email and password are required.'
    });
  }

  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@omnimail.local').toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (email.toLowerCase().trim() !== adminEmail || password !== adminPassword) {
    return res.status(401).json({
      success: false,
      error: 'invalid_credentials',
      message: 'Invalid admin credentials.'
    });
  }

  // Generate admin session token
  const token = 'tok_admin_' + crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

  adminSessions.set(token, { email: adminEmail, expiresAt });

  // Clean up expired sessions periodically
  for (const [k, v] of adminSessions) {
    if (v.expiresAt < Date.now()) adminSessions.delete(k);
  }

  res.json({
    success: true,
    message: 'Admin authenticated successfully.',
    token
  });
});

/**
 * POST /api/admin-auth/logout
 */
router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer tok_admin_')) {
    const token = authHeader.split(' ')[1].trim();
    adminSessions.delete(token);
  }
  res.json({ success: true, message: 'Admin logged out.' });
});

/**
 * GET /api/admin-auth/verify
 * Check if the current admin token is valid
 */
router.get('/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer tok_admin_')) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  const token = authHeader.split(' ')[1].trim();
  const session = adminSessions.get(token);

  if (!session || session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ success: false, error: 'expired' });
  }

  res.json({ success: true, data: { email: session.email } });
});

module.exports = router;
module.exports.adminSessions = adminSessions;
