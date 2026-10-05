require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: false })); // mesma origem apenas (front e API são servidos juntos)
app.use(express.json({ limit: '50mb' }));

// ─── Autenticação (HTTP Basic) ─────────────────────────────────────────────────
// Se APP_PASSWORD estiver definida, TODO acesso (página + API) exige senha.
// Usuário: qualquer um (padrão "admin"); senha: APP_PASSWORD.
const crypto = require('crypto');
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.use((req, res, next) => {
  const appPass = process.env.APP_PASSWORD;
  if (!appPass) return next();
  if (req.path === '/healthz') return next();
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    if (safeEqual(pass, appPass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="PGManager", charset="UTF-8"');
  res.status(401).send('Autenticação necessária');
});
app.get('/healthz', (req, res) => res.send('ok'));

app.use(express.static(path.join(__dirname, '../frontend/public')));

// Escapa identificadores SQL (schema/tabela/coluna)
const qi = (id) => '"' + String(id).replace(/"/g, '""') + '"';

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 2000 });
app.use('/api/', limiter);

// ─── Connection Pool Storage ───────────────────────────────────────────────────
let pool = null;
let currentConfig = null;

function buildSsl(host) {
  // Hosts que exigem SSL (Render, Supabase, Neon, Railway, Heroku, etc.)
  const sslHosts = ['render.com', 'supabase.co', 'neon.tech', 'railway.app', 'heroku.com', 'amazonaws.com', 'azure.com', 'cockroachlabs.cloud'];
  const needsSsl = sslHosts.some(h => (host || '').includes(h));
  if (needsSsl) return { rejectUnauthorized: false };
  return undefined;
}

function getPool(config = null) {
  if (config) {
    if (pool) pool.end().catch(() => {});
    const ssl = config.ssl === 'true' || config.ssl === true
      ? { rejectUnauthorized: false }
      : buildSsl(config.host);
    pool = new Pool({
      host: config.host || process.env.PG_HOST || 'localhost',
      port: parseInt(config.port) || parseInt(process.env.PG_PORT) || 5432,
      user: config.user || process.env.PG_USER || 'postgres',
      password: config.password || process.env.PG_PASSWORD || '',
      database: config.database || process.env.PG_DATABASE || 'postgres',
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: ssl,
    });
    currentConfig = config;
    return pool;
  }
  if (!pool) {
    const host = process.env.PG_HOST || 'localhost';
    pool = new Pool({
      host,
      port: parseInt(process.env.PG_PORT) || 5432,
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD || '',
      database: process.env.PG_DATABASE || 'postgres',
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: buildSsl(host),
    });
  }
  return pool;
}

// ─── Helper ────────────────────────────────────────────────────────────────────
async function query(sql, params = []) {
  const p = getPool();
  const client = await p.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

// ─── API: Connection ───────────────────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  try {
    const { host, port, user, password, database, ssl } = req.body;
    const sslOpt = ssl === 'true' || ssl === true ? { rejectUnauthorized: false } : buildSsl(host);
    const testPool = new Pool({ host, port: parseInt(port), user, password, database,
      connectionTimeoutMillis: 5000, max: 1, ssl: sslOpt });
    const client = await testPool.connect();
    const result = await client.query('SELECT version(), current_database(), current_user, pg_postmaster_start_time()');
    client.release();
    await testPool.end();
    getPool({ host, port, user, password, database, ssl });
    res.json({ success: true, info: result.rows[0] });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const result = await query('SELECT version(), current_database(), current_user, NOW() as server_time');
    res.json({ connected: true, info: result.rows[0], config: currentConfig });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  if (pool) { pool.end().catch(() => {}); pool = null; currentConfig = null; }
  res.json({ success: true });
});

// ─── API: Databases ────────────────────────────────────────────────────────────
app.get('/api/databases', async (req, res) => {
  try {
    const result = await query(`
      SELECT d.datname as name,
             pg_size_pretty(pg_database_size(d.datname)) as size,
             pg_database_size(d.datname) as size_bytes,
             d.datcollate as collation,
             d.datctype as ctype,
             r.rolname as owner,
             d.datconnlimit as conn_limit,
             d.datacl as acl
      FROM pg_database d
      JOIN pg_roles r ON r.oid = d.datdba
      WHERE d.datistemplate = false
      ORDER BY d.datname`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/databases', async (req, res) => {
  try {
    const { name, owner, encoding, collation } = req.body;
    let sql = `CREATE DATABASE ${qi(name)}`;
    if (owner) sql += ` OWNER ${qi(owner)}`;
    if (encoding) sql += ` ENCODING '${encoding}'`;
    if (collation) sql += ` LC_COLLATE '${collation}' LC_CTYPE '${collation}'`;
    await query(sql);
    res.json({ success: true, message: `Database "${name}" created successfully` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/databases/:name', async (req, res) => {
  try {
    const { name } = req.params;
    await query(`DROP DATABASE IF EXISTS ${qi(name)}`);
    res.json({ success: true, message: `Database "${name}" dropped` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: Schemas ──────────────────────────────────────────────────────────────
app.get('/api/schemas', async (req, res) => {
  try {
    const result = await query(`
      SELECT schema_name as name, schema_owner as owner
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('information_schema','pg_catalog','pg_toast')
        AND schema_name NOT LIKE 'pg_temp_%'
        AND schema_name NOT LIKE 'pg_toast_temp_%'
      ORDER BY schema_name`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: Tables ───────────────────────────────────────────────────────────────
app.get('/api/tables', async (req, res) => {
  try {
    const schema = req.query.schema || 'public';
    const result = await query(`
      SELECT t.table_name as name,
             t.table_schema as schema,
             pg_size_pretty(pg_total_relation_size(quote_ident(t.table_schema)||'.'||quote_ident(t.table_name))) as size,
             pg_total_relation_size(quote_ident(t.table_schema)||'.'||quote_ident(t.table_name)) as size_bytes,
             c.reltuples::bigint as estimated_rows,
             obj_description(c.oid) as description
      FROM information_schema.tables t
      JOIN pg_class c ON c.relname = t.table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
      WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name`, [schema]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tables', async (req, res) => {
  try {
    const { schema = 'public', name, columns } = req.body;
    const colDefs = columns.map(c => {
      let def = `${qi(c.name)} ${c.type}`;
      if (c.length) def += `(${c.length})`;
      if (c.primaryKey) def += ' PRIMARY KEY';
      if (c.notNull) def += ' NOT NULL';
      if (c.unique) def += ' UNIQUE';
      if (c.default) def += ` DEFAULT ${c.default}`;
      return def;
    }).join(',\n  ');
    await query(`CREATE TABLE ${qi(schema)}.${qi(name)} (\n  ${colDefs}\n)`);
    res.json({ success: true, message: `Table "${name}" created` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tables/:schema/:name', async (req, res) => {
  try {
    const { schema, name } = req.params;
    const cascade = req.query.cascade === 'true' ? ' CASCADE' : '';
    await query(`DROP TABLE IF EXISTS ${qi(schema)}.${qi(name)}${cascade}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: Table Columns ────────────────────────────────────────────────────────
app.get('/api/tables/:schema/:name/columns', async (req, res) => {
  try {
    const { schema, name } = req.params;
    const result = await query(`
      SELECT c.column_name as name,
             c.data_type as type,
             c.character_maximum_length as max_length,
             c.numeric_precision,
             c.numeric_scale,
             c.is_nullable as nullable,
             c.column_default as default_value,
             c.ordinal_position as position,
             CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
             CASE WHEN uq.column_name IS NOT NULL THEN true ELSE false END as is_unique,
             pgd.description as comment
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT ku.column_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
          AND tc.table_schema = ku.table_schema AND tc.table_name = ku.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
      ) pk ON pk.column_name = c.column_name
      LEFT JOIN (
        SELECT ku.column_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
          AND tc.table_schema = ku.table_schema AND tc.table_name = ku.table_name
        WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $1 AND tc.table_name = $2
      ) uq ON uq.column_name = c.column_name
      LEFT JOIN pg_description pgd ON pgd.objoid = (
        SELECT c2.oid FROM pg_class c2 JOIN pg_namespace n ON n.oid = c2.relnamespace
        WHERE c2.relname = $2 AND n.nspname = $1
      ) AND pgd.objsubid = c.ordinal_position
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position`, [schema, name]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: Table Data (CRUD) ────────────────────────────────────────────────────
app.get('/api/tables/:schema/:name/data', async (req, res) => {
  try {
    const { schema, name } = req.params;
    const requestedLimit = parseInt(req.query.limit) || 100;
    const limit = req.query.export === 'true'
      ? Math.min(requestedLimit, 100000)  // export: até 100k rows
      : Math.min(requestedLimit, 1000);   // browser: máx 1000
    const offset = parseInt(req.query.offset) || 0;
    const dir = String(req.query.dir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const orderBy = req.query.orderBy ? `ORDER BY ${qi(req.query.orderBy)} ${dir}` : '';
    const where = req.query.search && req.query.searchCol
      ? `WHERE CAST(${qi(req.query.searchCol)} AS TEXT) ILIKE $1`
      : '';
    const searchParam = `%${req.query.search || ''}%`;
    const countResult = await query(
      `SELECT COUNT(*) FROM ${qi(schema)}.${qi(name)} ${where}`,
      where ? [searchParam] : []
    );
    const dataResult = await query(
      where
        ? `SELECT * FROM ${qi(schema)}.${qi(name)} WHERE CAST(${qi(req.query.searchCol)} AS TEXT) ILIKE $1 ${orderBy} LIMIT $2 OFFSET $3`
        : `SELECT * FROM ${qi(schema)}.${qi(name)} ${orderBy} LIMIT $1 OFFSET $2`,
      where ? [searchParam, limit, offset] : [limit, offset]
    );
    res.json({ rows: dataResult.rows, total: parseInt(countResult.rows[0].count), limit, offset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tables/:schema/:name/data', async (req, res) => {
  try {
    const { schema, name } = req.params;
    const data = req.body;
    const keys = Object.keys(data);
    const vals = Object.values(data);
    const cols = keys.map(qi).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const result = await query(
      `INSERT INTO ${qi(schema)}.${qi(name)} (${cols}) VALUES (${placeholders}) RETURNING *`,
      vals
    );
    res.json({ success: true, row: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tables/:schema/:name/data', async (req, res) => {
  try {
    const { schema, name } = req.params;
    const { where, data } = req.body;
    const dataKeys = Object.keys(data);
    const dataVals = Object.values(data);
    const setClause = dataKeys.map((k, i) => `${qi(k)} = $${i + 1}`).join(', ');
    const whereKeys = Object.keys(where);
    const whereVals = Object.values(where);
    const whereClause = whereKeys.map((k, i) => `${qi(k)} = $${dataKeys.length + i + 1}`).join(' AND ');
    const result = await query(
      `UPDATE ${qi(schema)}.${qi(name)} SET ${setClause} WHERE ${whereClause} RETURNING *`,
      [...dataVals, ...whereVals]
    );
    res.json({ success: true, row: result.rows[0], affected: result.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tables/:schema/:name/data', async (req, res) => {
  try {
    const { schema, name } = req.params;
    const { where } = req.body;
    const whereKeys = Object.keys(where);
    const whereVals = Object.values(where);
    const whereClause = whereKeys.map((k, i) => `${qi(k)} = $${i + 1}`).join(' AND ');
    const result = await query(
      `DELETE FROM ${qi(schema)}.${qi(name)} WHERE ${whereClause}`,
      whereVals
    );
    res.json({ success: true, affected: result.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: SQL Query ────────────────────────────────────────────────────────────
app.post('/api/query', async (req, res) => {
  const startTime = Date.now();
  try {
    const { sql } = req.body;
    if (!sql || !sql.trim()) return res.status(400).json({ error: 'SQL cannot be empty' });
    const result = await query(sql);
    const duration = Date.now() - startTime;
    res.json({
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
      command: result.command,
      duration
    });
  } catch (err) {
    res.status(400).json({ error: err.message, duration: Date.now() - startTime });
  }
});

// ─── API: Batch Query (for SQL import) ────────────────────────────────────────
app.post('/api/query/batch', async (req, res) => {
  try {
    const { statements, stopOnError } = req.body;
    if (!Array.isArray(statements) || !statements.length)
      return res.status(400).json({ error: 'statements must be a non-empty array' });

    if (!pool) return res.status(400).json({ error: 'Não conectado ao banco' });
    const results = [];
    const client = await pool.connect();
    try {
      for (const sql of statements) {
        try {
          const r = await client.query(sql);
          results.push({ ok: true, command: r.command, rowCount: r.rowCount });
        } catch (err) {
          results.push({ ok: false, error: err.message, sql: sql.substring(0, 120) });
          if (stopOnError) break;
        }
      }
    } finally {
      client.release();
    }
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── API: Views ────────────────────────────────────────────────────────────────
app.get('/api/views', async (req, res) => {
  try {
    const schema = req.query.schema || 'public';
    const result = await query(`
      SELECT table_name as name, view_definition as definition
      FROM information_schema.views
      WHERE table_schema = $1 ORDER BY table_name`, [schema]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: Indexes ──────────────────────────────────────────────────────────────
app.get('/api/indexes', async (req, res) => {
  try {
    const schema = req.query.schema || 'public';
    const result = await query(`
      SELECT i.relname as index_name,
             t.relname as table_name,
             ix.indisunique as is_unique,
             ix.indisprimary as is_primary,
             pg_size_pretty(pg_relation_size(i.oid)) as size,
             am.amname as type,
             array_to_string(array_agg(a.attname ORDER BY k.n), ', ') as columns
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
      JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = $1
      GROUP BY i.relname, t.relname, ix.indisunique, ix.indisprimary, i.oid, am.amname
      ORDER BY t.relname, i.relname`, [schema]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: Functions ────────────────────────────────────────────────────────────
app.get('/api/functions', async (req, res) => {
  try {
    const schema = req.query.schema || 'public';
    const result = await query(`
      SELECT p.proname as name,
             pg_get_function_arguments(p.oid) as arguments,
             t.typname as return_type,
             l.lanname as language,
             p.prosrc as source
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_type t ON t.oid = p.prorettype
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = $1 AND p.prokind = 'f'
      ORDER BY p.proname`, [schema]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: Users/Roles ──────────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  try {
    const result = await query(`
      SELECT r.rolname as name,
             r.rolsuper as is_superuser,
             r.rolcreatedb as can_create_db,
             r.rolcreaterole as can_create_role,
             r.rolinherit as inherit,
             r.rolcanlogin as can_login,
             r.rolreplication as replication,
             r.rolconnlimit as conn_limit,
             r.rolvaliduntil as valid_until,
             array_agg(m.rolname) FILTER (WHERE m.rolname IS NOT NULL) as member_of
      FROM pg_roles r
      LEFT JOIN pg_auth_members am ON am.member = r.oid
      LEFT JOIN pg_roles m ON m.oid = am.roleid
      WHERE r.rolname NOT LIKE 'pg_%'
      GROUP BY r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
               r.rolinherit, r.rolcanlogin, r.rolreplication, r.rolconnlimit, r.rolvaliduntil
      ORDER BY r.rolname`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: Statistics ──────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [dbSize, connStats, tableStats, cacheHit, locks] = await Promise.all([
      query(`SELECT pg_size_pretty(SUM(pg_database_size(datname))) as total_size, 
                    COUNT(*) as db_count FROM pg_database WHERE datistemplate = false`),
      query(`SELECT COUNT(*) as total, 
                    SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) as active,
                    SUM(CASE WHEN state = 'idle' THEN 1 ELSE 0 END) as idle,
                    SUM(CASE WHEN state = 'idle in transaction' THEN 1 ELSE 0 END) as idle_in_transaction,
                    MAX(EXTRACT(EPOCH FROM (NOW() - query_start)))::int as longest_query_sec
             FROM pg_stat_activity WHERE pid <> pg_backend_pid()`),
      query(`SELECT schemaname, relname AS tablename, 
                    seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
                    n_tup_ins, n_tup_upd, n_tup_del, n_live_tup, n_dead_tup,
                    last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
             FROM pg_stat_user_tables ORDER BY seq_scan DESC LIMIT 10`),
      query(`SELECT ROUND(
               SUM(heap_blks_hit) * 100.0 / NULLIF(SUM(heap_blks_hit) + SUM(heap_blks_read), 0), 2
             ) as cache_hit_ratio FROM pg_statio_user_tables`),
      query(`SELECT COUNT(*) as lock_count, mode, 
                    SUM(CASE WHEN granted THEN 1 ELSE 0 END) as granted_count
             FROM pg_locks GROUP BY mode ORDER BY lock_count DESC LIMIT 5`)
    ]);
    res.json({
      database: dbSize.rows[0],
      connections: connStats.rows[0],
      topTables: tableStats.rows,
      cacheHit: cacheHit.rows[0],
      locks: locks.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API: Active Connections ───────────────────────────────────────────────────
app.get('/api/connections', async (req, res) => {
  try {
    const result = await query(`
      SELECT pid, usename, application_name, client_addr, 
             state, wait_event_type, wait_event,
             EXTRACT(EPOCH FROM (NOW() - query_start))::int as query_duration_sec,
             LEFT(query, 200) as query
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
      ORDER BY query_start DESC NULLS LAST`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/connections/:pid', async (req, res) => {
  try {
    const { pid } = req.params;
    await query(`SELECT pg_terminate_backend($1)`, [parseInt(pid)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Serve Frontend ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🐘 PostgreSQL Manager`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅  Server running on http://localhost:${PORT}`);
  console.log(`📁  API available at http://localhost:${PORT}/api`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
