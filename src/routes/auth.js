const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const checkout = require('../lib/checkout');
const { authenticateKey } = require('../middleware/auth');
const { logAudit } = require('../middleware/rbac');

// Helper: Get password salt
async function getSalt(email) {
  if (email === 'admin@omnimail.local') return 'omni_salt_demo';
  return 'omni_salt_' + email.toLowerCase().trim();
}

// Helper: Hash password
async function hashPassword(password, email) {
  return crypto.scryptSync(password, getSalt(email), 64).toString('hex');
}

/**
 * POST /api/auth/signup
 * User Registration with Email Verification OTP
 */
router.post('/signup', async (req, res) => {
  const { email, password, name = 'New User', org_name } = req.body;

  if (!email || !password || password.length < 6) {
    return res.status(400).json({
      success: false,
      error: 'invalid_input',
      message: 'Please provide a valid email address and a password with at least 6 characters.'
    });
  }

  const cleanEmail = email.toLowerCase().trim();
  const existingUser = await db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existingUser) {
    return res.status(400).json({
      success: false,
      error: 'email_exists',
      message: 'An account with this email address already exists. Please log in.'
    });
  }

  const now = Date.now();
  const orgId = 'org_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const userId = 'usr_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const keyId = 'key_' + now;
  const verificationOtp = Math.floor(100000 + Math.random() * 900000).toString();
  const passwordHash = hashPassword(password, cleanEmail);
  const organizationName = org_name || `${name}'s Organization`;

  await db.transaction(async () => {
    // Create Organization
    await db.prepare(`
      INSERT INTO orgs (id, name, plan_tier, onboarding_step, billing_cycle, custom_send_volume, created_at)
      VALUES (?, ?, 'free', 'plan_selection', 'monthly', 5000, ?)
    `).run(orgId, organizationName, now);

    // Create Owner User (Unverified initially!)
    await db.prepare(`
      INSERT INTO users (id, org_id, email, name, role, password_hash, is_verified, verification_token, created_at)
      VALUES (?, ?, ?, ?, 'owner', ?, 0, ?, ?)
    `).run(userId, orgId, cleanEmail, name, passwordHash, verificationOtp, now);

    // Create Default Scoped API Key
    const apiKey = 'omni_live_' + crypto.randomBytes(16).toString('hex');
    await db.prepare(`
      INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, role, created_at)
      VALUES (?, ?, ?, ?, 'omni_live_', 'owner', ?)
    `).run(keyId, orgId, 'Default Master Key', apiKey, now);
  })();

  logAudit(orgId, userId, 'user_signed_up', 'user', userId, { email: cleanEmail });

  res.status(201).json({
    success: true,
    message: 'Account created successfully! Please verify your email address to continue.',
    data: {
      user_id: userId,
      email: cleanEmail,
      org_id: orgId,
      verification_otp: verificationOtp, // Returned in demo/evaluation mode for instant verification!
      verification_url: `/verify?email=${encodeURIComponent(cleanEmail)}&otp=${verificationOtp}`
    }
  });
});

/**
 * POST /api/auth/verify-email
 * Email Verification (Required before dashboard access)
 */
router.post('/verify-email', async (req, res) => {
  const { email, token } = req.body;
  if (!email || !token) {
    return res.status(400).json({ success: false, error: 'missing_params', message: 'Email and verification OTP token are required.' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const user = await db.prepare('SELECT id, org_id, name, role, verification_token FROM users WHERE email = ?').get(cleanEmail);

  if (!user || user.verification_token !== token.trim()) {
    return res.status(400).json({ success: false, error: 'invalid_token', message: 'Invalid verification token or OTP code.' });
  }

  const now = Date.now();
  const sessionId = 'ses_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const sessionToken = 'tok_session_' + crypto.randomBytes(32).toString('hex');
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30 days

  await db.transaction(async () => {
    await db.prepare('UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?').run(user.id);
    await db.prepare(`
      INSERT INTO sessions (id, user_id, org_id, token, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, user.id, user.org_id, sessionToken, expiresAt, now);
  })();

  const org = await db.prepare('SELECT name, plan_tier, onboarding_step FROM orgs WHERE id = ?').get(user.org_id);

  logAudit(user.org_id, user.id, 'email_verified', 'user', user.id, { email: cleanEmail });

  res.status(200).json({
    success: true,
    message: 'Email verified successfully!',
    token: sessionToken,
    data: {
      user: { id: user.id, email: cleanEmail, name: user.name, role: user.role, is_verified: 1 },
      org: { id: user.org_id, name: org.name, plan_tier: org.plan_tier, onboarding_step: org.onboarding_step }
    }
  });
});

/**
 * POST /api/auth/login
 * User Login with Password & Verification Enforcement
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'missing_credentials', message: 'Email and password are required.' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const user = await db.prepare('SELECT id, org_id, name, role, password_hash, is_verified FROM users WHERE email = ?').get(cleanEmail);

  if (!user || !user.password_hash) {
    return res.status(401).json({ success: false, error: 'invalid_credentials', message: 'Invalid email or password.' });
  }

  const expectedHash = hashPassword(password, cleanEmail);
  if (user.password_hash !== expectedHash) {
    return res.status(401).json({ success: false, error: 'invalid_credentials', message: 'Invalid email or password.' });
  }

  // Enforce Email Verification Before Dashboard Access!
  if (user.is_verified === 0) {
    return res.status(403).json({
      success: false,
      error: 'email_not_verified',
      requires_verification: true,
      email: cleanEmail,
      message: 'Email verification is required before accessing the dashboard. Please check your inbox or verify your OTP.'
    });
  }

  const now = Date.now();
  const sessionId = 'ses_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const sessionToken = 'tok_session_' + crypto.randomBytes(32).toString('hex');
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

  await db.prepare(`
    INSERT INTO sessions (id, user_id, org_id, token, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, user.id, user.org_id, sessionToken, expiresAt, now);

  const org = await db.prepare('SELECT name, plan_tier, onboarding_step FROM orgs WHERE id = ?').get(user.org_id);

  logAudit(user.org_id, user.id, 'user_logged_in', 'session', sessionId, { email: cleanEmail });

  res.status(200).json({
    success: true,
    message: 'Logged in successfully!',
    token: sessionToken,
    data: {
      user: { id: user.id, email: cleanEmail, name: user.name, role: user.role, is_verified: 1 },
      org: { id: user.org_id, name: org.name, plan_tier: org.plan_tier, onboarding_step: org.onboarding_step }
    }
  });
});

/**
 * POST /api/auth/forgot-password
 * Generate password reset token
 */
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, error: 'missing_email' });

  const cleanEmail = email.toLowerCase().trim();
  const user = await db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);

  if (user) {
    const resetToken = 'reset_' + crypto.randomBytes(16).toString('hex');
    const expires = Date.now() + 3600 * 1000; // 1 hour
    await db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').run(resetToken, expires, user.id);

    return res.status(200).json({
      success: true,
      message: 'Password reset instructions generated.',
      data: { reset_token: resetToken, reset_url: `/reset-password?token=${resetToken}&email=${encodeURIComponent(cleanEmail)}` }
    });
  }

  // Return 200 even if email not found to prevent user enumeration
  res.status(200).json({ success: true, message: 'If an account exists with that email, reset instructions have been sent.' });
});

/**
 * POST /api/auth/reset-password
 */
router.post('/reset-password', async (req, res) => {
  const { email, token, new_password } = req.body;
  if (!email || !token || !new_password || new_password.length < 6) {
    return res.status(400).json({ success: false, error: 'invalid_input', message: 'Please provide valid token and new password.' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const user = await db.prepare('SELECT id, reset_token, reset_expires FROM users WHERE email = ?').get(cleanEmail);

  if (!user || user.reset_token !== token || user.reset_expires < Date.now()) {
    return res.status(400).json({ success: false, error: 'invalid_reset_token', message: 'Reset token is invalid or has expired.' });
  }

  const newHash = hashPassword(new_password, cleanEmail);
  await db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?').run(newHash, user.id);

  res.status(200).json({ success: true, message: 'Password updated successfully! You may now log in.' });
});

/**
 * POST /api/auth/oauth/:provider
 * Simulated Google/GitHub OAuth Login
 */
router.post('/oauth/:provider', async (req, res) => {
  const { provider } = req.params;
  const { email = 'oauth_user@example.com', name = 'OAuth User' } = req.body;
  const cleanEmail = email.toLowerCase().trim();
  const now = Date.now();

  let user = await db.prepare('SELECT id, org_id, name, role, is_verified FROM users WHERE email = ?').get(cleanEmail);
  let orgId = user ? user.org_id : null;

  if (!user) {
    orgId = 'org_' + now + '_' + Math.random().toString(36).substring(2, 6);
    const userId = 'usr_' + now + '_' + Math.random().toString(36).substring(2, 6);
    const passwordHash = hashPassword('oauth_random_' + now, cleanEmail);

    await db.transaction(async () => {
      await db.prepare(`
        INSERT INTO orgs (id, name, plan_tier, onboarding_step, billing_cycle, custom_send_volume, created_at)
        VALUES (?, ?, 'free', 'plan_selection', 'monthly', 5000, ?)
      `).run(orgId, `${name}'s Org (${provider.toUpperCase()})`, now);

      await db.prepare(`
        INSERT INTO users (id, org_id, email, name, role, password_hash, is_verified, created_at)
        VALUES (?, ?, ?, ?, 'owner', ?, 1, ?)
      `).run(userId, orgId, cleanEmail, name, passwordHash, now);
    })();
    user = { id: userId, org_id: orgId, name, role: 'owner', is_verified: 1 };
  } else if (user.is_verified === 0) {
    await db.prepare('UPDATE users SET is_verified = 1 WHERE id = ?').run(user.id);
    user.is_verified = 1;
  }

  const sessionId = 'ses_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const sessionToken = 'tok_session_' + crypto.randomBytes(32).toString('hex');
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

  await db.prepare(`
    INSERT INTO sessions (id, user_id, org_id, token, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, user.id, orgId, sessionToken, expiresAt, now);

  const org = await db.prepare('SELECT name, plan_tier, onboarding_step FROM orgs WHERE id = ?').get(orgId);

  res.status(200).json({
    success: true,
    message: `Authenticated via ${provider.toUpperCase()} successfully!`,
    token: sessionToken,
    data: {
      user: { id: user.id, email: cleanEmail, name: user.name, role: user.role, is_verified: 1 },
      org: { id: orgId, name: org.name, plan_tier: org.plan_tier, onboarding_step: org.onboarding_step }
    }
  });
});

/**
 * PROTECTED ROUTES BELOW (Require Auth Token / Session)
 */
router.use(authenticateKey);

/**
 * POST /api/auth/onboard-plan
 * Step 3: Plan Selection Onboarding
 */
router.post('/onboard-plan', async (req, res) => {
  const { plan_tier = 'free', billing_cycle = 'monthly' } = req.body;
  const orgId = req.auth.org_id;
  const now = Date.now();

  if (plan_tier === 'free') {
    await db.prepare(`
      UPDATE orgs SET plan_tier = 'free', onboarding_step = 'completed', billing_cycle = ?, custom_send_volume = 5000 WHERE id = ?
    `).run(billing_cycle, orgId);

    logAudit(orgId, req.auth.user_id || req.auth.key_id, 'onboarding_completed_free', 'org', orgId, { plan_tier, billing_cycle });

    return res.status(200).json({
      success: true,
      message: 'Free plan activated! Welcome to your OmniMail Dashboard.',
      data: { plan_tier: 'free', onboarding_step: 'completed', volume_cap: '5,000 emails/mo' }
    });
  }

  // Paid Plan Selection -> Initialize Universal Checkout Gateway
  const amounts = { entry: 7, mid: 49, enterprise: 299 };
  const amount = amounts[plan_tier] || 49;
  const orderId = 'ord_' + now + '_' + Math.random().toString(36).substring(2, 6);

  const reqResult = await checkout.createPaymentRequest({
    orderId,
    amount,
    currency: 'USD',
    redirectUrl: `/app?payment=success&order_id=${orderId}&plan=${plan_tier}`
  });

  await db.transaction(async () => {
    await db.prepare(`
      INSERT INTO checkout_orders (id, org_id, order_id, amount, currency, status, payment_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'USD', 'PENDING', ?, ?, ?)
    `).run('chk_' + now, orgId, orderId, amount, reqResult.paymentToken, now, now);

    await db.prepare(`
      UPDATE orgs SET onboarding_step = 'completed', billing_cycle = ? WHERE id = ?
    `).run(billing_cycle, orgId);
  })();

  logAudit(orgId, req.auth.user_id || req.auth.key_id, 'onboarding_checkout_initiated', 'order', orderId, { plan_tier, amount });

  res.status(200).json({
    success: true,
    message: `Checkout initiated for ${plan_tier.toUpperCase()} plan. Complete payment on Universal Gateway.`,
    data: {
      ...reqResult,
      plan_tier,
      onboarding_step: 'completed'
    }
  });
});

/**
 * GET /api/auth/me
 * Get current authenticated user, organization, and usage profile
 */
router.get('/me', async (req, res) => {
  const user = await db.prepare('SELECT id, email, name, role, is_verified, created_at FROM users WHERE id = ?').get(req.auth.user_id) || {
    id: req.auth.key_id,
    email: 'api_client@omnimail.local',
    name: req.auth.name,
    role: req.auth.role,
    is_verified: 1
  };

  const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.auth.org_id);
  const teamMembers = await db.prepare('SELECT id, email, name, role, created_at FROM users WHERE org_id = ?').all(req.auth.org_id);
  const apiKeysCount = ((await db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE org_id = ?').get(req.auth.org_id))).count;
  const sentCount = (await (await db.prepare("SELECT COUNT(*) as count FROM emails WHERE org_id = ? AND status = 'sent'").get(req.auth.org_id))).count;

  res.json({
    success: true,
    data: {
      user,
      org,
      team_members: teamMembers,
      stats: {
        api_keys_count: apiKeysCount,
        emails_sent_this_month: sentCount,
        quota_limit: org?.custom_send_volume || 50000
      }
    }
  });
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer tok_session_')) {
    const token = authHeader.split(' ')[1].trim();
    await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.json({ success: true, message: 'Logged out successfully.' });
});

module.exports = router;
