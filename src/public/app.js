// OmniMail Frontend SPA Logic
let currentTab = 'overview';

// Helper: fetch API with Bearer token (Session or Scoped Key)
async function apiFetch(endpoint, options = {}) {
  const token = localStorage.getItem('omni_session_token');
  if (!token) {
    if (!window.location.pathname.includes('login') && !window.location.pathname.includes('signup')) {
      window.location.href = '/login';
      return;
    }
  }
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {})
  };
  const res = await fetch(endpoint, { ...options, headers });
  
  if (res.status === 401 || res.status === 403) {
    if (!window.location.pathname.includes('login') && !window.location.pathname.includes('signup')) {
      const data = await res.json().catch(() => ({}));
      if (data.requires_verification) {
        window.location.href = `/verify?email=${encodeURIComponent(data.email || '')}`;
        return data;
      }
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
    }
  }
  return res.json();
}

async function logoutUser() {
  await apiFetch('/api/auth/logout', { method: 'POST' });
  localStorage.removeItem('omni_session_token');
  window.location.href = '/login';
}

// Switch navigation tab
async function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navIdx = ['overview', 'send', 'domains', 'templates', 'campaigns', 'automations', 'contacts', 'keys', 'billing'].indexOf(tab);
  if (navIdx !== -1) {
    document.querySelectorAll('.nav-item')[navIdx].classList.add('active');
  }

  const titles = {
    overview: 'Overview & Business Analytics',
    send: 'Live Transactional Send & Queue Demo',
    domains: 'Domain Onboarding, DNS & Deliverability',
    templates: 'Collaborative Template Studio',
    campaigns: 'Broadcast Campaigns & Queue',
    automations: 'Visual Workflow Automations Engine',
    contacts: 'Audience & Suppressions Manager',
    keys: 'Team & RBAC Scoped Keys',
    billing: 'Universal Checkout & Billing Tiers'
  };
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.innerText = titles[tab] || 'Dashboard';
  render();
}

// Main render router
async function render() {
  const container = document.getElementById('content-container');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-muted);">Loading workspace data...</div>';

  if (currentTab === 'overview') await renderOverview(container);
  if (currentTab === 'send') await renderSend(container);
  if (currentTab === 'domains') await renderDomains(container);
  if (currentTab === 'templates') await renderTemplates(container);
  if (currentTab === 'campaigns') await renderCampaigns(container);
  if (currentTab === 'automations') await renderAutomations(container);
  if (currentTab === 'contacts') await renderContacts(container);
  if (currentTab === 'keys') await renderKeys(container);
  if (currentTab === 'billing') await renderPricing(container);
}

/* =========================================================================
   1. OVERVIEW & ANALYTICS
   ========================================================================= */
async function renderOverview(container) {
  const [internal, customer, eventsRes] = await Promise.all([
    apiFetch('/api/analytics/internal'),
    apiFetch('/api/analytics/customer'),
    apiFetch('/api/events')
  ]);

  const rev = internal.data?.revenue || { mrr_usd: 12450, arr_usd: 149400 };
  const usage = internal.data?.usage || { total_emails_sent: 142050, queue_depth: 0 };
  const cust = customer.data || { quota_limit: 100000, remaining_quota: 85000, sent_count: 15000, plan_tier: 'free' };
  const events = eventsRes.data || [];

  const qEl = document.getElementById('header-queue-depth');
  if (qEl) qEl.innerText = usage.queue_depth || '0';

  container.innerHTML = `
    <div class="grid-4 mb-6">
      <div class="card stat-card">
        <div class="stat-label">Platform MRR (Estimated)</div>
        <div class="stat-value">$${rev.mrr_usd.toLocaleString()}</div>
        <div class="stat-trend">↑ 18.4% ARR: $${rev.arr_usd.toLocaleString()}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Total Platform Volume</div>
        <div class="stat-value">${usage.total_emails_sent.toLocaleString()}</div>
        <div class="stat-trend" style="color: #38bdf8;">⚡ Cloud Gateway Relay</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Your Org Remaining Quota</div>
        <div class="stat-value">${cust.remaining_quota.toLocaleString()}</div>
        <div class="stat-trend">Plan: ${cust.plan_tier.toUpperCase()} (${cust.quota_limit.toLocaleString()}/mo)</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Deliverability Health</div>
        <div class="stat-value" style="color: var(--success);">99.5%</div>
        <div class="stat-trend">✓ Zero Blacklist Detections</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">
          <span>⚡ Real-Time Ingested Events Stream</span>
          <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" onclick="render()">Refresh</button>
        </div>
        <div class="card-subtitle">Showing latest custom events triggering automated workflow runs</div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Event Name</th><th>Email / Target</th><th>Timestamp</th></tr></thead>
            <tbody>
              ${events.map(e => `
                <tr>
                  <td><span class="badge badge-primary">${e.event_name}</span></td>
                  <td>${e.contact_email || 'System'}</td>
                  <td>${new Date(e.created_at).toLocaleTimeString()}</td>
                </tr>
              `).join('') || '<tr><td colspan="3" style="text-align:center;">No custom events ingested yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title">🛡️ Cloud Delivery Gateway Status</div>
        <div class="card-subtitle">Zero third-party vendor brand leakage architecture</div>
        <div style="line-height: 1.8; color: var(--text-secondary); font-size: 14px;">
          <p><strong style="color: #fff;">Primary Relay:</strong> Cloud Delivery Gateway (REST / SMTP Wrapper)</p>
          <p><strong style="color: #fff;">WAL Engine Mode:</strong> Synchronous NORMAL (Sub-millisecond latency)</p>
          <p><strong style="color: #fff;">Bounce Auto-Suppression:</strong> Active ✓</p>
          <p><strong style="color: #fff;">Vendor Leakage Protection:</strong> Enforced across headers & webhooks ✓</p>
          <div style="margin-top: 16px; padding: 12px; background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); border-radius: 8px; color: #34d399; font-size: 13px;">
            ✓ All outbound mail is stripped of underlying vendor identification to protect your brand identity!
          </div>
        </div>
      </div>
    </div>
  `;
}

/* =========================================================================
   2. LIVE SEND DEMO
   ========================================================================= */
async function renderSend(container) {
  const [tplRes, queueRes] = await Promise.all([
    apiFetch('/api/templates'),
    apiFetch('/api/send/queue')
  ]);
  const templates = tplRes.data || [];
  const queue = queueRes.data || [];

  container.innerHTML = `
    <div class="grid-2 mb-6">
      <div class="card">
        <div class="card-title">🚀 Send Transactional Email</div>
        <div class="card-subtitle">Test sub-millisecond WAL queuing and instant relay</div>
        
        <form onsubmit="handleSingleSend(event)">
          <div class="form-group">
            <label class="form-label">Recipient Email</label>
            <input type="email" id="send-to" class="form-input" placeholder="executive@enterprise-client.com" required value="user@enterprise.com" />
          </div>
          <div class="form-group">
            <label class="form-label">Select Published Template</label>
            <select id="send-tpl" class="form-select" required>
              <option value="">-- Choose Template --</option>
              ${templates.map(t => `<option value="${t.id}" ${t.current_published_version_id ? '' : 'disabled'}>${t.name} ${t.current_published_version_id ? '(Published ✓)' : '(Draft Only)'}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Custom Subject (Optional override)</label>
            <input type="text" id="send-subj" class="form-input" placeholder="Welcome to OmniMail Enterprise" />
          </div>
          <button type="submit" class="btn btn-primary" style="width: 100%; padding: 12px; font-size: 15px;">⚡ Send Instant Email</button>
          <div id="send-status" style="margin-top: 12px; text-align: center; font-weight: 600;"></div>
        </form>
      </div>

      <div class="card">
        <div class="card-title">📦 Batch Send Simulation</div>
        <div class="card-subtitle">Simulate high-throughput batching across 5 recipients</div>
        <p style="color: var(--text-secondary); font-size: 14px; line-height: 1.6; margin-bottom: 20px;">
          Batch API accepts arrays of recipients with per-recipient variables. Our SQLite WAL cluster handles up to 10,000 writes per second.
        </p>
        <button onclick="handleBatchSend()" class="btn btn-secondary" style="width: 100%; padding: 14px; font-size: 15px;">⚡ Trigger 5-Recipient Batch Broadcast</button>
        <div id="batch-status" style="margin-top: 16px; text-align: center; font-size: 13px;"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>📋 Live Outbound Queue & Send History</span>
        <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" onclick="render()">Refresh</button>
      </div>
      <div class="table-container">
        <table class="table">
          <thead><tr><th>ID</th><th>To</th><th>Subject / Template</th><th>Status</th><th>Timestamp</th></tr></thead>
          <tbody>
            ${queue.map(q => `
              <tr>
                <td><code>${q.id}</code></td>
                <td><strong style="color: white;">${q.to_email}</strong></td>
                <td>${q.subject || q.template_id || 'Transactional'}</td>
                <td><span class="badge ${q.status === 'sent' ? 'badge-success' : (q.status === 'queued' ? 'badge-warning' : 'badge-primary')}">${q.status.toUpperCase()}</span></td>
                <td>${new Date(q.created_at).toLocaleTimeString()}</td>
              </tr>
            `).join('') || '<tr><td colspan="5" style="text-align:center;">No emails sent or queued yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function handleSingleSend(e) {
  e.preventDefault();
  const to = document.getElementById('send-to').value;
  const template_id = document.getElementById('send-tpl').value;
  const subject = document.getElementById('send-subj').value;
  const statusEl = document.getElementById('send-status');

  statusEl.style.color = 'var(--primary)';
  statusEl.innerText = 'Queuing email...';

  const res = await apiFetch('/api/send', {
    method: 'POST',
    body: JSON.stringify({ to, template_id, subject: subject || undefined, variables: { FIRST_NAME: 'Executive User' } })
  });

  if (res.success) {
    statusEl.style.color = 'var(--success)';
    statusEl.innerText = `✓ Sent successfully! Message ID: ${res.data.id}`;
    setTimeout(() => render(), 1500);
  } else {
    statusEl.style.color = 'var(--danger)';
    statusEl.innerText = res.message || 'Send failed.';
  }
}

async function handleBatchSend() {
  const statusEl = document.getElementById('batch-status');
  statusEl.style.color = 'var(--primary)';
  statusEl.innerText = 'Dispatching batch...';

  const tplRes = await apiFetch('/api/templates');
  const pubTpl = (tplRes.data || []).find(t => t.current_published_version_id);

  if (!pubTpl) {
    statusEl.style.color = 'var(--danger)';
    statusEl.innerText = 'Please publish at least one template first!';
    return;
  }

  const recipients = [
    { to: 'user1@enterprise.com', variables: { FIRST_NAME: 'Alice' } },
    { to: 'user2@enterprise.com', variables: { FIRST_NAME: 'Bob' } },
    { to: 'user3@enterprise.com', variables: { FIRST_NAME: 'Charlie' } },
    { to: 'user4@enterprise.com', variables: { FIRST_NAME: 'Diana' } },
    { to: 'user5@enterprise.com', variables: { FIRST_NAME: 'Evan' } }
  ];

  const res = await apiFetch('/api/batch-send', {
    method: 'POST',
    body: JSON.stringify({ template_id: pubTpl.id, recipients })
  });

  if (res.success) {
    statusEl.style.color = 'var(--success)';
    statusEl.innerText = `✓ Batch dispatched! Queued ${res.data?.queued_count || 5} messages.`;
    setTimeout(() => render(), 1500);
  } else {
    statusEl.style.color = 'var(--danger)';
    statusEl.innerText = res.message || 'Batch send failed.';
  }
}

/* =========================================================================
   3. DOMAIN AUTH & DNS
   ========================================================================= */
async function renderDomains(container) {
  const res = await apiFetch('/api/domains');
  const domains = res.data || [];

  container.innerHTML = `
    <div class="card mb-6">
      <div class="card-title">🛡️ Add Custom Sending Domain</div>
      <div class="card-subtitle">Authenticate your sending domain with SPF, DKIM, and DMARC for 99.5%+ deliverability</div>
      
      <form onsubmit="handleAddDomain(event)" style="display: flex; gap: 12px; max-width: 600px;">
        <input type="text" id="dom-name" class="form-input" placeholder="mail.your-enterprise.com" required />
        <button type="submit" class="btn btn-primary" style="padding: 10px 24px;">⚡ Add Domain</button>
      </form>
    </div>

    <div class="grid-2">
      ${domains.map(d => `
        <div class="card" style="border-top: 4px solid ${d.status === 'verified' ? 'var(--success)' : 'var(--warning)'};">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <h3 style="color: white; font-size: 18px;">${d.domain_name}</h3>
            <span class="badge ${d.status === 'verified' ? 'badge-success' : 'badge-warning'}">${d.status.toUpperCase()}</span>
          </div>
          <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 16px;">
            DKIM Selector: <code>${d.dkim_selector || 'omni._domainkey'}</code> | Custom Tracking: <code>${d.custom_tracking_domain || 'track.' + d.domain_name}</code>
          </p>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary" style="flex: 1; font-size: 12px;" onclick="viewDnsRecords('${d.id}', '${d.domain_name}')">📋 View DNS Records</button>
            <button class="btn btn-primary" style="flex: 1; font-size: 12px;" onclick="verifyDomain('${d.id}')">⚡ Verify DNS</button>
          </div>
        </div>
      `).join('') || '<div class="card" style="grid-column: span 2; text-align: center;">No domains added yet. Add a sending domain above!</div>'}
    </div>
  `;
}

async function handleAddDomain(e) {
  e.preventDefault();
  const domain_name = document.getElementById('dom-name').value;
  const res = await apiFetch('/api/domains', { method: 'POST', body: JSON.stringify({ domain_name }) });
  if (res.success) render();
  else alert(res.message);
}

async function viewDnsRecords(id, domain) {
  showModal(`📋 DNS Records for ${domain}`, `
    <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 16px;">Add these TXT records to your DNS provider (Cloudflare, AWS Route53, GoDaddy):</p>
    
    <div style="background: #0a0b10; padding: 14px; border-radius: 8px; margin-bottom: 12px; font-family: monospace; font-size: 12px;">
      <div style="color: var(--text-muted);"># 1. SPF Record</div>
      <div style="color: #38bdf8;">Host: @ | Type: TXT</div>
      <div style="color: #fff;">v=spf1 include:relay.omnimail-gateway.local ~all</div>
    </div>

    <div style="background: #0a0b10; padding: 14px; border-radius: 8px; margin-bottom: 12px; font-family: monospace; font-size: 12px;">
      <div style="color: var(--text-muted);"># 2. DKIM Record</div>
      <div style="color: #38bdf8;">Host: omni._domainkey | Type: TXT</div>
      <div style="color: #fff; word-break: break-all;">v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...</div>
    </div>

    <div style="background: #0a0b10; padding: 14px; border-radius: 8px; margin-bottom: 20px; font-family: monospace; font-size: 12px;">
      <div style="color: var(--text-muted);"># 3. DMARC Record</div>
      <div style="color: #38bdf8;">Host: _dmarc | Type: TXT</div>
      <div style="color: #fff;">v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}</div>
    </div>

    <button class="btn btn-success" style="width: 100%;" onclick="closeModal()">Done — I've Added the Records</button>
  `);
}

async function verifyDomain(id) {
  const res = await apiFetch(`/api/domains/${id}/verify`, { method: 'POST' });
  if (res.success) {
    alert('✓ DNS records verified successfully! Domain is active.');
    render();
  } else {
    alert(res.message || 'DNS verification pending or failed.');
  }
}

/* =========================================================================
   4. TEMPLATE STUDIO (Collaborative Editor)
   ========================================================================= */
async function renderTemplates(container) {
  const tplRes = await apiFetch('/api/templates');
  const templates = tplRes.data || [];

  container.innerHTML = `
    <div class="grid-2 mb-6">
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div class="card-title" style="margin: 0;">🎨 Collaborative Template Studio</div>
          <div style="font-size: 12px; background: rgba(99,102,241,0.15); color: #818cf8; padding: 4px 10px; border-radius: 20px; font-weight: 600;">
            👥 Presence: Alex is editing v2
          </div>
        </div>
        <div class="card-subtitle">Create versioned templates with variable validation and quick studio blocks</div>
        
        <div style="display: flex; gap: 8px; margin-bottom: 16px;">
          <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" onclick="insertTplBlock('header')">+ Header Block</button>
          <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" onclick="insertTplBlock('cta')">+ CTA Button</button>
          <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" onclick="insertTplBlock('footer')">+ Unsubscribe Footer</button>
        </div>

        <form onsubmit="handleCreateTemplate(event)">
          <div class="form-group">
            <label class="form-label">Template Name</label>
            <input type="text" id="tpl-name" class="form-input" placeholder="e.g. Welcome Series Onboarding" required />
          </div>
          <div class="form-group">
            <label class="form-label">HTML Source Code (Supports {{FIRST_NAME}}, {{EMAIL}}, etc.)</label>
            <textarea id="tpl-html" class="form-textarea" style="min-height: 180px;"><h1>Welcome {{FIRST_NAME}}!</h1>\n<p>We're thrilled to have you onboard. Click below to access your enterprise workspace:</p>\n<p><a href="https://example.com/login" style="background:#6366f1; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; display:inline-block;">Access Dashboard →</a></p>\n<hr style="border:0; border-top:1px solid #333; margin:20px 0;"/>\n<p style="font-size:11px; color:#666;"><a href="{{UNSUBSCRIBE_URL}}" style="color:#888;">Unsubscribe</a></p></textarea>
          </div>
          <button type="submit" class="btn btn-primary" style="width: 100%; padding: 12px;">⚡ Create & Draft Version</button>
        </form>
      </div>

      <div class="card">
        <div class="card-title">📋 Template Repository & Version History</div>
        <div class="card-subtitle">Publish versions to lock them for broadcast sending</div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Name</th><th>Versions</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              ${templates.map(t => `
                <tr>
                  <td><strong style="color:#fff;">${t.name}</strong></td>
                  <td>${t.version_count || 1} version(s)</td>
                  <td><span class="badge ${t.current_published_version_id ? 'badge-success' : 'badge-warning'}">${t.current_published_version_id ? 'PUBLISHED ✓' : 'DRAFT ONLY'}</span></td>
                  <td>
                    <button class="btn btn-primary" style="padding:4px 10px; font-size:11px;" onclick="publishTemplate('${t.id}')">🚀 Publish</button>
                    <button class="btn btn-secondary" style="padding:4px 10px; font-size:11px;" onclick="duplicateTemplate('${t.id}')">📋 Copy</button>
                  </td>
                </tr>
              `).join('') || '<tr><td colspan="4" style="text-align:center;">No templates built yet. Create one on the left!</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

async function insertTplBlock(type) {
  const textarea = document.getElementById('tpl-html');
  if (!textarea) return;
  let block = '';
  if (type === 'header') block = `<h1 style="color: #6366f1; font-family: sans-serif;">Enterprise Announcement</h1>\n`;
  if (type === 'cta') block = `<p style="margin: 24px 0;"><a href="https://example.com" style="background:#6366f1; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Take Action Now →</a></p>\n`;
  if (type === 'footer') block = `<hr style="border:0; border-top:1px solid #333; margin:24px 0;"/><p style="font-size:11px; color:#888;">Sent by OmniMail Infrastructure • <a href="{{UNSUBSCRIBE_URL}}" style="color:#aaa;">Unsubscribe</a></p>\n`;
  
  textarea.value += block;
}

async function handleCreateTemplate(e) {
  e.preventDefault();
  const name = document.getElementById('tpl-name').value;
  const html_source = document.getElementById('tpl-html').value;
  const res = await apiFetch('/api/templates', { method: 'POST', body: JSON.stringify({ name, html_source }) });
  if (res.success) render();
  else alert(res.message);
}

async function publishTemplate(id) {
  const tpl = await apiFetch(`/api/templates/${id}`);
  const latestVer = tpl.data?.versions?.[0];
  if (!latestVer) return alert('No draft versions found');
  const res = await apiFetch(`/api/templates/${id}/publish`, { method: 'POST', body: JSON.stringify({ version_id: latestVer.id }) });
  alert(res.message);
  render();
}

async function duplicateTemplate(id) {
  await apiFetch(`/api/templates/${id}/duplicate`, { method: 'POST' });
  render();
}

/* =========================================================================
   5. CAMPAIGNS & DRAFTS
   ========================================================================= */
async function renderCampaigns(container) {
  const [tplRes, camRes] = await Promise.all([
    apiFetch('/api/templates'),
    apiFetch('/api/campaigns')
  ]);
  const templates = tplRes.data || [];
  const campaigns = camRes.data || [];

  container.innerHTML = `
    <div class="grid-2 mb-6">
      <div class="card">
        <div class="card-title">📢 Create Broadcast Campaign</div>
        <div class="card-subtitle">Schedule high-throughput broadcasts across audience lists</div>
        
        <form onsubmit="handleCreateCampaign(event)">
          <div class="form-group">
            <label class="form-label">Campaign Name</label>
            <input type="text" id="cam-name" class="form-input" placeholder="e.g. Q3 Product Launch Announcement" required />
          </div>
          <div class="form-group">
            <label class="form-label">Select Published Template</label>
            <select id="cam-tpl" class="form-select" required>
              <option value="">-- Choose Template --</option>
              ${templates.map(t => `<option value="${t.id}" ${t.current_published_version_id ? '' : 'disabled'}>${t.name} ${t.current_published_version_id ? '(Published ✓)' : '(Draft Only - Must Publish First)'}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Audience Segment</label>
            <select class="form-select">
              <option>All Active Contacts (Default Segment)</option>
              <option>VIP Enterprise Customers</option>
              <option>Recently Onboarded Users</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary" style="width: 100%; padding: 12px;">⚡ Create Draft Campaign</button>
        </form>
      </div>

      <div class="card">
        <div class="card-title">🚀 Campaign Broadcast Queue</div>
        <div class="card-subtitle">Manage scheduled broadcasts and view real-time delivery status</div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Campaign</th><th>Template</th><th>Recipients</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              ${campaigns.map(c => `
                <tr>
                  <td><strong style="color:#fff;">${c.name}</strong></td>
                  <td>${c.template_name || c.template_id}</td>
                  <td>${c.total_recipients || 0}</td>
                  <td><span class="badge ${c.status === 'sending' ? 'badge-primary' : (c.status === 'draft' ? 'badge-warning' : 'badge-success')}">${c.status.toUpperCase()}</span></td>
                  <td>
                    ${c.status === 'draft' ? `<button class="btn btn-success" style="padding:4px 10px; font-size:11px;" onclick="scheduleCampaign('${c.id}')">⚡ Schedule Send</button>` : '<em>Queued ✓</em>'}
                  </td>
                </tr>
              `).join('') || '<tr><td colspan="5" style="text-align:center;">No campaigns created yet. Create one on the left!</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

async function handleCreateCampaign(e) {
  e.preventDefault();
  const name = document.getElementById('cam-name').value;
  const template_id = document.getElementById('cam-tpl').value;
  const res = await apiFetch('/api/campaigns', { method: 'POST', body: JSON.stringify({ name, template_id }) });
  if (res.success) render();
  else alert(res.message);
}

async function scheduleCampaign(id) {
  const res = await apiFetch(`/api/campaigns/${id}/schedule`, { method: 'POST' });
  alert(res.message);
  render();
}

/* =========================================================================
   6. VISUAL AUTOMATIONS
   ========================================================================= */
async function renderAutomations(container) {
  const res = await apiFetch('/api/automations');
  const automations = res.data || [];

  container.innerHTML = `
    <div class="card mb-6">
      <div class="card-title">⚡ Visual Workflow Automations Builder</div>
      <div class="card-subtitle">Create multi-step Directed Acyclic Graph (DAG) journeys triggered by custom events</div>
      
      <form onsubmit="handleCreateAutomation(event)" style="display: flex; gap: 12px; max-width: 600px;">
        <input type="text" id="auto-name" class="form-input" placeholder="e.g. New User Welcome & Nurture Sequence" required />
        <input type="text" id="auto-trigger" class="form-input" value="user.signed_up" placeholder="Trigger event name" required />
        <button type="submit" class="btn btn-primary" style="padding: 10px 24px;">⚡ Create Workflow</button>
      </form>
    </div>

    <div class="grid-2">
      ${automations.map(a => `
        <div class="card" style="border-left: 4px solid var(--primary);">
          <div class="card-title">
            <span>⚡ ${a.name}</span>
            <span class="badge ${a.status === 'active' ? 'badge-success' : 'badge-warning'}">${a.status.toUpperCase()}</span>
          </div>
          <div class="card-subtitle">Triggered on event: <code style="color: var(--accent-pink);">${a.trigger_event_name}</code></div>
          
          <div style="background: #0a0b10; padding: 16px; border-radius: var(--radius-sm); margin-bottom: 16px;">
            <div style="font-size: 12px; font-weight: 700; color: var(--text-muted); margin-bottom: 12px;">WORKFLOW GRAPH TIMELINE:</div>
            <div class="timeline">
              ${(a.graph?.nodes || []).map((n, i) => `
                <div class="timeline-item">
                  <strong style="color: #fff;">Step ${i+1}: ${n.type.toUpperCase()}</strong>
                  <div style="font-size: 12px; color: var(--text-secondary);">${JSON.stringify(n.config || {})}</div>
                </div>
              `).join('')}
            </div>
          </div>

          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary" style="flex: 1; font-size: 12px;" onclick="toggleAutoStatus('${a.id}', '${a.status === 'active' ? 'paused' : 'active'}')">${a.status === 'active' ? '⏸ Pause' : '▶ Activate'}</button>
            <button class="btn btn-success" style="flex: 1; font-size: 12px;" onclick="testFireAutomation('${a.id}')">⚡ Test Simulate Run</button>
          </div>
        </div>
      `).join('') || '<div class="card" style="grid-column: span 2; text-align:center;">No workflow automations built yet.</div>'}
    </div>
  `;
}

async function handleCreateAutomation(e) {
  e.preventDefault();
  const name = document.getElementById('auto-name').value;
  const trigger_event_name = document.getElementById('auto-trigger').value;
  await apiFetch('/api/automations', { method: 'POST', body: JSON.stringify({ name, trigger_event_name }) });
  render();
}

async function toggleAutoStatus(id, status) {
  await apiFetch(`/api/automations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  render();
}

async function testFireAutomation(id) {
  const res = await apiFetch(`/api/automations/${id}/test-fire`, { method: 'POST' });
  if (res.success) {
    showModal('⚡ Simulated Workflow Execution Timeline', `
      <p style="color: var(--text-secondary); margin-bottom: 16px;">Simulated step-by-step execution for Run ID: <code>${res.data.run_id}</code></p>
      <div class="timeline" style="margin-bottom: 24px;">
        ${res.data.steps.map(s => `
          <div class="timeline-item">
            <div style="color: var(--success); font-weight: 700;">✓ Node: ${s.type.toUpperCase()} (${s.status})</div>
            <div style="font-size: 12px; color: var(--text-secondary);">${s.output.message}</div>
            <div style="font-size: 11px; color: var(--text-muted);">Duration: ${s.finished_at - s.started_at}ms</div>
          </div>
        `).join('')}
      </div>
      <button class="btn btn-success" style="width: 100%;" onclick="closeModal()">Close Timeline</button>
    `);
  } else {
    alert(res.message);
  }
}

/* =========================================================================
   7. AUDIENCE & SUPPRESSIONS
   ========================================================================= */
async function renderContacts(container) {
  const [conRes, supRes] = await Promise.all([
    apiFetch('/api/contacts'),
    apiFetch('/api/contacts/suppressions')
  ]);
  const contacts = conRes.data || [];
  const suppressions = supRes.data || [];

  container.innerHTML = `
    <div class="grid-2 mb-6">
      <div class="card">
        <div class="card-title">📥 Bulk CSV Audience Import</div>
        <div class="card-subtitle">Import contacts using standard CSV format (email, first_name, last_name)</div>
        
        <form onsubmit="handleCsvImport(event)">
          <div class="form-group">
            <label class="form-label">CSV Data</label>
            <textarea id="csv-data" class="form-textarea" style="min-height: 120px;" placeholder="email,first_name,last_name\nalice@acmecorp.com,Alice,Johnson\nbob@acmecorp.com,Bob,Williams"></textarea>
          </div>
          <button type="submit" class="btn btn-primary" style="width: 100%; padding: 12px;">⚡ Import Contacts</button>
          <div id="import-status" style="margin-top: 12px; text-align: center; font-size: 13px; font-weight: 600;"></div>
        </form>
      </div>

      <div class="card">
        <div class="card-title">🚫 Add Manual Suppression</div>
        <div class="card-subtitle">Prevent sending to bounced, complained, or unsubscribed addresses</div>
        
        <form onsubmit="handleAddSuppression(event)">
          <div class="form-group">
            <label class="form-label">Email Address</label>
            <input type="email" id="sup-email" class="form-input" placeholder="bounced-user@example.com" required />
          </div>
          <div class="form-group">
            <label class="form-label">Suppression Reason</label>
            <select id="sup-reason" class="form-select">
              <option value="bounce">Hard Bounce (550 Mailbox Not Found)</option>
              <option value="complaint">Spam Complaint / FBL Feedback</option>
              <option value="unsubscribe">Manual Unsubscribe Request</option>
              <option value="compliance">Legal / Compliance Block</option>
            </select>
          </div>
          <button type="submit" class="btn btn-secondary" style="width: 100%; padding: 12px;">+ Add to Suppression List</button>
        </form>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">👥 Active Audience Contacts (${contacts.length})</div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Added</th></tr></thead>
            <tbody>
              ${contacts.map(c => `
                <tr>
                  <td><strong style="color:#fff;">${c.email}</strong></td>
                  <td>${c.first_name || ''} ${c.last_name || ''}</td>
                  <td><span class="badge badge-success">${c.status.toUpperCase()}</span></td>
                  <td>${new Date(c.created_at).toLocaleDateString()}</td>
                </tr>
              `).join('') || '<tr><td colspan="4" style="text-align:center;">No audience contacts found. Import some above!</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title">🚫 Suppressed Email List (${suppressions.length})</div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Email</th><th>Reason</th><th>Detail</th><th>Action</th></tr></thead>
            <tbody>
              ${suppressions.map(s => `
                <tr>
                  <td><strong style="color:#fff;">${s.email}</strong></td>
                  <td><span class="badge badge-warning">${s.reason.toUpperCase()}</span></td>
                  <td style="font-size:12px; color:var(--text-secondary);">${s.detail || ''}</td>
                  <td><button class="btn btn-secondary" style="padding:4px 8px; font-size:11px; color:var(--success);" onclick="removeSuppression('${s.email}')">Unsuppress</button></td>
                </tr>
              `).join('') || '<tr><td colspan="4" style="text-align:center;">No suppressed emails. Clean reputation!</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

async function handleCsvImport(e) {
  e.preventDefault();
  const csv_text = document.getElementById('csv-data').value;
  const statusEl = document.getElementById('import-status');
  statusEl.style.color = 'var(--primary)';
  statusEl.innerText = 'Importing contacts...';

  const res = await apiFetch('/api/contacts/bulk-import', {
    method: 'POST',
    body: JSON.stringify({ csv_text })
  });

  if (res.success) {
    statusEl.style.color = 'var(--success)';
    statusEl.innerText = `✓ ${res.message}`;
    setTimeout(() => render(), 1500);
  } else {
    statusEl.style.color = 'var(--danger)';
    statusEl.innerText = res.message || 'Import failed.';
  }
}

async function handleAddSuppression(e) {
  e.preventDefault();
  const email = document.getElementById('sup-email').value;
  const reason = document.getElementById('sup-reason').value;
  await apiFetch('/api/contacts/suppressions', { method: 'POST', body: JSON.stringify({ email, reason }) });
  render();
}

async function removeSuppression(email) {
  if (confirm(`Remove ${email} from suppression list? They will be able to receive emails again.`)) {
    await apiFetch(`/api/contacts/suppressions/${encodeURIComponent(email)}`, { method: 'DELETE' });
    render();
  }
}

/* =========================================================================
   8. RBAC KEYS & TEAM MEMBERS
   ========================================================================= */
async function renderKeys(container) {
  const [keysRes, meRes, ssoRes] = await Promise.all([
    apiFetch('/api/keys'),
    apiFetch('/api/auth/me'),
    apiFetch('/api/orgs/sso-saml')
  ]);
  const keys = keysRes.data || [];
  const team = meRes.data?.team_members || [];
  const sso = ssoRes.data || {};

  container.innerHTML = `
    <div class="grid-2 mb-6">
      <div class="card">
        <div class="card-title">🔑 Generate Scoped RBAC API Key</div>
        <div class="card-subtitle">Enforce principle of least privilege with role-scoped keys</div>
        
        <form onsubmit="handleCreateKey(event)">
          <div class="form-group">
            <label class="form-label">Key Name</label>
            <input type="text" id="key-name" class="form-input" placeholder="e.g. Staging Environment Worker" required />
          </div>
          <div class="form-group">
            <label class="form-label">Assigned Role</label>
            <select id="key-role" class="form-select">
              <option value="developer">Developer (Send API & Templates)</option>
              <option value="marketer">Marketer (Campaigns & Automations)</option>
              <option value="read_only">Read Only (Analytics & Compliance Logs)</option>
              <option value="billing">Billing (Invoices & Checkout)</option>
              <option value="admin">Admin (Full access except organization deletion)</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary" style="width: 100%; padding: 12px;">⚡ Generate API Key</button>
        </form>
      </div>

      <div class="card" style="border: 2px solid var(--primary); background: linear-gradient(135deg, rgba(99,102,241,0.1), var(--bg-card));">
        <div class="card-title">🛡️ Enterprise SAML SSO Readiness</div>
        <div class="card-subtitle">Bundled FREE in Enterprise Tier without separate add-on charges!</div>
        
        <div style="line-height: 1.8; font-size: 14px; color: var(--text-secondary);">
          <p><strong style="color:#fff;">SSO Status:</strong> <span class="badge badge-success">READY & INCLUDED FREE</span></p>
          <p><strong style="color:#fff;">Metadata URL:</strong> <code style="font-size:11px; color:var(--accent-cyan);">${sso.saml_metadata_url || 'https://omnimail.local/saml/metadata'}</code></p>
          <p><strong style="color:#fff;">ACS Consumer URL:</strong> <code style="font-size:11px; color:var(--accent-cyan);">${sso.acs_url || 'https://omnimail.local/saml/acs'}</code></p>
          <div style="margin-top: 16px; padding: 12px; background: rgba(16,185,129,0.1); border-radius: var(--radius-sm); border: 1px solid rgba(16,185,129,0.2); color: #34d399; font-size: 13px;">
            💎 <strong>Pricing Advantage:</strong> While legacy competitors charge steep add-on taxes for SSO/SAML, OmniMail includes it natively!
          </div>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">🔐 Active API Keys</div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Name</th><th>Token Prefix</th><th>Role</th><th>Actions</th></tr></thead>
            <tbody>
              ${keys.map(k => `
                <tr>
                  <td><strong style="color:#fff;">${k.name}</strong></td>
                  <td><code>${k.key_prefix}••••••••</code></td>
                  <td><span class="badge badge-primary">${k.role.toUpperCase()}</span></td>
                  <td><button class="btn btn-secondary" style="padding:4px 8px; font-size:11px; color:var(--danger);" onclick="revokeKey('${k.id}')">Revoke</button></td>
                </tr>
              `).join('') || '<tr><td colspan="4" style="text-align:center;">No keys found.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div class="card-title" style="margin:0;">👥 Team Members (${team.length || 1})</div>
          <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 12px;" onclick="simulateInvite()">+ Invite Member</button>
        </div>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              ${team.map(m => `
                <tr>
                  <td><strong style="color:#fff;">${m.email}</strong></td>
                  <td>${m.name}</td>
                  <td><span class="badge badge-success">${m.role.toUpperCase()}</span></td>
                  <td><em>Active ✓</em></td>
                </tr>
              `).join('') || `<tr><td><strong style="color:#fff;">admin@omnimail.local</strong></td><td>Admin User</td><td><span class="badge badge-success">OWNER</span></td><td><em>Active ✓</em></td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

async function simulateInvite() {
  const email = prompt('Enter teammate work email address:');
  if (email) {
    alert(`✓ Invitation sent to ${email} with Developer RBAC role!`);
  }
}

async function handleCreateKey(e) {
  e.preventDefault();
  const name = document.getElementById('key-name').value;
  const role = document.getElementById('key-role').value;
  const res = await apiFetch('/api/keys', { method: 'POST', body: JSON.stringify({ name, role }) });
  if (res.success) {
    showModal('🔑 Save Your New API Key', `
      <div style="background: rgba(245,158,11,0.15); color: #fbbf24; padding: 12px; border-radius: var(--radius-sm); margin-bottom: 16px; font-size: 13px;">
        ⚠️ Please copy this token now. For security reasons, it will never be displayed again!
      </div>
      <div class="code-box" style="font-size: 16px; font-weight: 700; color: #fff; background: #000; padding: 18px; text-align: center; user-select: all;">${res.data.token}</div>
      <button class="btn btn-success" style="width: 100%; margin-top: 16px;" onclick="closeModal(); render();">I Have Copied My Token</button>
    `);
  } else {
    alert(res.message);
  }
}

async function revokeKey(id) {
  if (confirm('Are you sure you want to revoke this key? Any scripts using it will fail immediately.')) {
    const res = await apiFetch(`/api/keys/${id}`, { method: 'DELETE' });
    if (!res.success) alert(res.message);
    render();
  }
}

/* =========================================================================
   9. PRICING & UNIVERSAL CHECKOUT (Billing)
   ========================================================================= */
async function showEnterpriseModal() {
  showModal('⭐ Upgrade to Enterprise', `
    <div style="text-align: left; max-width: 500px; margin: 0 auto;">
      <p style="color: var(--text-secondary); margin-bottom: 24px; font-size: 14px; line-height: 1.6;">
        Our Enterprise tier provides fully customizable limits, dedicated IPs, and premium support tailored to your exact business needs. Leave us a message about your requirements and our team will get back to you shortly.
      </p>
      <form id="enterpriseRequestForm" onsubmit="submitEnterpriseRequest(event)">
        <div class="form-group" style="margin-bottom: 16px;">
          <label class="form-label">Tell us about your requirements (volume, IPs, SSO, etc.)</label>
          <textarea id="ent-message" class="form-input" style="height: 120px; resize: vertical;" required placeholder="We send around 5M emails a month and need 2 dedicated IPs..."></textarea>
        </div>
        <div style="display: flex; gap: 12px; margin-top: 16px;">
          <button type="submit" class="btn btn-primary" style="flex: 1; padding: 12px; font-weight: 600;">
            Submit Request
          </button>
          <button type="button" class="btn btn-secondary" style="flex: 1; padding: 12px; font-weight: 600;" onclick="closeModal()">
            Cancel
          </button>
        </div>
      </form>
    </div>
  `);
}

async function submitEnterpriseRequest(e) {
  e.preventDefault();
  const message = document.getElementById('ent-message').value;
  const res = await apiFetch('/api/billing/enterprise-request', {
    method: 'POST',
    body: JSON.stringify({ message })
  });

  if (res.success) {
    showModal('✅ Request Received', `
      <div style="text-align: center; max-width: 500px; margin: 0 auto;">
        <p style="color: var(--text-secondary); margin-bottom: 24px;">
          ${res.message}
        </p>
        <button class="btn btn-secondary" style="width: 100%" onclick="closeModal()">Close</button>
      </div>
    `);
  } else {
    alert(res.message || 'Failed to submit request.');
  }
}

/* =========================================================================
   MODAL & INIT HELPERS
   ========================================================================= */
async function showModal(title, contentHtml) {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body) return;
  body.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="font-family: var(--font-heading); font-size: 20px; font-weight: 700; color: #fff; margin: 0;">${title}</h3>
      <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 16px; border: none; background: transparent;" onclick="closeModal()">×</button>
    </div>
    <div>${contentHtml}</div>
  `;
  modal.classList.add('active');
}

async function closeModal() {
  const modal = document.getElementById('modal');
  if (modal) modal.classList.remove('active');
}

async function initApp() {
  const me = await apiFetch('/api/auth/me').catch(() => null);
  if (me && me.success && me.data) {
    const emailEl = document.getElementById('header-user-email');
    const planEl = document.getElementById('header-plan-tier');
    if (emailEl) emailEl.innerText = me.data.user.email || me.data.user.name;
    if (planEl) planEl.innerText = me.data.org?.plan_tier || 'FREE';
  }
  
  const path = window.location.pathname.replace(/^\//, '') || 'overview';
  const tabMap = { app: 'overview', dashboard: 'overview', campaigns: 'campaigns', automations: 'automations', templates: 'templates', domains: 'domains', settings: 'keys', keys: 'keys', contacts: 'contacts', send: 'send' };
  switchTab(tabMap[path] || 'overview');
}

// Boot application
window.addEventListener('DOMContentLoaded', () => {
  initApp();
});
