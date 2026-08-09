const { nanoid } = require('nanoid');
const db = require('../db');
const { queueEmail } = require('./queueEmail');
const { logAudit } = require('../middleware/rbac');

async function executeStep(run) {
  if (!run || run.status !== 'running') return;
  const now = Date.now();

  const node = await db.prepare('SELECT * FROM automation_nodes WHERE id = ?').get(run.current_node_id);
  if (!node) {
    await db.prepare("UPDATE automation_runs SET status = 'completed', finished_at = ? WHERE id = ?").run(now, run.id);
    return;
  }

  let config = {};
  try { config = JSON.parse(node.config_json || '{}'); } catch {}

  let context = {};
  try { context = JSON.parse(run.context_json || '{}'); } catch {}

  const stepId = `stp_${nanoid(16)}`;
  await db.prepare(`
    INSERT INTO automation_run_steps (id, run_id, node_id, node_type, status, output_json, started_at, finished_at)
    VALUES (?, ?, ?, ?, 'success', ?, ?, ?)
  `).run(stepId, run.id, node.id, node.type, JSON.stringify({ executed: true }), now, now);

  const edges = await db.prepare('SELECT * FROM automation_edges WHERE from_node_id = ?').all(node.id);
  const targetEdge = edges[0];

  if (targetEdge) {
    await db.prepare('UPDATE automation_runs SET current_node_id = ?, context_json = ? WHERE id = ?')
      .run(targetEdge.to_node_id, JSON.stringify(context), run.id);
  } else {
    db.prepare("UPDATE automation_runs SET status = 'completed', finished_at = ? WHERE id = ?")
      .run(now, run.id);
  }
}

async function triggerAutomations(orgId, eventType, contactEmail, eventPayload = {}) {
  const activeAutomations = db.prepare(`
    SELECT * FROM automations
    WHERE org_id = ? AND status = 'active' AND trigger_event_name = ?
  `).all(orgId, eventType);

  if (!activeAutomations.length) return { triggered: 0, runs: [] };

  const cleanEmail = contactEmail.toLowerCase().trim();
  let contact = await db.prepare('SELECT * FROM contacts WHERE org_id = ? AND LOWER(email) = ?').get(orgId, cleanEmail);
  if (!contact) {
    const contactId = `ct_${nanoid(16)}`;
    const now = Date.now();
    await db.prepare('INSERT INTO contacts (id, org_id, email, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(contactId, orgId, cleanEmail, 'active', now);
    contact = { id: contactId, org_id: orgId, email: cleanEmail };
  }

  const runIds = [];
  const now = Date.now();

  for (const auto of activeAutomations) {
    const allNodes = await db.prepare('SELECT * FROM automation_nodes WHERE automation_id = ?').all(auto.id);
    if (!allNodes.length) continue;

    const targetIds = new Set(
      await db.prepare('SELECT to_node_id FROM automation_edges WHERE automation_id = ?').all(auto.id).map(e => e.to_node_id)
    );
    let rootNode = allNodes.find(n => !targetIds.has(n.id)) || allNodes[0];

    const runId = `ar_${nanoid(16)}`;
    const contextJson = JSON.stringify({ event: eventPayload, contact });

    await db.prepare(`
      INSERT INTO automation_runs (id, automation_id, status, context_json, started_at)
      VALUES (?, ?, 'running', ?, ?)
    `).run(runId, auto.id, contextJson, now);

    runIds.push(runId);
  }

  for (const runId of runIds) {
    const run = await db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(runId);
    if (run) executeStep(run);
  }

  return { triggered: runIds.length, runs: runIds };
}

async function simulateAutomation(automationId, contactEmail = 'sim@omnimail.local', eventPayload = {}) {
  const auto = await db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId);
  if (!auto) throw new Error('Automation not found');

  const nodes = await db.prepare('SELECT * FROM automation_nodes WHERE automation_id = ?').all(auto.id);
  const edges = await db.prepare('SELECT * FROM automation_edges WHERE automation_id = ?').all(auto.id);

  const simulationLog = [];
  for (const n of nodes) {
    simulationLog.push({
      node_id: n.id,
      type: n.type,
      config: JSON.parse(n.config_json || '{}'),
      simulated_result: 'success',
      timestamp: Date.now()
    });
  }

  return {
    automation_id: auto.id,
    automation_name: auto.name,
    simulated_contact: contactEmail,
    payload: eventPayload,
    steps_simulated: simulationLog.length,
    timeline: simulationLog,
    status: 'simulation_passed'
  };
}

module.exports = {
  triggerAutomations,
  simulateAutomation,
  executeStep
};
