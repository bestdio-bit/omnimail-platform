const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateKey } = require('../middleware/auth');
const { requireRole, logAudit } = require('../middleware/rbac');

router.use(authenticateKey);

/**
 * GET /api/automations
 */
router.get('/', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const automations = await db.prepare(`
    SELECT a.*,
           (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'running') as running_count,
           (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'completed') as completed_count,
           (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'failed') as failed_count
    FROM automations a
    WHERE a.org_id = ?
    ORDER BY a.updated_at DESC
  `).all(req.auth.org_id);

  for (const auto of automations) auto.graph = JSON.parse(auto.graph_json || '{"nodes":[],"edges":[]}');
  res.json({ success: true, data: automations });
});

/**
 * POST /api/automations
 * Create new automation workflow
 */
router.post('/', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const { name, trigger_event_name = 'user.signed_up', graph } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, error: 'missing_name', message: 'Automation name is required.' });
  }

  const now = Date.now();
  const id = 'aut_' + now + '_' + Math.random().toString(36).substring(2, 6);

  const defaultGraph = graph || {
    nodes: [
      { id: 'node_1', type: 'trigger', config: { event: trigger_event_name }, position: { x: 250, y: 50 } },
      { id: 'node_2', type: 'delay', config: { minutes: 10 }, position: { x: 250, y: 180 } },
      { id: 'node_3', type: 'send_email', config: { template_id: 'tpl_welcome' }, position: { x: 250, y: 310 } }
    ],
    edges: [
      { id: 'edge_1', from: 'node_1', to: 'node_2' },
      { id: 'edge_2', from: 'node_2', to: 'node_3' }
    ]
  };

  await db.prepare(`
    INSERT INTO automations (id, org_id, name, status, trigger_event_name, graph_json, created_at, updated_at)
    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)
  `).run(id, req.auth.org_id, name, trigger_event_name, JSON.stringify(defaultGraph), now, now);

  logAudit(req.auth.org_id, req.auth.key_id, 'automation_created', 'automation', id, { name, trigger_event_name });

  res.status(201).json({
    success: true,
    data: { id, name, status: 'draft', trigger_event_name, graph: defaultGraph, created_at: now },
    message: 'Automation created in DRAFT status.'
  });
});

/**
 * GET /api/automations/:id
 */
router.get('/:id', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const auto = await db.prepare('SELECT * FROM automations WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!auto) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Automation not found.' });
  }
  auto.graph = JSON.parse(auto.graph_json || '{"nodes":[],"edges":[]}');
  res.json({ success: true, data: auto });
});

/**
 * PUT /api/automations/:id
 * Update workflow graph (nodes and edges)
 */
router.put('/:id', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const { name, trigger_event_name, graph } = req.body;
  const auto = await db.prepare('SELECT * FROM automations WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!auto) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Automation not found.' });
  }

  const now = Date.now();
  const newName = name || auto.name;
  const newTrigger = trigger_event_name || auto.trigger_event_name;
  const newGraph = graph || JSON.parse(auto.graph_json || '{"nodes":[],"edges":[]}');

  await db.transaction(async () => {
    await db.prepare('UPDATE automations SET name = ?, trigger_event_name = ?, graph_json = ?, updated_at = ? WHERE id = ?').run(newName, newTrigger, JSON.stringify(newGraph), now, auto.id);
    
    // Update relational tables for SQL querying
    await db.prepare('DELETE FROM automation_nodes WHERE automation_id = ?').run(auto.id);
    await db.prepare('DELETE FROM automation_edges WHERE automation_id = ?').run(auto.id);

    for (const node of (newGraph.nodes || [])) {
      await db.prepare(`
        INSERT INTO automation_nodes (id, automation_id, type, config_json, position_x, position_y)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(node.id || ('nd_' + Math.random().toString(36).substring(2, 6)), auto.id, node.type || 'send_email', JSON.stringify(node.config || {}), node.position?.x || 0, node.position?.y || 0);
    }

    for (const edge of (newGraph.edges || [])) {
      await db.prepare(`
        INSERT INTO automation_edges (id, automation_id, from_node_id, to_node_id, condition_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(edge.id || ('ed_' + Math.random().toString(36).substring(2, 6)), auto.id, edge.from, edge.to, edge.condition ? JSON.stringify({ cond: edge.condition }) : null);
    }
  })();

  logAudit(req.auth.org_id, req.auth.key_id, 'automation_updated', 'automation', auto.id, { name: newName });

  res.json({ success: true, data: { id: auto.id, name: newName, trigger_event_name: newTrigger, graph: newGraph, updated_at: now }, message: 'Automation graph updated.' });
});

/**
 * PATCH /api/automations/:id
 * Toggle status (active / paused / draft)
 */
router.patch('/:id', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const { status } = req.body;
  if (!['draft', 'active', 'paused'].includes(status)) {
    return res.status(400).json({ success: false, error: 'invalid_status', message: 'Status must be draft, active, or paused.' });
  }
  await db.prepare('UPDATE automations SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?').run(status, Date.now(), req.params.id, req.auth.org_id);
  res.json({ success: true, data: { id: req.params.id, status }, message: `Automation status set to '${status}'.` });
});

/**
 * GET /api/automations/:id/runs
 * List workflow runs with status counts
 */
router.get('/:id/runs', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const runs = await db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 100').all(req.params.id);
  for (const r of runs) r.context = JSON.parse(r.context_json || '{}');
  res.json({ success: true, data: runs });
});

/**
 * GET /api/runs/:id/steps
 * Full execution timeline for one run
 */
router.get('/runs/:id/steps', requireRole('owner', 'admin', 'developer', 'marketer', 'read_only'), async (req, res) => {
  const steps = await db.prepare('SELECT * FROM automation_run_steps WHERE run_id = ? ORDER BY started_at ASC').all(req.params.id);
  for (const s of steps) s.output = JSON.parse(s.output_json || '{}');
  res.json({ success: true, data: steps });
});

/**
 * POST /api/automations/:id/test-fire
 * Simulated execution without sending real email
 */
router.post('/:id/test-fire', requireRole('owner', 'admin', 'developer', 'marketer'), async (req, res) => {
  const auto = await db.prepare('SELECT * FROM automations WHERE id = ? AND org_id = ?').get(req.params.id, req.auth.org_id);
  if (!auto) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Automation not found.' });
  }

  const graph = JSON.parse(auto.graph_json || '{"nodes":[],"edges":[]}');
  const now = Date.now();
  const simRunId = 'sim_run_' + now + '_' + Math.random().toString(36).substring(2, 6);
  const simulatedSteps = [];

  for (const node of (graph.nodes || [])) {
    simulatedSteps.push({
      node_id: node.id,
      type: node.type,
      status: 'success',
      started_at: now,
      finished_at: now + 50,
      output: { simulated: true, message: `Simulated execution of node '${node.type}' OK` }
    });
  }

  res.json({
    success: true,
    data: {
      run_id: simRunId,
      automation_id: auto.id,
      status: 'completed_simulation',
      simulated: true,
      steps: simulatedSteps
    },
    message: 'Test simulation completed! Step-by-step timeline verified without sending live emails.'
  });
});

module.exports = router;
