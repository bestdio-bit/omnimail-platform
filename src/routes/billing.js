const express = require('express');
const router = express.Router();
const db = require('../db');
const crypto = require('crypto');
const checkout = require('../lib/checkout');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

// 1. Universal Server-to-Server Webhook Receiver (No Bearer Token Required!)
router.post('/webhooks/checkout', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-verify-signature'] || req.headers['x-checkout-signature'] || '';
  const payloadStr = req.body.toString('utf8');
  const payloadBase64 = Buffer.from(payloadStr).toString('base64');

  // Verify HMAC signature
  if (!checkout.verifyWebhookSignature(payloadBase64, signature) && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'invalid_signature', message: 'HMAC webhook verification failed.' });
  }

  try {
    const data = JSON.parse(payloadStr);
    const { orderId, status = 'SUCCESS', planTier = 'mid' } = data;

    if (orderId) {
      const order = await db.prepare('SELECT * FROM checkout_orders WHERE order_id = ?').get(orderId);
      if (order) {
        const now = Date.now();
        await db.transaction(async () => {
          await db.prepare('UPDATE checkout_orders SET status = ?, updated_at = ? WHERE order_id = ?').run(status, now, orderId);
          if (status === 'SUCCESS') {
            await db.prepare('UPDATE orgs SET plan_tier = ? WHERE id = ?').run(planTier, order.org_id);
          }
        })();
        console.log(`✅ [Checkout Webhook] Verified payment order ${orderId} -> Status: ${status}, Plan: ${planTier}`);
      }
    }
    res.status(200).json({ success: true, message: 'Webhook processed successfully.' });
  } catch (err) {
    console.error('❌ [Checkout Webhook Error]:', err);
    res.status(500).json({ success: false, error: 'webhook_error' });
  }
});

// 2. Mock PayPage for Local Testing (Simulates Customer Checkout UI)
router.get('/mock-paypage', async (req, res) => {
  const { order_id, amount, token } = req.query;
  res.send(`
    <div style="font-family: Inter, sans-serif; max-width: 500px; margin: 80px auto; padding: 40px; background: #11131c; color: #e6eaf3; border-radius: 12px; border: 1px solid #252940; text-align: center;">
      <h1 style="color: #6366f1; margin-bottom: 8px;">Universal Checkout Gateway</h1>
      <p style="color: #a0a8c0; margin-bottom: 24px;">Order ID: <code>${order_id}</code> | Amount: <strong>$${amount}</strong></p>
      <form action="/api/billing/mock-confirm" method="POST">
        <input type="hidden" name="order_id" value="${order_id}" />
        <input type="hidden" name="plan_tier" value="mid" />
        <button type="submit" style="background: #6366f1; color: white; border: none; padding: 12px 24px; font-size: 16px; font-weight: 600; border-radius: 8px; cursor: pointer; width: 100%;">Simulate Payment Success</button>
      </form>
    </div>
  `);
});

router.post('/mock-confirm', express.urlencoded({ extended: true }), async (req, res) => {
  const { order_id, plan_tier = 'mid' } = req.body;
  const order = await db.prepare('SELECT * FROM checkout_orders WHERE order_id = ?').get(order_id);
  if (order) {
    const now = Date.now();
    await db.transaction(async () => {
      await db.prepare('UPDATE checkout_orders SET status = ?, updated_at = ? WHERE order_id = ?').run('SUCCESS', now, order_id);
      await db.prepare('UPDATE orgs SET plan_tier = ? WHERE id = ?').run(plan_tier, order.org_id);
    })();
  }
  res.redirect('/?payment=success&order_id=' + order_id);
});

// 3. Authenticated Management Endpoints
router.use(authenticateKey);

/**
 * GET /api/billing/plans
 * List pricing tiers and features (undercutting legacy anchor points!)
 */
router.get('/plans', requireRole('owner', 'admin', 'billing', 'read_only'), async (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 'free', name: 'Free Tier', price: '$0/mo', volume: '5,000 emails/mo', daily_cap: 'No daily cap!', features: ['RBAC Scoped Keys', 'Core Send API', 'Community Support'] },
      { id: 'entry', name: 'Entry Paid', price: '$7/mo', volume: '10,000 emails/mo', daily_cap: 'No daily cap!', features: ['RBAC Scoped Keys', 'All Free Features', 'Email Support'] },
      { id: 'mid', name: 'Mid Tier (Pro)', price: '$49/mo', volume: '100,000 emails/mo', daily_cap: 'No daily cap!', features: ['Included FREE Dedicated IP!', 'RBAC Scoped Keys', 'Visual Automations', 'Priority Support'] },
      { id: 'enterprise', name: 'Enterprise', price: 'Custom', volume: 'Custom Volume', daily_cap: 'No daily cap!', features: ['Included FREE SAML SSO!', 'Dedicated IP included', 'Dedicated Account Manager', 'SLA Guarantee'] }
    ]
  });
});

/**
 * POST /api/billing/checkout
 * Create Universal Server-to-Server Payment Request
 */
router.post('/checkout', requireRole('owner', 'admin', 'billing'), async (req, res) => {
  const { plan_tier = 'mid', amount = 49 } = req.body;
  const orgId = req.auth.org_id;
  const now = Date.now();
  const orderId = 'ord_' + now + '_' + Math.random().toString(36).substring(2, 6);

  const reqResult = await checkout.createPaymentRequest({
    orderId,
    amount,
    currency: 'USD',
    redirectUrl: `${process.env.APP_URL || 'http://localhost:3000'}/?order_id=${orderId}`
  });

  await db.prepare(`
    INSERT INTO checkout_orders (id, org_id, order_id, amount, currency, status, payment_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'USD', 'PENDING', ?, ?, ?)
  `).run('chk_' + now, orgId, orderId, amount, reqResult.paymentToken, now, now);

  logAudit(orgId, req.auth.key_id, 'checkout_initiated', 'order', orderId, { plan_tier, amount });

  res.status(201).json({
    success: true,
    data: reqResult,
    message: 'Payment request generated! Redirect user to payPageUrl to complete checkout.'
  });
});

/**
 * GET /api/billing/orders
 */
router.get('/orders', requireRole('owner', 'admin', 'billing', 'read_only'), async (req, res) => {
  const orders = await db.prepare('SELECT * FROM checkout_orders WHERE org_id = ? ORDER BY created_at DESC').all(req.auth.org_id);
  res.json({ success: true, data: orders });
});

/**
 * POST /api/billing/enterprise-request
 * Submit an enterprise pricing request
 */
router.post('/enterprise-request', async (req, res) => {
  const { message } = req.body;
  const id = 'req_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();

  try {
    await db.prepare(`
      INSERT INTO enterprise_requests (id, org_id, user_id, name, email, message, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.auth.org_id, req.auth.user_id || 'unknown', req.auth.name, req.auth.email || req.auth.name, message || '', 'pending', now);

    res.json({ success: true, message: 'Enterprise request submitted successfully. Our team will contact you shortly.' });
  } catch (err) {
    console.error('Enterprise request error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit enterprise request.' });
  }
});

module.exports = router;
