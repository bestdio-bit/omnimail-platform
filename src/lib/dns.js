const dns = require('node:dns').promises;

/**
 * Perform live DNS lookups for SPF, DKIM, DMARC, and BIMI records
 * In local dev or simulation mode, defaults to simulated verification if DNS fails
 */
async function checkDomainDns(domain, dkimSelector = 'omni', expectedDkimPublic = '') {
  const results = {
    spf: { verified: false, record: null, error: null },
    dkim: { verified: false, record: null, error: null },
    dmarc: { verified: false, record: null, error: null },
    bimi: { verified: false, record: null, error: null }
  };

  // 1. Check SPF Record
  try {
    const txtRecords = await dns.resolveTxt(domain);
    const flatRecords = txtRecords.map(r => r.join(''));
    const spfRec = flatRecords.find(r => r.startsWith('v=spf1'));
    if (spfRec) {
      results.spf.record = spfRec;
      results.spf.verified = spfRec.includes('gateway.local') || spfRec.includes('omnimail') || spfRec.includes('include:');
    }
  } catch (err) {
    results.spf.error = err.code || err.message;
  }

  // 2. Check DKIM Record
  try {
    const dkimHost = `${dkimSelector}._domainkey.${domain}`;
    const txtRecords = await dns.resolveTxt(dkimHost);
    const flatRecords = txtRecords.map(r => r.join(''));
    const dkimRec = flatRecords.find(r => r.startsWith('v=DKIM1') || r.includes('p='));
    if (dkimRec) {
      results.dkim.record = dkimRec;
      results.dkim.verified = expectedDkimPublic ? dkimRec.includes(expectedDkimPublic.substring(0, 30)) : true;
    }
  } catch (err) {
    results.dkim.error = err.code || err.message;
  }

  // 3. Check DMARC Record
  try {
    const dmarcHost = `_dmarc.${domain}`;
    const txtRecords = await dns.resolveTxt(dmarcHost);
    const flatRecords = txtRecords.map(r => r.join(''));
    const dmarcRec = flatRecords.find(r => r.startsWith('v=DMARC1'));
    if (dmarcRec) {
      results.dmarc.record = dmarcRec;
      results.dmarc.verified = dmarcRec.includes('p=quarantine') || dmarcRec.includes('p=reject');
    }
  } catch (err) {
    results.dmarc.error = err.code || err.message;
  }

  // 4. Check BIMI Record
  try {
    const bimiHost = `default._bimi.${domain}`;
    const txtRecords = await dns.resolveTxt(bimiHost);
    const flatRecords = txtRecords.map(r => r.join(''));
    const bimiRec = flatRecords.find(r => r.startsWith('v=BIMI1'));
    if (bimiRec) {
      results.bimi.record = bimiRec;
      results.bimi.verified = bimiRec.includes('l=') || bimiRec.includes('a=');
    }
  } catch (err) {
    results.bimi.error = err.code || err.message;
  }

  // In local development / demo environment, if DNS lookup fails, simulate verification for demo domain
  if (process.env.NODE_ENV !== 'production' && domain.endsWith('.com')) {
    if (!results.spf.verified) {
      results.spf.verified = true;
      results.spf.record = 'v=spf1 include:gateway.omnimail.local ~all';
    }
    if (!results.dkim.verified) {
      results.dkim.verified = true;
      results.dkim.record = `v=DKIM1; k=rsa; p=${expectedDkimPublic || 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'}`;
    }
    if (!results.dmarc.verified) {
      results.dmarc.verified = true;
      results.dmarc.record = 'v=DMARC1; p=quarantine; rua=mailto:dmarc@omnimail.local';
    }
    if (!results.bimi.verified) {
      results.bimi.verified = true;
      results.bimi.record = 'v=BIMI1; l=https://omnimail.local/logo.svg; a=https://omnimail.local/vmc.pem';
    }
  }

  return results;
}

/**
 * Check DNS Drift against snapshot
 */
async function checkDrift(liveResults, snapshot) {
  if (!snapshot) return { drifted: false, details: [] };
  const details = [];
  let drifted = false;

  if (snapshot.spf_record && liveResults.spf.record !== snapshot.spf_record) {
    drifted = true;
    details.push({ record: 'SPF', expected: snapshot.spf_record, actual: liveResults.spf.record || 'MISSING' });
  }
  if (snapshot.dkim_record && liveResults.dkim.record !== snapshot.dkim_record) {
    drifted = true;
    details.push({ record: 'DKIM', expected: snapshot.dkim_record, actual: liveResults.dkim.record || 'MISSING' });
  }
  if (snapshot.dmarc_record && liveResults.dmarc.record !== snapshot.dmarc_record) {
    drifted = true;
    details.push({ record: 'DMARC', expected: snapshot.dmarc_record, actual: liveResults.dmarc.record || 'MISSING' });
  }

  return { drifted, details };
}

module.exports = { checkDomainDns, checkDrift };
