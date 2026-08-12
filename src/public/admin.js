document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('omni_admin_token');
  if (!token) {
    window.location.href = '/admin/login';
    return;
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  // UI Helpers
  async function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.borderLeft = `4px solid ${type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#6366f1')}`;
    toast.innerText = message;
    container.appendChild(toast);
    
    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);
    
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  async function handleAuthError(res) {
    if (res.error === 'forbidden_super_admin') {
      showToast('Admin privileges required. Redirecting to login...', 'error');
      localStorage.removeItem('omni_admin_token');
      setTimeout(() => window.location.href = '/admin/login', 2000);
    } else {
      showToast('Access denied: ' + (res.message || 'Unknown error'), 'error');
    }
  }

  // Navigation Logic
  const navItems = document.querySelectorAll('.nav-item');
  const viewSections = document.querySelectorAll('.view-section');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');
      
      const viewId = 'view-' + item.dataset.view;
      viewSections.forEach(section => {
        if (section.id === viewId) {
          section.classList.remove('hidden');
        } else {
          section.classList.add('hidden');
        }
      });
    });
  });

  // Data Fetching
  async function fetchStats() {
    fetch('/api/admin/stats', { headers })
      .then(res => res.json())
      .then(res => {
        if (!res.success) {
          handleAuthError(res);
          return;
        }

        // Auth passed: reveal app
        document.getElementById('loader').style.display = 'none';
        document.getElementById('appContainer').style.display = 'flex';

        const s = res.data;
        document.getElementById('stat-orgs').innerText = s.total_orgs.toLocaleString();
        document.getElementById('stat-users').innerText = s.total_users.toLocaleString();
        document.getElementById('stat-sent').innerText = s.total_emails_sent.toLocaleString();
        document.getElementById('stat-queued').innerText = s.total_emails_queued.toLocaleString();
        document.getElementById('stat-orders').innerText = s.total_orders.toLocaleString();
      })
      .catch((err) => {
        console.error(err);
        showToast('Error connecting to server.', 'error');
      });
  }

  async function fetchOrgs() {
    fetch('/api/admin/orgs', { headers })
      .then(res => res.json())
      .then(res => {
        if (!res.success) return; // Error handled by fetchStats usually
        const tbody = document.getElementById('orgsTableBody');
        tbody.innerHTML = '';
        res.data.forEach(org => {
          const date = new Date(org.created_at).toLocaleDateString();
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><code style="color:#a0a8c0">${org.id}</code></td>
            <td>${org.name}</td>
            <td><span class="badge ${org.plan_tier}">${org.plan_tier}</span></td>
            <td>${org.user_count}</td>
            <td>${org.custom_send_volume.toLocaleString()}</td>
            <td>${date}</td>
            <td><button class="btn" style="padding:6px 12px; font-size:12px;" onclick="editOrg('${org.id}')">Configure</button></td>
          `;
          tbody.appendChild(tr);
        });
      })
      .catch(console.error);
  }

  async function fetchBilling() {
    fetch('/api/admin/billing', { headers })
      .then(res => res.json())
      .then(res => {
        if (!res.success) return;
        const tbody = document.getElementById('billingTableBody');
        tbody.innerHTML = '';
        res.data.forEach(order => {
          const date = new Date(order.created_at).toLocaleDateString();
          const color = order.status === 'SUCCESS' ? '#34d399' : (order.status === 'PENDING' ? '#fbbf24' : '#ef4444');
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><code>${order.order_id}</code></td>
            <td><code style="color:#a0a8c0">${order.org_id}</code></td>
            <td>$${order.amount}</td>
            <td style="color:${color}; font-weight:600">${order.status}</td>
            <td>${date}</td>
          `;
          tbody.appendChild(tr);
        });
        if (res.data.length === 0) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px; color:#a0a8c0;">No billing orders found.</td></tr>';
      })
      .catch(console.error);
  }

  // Enterprise Requests Logic
  async function fetchEnterpriseRequests() {
    fetch('/api/admin/enterprise-requests', { headers })
      .then(res => res.json())
      .then(res => {
        if (!res.success) return;
        const tbody = document.getElementById('enterpriseRequestsTableBody');
        tbody.innerHTML = '';
        res.data.forEach(req => {
          const date = new Date(req.created_at).toLocaleDateString();
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${date}</td>
            <td><code style="color:#a0a8c0">${req.org_id}</code></td>
            <td><strong>${req.name}</strong><br><span style="font-size:12px;color:#a0a8c0">${req.email}</span></td>
            <td style="max-width:300px; white-space:pre-wrap; font-size: 13px;">${req.message}</td>
            <td><button class="btn btn-success" style="padding:6px 12px; font-size:12px;" onclick="completeEnterpriseRequest('${req.id}')">✓ Mark Complete</button></td>
          `;
          tbody.appendChild(tr);
        });
        if (res.data.length === 0) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px; color:#a0a8c0;">No pending requests found.</td></tr>';
      })
      .catch(console.error);
  }

  window.completeEnterpriseRequest = async (id) => {
    try {
      const res = await fetch(`/api/admin/enterprise-requests/${id}/complete`, { method: 'PUT', headers });
      const data = await res.json();
      if (data.success) {
        showToast('Request marked as complete', 'success');
        fetchEnterpriseRequests();
      } else {
        showToast(data.message, 'error');
      }
    } catch (err) {
      showToast('Error completing request', 'error');
    }
  };

  // Enterprise Config Logic
  window.loadEnterpriseConfig = async () => {
    const orgId = document.getElementById('entSearchOrgId').value.trim();
    if (!orgId) return showToast('Please enter an Organization ID', 'error');

    try {
      const res = await fetch(`/api/admin/orgs/${orgId}`, { headers });
      const data = await res.json();
      if (data.success) {
        const org = data.data;
        document.getElementById('entConfigOrgId').value = org.id;
        document.getElementById('entConfigTier').value = org.plan_tier;
        document.getElementById('entConfigVolume').value = org.custom_send_volume;
        document.getElementById('entConfigIp').value = org.dedicated_ip || '';
        document.getElementById('entConfigPanel').style.display = 'block';
        showToast('Organization loaded', 'success');
      } else {
        showToast(data.message, 'error');
        document.getElementById('entConfigPanel').style.display = 'none';
      }
    } catch (err) {
      showToast('Failed to load org', 'error');
    }
  };

  window.saveEnterpriseConfig = async (e) => {
    e.preventDefault();
    const id = document.getElementById('entConfigOrgId').value;
    const plan_tier = document.getElementById('entConfigTier').value;
    const custom_send_volume = parseInt(document.getElementById('entConfigVolume').value, 10);
    const dedicated_ip = document.getElementById('entConfigIp').value || null;

    try {
      const res = await fetch(`/api/admin/orgs/${id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ plan_tier, custom_send_volume, dedicated_ip })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Enterprise settings applied successfully!', 'success');
        fetchOrgs(); // Refresh orgs list in background
      } else {
        showToast(data.message, 'error');
      }
    } catch (err) {
      showToast('Failed to save config', 'error');
    }
  };

  window.editOrg = (id) => {
    // Switch to enterprise config tab
    const viewSections = document.querySelectorAll('.view-section');
    viewSections.forEach(section => {
      section.classList.add('hidden');
    });
    document.getElementById('view-enterprise-config').classList.remove('hidden');

    // Update active nav item
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-view="enterprise-config"]').classList.add('active');

    // Fill the search input and trigger load
    document.getElementById('entSearchOrgId').value = id;
    window.loadEnterpriseConfig();
  };




  // Provision Business Logic
  document.getElementById('provisionForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('bizName').value;
    const email = document.getElementById('bizEmail').value;
    const plan_tier = document.getElementById('bizTier').value;

    fetch('/api/admin/orgs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, email, plan_tier, custom_send_volume: 1000000 })
    })
    .then(res => res.json())
    .then(res => {
      if (res.success) {
        showToast('Business provisioned successfully!', 'success');
        document.getElementById('provisionResult').innerText = `✅ Provisioned! Default pass: changeme123 (Org ID: ${res.data.org_id})`;
        fetchOrgs();
        fetchStats();
        document.getElementById('provisionForm').reset();
      } else {
        showToast('Error: ' + res.message, 'error');
      }
    });
  });

  // Admin logout
  window.logoutAdmin = () => {
    fetch('/api/admin-auth/logout', {
      method: 'POST',
      headers
    }).finally(() => {
      localStorage.removeItem('omni_admin_token');
      window.location.href = '/admin/login';
    });
  };

  // Initial fetch
  fetchStats();
  fetchOrgs();
  fetchBilling();
  fetchEnterpriseRequests();
});
