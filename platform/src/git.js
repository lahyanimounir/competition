// Git hosting: bare repositories on disk, served over the git "smart HTTP" protocol.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const config = require('./config');
const { q, audit } = require('./db');
const crypto = require('crypto');
const { run, verifyPasswordAsync, httpError } = require('./util');

const IDENTITY = ['-c', 'user.name=WorldSkills Platform', '-c', 'user.email=platform@worldskills.local'];

const repoPath = (gitUser, name) => path.join(config.REPO_DIR, gitUser, `${name}.git`);
const remoteUrl = (gitUser, name) => {
  const port = config.PUBLIC_PORT === '80' ? '' : `:${config.PUBLIC_PORT}`;
  return `http://${gitUser}@${config.BASE_DOMAIN}${port}/git/${gitUser}/${name}.git`;
};

async function git(args, opts = {}) {
  const r = await run('git', args, opts);
  if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r;
}

/** Create a bare repository whose first commit is the contents of `dir`. */
async function initBareFromDir(bare, dir, message) {
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  await git(['init', '--bare', '-b', 'main', bare]);
  await git(['init', '-b', 'main'], { cwd: dir });
  await git(['add', '-A'], { cwd: dir });
  await git([...IDENTITY, 'commit', '-q', '-m', message], { cwd: dir });
  await git(['push', '-q', bare, 'main'], { cwd: dir });
}

async function headSha(bare, ref = 'refs/heads/main') {
  const r = await run('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', ref]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function commitInfo(bare, sha) {
  const r = await run('git', ['--git-dir', bare, 'log', '-1', '--format=%H%x09%an%x09%aI%x09%s', sha]);
  if (r.code !== 0) return null;
  const [hash, author, date, ...subject] = r.stdout.trim().split('\t');
  return { sha: hash, author, date, message: subject.join('\t') };
}

async function log(bare, ref = 'main', limit = 100) {
  const r = await run('git', ['--git-dir', bare, 'log', `-n${limit}`, '--format=%H%x09%an%x09%aI%x09%s', ref]);
  if (r.code !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [sha, author, date, ...subject] = line.split('\t');
    return { sha, author, date, message: subject.join('\t') };
  });
}

function safeRef(ref) {
  ref = String(ref || 'main');
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(ref) || ref.includes('..')) throw httpError(400, 'Invalid ref');
  return ref;
}

function safePath(p) {
  p = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = p.split('/');
  if (!p || parts.some((s) => s === '' || s === '.' || s === '..') || parts[0] === '.git') throw httpError(400, 'Invalid file path');
  return p;
}

async function listFiles(bare, ref) {
  const r = await git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', safeRef(ref)]);
  return r.stdout.split('\n').filter(Boolean);
}

async function readFile(bare, ref, file) {
  const r = await run('git', ['--git-dir', bare, 'show', `${safeRef(ref)}:${safePath(file)}`]);
  if (r.code !== 0) throw httpError(404, 'File not found');
  if (r.stdout.includes('\u0000')) return { binary: true, content: '' };
  return { binary: false, content: r.stdout };
}

/** Apply file changes ([{path, content|null}]) as one commit on main. Returns the new sha. */
async function commitChanges(bare, changes, message, author) {
  const tmp = fs.mkdtempSync(path.join(config.TMP_DIR, 'ide-'));
  try {
    await git(['clone', '-q', '--branch', 'main', bare, tmp]);
    for (const c of changes) {
      const target = path.join(tmp, safePath(c.path));
      if (c.content === null || c.content === undefined) {
        fs.rmSync(target, { force: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, c.content);
      }
    }
    await git(['add', '-A'], { cwd: tmp });
    const status = await git(['status', '--porcelain'], { cwd: tmp });
    if (!status.stdout.trim()) return null;
    await git(['-c', `user.name=${author}`, '-c', 'user.email=ide@worldskills.local', 'commit', '-q', '-m', message || 'Edit via web IDE'], { cwd: tmp });
    await git(['push', '-q', 'origin', 'HEAD:main'], { cwd: tmp });
    return (await git(['rev-parse', 'HEAD'], { cwd: tmp })).stdout.trim();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- smart HTTP ------------------------------------------------------------

const pkt = (s) => (s.length + 4).toString(16).padStart(4, '0') + s;

// A clone or push is several HTTP requests, each carrying the password. scrypt is slow on purpose,
// so a successful check is remembered briefly. The key includes the stored hash, so rotating the
// git password invalidates it immediately.
const AUTH_TTL_MS = 5 * 60 * 1000;
const authCache = new Map();
async function checkGitPassword(user, password) {
  const key = crypto.createHash('sha256').update(`${user.id}\0${user.git_pass_hash}\0${password}`).digest('hex');
  const hit = authCache.get(key);
  if (hit && hit > Date.now()) return true;
  const ok = await verifyPasswordAsync(password, user.git_pass_hash);
  if (ok) {
    if (authCache.size > 5000) authCache.clear();
    authCache.set(key, Date.now() + AUTH_TTL_MS);
  }
  return ok;
}

function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', 'Basic realm="WorldSkills Git", charset="UTF-8"');
  res.end('Authentication required\n');
}

/**
 * Express handler mounted at /git. onPush(repo, sha, user) is called after a push
 * changes refs/heads/main.
 */
function smartHttp(onPush) {
  return async (req, res) => {
    const m = req.path.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (!m) { res.statusCode = 404; return res.end('Not found\n'); }
    const [, gitUser, repoName, action] = m;

    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Basic ')) return unauthorized(res);
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const sep = decoded.indexOf(':');
    const user = q.get("SELECT * FROM users WHERE git_user = ? AND role = 'competitor'", decoded.slice(0, sep));
    // A competitor can only ever reach their own namespace.
    if (!user || user.git_user !== gitUser || !(await checkGitPassword(user, decoded.slice(sep + 1)))) {
      audit(user && user.id, 'git.auth_failed', `${decoded.slice(0, sep)} -> ${gitUser}/${repoName}`);
      return unauthorized(res);
    }
    const repo = q.get('SELECT * FROM repos WHERE user_id = ? AND name = ?', user.id, repoName);
    if (!repo) { res.statusCode = 404; return res.end('Repository not found\n'); }
    const bare = repoPath(gitUser, repoName);

    res.setHeader('Cache-Control', 'no-cache');
    if (action === 'info/refs') {
      const service = req.query.service;
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.statusCode = 403;
        return res.end('Only the smart HTTP protocol is supported. Upgrade git.\n');
      }
      res.setHeader('Content-Type', `application/x-${service}-advertisement`);
      res.write(pkt(`# service=${service}\n`));
      res.write('0000');
      const p = spawn('git', [service.slice(4), '--stateless-rpc', '--advertise-refs', bare]);
      p.stdout.pipe(res);
      p.stderr.on('data', (d) => console.error('[git]', d.toString()));
      return;
    }

    const before = action === 'git-receive-pack' ? await headSha(bare) : null;
    res.setHeader('Content-Type', `application/x-${action}-result`);
    const p = spawn('git', [action.slice(4), '--stateless-rpc', bare]);
    let input = req;
    if (req.headers['content-encoding'] === 'gzip') input = req.pipe(zlib.createGunzip());
    input.pipe(p.stdin);
    p.stdout.pipe(res);
    p.stderr.on('data', (d) => console.error('[git]', d.toString()));
    p.on('close', async () => {
      if (action !== 'git-receive-pack') return;
      const after = await headSha(bare);
      if (after && after !== before) {
        audit(user.id, 'git.push', `${gitUser}/${repoName} ${after.slice(0, 7)}`);
        try { await onPush(repo, after, user); } catch (e) { console.error('[git] onPush failed', e); }
      }
    });
  };
}

module.exports = {
  repoPath, remoteUrl, initBareFromDir, headSha, commitInfo, log, listFiles, readFile, commitChanges, smartHttp, safePath,
};
