const crypto = require('crypto');

/**
 * Generate 2048-bit RSA Keypair for DKIM domain authentication
 */
async function generateDkimKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  // Extract base64 body from PEM for DNS TXT record
  const publicKeyBase64 = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\r?\n|\r/g, '')
    .trim();

  return {
    privateKey,
    publicKey,
    publicKeyBase64
  };
}

/**
 * Create HMAC-SHA256 signature for stateless unsubscribe links and webhook verification
 */
async function signHmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Verify HMAC-SHA256 signature
 */
async function verifyHmac(data, signature, secret) {
  const expected = signHmac(data, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch (err) {
    return false;
  }
}

/**
 * Generate secure random token
 */
async function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

module.exports = {
  generateDkimKeyPair,
  signHmac,
  verifyHmac,
  generateToken
};
