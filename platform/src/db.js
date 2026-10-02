// Platform metadata store (users, repositories, deployments, assessment marks, announcements, audit log).
// Competitor application data lives in MySQL, one database per repository (see mysql.js).
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('competitor','trainer','admin')),
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  git_user TEXT UNIQUE,
  git_pass_hash TEXT,
  pending_secrets TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  subdomain TEXT NOT NULL UNIQUE,
  db_name TEXT NOT NULL,
  db_user TEXT NOT NULL,
  db_pass TEXT NOT NULL,
  current_container TEXT,
  current_deployment_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  commit_msg TEXT,
  trigger TEXT NOT NULL,
  triggered_by INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  container TEXT,
  image TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deploy_repo ON deployments(repo_id, id);
CREATE TABLE IF NOT EXISTS env_vars (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (repo_id, key)
);
CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  brief TEXT,
  requirements TEXT,
  deadline TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (module_id, user_id)
);
CREATE TABLE IF NOT EXISTS rubric_criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  max_points REAL NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  trainer_id INTEGER,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assessment_scores (
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL,
  criterion_name TEXT NOT NULL,
  max_points REAL NOT NULL,
  score REAL,
  feedback TEXT
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  author_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repo_assessments (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  trainer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  commit_sha TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, trainer_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Columns added after the first release (existing databases are upgraded in place).
// code_enc / git_pass_enc: the access code and git password, ENCRYPTED with the server secret,
// so administrators can look them up at any time (see auth.seal).
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('code_enc')) db.exec('ALTER TABLE users ADD COLUMN code_enc TEXT');
if (!userCols.includes('git_pass_enc')) db.exec('ALTER TABLE users ADD COLUMN git_pass_enc TEXT');
// Old competitor-level assessment mark (replaced by repo_assessments; columns kept, unused).
if (!userCols.includes('assessed_at')) db.exec('ALTER TABLE users ADD COLUMN assessed_at TEXT');
if (!userCols.includes('assessed_by')) db.exec('ALTER TABLE users ADD COLUMN assessed_by INTEGER');
// Where a trainer is right now ('floor' | 'marking' | NULL = off duty), set by an administrator.
if (!userCols.includes('location')) db.exec('ALTER TABLE users ADD COLUMN location TEXT');
if (!userCols.includes('location_at')) db.exec('ALTER TABLE users ADD COLUMN location_at TEXT');
// Extra time (seconds) an administrator gave this competitor on top of the shared timer.
if (!userCols.includes('extra_seconds')) db.exec('ALTER TABLE users ADD COLUMN extra_seconds INTEGER NOT NULL DEFAULT 0');

const norm = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const plain = (row) => (row ? { ...row } : row);

const q = {
  get: (sql, ...p) => plain(db.prepare(sql).get(...norm(p))),
  all: (sql, ...p) => db.prepare(sql).all(...norm(p)).map(plain),
  run: (sql, ...p) => {
    const r = db.prepare(sql).run(...norm(p));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  },
};

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSetting(key, fallback) {
  const r = q.get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

function audit(userId, action, detail) {
  q.run('INSERT INTO audit(user_id, action, detail, created_at) VALUES(?,?,?,?)',
    userId || null, action, detail ? String(detail) : null, new Date().toISOString());
}

module.exports = { db, q, tx, getSetting, setSetting, audit };
