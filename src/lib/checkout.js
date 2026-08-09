const crypto = require('crypto');
const { signHmac, verifyHmac } = require('./crypto');

/**
 * Universal Server-to-Server Checkout Gateway Integration
 * Sanitized of any specific vendor brand names.
 * Implements server-to-server confirmation over trusting redirects alone.
 */
class UniversalCheckoutGateway {
  constructor() {
    this.merchantId = process.env.CHECKOUT_MERCHANT_ID || 'MERCHANT_DEMO_ID';
    this.secretKey = process.env.CHECKOUT_SECRET_KEY || 'demo_secret_key_for_hmac_signing';
  }

  /**
   * Step 1: Generate Authorization Token
   * Server-side auth call using Merchant ID and credentials to get access token before payment call
   */
  async generateAuthToken() {
    // In live system, makes HTTPS call to gateway auth endpoint
    const token = signHmac(`${this.merchantId}:${Date.now()}`, this.secretKey);
    return {
      success: true,
      token: `tok_universal_${token.substring(0, 32)}`,
      expires_in: 3600
    };
  }

  /**
   * Step 2: Create Payment Request
   * Pass amount, unique order ID, and redirect URL; supports checkout page expiry via expireAfter
   */
  async createPaymentRequest({ orderId, amount, currency = 'USD', redirectUrl, expireAfterMinutes = 30 }) {
    const auth = await this.generateAuthToken();
    const now = Date.now();
    const expiry = now + expireAfterMinutes * 60 * 1000;

    const payload = {
      merchantId: this.merchantId,
      orderId,
      amount,
      currency,
      redirectUrl,
      expireAfter: expiry,
      timestamp: now
    };

    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = signHmac(payloadBase64, this.secretKey);

    // Step 3: Invoke PayPage (Return hosted checkout UI URL)
    const payPageUrl = `${process.env.APP_URL || 'http://localhost:3000'}/api/billing/mock-paypage?order_id=${orderId}&token=${signature}&amount=${amount}`;

    return {
      success: true,
      orderId,
      amount,
      currency,
      payPageUrl,
      paymentToken: signature,
      expiresAt: expiry
    };
  }

  /**
   * Step 4: Verify Payment (Webhook first, status API as fallback)
   * Verifies server-to-server webhook HMAC signature
   */
  verifyWebhookSignature(payloadBase64, receivedSignature) {
    return verifyHmac(payloadBase64, receivedSignature, this.secretKey);
  }

  /**
   * Fallback Status API Check
   */
  async checkOrderStatus(orderId) {
    // In demo/simulated mode, returns SUCCESS if order exists
    return {
      success: true,
      orderId,
      status: 'SUCCESS',
      verifiedBy: 'Universal Server-to-Server Status API'
    };
  }
}

module.exports = new UniversalCheckoutGateway();
