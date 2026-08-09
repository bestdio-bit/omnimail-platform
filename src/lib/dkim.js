const crypto = require('crypto');

async function generateDkimKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

async function publicKeyToDnsValue(publicKeyPem) {
  return publicKeyPem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
}

async function buildDnsRecords({ domain, selector, publicKeyPem }) {
  return {
    dkim: {
      type: 'TXT',
      host: `${selector}._domainkey.${domain}`,
      value: `v=DKIM1; k=rsa; p=${publicKeyToDnsValue(publicKeyPem)}`,
    },
    spf: {
      type: 'TXT',
      host: domain,
      value: 'v=spf1 include:gateway.omnimail.local ~all',
      note: 'Replace with your sending gateway or provider SPF include.',
    },
    dmarc: {
      type: 'TXT',
      host: `_dmarc.${domain}`,
      value: 'v=DMARC1; p=quarantine; rua=mailto:postmaster@' + domain,
      note: 'Start with p=quarantine before moving to p=reject.',
    },
  };
}

module.exports = { generateDkimKeypair, publicKeyToDnsValue, buildDnsRecords };
