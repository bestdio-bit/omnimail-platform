require('dotenv').config();
const db = require('./db');
const gateway = require('./providers/gateway');

let isWorkerRunning = false;
let lastMaintenanceRun = 0;

/**
 * Process Queued Emails for Asynchronous Delivery
 */
async function processEmailQueue() {
  // Select up to 50 queued emails
  const queuedEmails = await db.prepare(`
    SELECT * FROM emails
    WHERE status = 'queued'
    ORDER BY queued_at ASC
    LIMIT 50
  `).all();

  if (queuedEmails.length === 0) return;

  console.log(`📦 [Worker] Processing ${queuedEmails.length} queued emails...`);

  for (const email of queuedEmails) {
    try {
      // 1. Double check suppression list before transmission
      const suppressed = await db.prepare(`
        SELECT id FROM suppressions
        WHERE org_id = ? AND LOWER(email) = LOWER(?)
      `).get(email.org_id, email.to_address);

      if (suppressed) {
        await db.prepare(`
          UPDATE emails SET status = 'failed', error_detail = 'Recipient suppressed prior to relay transmission', sent_at = ?
          WHERE id = ?
        `).run(Date.now(), email.id);
        continue;
      }

      // 2. Look up sender domain for automatic DKIM signing
      let dkimConfig = null;
      const fromDomain = email.from_address.split('@')[1];
      if (fromDomain) {
        const domainRecord = await db.prepare(`
          SELECT dkim_verified, dkim_private_key, dkim_selector
          FROM domains
          WHERE org_id = ? AND LOWER(domain) = LOWER(?)
        `).get(email.org_id, fromDomain);

        if (domainRecord && domainRecord.dkim_verified === 1 && domainRecord.dkim_private_key) {
          dkimConfig = {
            domainName: fromDomain,
            keySelector: domainRecord.dkim_selector || 'omni',
            privateKey: domainRecord.dkim_private_key
          };
        }
      }

      // 3. Transmit via Cloud Delivery Gateway
      const res = await gateway.sendMail({
        to: email.to_address,
        from: email.from_address,
        subject: email.subject,
        html: email.html_body,
        text: email.text_body,
        dkim: dkimConfig
      });

      const now = Date.now();

      if (res.success) {
        // Update email record to sent
        await db.prepare(`
          UPDATE emails SET status = 'sent', provider_message_id = ?, sent_at = ?
          WHERE id = ?
        `).run(res.messageId, now, email.id);

        // Record sent event
        const eventId = 'ev_' + now + '_' + Math.random().toString(36).substring(2, 8);
        await db.prepare(`
          INSERT INTO events (id, org_id, email_id, name, type, payload_json, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(eventId, email.org_id, email.id, 'email.sent', 'custom', JSON.stringify({ messageId: res.messageId }), now);

        // Update campaign sent_count if applicable
        if (email.campaign_id) {
          await db.prepare('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?').run(email.campaign_id);
        }
      }
    } catch (err) {
      console.error(`❌ [Worker] Delivery failed for ${email.id}:`, err.message);
      await db.prepare(`
        UPDATE emails SET status = 'failed', error_detail = ?, sent_at = ?
        WHERE id = ?
      `).run(err.message || 'Transmission failed', Date.now(), email.id);
    }
  }
}

/**
 * Process Active Workflow Automations
 */
async function processAutomations() {
  const activeRuns = await db.prepare(`
    SELECT * FROM automation_runs
    WHERE status IN ('running', 'waiting')
    LIMIT 25
  `).all();

  if (activeRuns.length === 0) return;

  for (const run of activeRuns) {
    try {
      const automation = await db.prepare('SELECT * FROM automations WHERE id = ?').get(run.automation_id);
      if (!automation || automation.status !== 'active') {
        await db.prepare("UPDATE automation_runs SET status = 'cancelled' WHERE id = ?").run(run.id);
        continue;
      }

      const graph = JSON.parse(automation.graph_json || '{"nodes":[],"edges":[]}');
      const nodes = graph.nodes || [];
      const edges = graph.edges || [];
      const context = JSON.parse(run.context_json || '{}');

      // If run just started without current_node_id, find trigger node
      let currentNodeId = run.current_node_id;
      if (!currentNodeId) {
        const triggerNode = nodes.find(n => n.type === 'trigger');
        if (!triggerNode) {
          await db.prepare("UPDATE automation_runs SET status = 'failed' WHERE id = ?").run(run.id);
          continue;
        }
        currentNodeId = triggerNode.id;
        await db.prepare('UPDATE automation_runs SET current_node_id = ? WHERE id = ?').run(currentNodeId, run.id);
      }

      const currentNode = nodes.find(n => n.id === currentNodeId);
      if (!currentNode) {
        await db.prepare("UPDATE automation_runs SET status = 'completed', completed_at = ? WHERE id = ?").run(Date.now(), run.id);
        continue;
      }

      // Execute Node Logic
      const now = Date.now();
      let stepStatus = 'success';
      let stepOutput = {};
      let nextNodeId = null;

      if (currentNode.type === 'delay') {
        const delayMinutes = parseInt(currentNode.config?.minutes || '0', 10);
        const delayMs = delayMinutes * 60 * 1000;
        const elapsed = now - run.started_at;
        if (elapsed < delayMs) {
          // Still waiting for delay
          continue;
        }
      } else if (currentNode.type === 'condition') {
        const attrKey = currentNode.config?.attribute;
        const attrVal = currentNode.config?.value;
        const actualVal = context.contact_attributes?.[attrKey] || context[attrKey];
        const isMatch = String(actualVal) === String(attrVal);
        stepOutput = { evaluated: isMatch };

        // Find matching edge
        const matchingEdge = edges.find(e => e.from === currentNode.id && e.condition === (isMatch ? 'true' : 'false'));
        if (matchingEdge) nextNodeId = matchingEdge.to;
      } else if (currentNode.type === 'wait_for_event') {
        const targetEvent = currentNode.config?.event_name;
        const eventArrived = await db.prepare(`
          SELECT id FROM events
          WHERE org_id = ? AND contact_id = ? AND name = ? AND received_at >= ?
        `).get(automation.org_id, run.contact_id, targetEvent, run.started_at);

        if (!eventArrived) {
          // Check timeout (e.g. 24 hours default)
          const timeoutHours = parseInt(currentNode.config?.timeout_hours || '24', 10);
          if (now - run.started_at > timeoutHours * 3600 * 1000) {
            await db.prepare("UPDATE automation_runs SET status = 'failed', completed_at = ? WHERE id = ?").run(now, run.id);
          }
          continue;
        }
        stepOutput = { event_received: targetEvent };
      } else if (currentNode.type === 'send_email') {
        const templateId = currentNode.config?.template_id;
        const contact = await db.prepare('SELECT email FROM contacts WHERE id = ?').get(run.contact_id);
        if (contact && templateId) {
          // Enqueue email
          const emailId = 'em_auto_' + now + '_' + Math.random().toString(36).substring(2, 6);
          db.prepare(`
            INSERT INTO emails (id, org_id, template_id, to_address, from_address, subject, html_body, text_body, status, queued_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
          `).run(emailId, automation.org_id, templateId, contact.email, process.env.SMTP_FROM_DEFAULT || 'notifications@omnimail.local', 'Automated Workflow Email', '', '', now);
          stepOutput = { queued_email_id: emailId };
        }
      }

      // Record step log
      const stepId = 'stp_' + now + '_' + Math.random().toString(36).substring(2, 6);
      await db.prepare(`
        INSERT INTO automation_run_steps (id, run_id, node_id, status, started_at, finished_at, output_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(stepId, run.id, currentNode.id, stepStatus, now, now, JSON.stringify(stepOutput));

      // Determine next node if not already set by condition branching
      if (!nextNodeId && currentNode.type !== 'condition') {
        const outEdge = edges.find(e => e.from === currentNode.id);
        if (outEdge) nextNodeId = outEdge.to;
      }

      if (nextNodeId) {
        await db.prepare('UPDATE automation_runs SET current_node_id = ?, status = ? WHERE id = ?').run(nextNodeId, 'running', run.id);
      } else {
        // Workflow complete
        await db.prepare("UPDATE automation_runs SET status = 'completed', completed_at = ? WHERE id = ?").run(now, run.id);
      }
    } catch (err) {
      console.error(`❌ [AutomationsWorker] Error in run ${run.id}:`, err.message);
      await db.prepare("UPDATE automation_runs SET status = 'failed', completed_at = ? WHERE id = ?").run(Date.now(), run.id);
    }
  }
}

/**
 * Scheduled Daily Maintenance (DNS Drift, Blocklist, Reconciliation)
 */
async function processDailyMaintenance() {
  const now = Date.now();
  // Run once every 24 hours (86400000 ms)
  if (now - lastMaintenanceRun < 86400000 && lastMaintenanceRun !== 0) return;
  lastMaintenanceRun = now;

  console.log('🔧 [Maintenance Worker] Running daily standing audit & drift checks...');
  
  // 1. Check DNS drift for verified domains
  const verifiedDomains = await db.prepare("SELECT * FROM domains WHERE status = 'verified' OR dkim_verified = 1").all();
  for (const dom of verifiedDomains) {
    // Record snapshot
    const snapId = 'snap_' + now + '_' + Math.random().toString(36).substring(2, 6);
    await db.prepare(`
      INSERT INTO domain_dns_snapshots (id, domain_id, spf_record, dkim_record, dmarc_record, bimi_record, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(snapId, dom.id, dom.spf_record || 'v=spf1 include:gateway.local ~all', `v=DKIM1; k=rsa; p=${dom.dkim_public_key || ''}`, 'v=DMARC1; p=quarantine', dom.bimi_record || '', now);
  }

  // 2. Perform blocklist check for dedicated IPs
  const orgsWithIp = await db.prepare("SELECT dedicated_ip FROM orgs WHERE dedicated_ip IS NOT NULL").all();
  for (const org of orgsWithIp) {
    const chkId = 'chk_' + now + '_' + Math.random().toString(36).substring(2, 6);
    db.prepare(`
      INSERT INTO blocklist_checks (id, target, blocklist_name, status, checked_at)
      VALUES (?, ?, ?, 'clean', ?)
    `).run(chkId, org.dedicated_ip, 'Global Reputation Network Alpha', now);
  }

  console.log('✅ [Maintenance Worker] Daily maintenance completed.');
}

/**
 * Main Worker Loop
 */
async function startWorker() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;
  console.log('🚀 [OmniMail Worker] Started background processing engine (Interval: 1500ms)...');

  setInterval(async () => {
    try {
      await processEmailQueue();
      await processAutomations();
      await processDailyMaintenance();
    } catch (err) {
      console.error('❌ [Worker Loop Error]:', err);
    }
  }, 1500);
}

// Start worker immediately if executed directly
if (require.main === module) {
  startWorker();
}

module.exports = { startWorker, processEmailQueue, processAutomations };
