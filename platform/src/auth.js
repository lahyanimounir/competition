const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { q, audit } = require('./db');
const { randomDigits, randomString, hashPassword, now, httpError } = require('./util');

// Server-side pepper so access-code hashes in the database are useless on their own.
const secretFile = path.join(config.DATA_DIR, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const PEPPER = fs.readFileSync(secretFile, 'utf8').trim();

const COOKIE = 'ws_session';

const hashCode = (code) => crypto.createHmac('sha256', PEPPER).update(String(code).trim()).digest('hex');

// Credentials are kept encrypted (AES-256-GCM, key derived from the server secret) so the
// administrator can view them at any time. The database file alone does not reveal them.
const VAULT_KEY = crypto.createHash('sha256').update(`vault:${PEPPER}`).digest();
function seal(text) {
  if (text === null || text === undefined) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}
function unseal(sealed) {
  if (!sealed) return null;
  try {
    const [, iv, tag, enc] = sealed.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Generate a unique access code: 6 digits for competitors, 8 for staff. */
function newAccessCode(role) {
  const len = role === 'competitor' ? 6 : 8;
  for (let i = 0; i < 50; i++) {
    const code = randomDigits(len);
    if (!q.get('SELECT 1 FROM users WHERE code_hash = ?', hashCode(code))) return code;
  }
  throw new Error('Could not allocate a unique access code');
}

function slugGitUser(name) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'competitor';
  let candidate = base;
  for (let i = 2; q.get('SELECT 1 FROM users WHERE git_user = ?', candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}

/**
 * Create a user. Competitors automatically get git credentials for their own namespace;
 * the git password is stored only as a hash and shown once on their dashboard.
 */
function createUser({ role, name }) {
  if (!['competitor', 'trainer', 'admin'].includes(role)) throw httpError(400, 'Invalid role');
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'Name is required');
  const code = newAccessCode(role);
  let gitUser = null;
  let gitHash = null;
  let pending = null;
  let gitPassword = null;
  if (role === 'competitor') {
    gitUser = slugGitUser(name);
    gitPassword = randomString(16);
    gitHash = hashPassword(gitPassword);
    pending = JSON.stringify({ gitPassword: true }); // flag only: the password itself is stored encrypted
  }
  const r = q.run(
    'INSERT INTO users(role, name, code_hash, git_user, git_pass_hash, pending_secrets, code_enc, git_pass_enc, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    role, name, hashCode(code), gitUser, gitHash, pending, seal(code), seal(gitPassword), now(),
  );
  return { id: r.id, code };
}

function resetAccessCode(userId) {
  const user = q.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw httpError(404, 'User not found');
  const code = newAccessCode(user.role);
  q.run('UPDATE users SET code_hash = ?, code_enc = ? WHERE id = ?', hashCode(code), seal(code), userId);
  q.run('DELETE FROM sessions WHERE user_id = ?', userId);
  return code;
}

/** New git password; existing repositories are unaffected. Shown once to the competitor. */
function rotateGitPassword(userId) {
  const user = q.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user || user.role !== 'competitor') throw httpError(404, 'Competitor not found');
  const gitPassword = randomString(16);
  q.run('UPDATE users SET git_pass_hash = ?, git_pass_enc = ?, pending_secrets = ? WHERE id = ?',
    hashPassword(gitPassword), seal(gitPassword), JSON.stringify({ gitPassword: true }), userId);
}

/** Make sure the administrator from .env exists and its code matches ADMIN_CODE. */
function ensureAdmin() {
  if (!config.ADMIN_CODE) {
    console.warn('[auth] ADMIN_CODE is not set - no administrator account will be created.');
    return;
  }
  const h = hashCode(config.ADMIN_CODE);
  const clash = q.get('SELECT id, name FROM users WHERE code_hash = ?', h);
  const admin = q.get("SELECT * FROM users WHERE role = 'admin' AND name = 'Administrator'");
  if (admin) {
    if (!clash || clash.id === admin.id) q.run('UPDATE users SET code_hash = ?, code_enc = ? WHERE id = ?', h, seal(config.ADMIN_CODE), admin.id);
  } else if (!clash) {
    q.run("INSERT INTO users(role, name, code_hash, code_enc, created_at) VALUES('admin','Administrator',?,?,?)", h, seal(config.ADMIN_CODE), now());
    console.log('[auth] Administrator account created (log in with ADMIN_CODE).');
  }
}

// ---- sessions --------------------------------------------------------------

// Only FAILED attempts count, so many competitors behind one router (same IP) can all log in at once.
const failures = new Map(); // ip -> { count, reset }
function rateLimited(ip) {
  const a = failures.get(ip);
  return !!a && a.reset > Date.now() && a.count >= 10;
}
function recordFailure(ip) {
  const t = Date.now();
  const a = failures.get(ip);
  if (!a || a.reset < t) failures.set(ip, { count: 1, reset: t + 60_000 });
  else a.count++;
}

function login(req, res) {
  const ip = req.socket.remoteAddress;
  if (rateLimited(ip)) throw httpError(429, 'Too many wrong codes. Wait a minute and try again.');
  const code = String((req.body && req.body.code) || '').replace(/\s+/g, '');
  if (!/^\d{6,12}$/.test(code)) { recordFailure(ip); throw httpError(400, 'Enter your numeric access code'); }
  const user = q.get('SELECT * FROM users WHERE code_hash = ?', hashCode(code));
  if (!user) { recordFailure(ip); audit(null, 'login.failed', ip); throw httpError(401, 'Unknown access code'); }
  const token = crypto.randomBytes(32).toString('hex');
  q.run('INSERT INTO sessions(token, user_id, created_at) VALUES(?,?,?)', token, user.id, now());
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
  audit(user.id, 'login', ip);
  return user;
}

function logout(req, res) {
  const token = readCookie(req);
  if (token) q.run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

function currentUser(req) {
  const token = readCookie(req);
  if (!token) return null;
  return q.get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', token) || null;
}

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
};

const isStaff = (user) => user && (user.role === 'trainer' || user.role === 'admin');

module.exports = {
  hashCode, seal, unseal, createUser, resetAccessCode, rotateGitPassword, ensureAdmin,
  login, logout, currentUser, requireUser, requireRole, isStaff,
};
