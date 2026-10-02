// Per-repository MySQL databases. Each repository gets its own database AND its own
// MySQL user that is granted access to that one database only.
const mysql = require('mysql2/promise');
const config = require('./config');

let pool;
function root() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.MYSQL_HOST, port: config.MYSQL_PORT, user: 'root', password: config.MYSQL_ROOT_PASSWORD,
      connectionLimit: 4, waitForConnections: true,
    });
  }
  return pool;
}

async function waitReady(maxSeconds = 120) {
  for (let i = 0; i < maxSeconds; i++) {
    try { await root().query('SELECT 1'); return true; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  return false;
}

async function provision(dbName, dbUser, dbPass) {
  const p = root();
  await p.query(`CREATE DATABASE ${mysql.escapeId(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await p.query("CREATE USER ?@'%' IDENTIFIED WITH mysql_native_password BY ?", [dbUser, dbPass]);
  await p.query(`GRANT ALL PRIVILEGES ON ${mysql.escapeId(dbName)}.* TO ?@'%'`, [dbUser]);
}

async function drop(dbName, dbUser) {
  const p = root();
  await p.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(dbName)}`);
  await p.query("DROP USER IF EXISTS ?@'%'", [dbUser]);
}

/** Run something with the repository's own (scoped) credentials, never root. */
async function withRepoConnection(repo, fn) {
  const conn = await mysql.createConnection({
    host: config.MYSQL_HOST, port: config.MYSQL_PORT, user: repo.db_user, password: repo.db_pass, database: repo.db_name,
    multipleStatements: false, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  });
  try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}

async function listTables(repo) {
  return withRepoConnection(repo, async (c) => {
    const [rows] = await c.query(
      'SELECT TABLE_NAME AS name, TABLE_ROWS AS approxRows FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [repo.db_name],
    );
    return rows;
  });
}

async function tableRows(repo, table, limit = 200) {
  return withRepoConnection(repo, async (c) => {
    const [cols] = await c.query(`SHOW COLUMNS FROM ${mysql.escapeId(table)}`);
    const [rows] = await c.query(`SELECT * FROM ${mysql.escapeId(table)} LIMIT ${Number(limit)}`);
    return { columns: cols.map((x) => x.Field), rows };
  });
}

async function query(repo, sql) {
  return withRepoConnection(repo, async (c) => {
    const [result, fields] = await c.query({ sql, rowsAsArray: false });
    if (Array.isArray(result)) {
      return { columns: (fields || []).map((f) => f.name), rows: result.slice(0, 1000), truncated: result.length > 1000 };
    }
    return { affectedRows: result.affectedRows, insertId: result.insertId, info: result.info };
  });
}

async function status() {
  try {
    const [[row]] = await root().query('SELECT VERSION() AS version');
    const [dbs] = await root().query("SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'ws\\_%'");
    return { ok: true, version: row.version, databases: dbs[0].n };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { waitReady, provision, drop, listTables, tableRows, query, status };
