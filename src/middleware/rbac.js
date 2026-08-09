const db = require('../db');

/**
 * Role-Based Access Control (RBAC) Middleware
 * Ensures the authenticated API key role is included in allowedRoles
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth || !req.auth.role) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Authentication required before verifying role permissions.'
      });
    }

    // Owner always has full access
    if (req.auth.role === 'owner') {
      return next();
    }

    if (!allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({
        error: 'forbidden_role_access',
        message: `Your API key role ('${req.auth.role}') is not authorized to perform this action. Required roles: [${allowedRoles.join(', ')}].`,
        required_roles: allowedRoles,
        current_role: req.auth.role
      });
    }

    next();
  };
}

/**
 * Log administrative or system actions to audit_logs
 */
async function logAudit(orgId, userId, action, resourceType, resourceId, details = {}) {
  try {
    const id = 'aud_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    await db.prepare(`
      INSERT INTO audit_logs (id, org_id, user_id, action, resource_type, resource_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, userId || 'system', action, resourceType, resourceId, JSON.stringify(details), Date.now());
  } catch (err) {
    console.error('❌ [AuditLog] Failed to record audit log:', err.message);
  }
}

/**
 * Super Admin Middleware
 * Restricts access to the system owner (Master Admin) of the default org
 */
async function requireSuperAdmin(req, res, next) {
  if (!req.auth || !req.auth.role) {
    return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  }

  // Define super admin as the 'owner' of the default root organization 'org_demo_omnimail_001'
  if (req.auth.org_id === 'org_demo_omnimail_001' && req.auth.role === 'owner') {
    return next();
  }

  return res.status(403).json({
    error: 'forbidden_super_admin',
    message: 'Access denied. Master Admin privileges required.'
  });
}

module.exports = { requireRole, requireSuperAdmin, logAudit };
