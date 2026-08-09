const express = require('express');
const db = require('../db');
const { handleRpc, TOOLS_METADATA } = require('../mcp/mcpServer');
const { authenticateKey } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

const router = express.Router();

router.use(authenticateKey);
router.use((req, res, next) => {
  req.apiKey = req.auth || {};
  next();
});

router.post('/rpc', async (req, res) => {
  const rpcResponse = await handleRpc(req.body, req.apiKey);
  res.json(rpcResponse);
});

router.get('/sse', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(`event: endpoint\ndata: /api/mcp/rpc\n\n`);

  const interval = setInterval(() => {
    res.write(`event: ping\ndata: ${Date.now()}\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

router.get('/tools', async (req, res) => {
  res.json({ count: TOOLS_METADATA.length, tools: TOOLS_METADATA });
});

router.get('/audit', requireRole('owner', 'admin', 'developer'), async (req, res) => {
  const { limit = 50, tool_name } = req.query;
  const orgId = req.apiKey.org_id || 'org_default';

  let rows;
  if (tool_name) {
    rows = db.prepare('SELECT * FROM mcp_audit_logs WHERE org_id = ? AND tool_name = ? ORDER BY created_at DESC LIMIT ?')
      .all(orgId, tool_name, Number(limit));
  } else {
    rows = db.prepare('SELECT * FROM mcp_audit_logs WHERE org_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(orgId, Number(limit));
  }
  res.json(rows);
});

module.exports = router;
