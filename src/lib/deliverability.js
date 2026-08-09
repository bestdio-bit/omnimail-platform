const dns = require('dns').promises;
const { nanoid } = require('nanoid');
const db = require('../db');
const { logAudit } = require('../middleware/rbac');

const MAJOR_DNSBLS = [
  'zen.spamhaus.org',
  'b.barracudacentral.org',
  'bl.spamcop.net',
  'dnsbl.sorbs.net',
];



async function generateBimiRecord(logoUrl, vmcUrl) {
  if (!logoUrl) return { error: 'logoUrl is required for BIMI (must be SVG)' };
  let record = `v=BIMI1; l=${logoUrl};`;
  if (vmcUrl) {
    record += ` a=${vmcUrl};`;
  }
  return {
    record,
    host: 'default._bimi',
    instructions: 'Add this TXT record to your DNS settings at default._bimi.<yourdomain.com>',
  };
}

async function checkBlocklists(domainId, ipAddress = '127.0.0.2') {
  let targetIp = ipAddress;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(targetIp)) {
    try {
      const addrs = await dns.resolve4(targetIp);
      if (addrs && addrs.length) targetIp = addrs[0];
      else targetIp = '127.0.0.1';
    } catch {
      targetIp = '127.0.0.1';
    }
  }

  const reversedIp = targetIp.split('.').reverse().join('.');
  const results = [];
  const now = Date.now();

  for (const dnsbl of MAJOR_DNSBLS) {
    const lookupHost = `${reversedIp}.${dnsbl}`;
    let isListed = false;
    let details = 'Not listed';

    try {
      const addrs = await dns.resolve4(lookupHost);
      if (addrs && addrs.length) {
        isListed = true;
        details = `Listed on ${dnsbl} (${addrs.join(', ')})`;
      }
    } catch (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'SERVFAIL') {
        isListed = false;
        details = 'Clean / Not listed';
      } else {
        isListed = false;
        details = `Check error: ${err.code || err.message}`;
      }
    }

    const checkId = `bl_${nanoid(16)}`;
    try {
      await db.prepare(`
        INSERT INTO blocklist_checks (id, target, blocklist_name, status, checked_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(checkId, targetIp, dnsbl, isListed ? 'listed' : 'clean', now);
    } catch (e) {}

    results.push({ dnsbl_host: dnsbl, is_listed: isListed, details, checked_at: new Date(now).toISOString() });
  }

  return { domain_id: domainId, ip_address: targetIp, checks: results };
}

async function snapshotAndCheckDrift(domainId) {
  const domainRow = await db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId);
  if (!domainRow) return { error: 'Domain not found' };

  const domain = domainRow.domain;
  let currentSpf = null;
  let currentDkim = null;
  let currentDmarc = null;
  let currentBimi = null;

  try {
    const txts = await dns.resolveTxt(domain);
    const flat = txts.map(r => r.join(''));
    currentSpf = flat.find(r => r.startsWith('v=spf1')) || null;
  } catch {}

  try {
    const selector = domainRow.dkim_selector || 'omni';
    const dkimTxts = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
    currentDkim = dkimTxts.map(r => r.join('')).find(r => r.startsWith('v=DKIM1')) || null;
  } catch {}

  try {
    const dmarcTxts = await dns.resolveTxt(`_dmarc.${domain}`);
    currentDmarc = dmarcTxts.map(r => r.join('')).find(r => r.startsWith('v=DMARC1')) || null;
  } catch {}

  try {
    const bimiTxts = await dns.resolveTxt(`default._bimi.${domain}`);
    currentBimi = bimiTxts.map(r => r.join('')).find(r => r.startsWith('v=BIMI1')) || null;
  } catch {}

  const snapshot = await db.prepare('SELECT * FROM domain_dns_snapshots WHERE domain_id = ?').get(domainId);

  if (!snapshot) {
    db.prepare(`
      INSERT INTO domain_dns_snapshots (domain_id, spf_record, dkim_record, dmarc_record, bimi_record, snapshotted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(domainId, currentSpf, currentDkim, currentDmarc, currentBimi, Date.now());
    return {
      status: 'snapshot_created',
      snapshot: { spf: currentSpf, dkim: currentDkim, dmarc: currentDmarc, bimi: currentBimi },
      drift_detected: false,
      drift_details: [],
    };
  }

  const driftDetails = [];
  let driftDetected = false;

  if (snapshot.spf_record !== currentSpf) {
    driftDetected = true;
    driftDetails.push({ record: 'SPF', expected: snapshot.spf_record, actual: currentSpf });
  }
  if (snapshot.dkim_record !== currentDkim) {
    driftDetected = true;
    driftDetails.push({ record: 'DKIM', expected: snapshot.dkim_record, actual: currentDkim });
  }
  if (snapshot.dmarc_record !== currentDmarc) {
    driftDetected = true;
    driftDetails.push({ record: 'DMARC', expected: snapshot.dmarc_record, actual: currentDmarc });
  }

  return {
    status: driftDetected ? 'drift_detected' : 'in_sync',
    drift_detected: driftDetected,
    drift_details: driftDetails,
    current: { spf: currentSpf, dkim: currentDkim, dmarc: currentDmarc, bimi: currentBimi },
    snapshot: {
      spf: snapshot.spf_record,
      dkim: snapshot.dkim_record,
      dmarc: snapshot.dmarc_record,
      bimi: snapshot.bimi_record,
    },
  };
}

module.exports = { generateBimiRecord, checkBlocklists, snapshotAndCheckDrift };
