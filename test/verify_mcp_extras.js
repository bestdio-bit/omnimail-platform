process.env.NODE_ENV = 'test';
process.env.PORT = '3008';

const http = require('http');
const assert = require('assert');
const app = require('../src/server');

const server = http.createServer(app);

server.listen(3008, async () => {
  console.log('🌐 Server booted on http://localhost:3008. Executing MCP & Extra features verification tests...');

  try {
    const token = 'omni_live_master_key_9988776655';
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

    // 1. Test GET /api/mcp/tools
    const toolsRes = await fetch('http://localhost:3008/api/mcp/tools', { headers });
    assert.strictEqual(toolsRes.status, 200, 'Expected 200 on /api/mcp/tools');
    const toolsData = await toolsRes.json();
    assert.ok(toolsData.count >= 20, `Expected at least 20 tools, got ${toolsData.count}`);
    console.log(`  ✓ GET /api/mcp/tools -> Returned ${toolsData.count} tools metadata`);

    // 2. Test POST /api/mcp/rpc (tools/list method)
    const listRpcRes = await fetch('http://localhost:3008/api/mcp/rpc', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    const listRpcData = await listRpcRes.json();
    assert.strictEqual(listRpcData.jsonrpc, '2.0');
    assert.ok(listRpcData.result.tools.length >= 20);
    console.log(`  ✓ POST /api/mcp/rpc (tools/list) -> Valid JSON-RPC 2.0 response`);

    // 3. Test POST /api/mcp/rpc (tools/call method: send_email)
    const callRpcRes = await fetch('http://localhost:3008/api/mcp/rpc', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'send_email',
          arguments: {
            to: 'mcp-user@omnimail.local',
            subject: 'Hello via MCP',
            html: '<p>MCP Works!</p>'
          }
        }
      })
    });
    const callRpcData = await callRpcRes.json();
    assert.strictEqual(callRpcData.jsonrpc, '2.0');
    assert.ok(callRpcData.result.content[0].text.includes('email_'));
    console.log(`  ✓ POST /api/mcp/rpc (tools/call send_email) -> Queued successfully via MCP tool`);

    // 4. Test GET /api/mcp/audit
    const auditRes = await fetch('http://localhost:3008/api/mcp/audit', { headers });
    assert.strictEqual(auditRes.status, 200);
    const auditData = await auditRes.json();
    assert.ok(auditData.length > 0, 'Expected at least 1 audit log entry');
    console.log(`  ✓ GET /api/mcp/audit -> Logged MCP executions correctly (${auditData.length} entries found)`);

    // 5. Test GET /api/track/open/:emailId.gif
    const trackRes = await fetch('http://localhost:3008/api/track/open/email_test123.gif');
    assert.strictEqual(trackRes.status, 200);
    assert.strictEqual(trackRes.headers.get('content-type'), 'image/gif');
    console.log(`  ✓ GET /api/track/open/:emailId.gif -> 1x1 GIF tracking pixel returned cleanly`);

    // 6. Test GET /api/unsubscribe/:email/:token with invalid token vs valid token
    const unsubsRes = await fetch('http://localhost:3008/api/unsubscribe/test@omnimail.local/invalid_token');
    assert.strictEqual(unsubsRes.status, 400);
    console.log(`  ✓ GET /api/unsubscribe -> Properly rejects invalid token`);

    console.log('\n🎉 [SUCCESS] All MCP & extra porting feature tests passed flawlessly!');
    server.close(() => {
      process.exit(0);
    });
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
});
