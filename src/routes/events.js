const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

router.use(authenticateKey);

/**
 * POST /api/events
 * Ingest custom event and trigger matching workflow automations
 */
router.post('/', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const { name, email, contact_id, payload = {} } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, error: 'missing_name', message: 'Event "name" is required (e.g. user.signed_up).' });
  }

  const orgId = req.auth.org_id;
  const now = Date.now();
  const eventId = 'ev_' + now + '_' + Math.random().toString(36).substring(2, 8);

  // Resolve contact if email provided
  let resolvedContactId = contact_id;
  let contactAttributes = {};
  if (!resolvedContactId && email) {
    const contact = await db.prepare('SELECT id, attributes_json FROM contacts WHERE org_id = ? AND LOWER(email) = LOWER(?)').get(orgId, email.trim());
    if (contact) {
      resolvedContactId = contact.id;
      contactAttributes = JSON.parse(contact.attributes_json || '{}');
    }
  } else if (resolvedContactId) {
    const contact = await db.prepare('SELECT attributes_json FROM contacts WHERE id = ? AND org_id = ?').get(resolvedContactId, orgId);
    if (contact) {
      contactAttributes = JSON.parse(contact.attributes_json || '{}');
    }
  }

  // 1. Write event to events table
  db.prepare(`
    INSERT INTO events (id, org_id, contact_id, name, type, payload_json, received_at)
    VALUES (?, ?, ?, ?, 'custom', ?, ?)
  `).run(eventId, orgId, resolvedContactId || null, name, JSON.stringify(payload), now);

  // 2. Check for matching active automations
  const matchingAutomations = await db.prepare(`
    SELECT id, name, graph_json FROM automations
    WHERE org_id = ? AND status = 'active' AND trigger_event_name = ?
  `).all(orgId, name);

  const triggeredRuns = [];
  const contextData = {
    event_name: name,
    event_payload: payload,
    contact_attributes: contactAttributes,
    triggered_at: now
  };

  await db.transaction(async () => {
    for (const auto of matchingAutomations) {
      const runId = 'run_' + now + '_' + Math.random().toString(36).substring(2, 6);
      
      // Find trigger node ID
      const graph = JSON.parse(auto.graph_json || '{"nodes":[]}');
      const triggerNode = (graph.nodes || []).find(n => n.type === 'trigger');

      await db.prepare(`
        INSERT INTO automation_runs (id, automation_id, contact_id, status, current_node_id, started_at, context_json)
        VALUES (?, ?, ?, 'running', ?, ?, ?)
      `).run(runId, auto.id, resolvedContactId || null, triggerNode?.id || null, now, JSON.stringify(contextData));

      triggeredRuns.push({ run_id: runId, automation_id: auto.id, automation_name: auto.name });
    }
  })();

  logAudit(orgId, req.auth.key_id, 'event_ingested', 'event', eventId, { name, triggered_automations: triggeredRuns.length });

  res.status(202).json({
    success: true,
    data: {
      event_id: eventId,
      name,
      contact_id: resolvedContactId || null,
      received_at: now,
      triggered_runs: triggeredRuns
    },
    message: `Event ingested. Triggered ${triggeredRuns.length} active automation workflow(s).`
  });
});

/**
 * GET /api/events
 */
router.get('/', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const events = await db.prepare('SELECT * FROM events WHERE org_id = ? ORDER BY received_at DESC LIMIT 200').all(req.auth.org_id);
  for (const ev of events) ev.payload = JSON.parse(ev.payload_json || '{}');
  res.json({ success: true, data: events });
});

module.exports = router;
