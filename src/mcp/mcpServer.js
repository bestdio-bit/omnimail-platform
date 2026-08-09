const { nanoid } = require('nanoid');
const db = require('../db');
const { queueEmail } = require('../lib/queueEmail');
const { triggerAutomations, simulateAutomation } = require('../lib/automationEngine');
const { checkBlocklists, snapshotAndCheckDrift, generateBimiRecord } = require('../lib/deliverability');
const { createPaymentRequest } = require('../lib/checkout');
const { logAudit } = require('../middleware/rbac');

const TOOLS_METADATA = [
  { name: 'send_email', description: 'Queue and send a single transactional email', inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, html: { type: 'string' }, text: { type: 'string' }, template_id: { type: 'string' }, variables: { type: 'object' } }, required: ['to'] } },
  { name: 'list_emails', description: 'List sent and queued emails with status filtering', inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'get_email_status', description: 'Get delivery status and tracking events of a specific email', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_contacts', description: 'List audience contacts in organization', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'create_contact', description: 'Create or update a contact with custom attributes', inputSchema: { type: 'object', properties: { email: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' }, custom_fields: { type: 'object' } }, required: ['email'] } },
  { name: 'delete_contact', description: 'Delete a contact by email or ID', inputSchema: { type: 'object', properties: { email: { type: 'string' }, id: { type: 'string' } } } },
  { name: 'list_templates', description: 'List email templates', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_template', description: 'Get template details and version history', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'create_template', description: 'Create a new email template', inputSchema: { type: 'object', properties: { name: { type: 'string' }, subject: { type: 'string' }, html_body: { type: 'string' }, text_body: { type: 'string' } }, required: ['name', 'subject'] } },
  { name: 'update_template', description: 'Update draft content of a template', inputSchema: { type: 'object', properties: { id: { type: 'string' }, subject: { type: 'string' }, html_body: { type: 'string' }, text_body: { type: 'string' } }, required: ['id'] } },
  { name: 'publish_template', description: 'Promote template draft to published live version', inputSchema: { type: 'object', properties: { id: { type: 'string' }, required: ['id'] } } },
  { name: 'list_campaigns', description: 'List email campaigns and broadcasts', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_campaign', description: 'Get campaign delivery status and A/B test analytics', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'create_campaign', description: 'Create a new broadcast campaign', inputSchema: { type: 'object', properties: { name: { type: 'string' }, subject: { type: 'string' }, template_id: { type: 'string' } }, required: ['name', 'template_id'] } },
  { name: 'send_campaign', description: 'Trigger queuing and sending of a campaign', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_automations', description: 'List visual workflow automations', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_automation', description: 'Get automation graph with nodes and edges', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'create_automation', description: 'Create a new automation workflow', inputSchema: { type: 'object', properties: { name: { type: 'string' }, trigger_type: { type: 'string' } }, required: ['name'] } },
  { name: 'update_automation_graph', description: 'Save automation workflow nodes and edges', inputSchema: { type: 'object', properties: { id: { type: 'string' }, nodes: { type: 'array' }, edges: { type: 'array' } }, required: ['id'] } },
  { name: 'simulate_automation', description: 'Dry-run test an automation graph without sending live emails', inputSchema: { type: 'object', properties: { id: { type: 'string' }, contact_email: { type: 'string' }, payload: { type: 'object' } }, required: ['id'] } },
  { name: 'list_automation_runs', description: 'List execution instances for an automation workflow', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'trigger_event', description: 'Ingest a custom event to trigger automations', inputSchema: { type: 'object', properties: { email: { type: 'string' }, event_type: { type: 'string' }, payload: { type: 'object' } }, required: ['email', 'event_type'] } },
  { name: 'list_domains', description: 'List sender domains and DNS verification status', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_domain', description: 'Add sender domain and generate DKIM keypair', inputSchema: { type: 'object', properties: { domain: { type: 'string' } }, required: ['domain'] } },
  { name: 'verify_domain', description: 'Trigger live DNS lookup for SPF, DKIM, and DMARC verification', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'check_domain_deliverability', description: 'Check domain against DNSBL blocklists and DNS drift snapshots', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'setup_bimi', description: 'Generate BIMI TXT record for a verified domain', inputSchema: { type: 'object', properties: { id: { type: 'string' }, logo_url: { type: 'string' }, vmc_url: { type: 'string' } }, required: ['id', 'logo_url'] } },
  { name: 'get_analytics_summary', description: 'Get organization sending, open, click, and bounce analytics', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_billing_status', description: 'Get organization subscription tier and email credit balance', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_billing_checkout', description: 'Create payment checkout session to buy credits or upgrade tier', inputSchema: { type: 'object', properties: { amount_in_rupees: { type: 'number' }, plan_tier: { type: 'string' }, credits: { type: 'number' } }, required: ['amount_in_rupees'] } },
  { name: 'list_api_keys', description: 'List organization API keys and their assigned RBAC roles', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_audit_logs', description: 'List organization security and action audit logs', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
];

const TOOL_ROLES = {
  send_email: ['owner', 'admin', 'developer', 'marketer'],
  create_contact: ['owner', 'admin', 'developer', 'marketer'],
  delete_contact: ['owner', 'admin', 'marketer'],
  create_template: ['owner', 'admin', 'developer', 'marketer'],
  update_template: ['owner', 'admin', 'developer', 'marketer'],
  publish_template: ['owner', 'admin', 'developer', 'marketer'],
  create_campaign: ['owner', 'admin', 'marketer'],
  send_campaign: ['owner', 'admin', 'marketer'],
  create_automation: ['owner', 'admin', 'developer', 'marketer'],
  update_automation_graph: ['owner', 'admin', 'developer', 'marketer'],
  simulate_automation: ['owner', 'admin', 'developer', 'marketer'],
  trigger_event: ['owner', 'admin', 'developer', 'marketer'],
  add_domain: ['owner', 'admin'],
  verify_domain: ['owner', 'admin'],
  setup_bimi: ['owner', 'admin'],
  get_billing_status: ['owner', 'admin', 'billing'],
  create_billing_checkout: ['owner', 'admin', 'billing'],
  list_api_keys: ['owner', 'admin'],
  list_audit_logs: ['owner', 'admin'],
};

async function checkToolPermission(toolName, role) {
  if (role === 'owner' || role === 'admin') return true;
  const allowed = TOOL_ROLES[toolName];
  if (!allowed) return true;
  return allowed.includes(role);
}

async function executeTool(toolName, args = {}, apiKey = {}) {
  const orgId = apiKey.org_id || 'org_default';

  switch (toolName) {
    case 'send_email': {
      const res = queueEmail({
        apiKeyId: apiKey.id || apiKey.key_id,
        orgId,
        from: args.from || 'agent@omnimail.local',
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
        template_id: args.template_id,
        variables: args.variables || {},
      });
      if (res.error) throw new Error(res.error);
      return res;
    }
    case 'list_emails': {
      const limit = Number(args.limit || 50);
      if (args.status) {
        return await db.prepare('SELECT id, to_address, subject, status, queued_at as created_at FROM emails WHERE org_id = ? AND status = ? ORDER BY queued_at DESC LIMIT ?').all(orgId, args.status, limit);
      }
      return await db.prepare('SELECT id, to_address, subject, status, queued_at as created_at FROM emails WHERE org_id = ? ORDER BY queued_at DESC LIMIT ?').all(orgId, limit);
    }
    case 'get_email_status': {
      const email = await db.prepare('SELECT * FROM emails WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!email) throw new Error('Email not found');
      const events = await db.prepare('SELECT * FROM events WHERE email_id = ? ORDER BY received_at ASC').all(email.id);
      return { ...email, tracking_events: events };
    }
    case 'list_contacts': {
      return await db.prepare('SELECT * FROM contacts WHERE org_id = ? ORDER BY created_at DESC LIMIT ?').all(orgId, Number(args.limit || 100));
    }
    case 'create_contact': {
      const cleanEmail = args.email.toLowerCase().trim();
      let contact = await db.prepare('SELECT * FROM contacts WHERE org_id = ? AND LOWER(email) = ?').get(orgId, cleanEmail);
      const fieldsStr = args.custom_fields ? JSON.stringify(args.custom_fields) : '{}';
      const now = Date.now();
      if (contact) {
        await db.prepare('UPDATE contacts SET first_name = ?, last_name = ?, attributes_json = ? WHERE id = ?').run(args.first_name || contact.first_name, args.last_name || contact.last_name, fieldsStr, contact.id);
        return await db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
      }
      const id = `ct_${nanoid(16)}`;
      await db.prepare('INSERT INTO contacts (id, org_id, email, first_name, last_name, attributes_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, orgId, cleanEmail, args.first_name || null, args.last_name || null, fieldsStr, 'active', now);
      return await db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    }
    case 'delete_contact': {
      if (args.id) await db.prepare('DELETE FROM contacts WHERE id = ? AND org_id = ?').run(args.id, orgId);
      else if (args.email) await db.prepare('DELETE FROM contacts WHERE LOWER(email) = ? AND org_id = ?').run(args.email.toLowerCase().trim(), orgId);
      return { success: true };
    }
    case 'list_templates': {
      return await db.prepare('SELECT id, name, subject, current_published_version_id, created_at FROM templates WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
    }
    case 'get_template': {
      const t = await db.prepare('SELECT * FROM templates WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!t) throw new Error('Template not found');
      const versions = await db.prepare('SELECT id, status, created_at FROM template_versions WHERE template_id = ? ORDER BY created_at DESC').all(t.id);
      return { ...t, versions };
    }
    case 'create_template': {
      const id = `tpl_${nanoid(16)}`;
      const verId = `tv_${nanoid(16)}`;
      const now = Date.now();
      await db.prepare('INSERT INTO templates (id, org_id, name, subject, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, orgId, args.name, args.subject, now);
      db.prepare("INSERT INTO template_versions (id, template_id, html_source, status, created_by, created_at) VALUES (?, ?, ?, 'draft', ?, ?)")
        .run(verId, id, args.html_body || '', apiKey.id || apiKey.key_id || 'system', now);
      return await db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    }
    case 'update_template': {
      const t = await db.prepare('SELECT * FROM templates WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!t) throw new Error('Template not found');
      const now = Date.now();
      await db.prepare('UPDATE templates SET subject = ? WHERE id = ?').run(args.subject || t.subject, t.id);
      const verId = `tv_${nanoid(16)}`;
      await db.prepare("INSERT INTO template_versions (id, template_id, html_source, status, created_by, created_at) VALUES (?, ?, ?, 'draft', ?, ?)")
        .run(verId, t.id, args.html_body || '', apiKey.id || apiKey.key_id || 'system', now);
      return await db.prepare('SELECT * FROM templates WHERE id = ?').get(t.id);
    }
    case 'publish_template': {
      const t = await db.prepare('SELECT * FROM templates WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!t) throw new Error('Template not found');
      const now = Date.now();
      const verId = `tv_${nanoid(16)}`;
      await db.prepare("INSERT INTO template_versions (id, template_id, html_source, status, created_by, created_at) VALUES (?, ?, ?, 'published', ?, ?)")
        .run(verId, t.id, args.html_body || '', apiKey.id || apiKey.key_id || 'system', now);
      await db.prepare('UPDATE templates SET current_published_version_id = ? WHERE id = ?').run(verId, t.id);
      return { id: t.id, published_version_id: verId, status: 'published' };
    }
    case 'list_campaigns': {
      return await db.prepare('SELECT * FROM campaigns WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
    }
    case 'get_campaign': {
      const c = await db.prepare('SELECT * FROM campaigns WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!c) throw new Error('Campaign not found');
      return c;
    }
    case 'create_campaign': {
      const id = `cmp_${nanoid(16)}`;
      const now = Date.now();
      await db.prepare("INSERT INTO campaigns (id, org_id, name, template_id, list_id, status, created_at) VALUES (?, ?, ?, ?, 'all', 'draft', ?)")
        .run(id, orgId, args.name, args.template_id, now);
      return await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    }
    case 'send_campaign': {
      const c = await db.prepare('SELECT * FROM campaigns WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!c) throw new Error('Campaign not found');
      await db.prepare("UPDATE campaigns SET status = 'sending', scheduled_at = ? WHERE id = ?").run(Date.now(), c.id);
      return { id: c.id, status: 'sending' };
    }
    case 'list_automations': {
      return await db.prepare('SELECT * FROM automations WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
    }
    case 'get_automation': {
      const auto = await db.prepare('SELECT * FROM automations WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!auto) throw new Error('Automation not found');
      const nodes = await db.prepare('SELECT * FROM automation_nodes WHERE automation_id = ?').all(auto.id);
      const edges = await db.prepare('SELECT * FROM automation_edges WHERE automation_id = ?').all(auto.id);
      return { ...auto, nodes, edges };
    }
    case 'create_automation': {
      const id = `auto_${nanoid(16)}`;
      const now = Date.now();
      await db.prepare("INSERT INTO automations (id, org_id, name, status, trigger_event_name, graph_json, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, '{}', ?, ?)")
        .run(id, orgId, args.name, args.trigger_type || 'user_signed_up', now, now);
      return await db.prepare('SELECT * FROM automations WHERE id = ?').get(id);
    }
    case 'update_automation_graph': {
      const auto = await db.prepare('SELECT * FROM automations WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!auto) throw new Error('Automation not found');
      if (Array.isArray(args.nodes)) {
        await db.prepare('DELETE FROM automation_nodes WHERE automation_id = ?').run(auto.id);
        const ins = await db.prepare('INSERT INTO automation_nodes (id, automation_id, type, config_json) VALUES (?, ?, ?, ?)');
        for (const n of args.nodes) ins.run(n.id || `node_${nanoid(16)}`, auto.id, n.type || 'send_email', JSON.stringify(n.config || {}));
      }
      if (Array.isArray(args.edges)) {
        await db.prepare('DELETE FROM automation_edges WHERE automation_id = ?').run(auto.id);
        const ins = await db.prepare('INSERT INTO automation_edges (id, automation_id, from_node_id, to_node_id, condition_json) VALUES (?, ?, ?, ?, ?)');
        for (const e of args.edges) ins.run(e.id || `edge_${nanoid(16)}`, auto.id, e.source_node_id || e.from_node_id, e.target_node_id || e.to_node_id, JSON.stringify({ label: e.label || 'default' }));
      }
      return { success: true, automation_id: auto.id };
    }
    case 'simulate_automation': {
      return simulateAutomation(args.id, args.contact_email || 'sim@omnimail.local', args.payload || {});
    }
    case 'list_automation_runs': {
      return await db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 50').all(args.id);
    }
    case 'trigger_event': {
      return triggerAutomations(orgId, args.event_type, args.email, args.payload || {});
    }
    case 'list_domains': {
      return await db.prepare('SELECT id, domain, status, created_at FROM domains WHERE org_id = ?').all(orgId);
    }
    case 'add_domain': {
      const id = `domain_${nanoid(16)}`;
      const clean = args.domain.toLowerCase().trim();
      const now = Date.now();
      const { generateDkimKeypair } = require('../lib/dkim');
      const { publicKey, privateKey } = generateDkimKeypair();
      await db.prepare("INSERT INTO domains (id, org_id, domain, dkim_selector, dkim_private_key, dkim_public_key, status, created_at) VALUES (?, ?, ?, 'omni', ?, ?, 'pending', ?)")
        .run(id, orgId, clean, privateKey, publicKey, now);
      return await db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
    }
    case 'verify_domain': {
      const d = await db.prepare('SELECT * FROM domains WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!d) throw new Error('Domain not found');
      return { id: d.id, domain: d.domain, status: 'verification_triggered' };
    }
    case 'check_domain_deliverability': {
      const d = await db.prepare('SELECT * FROM domains WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!d) throw new Error('Domain not found');
      const bl = await checkBlocklists(d.id, d.domain);
      const drift = await snapshotAndCheckDrift(d.id);
      return { domain: d.domain, blocklists: bl, drift };
    }
    case 'setup_bimi': {
      const d = await db.prepare('SELECT * FROM domains WHERE id = ? AND org_id = ?').get(args.id, orgId);
      if (!d) throw new Error('Domain not found');
      const bimi = generateBimiRecord(args.logo_url, args.vmc_url);
      try { await db.prepare('UPDATE domains SET bimi_record = ? WHERE id = ?').run(bimi.record, d.id); } catch (e) {}
      return bimi;
    }
    case 'get_analytics_summary': {
      const sent = await db.prepare("SELECT COUNT(*) as cnt FROM emails WHERE org_id = ? AND status = 'sent'").get(orgId).cnt;
      const queued = await db.prepare("SELECT COUNT(*) as cnt FROM emails WHERE org_id = ? AND status = 'queued'").get(orgId).cnt;
      const failed = await db.prepare("SELECT COUNT(*) as cnt FROM emails WHERE org_id = ? AND status = 'failed'").get(orgId).cnt;
      const opens = await db.prepare("SELECT COUNT(*) as cnt FROM events e JOIN emails m ON e.email_id = m.id WHERE m.org_id = ? AND e.type = 'open'").get(orgId).cnt;
      const clicks = await db.prepare("SELECT COUNT(*) as cnt FROM events e JOIN emails m ON e.email_id = m.id WHERE m.org_id = ? AND e.type = 'click'").get(orgId).cnt;
      return { sent, queued, failed, opens, clicks, open_rate_pct: sent > 0 ? ((opens / sent) * 100).toFixed(1) : '0.0' };
    }
    case 'get_billing_status': {
      const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
      const orders = await db.prepare('SELECT * FROM checkout_orders WHERE org_id = ? ORDER BY created_at DESC LIMIT 10').all(orgId);
      return { organization: org, recent_orders: orders };
    }
    case 'create_billing_checkout': {
      const checkout = require('../lib/checkout');
      return checkout.createPaymentRequest({
        orderId: `order_${nanoid(16)}`,
        amount: args.amount_in_rupees || args.amount || 100,
        currency: 'USD',
      });
    }
    case 'list_api_keys': {
      return await db.prepare('SELECT id, name, role, created_at, last_used_at FROM api_keys WHERE org_id = ?').all(orgId);
    }
    case 'list_audit_logs': {
      return await db.prepare('SELECT * FROM audit_logs WHERE org_id = ? ORDER BY created_at DESC LIMIT ?').all(orgId, Number(args.limit || 50));
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function handleRpc(request, apiKey = {}) {
  const { jsonrpc, id, method, params } = request || {};
  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: id || null, error: { code: -32600, message: 'Invalid Request: must be JSON-RPC 2.0' } };
  }

  const startTime = Date.now();
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS_METADATA } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    if (!name) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: tool name required' } };
    }

    if (!checkToolPermission(name, apiKey.role || 'user')) {
      const logId = `mcp_${nanoid(16)}`;
      try {
        db.prepare("INSERT INTO mcp_audit_logs (id, org_id, tool_name, arguments_json, result_status, execution_time_ms, created_at) VALUES (?, ?, ?, ?, 'permission_denied', ?, ?)")
          .run(logId, apiKey.org_id || 'org_default', name, JSON.stringify(args), Date.now() - startTime, Date.now());
      } catch (e) {}
      return { jsonrpc: '2.0', id, error: { code: -32001, message: `Permission denied: role '${apiKey.role || 'user'}' cannot execute tool '${name}'` } };
    }

    try {
      const result = await executeTool(name, args, apiKey);
      const logId = `mcp_${nanoid(16)}`;
      try {
        db.prepare("INSERT INTO mcp_audit_logs (id, org_id, tool_name, arguments_json, result_status, execution_time_ms, created_at) VALUES (?, ?, ?, ?, 'success', ?, ?)")
          .run(logId, apiKey.org_id || 'org_default', name, JSON.stringify(args), Date.now() - startTime, Date.now());
      } catch (e) {}

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
        },
      };
    } catch (err) {
      const logId = `mcp_${nanoid(16)}`;
      try {
        db.prepare("INSERT INTO mcp_audit_logs (id, org_id, tool_name, arguments_json, result_status, execution_time_ms, created_at) VALUES (?, ?, ?, ?, 'error', ?, ?)")
          .run(logId, apiKey.org_id || 'org_default', name, JSON.stringify(args), Date.now() - startTime, Date.now());
      } catch (e) {}

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err.message || 'Tool execution error' },
      };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

module.exports = {
  TOOLS_METADATA,
  handleRpc,
  executeTool,
};
