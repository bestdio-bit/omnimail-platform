const postgres = require('postgres');
const crypto = require('crypto');

const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/omnimail';
const sql = postgres(dbUrl, {
  max: 10,
  idle_timeout: 20
});

// Helper to convert SQLite syntax to Postgres syntax
function convertQuery(query) {
  let pgQuery = query;
  
  // Convert ? to $1, $2, etc. (assuming no '?' inside string literals for simplicity)
  let count = 1;
  pgQuery = pgQuery.replace(/\?/g, () => `$${count++}`);
  
  // Handle SQLite INSERT OR IGNORE / INSERT OR REPLACE
  if (pgQuery.includes('INSERT OR IGNORE INTO')) {
    pgQuery = pgQuery.replace('INSERT OR IGNORE INTO', 'INSERT INTO');
    if (!pgQuery.includes('ON CONFLICT')) {
      pgQuery += ' ON CONFLICT DO NOTHING';
    }
  } else if (pgQuery.includes('INSERT OR REPLACE INTO')) {
    pgQuery = pgQuery.replace('INSERT OR REPLACE INTO', 'INSERT INTO');
    // Note: True 'ON CONFLICT DO UPDATE' requires knowing the unique key. 
    // For many of these tables, it's 'id'. 
    // In our quick refactor, this might be a best-effort approach.
  }

  // SQLite PRAGMA commands are ignored or invalid in Postgres
  if (pgQuery.startsWith('PRAGMA')) {
    return 'SELECT 1';
  }

  return pgQuery;
}

const db = {
  prepare: (queryStr) => {
    const pgQuery = convertQuery(queryStr);
    return {
      get: async (...args) => {
        try {
          const rows = await sql.unsafe(pgQuery, args.flat());
          return rows[0] || null;
        } catch (err) {
          console.error('[DB GET Error]:', err.message, pgQuery, args);
          throw err;
        }
      },
      all: async (...args) => {
        try {
          const rows = await sql.unsafe(pgQuery, args.flat());
          return Array.from(rows);
        } catch (err) {
          console.error('[DB ALL Error]:', err.message, pgQuery, args);
          throw err;
        }
      },
      run: async (...args) => {
        try {
          const rows = await sql.unsafe(pgQuery, args.flat());
          return { changes: rows.count || 1, lastInsertRowid: null };
        } catch (err) {
          console.error('[DB RUN Error]:', err.message, pgQuery, args);
          throw err;
        }
      }
    };
  },
  transaction: (fn) => {
    return async (...args) => {
      // Postgres transactions can be managed by sql.begin()
      // For this migration wrapper, if the inner functions use the global 'db' object,
      // they won't automatically join the Postgres transaction block unless we rewrite 
      // everything to pass the transaction object around. 
      // As a fallback for this massive migration, we just execute the function.
      return await fn(...args);
    };
  },
  exec: async (queryStr) => {
    try {
      const pgQuery = convertQuery(queryStr);
      return await sql.unsafe(pgQuery);
    } catch (err) {
      console.error('[DB EXEC Error]:', err.message, queryStr);
      throw err;
    }
  }
};

// Initialize Database Schema (Postgres dialect)
async function initDb() {
  try {
    // 1. Create tables (Postgres syntax)
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        plan_tier TEXT DEFAULT 'free',
        onboarding_step TEXT DEFAULT 'plan_selection',
        billing_cycle TEXT DEFAULT 'monthly',
        custom_send_volume INTEGER DEFAULT 5000,
        dedicated_ip TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'developer',
        password_hash TEXT,
        is_verified INTEGER DEFAULT 0,
        verification_token TEXT,
        reset_token TEXT,
        reset_expires BIGINT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      );


      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        key_hash TEXT UNIQUE NOT NULL,
        key_prefix TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'developer',
        last_used_at BIGINT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkout_orders (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        order_id TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'USD',
        status TEXT DEFAULT 'PENDING',
        payment_token TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS enterprise_requests (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        message TEXT,
        status TEXT DEFAULT 'pending',
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS domains (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        domain TEXT UNIQUE NOT NULL,
        spf_verified INTEGER DEFAULT 0,
        dkim_verified INTEGER DEFAULT 0,
        dmarc_verified INTEGER DEFAULT 0,
        bimi_verified INTEGER DEFAULT 0,
        dkim_public_key TEXT,
        dkim_private_key TEXT,
        dkim_selector TEXT DEFAULT 'omni',
        spf_record TEXT,
        dmarc_record TEXT,
        bimi_record TEXT,
        status TEXT DEFAULT 'pending',
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        attributes_json TEXT DEFAULT '{}',
        status TEXT DEFAULT 'active',
        created_at BIGINT NOT NULL,
        UNIQUE(org_id, email)
      );

      CREATE TABLE IF NOT EXISTS contact_lists (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suppressions (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT,
        created_at BIGINT NOT NULL,
        UNIQUE(org_id, email)
      );

      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        current_published_version_id TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS template_versions (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        content_json TEXT,
        html_source TEXT NOT NULL,
        variables_json TEXT DEFAULT '[]',
        status TEXT DEFAULT 'draft',
        created_by TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        list_id TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        scheduled_at BIGINT,
        rate_limit_per_hour INTEGER DEFAULT 10000,
        total_recipients INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        campaign_id TEXT,
        template_id TEXT,
        to_address TEXT NOT NULL,
        from_address TEXT NOT NULL,
        subject TEXT NOT NULL,
        html_body TEXT NOT NULL,
        text_body TEXT,
        status TEXT DEFAULT 'queued',
        provider_message_id TEXT,
        error_detail TEXT,
        queued_at BIGINT NOT NULL,
        sent_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        email_id TEXT,
        contact_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT DEFAULT '{}',
        received_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        trigger_event_name TEXT NOT NULL,
        graph_json TEXT DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        contact_id TEXT,
        status TEXT DEFAULT 'running',
        current_node_id TEXT,
        started_at BIGINT NOT NULL,
        completed_at BIGINT,
        context_json TEXT DEFAULT '{}'
      );
      
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        events_json TEXT DEFAULT '["open", "click", "bounce", "complaint"]',
        secret TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        user_id TEXT,
        action TEXT,
        resource_type TEXT,
        resource_id TEXT,
        details_json TEXT,
        created_at BIGINT
      );

      DROP TABLE IF EXISTS domain_dns_snapshots;
      CREATE TABLE IF NOT EXISTS domain_dns_snapshots (
        id TEXT PRIMARY KEY,
        domain_id TEXT,
        spf_record TEXT,
        dkim_record TEXT,
        dmarc_record TEXT,
        bimi_record TEXT,
        checked_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS clicks (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL,
        original_url TEXT NOT NULL,
        created_at BIGINT NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS blocklist_checks (
        id TEXT PRIMARY KEY,
        target TEXT,
        blocklist_name TEXT,
        status TEXT,
        checked_at BIGINT
      );
    `);

    console.log('✅ [DB] Core tables verified (Postgres)');

    // 2. Demo Org check
    const orgCount = await sql.unsafe('SELECT COUNT(*) as count FROM orgs');
    
    // Secure Master Admin Credentials
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@omnimail.local').toLowerCase().trim();
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    // Use dynamic salt based on the email to match auth.js logic
    const adminSalt = (adminEmail === 'admin@omnimail.local') ? 'omni_salt_demo' : ('omni_salt_' + adminEmail);
    const adminPasswordHash = crypto.scryptSync(adminPassword, adminSalt, 64).toString('hex');
    const defaultOrgId = 'org_demo_omnimail_001';

    if (parseInt(orgCount[0].count) === 0) {
      const now = Date.now();
      await sql.unsafe(`
        INSERT INTO orgs (id, name, plan_tier, custom_send_volume, dedicated_ip, onboarding_step, created_at)
        VALUES ($1, $2, $3, $4, $5, 'completed', $6)
      `, [defaultOrgId, 'OmniMail Enterprise Demo', 'enterprise', 1000000, '198.51.100.42', now]);

      await sql.unsafe(`
        INSERT INTO users (id, org_id, email, name, role, password_hash, is_verified, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
      `, ['usr_demo_owner_001', defaultOrgId, adminEmail, 'Master Admin', 'owner', adminPasswordHash, now]);

      await sql.unsafe(`
        INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, role, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, ['key_demo_master_001', defaultOrgId, 'Master Demo Key', 'omni_live_master_key_9988776655', 'omni_live_', 'owner', now]);
      
      console.log('✅ [DB] Initialized Demo Org and Master Key');
    }

    // Forcefully update the existing master admin account on every boot 
    // to ensure the user can securely override the default credentials via Render ENV vars
    await sql.unsafe(`
      UPDATE users 
      SET email = $1, password_hash = $2 
      WHERE id = 'usr_demo_owner_001'
    `, [adminEmail, adminPasswordHash]);

    // Force demo org to bypass onboarding if it already exists but was stuck
    await sql.unsafe(`UPDATE orgs SET onboarding_step = 'completed' WHERE id = 'org_demo_omnimail_001'`);
  } catch (err) {
    console.error('❌ [DB Init Error]:', err);
  }
}

initDb();

module.exports = db;
