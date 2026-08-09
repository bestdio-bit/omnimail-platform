const dns = require('dns').promises;

async function resolveTxtFlat(hostname) {
  try {
    const records = await dns.resolveTxt(hostname);
    return records.map((chunks) => chunks.join(''));
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') return [];
    throw err;
  }
}

async function checkSpf(domain) {
  const records = await resolveTxtFlat(domain);
  return records.some((r) => r.trim().toLowerCase().startsWith('v=spf1'));
}

async function checkDkim(domain, selector, expectedPublicKeyDnsValue) {
  const records = await resolveTxtFlat(`${selector}._domainkey.${domain}`);
  return records.some((r) => {
    const normalized = r.replace(/\s+/g, '');
    return normalized.includes(expectedPublicKeyDnsValue);
  });
}

async function checkDmarc(domain) {
  const records = await resolveTxtFlat(`_dmarc.${domain}`);
  return records.some((r) => r.trim().toLowerCase().startsWith('v=dmarc1'));
}

module.exports = { checkSpf, checkDkim, checkDmarc };
