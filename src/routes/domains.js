const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateDkimKeyPair } = require('../lib/crypto');
const { checkDomainDns, checkDrift } = require('../lib/dns');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

router.use(authenticateKey);

/**
 * GET /api/domains
 * List all domains for organization with deliverability status
 */
router.get('/', requireRole('owner', 'admin', 'developer', 'read_only'), async (req, res) => {
  const domains = await db.prepare('SELECT id, domain, spf_verified, dkim_verified, dmarc_verified, bimi_verified, dkim_selector, spf_record, dmarc_record, bimi_record, status, created_at FROM domains WHERE org_id = ? ORDER BY created_at DESC').all(req.auth.org_id);
  res.json({ success: true, data: domains });
});

/**
 * POST /api/domains
 * Onboard new sender domain and generate DKIM keypair & DNS records
 */
router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  const { domain } = req.body;
  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ success: false, error: 'invalid_domain', message: 'Please provide a valid domain string.' });
  }

  const cleanDomain = domain.trim().toLowerCase();
  
  // Check if domain already exists
  const existing = await db.prepare('SELECT id FROM domains WHERE org_id = ? AND domain = ?').get(req.auth.org_id, cleanDomain);
  if (existing) {
    return res.status(409).json({ success: false, error: 'domain_exists', message: `Domain '${cleanDomain}' is already onboarded.` });
  }

  // Generate 2048-bit RSA DKIM Keypair
  const dkim = generateDkimKeyPair();
  const selector = 'omni';
  const id = 'dom_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  const now = Date.now();

  const spfRecord = 'v=spf1 include:gateway.omnimail.local ~all';
  const dmarcRecord = 'v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@' + cleanDomain;
  const bimiRecord = 'v=BIMI1; l=https://' + cleanDomain + '/logo.svg';

  await db.prepare(`
    INSERT INTO domains (id, org_id, domain, dkim_public_key, dkim_private_key, dkim_selector, spf_record, dmarc_record, bimi_record, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, req.auth.org_id, cleanDomain, dkim.publicKeyBase64, dkim.privateKey, selector, spfRecord, dmarcRecord, bimiRecord, now);

  logAudit(req.auth.org_id, req.auth.key_id, 'domain_onboarded', 'domain', id, { domain: cleanDomain });

  res.status(201).json({
    success: true,
    data: {
      id,
      domain: cleanDomain,
      status: 'pending',
      dns_records: [
        { type: 'TXT', host: `${selector}._domainkey.${cleanDomain}`, value: `v=DKIM1; k=rsa; p=${dkim.publicKeyBase64}`, purpose: 'DKIM Authentication (Required)' },
        { type: 'TXT', host: cleanDomain, value: spfRecord, purpose: 'SPF Authorization (Required)' },
        { type: 'TXT', host: `_dmarc.${cleanDomain}`, value: dmarcRecord, purpose: 'DMARC Policy Enforcement (Required)' },
        { type: 'TXT', host: `default._bimi.${cleanDomain}`, value: bimiRecord, purpose: 'BIMI Brand Verification (Optional)' }
      ]
    },
    message: 'Domain onboarded successfully. Please add the DNS TXT records to your domain registrar.'
  });
});

/**
 * GET /api/domains/:id
 */
router.get('/:id', requireRole('owner', 'admin', 'developer', 'read_only'), async (req, res) => {
  const domain = await db.prepare('SELECT id, domain, spf_verified, dkim_verified, dmarc_verified, bimi_verified, dkim_selector, spf_record, dmarc_record, bimi_record, status, created_at FROM domains WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!domain) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Domain not found.' });
  }
  res.json({ success: true, data: domain });
});

/**
 * POST /api/domains/:id/verify
 * Live DNS verification check
 */
router.post('/:id/verify', requireRole('owner', 'admin'), async (req, res) => {
  const domain = await db.prepare('SELECT * FROM domains WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!domain) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Domain not found.' });
  }

  const dnsResults = await checkDomainDns(domain.domain, domain.dkim_selector, domain.dkim_public_key);
  const spfVer = dnsResults.spf.verified ? 1 : 0;
  const dkimVer = dnsResults.dkim.verified ? 1 : 0;
  const dmarcVer = dnsResults.dmarc.verified ? 1 : 0;
  const bimiVer = dnsResults.bimi.verified ? 1 : 0;

  const newStatus = (spfVer && dkimVer && dmarcVer) ? 'verified' : 'pending';

  await db.prepare(`
    UPDATE domains
    SET spf_verified = ?, dkim_verified = ?, dmarc_verified = ?, bimi_verified = ?, status = ?
    WHERE id = ?
  `).run(spfVer, dkimVer, dmarcVer, bimiVer, newStatus, domain.id);

  // Take DNS snapshot if verified
  if (newStatus === 'verified') {
    const snapId = 'snap_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    await db.prepare(`
      INSERT INTO domain_dns_snapshots (id, domain_id, spf_record, dkim_record, dmarc_record, bimi_record, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(snapId, domain.id, dnsResults.spf.record || domain.spf_record, dnsResults.dkim.record || '', dnsResults.dmarc.record || domain.dmarc_record, dnsResults.bimi.record || domain.bimi_record, Date.now());
  }

  logAudit(req.auth.org_id, req.auth.key_id, 'domain_verified', 'domain', domain.id, { status: newStatus, results: dnsResults });

  res.json({
    success: true,
    data: {
      id: domain.id,
      domain: domain.domain,
      status: newStatus,
      spf_verified: Boolean(spfVer),
      dkim_verified: Boolean(dkimVer),
      dmarc_verified: Boolean(dmarcVer),
      bimi_verified: Boolean(bimiVer),
      dns_results: dnsResults
    },
    message: `Domain verification completed. Status: ${newStatus.toUpperCase()}`
  });
});

/**
 * POST /api/domains/:id/check-drift
 * Check for DNS regression/drift against last snapshot
 */
router.post('/:id/check-drift', requireRole('owner', 'admin'), async (req, res) => {
  const domain = await db.prepare('SELECT * FROM domains WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!domain) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Domain not found.' });
  }

  const snapshot = await db.prepare('SELECT * FROM domain_dns_snapshots WHERE domain_id = ? ORDER BY checked_at DESC LIMIT 1').get(domain.id);
  const liveResults = await checkDomainDns(domain.domain, domain.dkim_selector, domain.dkim_public_key);
  const drift = checkDrift(liveResults, snapshot);

  if (drift.drifted) {
    await db.prepare("UPDATE domains SET status = 'at_risk' WHERE id = ?").run(domain.id);
    logAudit(req.auth.org_id, req.auth.key_id, 'domain_drift_detected', 'domain', domain.id, { details: drift.details });
  }

  res.json({
    success: true,
    data: {
      domain_id: domain.id,
      domain: domain.domain,
      drift_detected: drift.drifted,
      status: drift.drifted ? 'at_risk' : domain.status,
      drift_details: drift.details
    },
    message: drift.drifted ? '⚠️ DNS Drift Detected! Domain marked as AT RISK.' : '✅ No DNS drift detected. Domain records are stable.'
  });
});

/**
 * DELETE /api/domains/:id
 */
router.delete('/:id', requireRole('owner', 'admin'), async (req, res) => {
  const info = await db.prepare('DELETE FROM domains WHERE id = ? AND org_id = ?').run(req.params.id, req.auth.org_id);
  if (info.changes === 0) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Domain not found.' });
  }
  logAudit(req.auth.org_id, req.auth.key_id, 'domain_deleted', 'domain', req.params.id);
  res.json({ success: true, message: 'Domain removed successfully.' });
});

module.exports = router;
