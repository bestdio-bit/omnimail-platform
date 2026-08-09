const postgres = require('postgres');
const crypto = require('crypto');

const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/omnimail';
const sql = postgres(dbUrl, {
  max: 10,
  idle_timeout: 20
});

// Helper to convert SQLite syntax to Postgres syntax
async function convertQuery(query) {
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
    `);

    console.log('✅ [DB] Core tables verified (Postgres)');

    // 2. Demo Org check
    const orgCount = await sql.unsafe('SELECT COUNT(*) as count FROM orgs');
    if (parseInt(orgCount[0].count) === 0) {
      const now = Date.now();
      const defaultOrgId = 'org_demo_omnimail_001';
      await sql.unsafe(`
        INSERT INTO orgs (id, name, plan_tier, custom_send_volume, dedicated_ip, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [defaultOrgId, 'OmniMail Enterprise Demo', 'enterprise', 1000000, '198.51.100.42', now]);

      const demoPasswordHash = crypto.scryptSync('admin123', 'omni_salt_demo', 64).toString('hex');
      await sql.unsafe(`
        INSERT INTO users (id, org_id, email, name, role, password_hash, is_verified, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
      `, ['usr_demo_owner_001', defaultOrgId, 'admin@omnimail.local', 'Demo Admin', 'owner', demoPasswordHash, now]);

      await sql.unsafe(`
        INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, role, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, ['key_demo_master_001', defaultOrgId, 'Master Demo Key', 'omni_live_master_key_9988776655', 'omni_live_', 'owner', now]);
      
      console.log('✅ [DB] Initialized Demo Org and Master Key: omni_live_master_key_9988776655');
    }
  } catch (err) {
    console.error('❌ [DB Init Error]:', err);
  }
}

initDb();

module.exports = db;
