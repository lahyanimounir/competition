const express = require('express');
const fs = require('fs');
const config = require('./config');
const { q, tx, audit, getSetting, setSetting } = require('./db');
const auth = require('./auth');
const git = require('./git');
const mysql = require('./mysql');
const docker = require('./docker');
const templates = require('./templates');
const builder = require('./builder');
const repos = require('./repos');
const timer = require('./timer');
const { now, httpError } = require('./util');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const staff = auth.requireRole('trainer', 'admin');
const adminOnly = auth.requireRole('admin');

const publicUser = (u) => u && { id: u.id, role: u.role, name: u.name, gitUser: u.git_user, createdAt: u.created_at };

// ---- auth ------------------------------------------------------------------

router.post('/login', wrap(async (req, res) => {
  const user = auth.login(req, res);
  res.json({ user: publicUser(user) });
}));

router.post('/logout', (req, res) => { auth.logout(req, res); res.json({ ok: true }); });

// ---- public (no login) -------------------------------------------------------

const LOCATIONS = ['floor', 'marking'];
const trainerBoard = () => q.all("SELECT id, name, location, location_at FROM users WHERE role = 'trainer' ORDER BY name")
  .map((u) => ({ id: u.id, name: u.name, location: LOCATIONS.includes(u.location) ? u.location : null, since: u.location_at }));

// Trainer locations for the public board (/board). Only names and locations - nothing else.
router.get('/public/board', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ trainers: trainerBoard().map(({ name, location, since }) => ({ name, location, since })), now: now() });
});

// Competition timer for the public screen (/timer): the shared countdown plus the competitors who
// received extra time (names and extra minutes only).
router.get('/public/timer', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...timer.state(), extra: timer.competitorsWithExtra().map(({ name, extraSeconds }) => ({ name, extraSeconds })) });
});

router.use(auth.requireUser);

router.get('/me', (req, res) => {
  // pending_secrets only flags "a new password was issued"; the value comes from encrypted storage.
  // (Older rows may still hold the plain value from before; it is cleared when acknowledged.)
  const flag = req.user.pending_secrets ? JSON.parse(req.user.pending_secrets) : null;
  const pending = flag && flag.gitPassword
    ? { gitPassword: auth.unseal(req.user.git_pass_enc) || (typeof flag.gitPassword === 'string' ? flag.gitPassword : null) }
    : null;
  res.json({
    user: publicUser(req.user),
    pendingSecrets: pending,
    platform: { baseDomain: config.BASE_DOMAIN, dashboardUrl: config.DASHBOARD_URL, pmaUrl: config.PMA_URL, mysqlPort: config.MYSQL_PUBLIC_PORT },
  });
});

// A competitor can show their own git password again at any time.
router.get('/me/git-password', (req, res) => {
  if (req.user.role !== 'competitor') throw httpError(404, 'Only competitors have git credentials');
  res.json({ username: req.user.git_user, gitPassword: auth.unseal(req.user.git_pass_enc) });
});

// Hides the "new password" banner after the user confirms they saved it.
router.post('/me/ack-secrets', (req, res) => {
  q.run('UPDATE users SET pending_secrets = NULL WHERE id = ?', req.user.id);
  res.json({ ok: true });
});

// ---- access helpers --------------------------------------------------------

/** The competitor whose account is being acted on: yourself, or (staff) any competitor. */
function targetCompetitor(req, id) {
  if (req.user.role === 'competitor') return req.user;
  const u = q.get("SELECT * FROM users WHERE id = ? AND role = 'competitor'", Number(id));
  if (!u) throw httpError(404, 'Competitor not found');
  return u;
}

function loadRepo(req, { write = false } = {}) {
  const repo = q.get('SELECT * FROM repos WHERE id = ?', Number(req.params.id));
  if (!repo) throw httpError(404, 'Repository not found');
  const isOwner = repo.user_id === req.user.id;
  if (!isOwner && !auth.isStaff(req.user)) throw httpError(404, 'Repository not found');
  if (write === 'owner' && !isOwner) throw httpError(403, 'Only the competitor can change their own code (trainer access is read-only)');
  return repo;
}

function bareOf(repo) {
  const owner = q.get('SELECT git_user FROM users WHERE id = ?', repo.user_id);
  return git.repoPath(owner.git_user, repo.name);
}

// ---- competitor dashboard --------------------------------------------------

router.get('/dashboard', wrap(async (req, res) => {
  const user = targetCompetitor(req, req.query.user);
  const list = q.all('SELECT * FROM repos WHERE user_id = ? ORDER BY created_at DESC', user.id);
  res.json({
    competitor: publicUser(user),
    timer: { ...timer.state(), extraSeconds: user.extra_seconds || 0 },
    assessment: auth.isStaff(req.user) ? competitorAssessment(user.id, req.user.id) : undefined,
    git: { username: user.git_user, host: config.DASHBOARD_URL, passwordPending: !!(user.pending_secrets && JSON.parse(user.pending_secrets).gitPassword) },
    announcements: q.all('SELECT a.*, u.name AS author FROM announcements a LEFT JOIN users u ON u.id = a.author_id ORDER BY a.id DESC LIMIT 10'),
    repos: list.map((r) => repos.describe(r, req.user)),
    templates: templates.list().filter((t) => t.enabled).map(({ id, name, description }) => ({ id, name, description })),
    builder: builder.stats(),
  });
}));

router.post('/repos', wrap(async (req, res) => {
  const owner = targetCompetitor(req, req.body.userId);
  const repo = await repos.create(owner, req.body, req.user);
  res.status(201).json(repos.describe(repo, req.user));
}));

router.get('/repos/:id', wrap(async (req, res) => res.json(repos.describe(loadRepo(req), req.user))));

router.patch('/repos/:id', wrap(async (req, res) => {
  const repo = loadRepo(req);
  if (req.body.subdomain !== undefined) {
    const sub = repos.validateSubdomain(req.body.subdomain, repo.id);
    q.run('UPDATE repos SET subdomain = ? WHERE id = ?', sub, repo.id);
    audit(req.user.id, 'repo.subdomain', `${repo.name}: ${repo.subdomain} -> ${sub}`);
    // Redeploy so APP_URL inside the container matches the new address.
    if (repo.current_container) await builder.deployHead({ ...repo, subdomain: sub }, 'subdomain-change', req.user.id);
  }
  res.json(repos.describe(q.get('SELECT * FROM repos WHERE id = ?', repo.id), req.user));
}));

router.delete('/repos/:id', wrap(async (req, res) => {
  const repo = loadRepo(req);
  await repos.remove(repo, req.user);
  res.json({ ok: true });
}));

router.post('/repos/:id/deploy', wrap(async (req, res) => {
  const repo = loadRepo(req);
  const id = await builder.deployHead(repo, req.body.retry ? 'retry' : 'manual', req.user.id);
  audit(req.user.id, 'deploy.manual', `${repo.name} #${id}`);
  res.json({ deploymentId: id });
}));

router.get('/repos/:id/deployments', wrap(async (req, res) => {
  const repo = loadRepo(req);
  res.json(q.all(`SELECT d.*, u.name AS triggered_by_name FROM deployments d LEFT JOIN users u ON u.id = d.triggered_by
    WHERE d.repo_id = ? ORDER BY d.id DESC LIMIT 100`, repo.id));
}));

router.get('/repos/:id/deployments/:dep/log', wrap(async (req, res) => {
  const repo = loadRepo(req);
  const dep = q.get('SELECT * FROM deployments WHERE id = ? AND repo_id = ?', Number(req.params.dep), repo.id);
  if (!dep) throw httpError(404, 'Deployment not found');
  const file = builder.logFile(dep.id);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  res.json({ status: dep.status, log: text.length > 400_000 ? `...(truncated)\n${text.slice(-400_000)}` : text });
}));

router.get('/repos/:id/app-logs', wrap(async (req, res) => {
  const repo = loadRepo(req);
  if (!repo.current_container) return res.json({ log: '', note: 'No running deployment.' });
  const text = await docker.logs(repo.current_container, Math.min(Number(req.query.tail) || 500, 5000));
  res.json({ log: text || '', container: repo.current_container });
}));

// ---- environment variables -------------------------------------------------

const RESERVED_ENV = new Set(['PORT', 'HOST', 'WS_INTERNAL_HOST', 'WS_BASE_DOMAIN']);

router.get('/repos/:id/env', wrap(async (req, res) => {
  const repo = loadRepo(req);
  res.json(q.all('SELECT key, value FROM env_vars WHERE repo_id = ? ORDER BY key', repo.id));
}));

router.put('/repos/:id/env', wrap(async (req, res) => {
  const repo = loadRepo(req);
  const vars = Array.isArray(req.body.vars) ? req.body.vars : [];
  for (const v of vars) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(v.key || '')) throw httpError(400, `Invalid variable name "${v.key}"`);
    if (RESERVED_ENV.has(v.key)) throw httpError(400, `${v.key} is set by the platform`);
  }
  tx(() => {
    q.run('DELETE FROM env_vars WHERE repo_id = ?', repo.id);
    for (const v of vars) q.run('INSERT INTO env_vars(repo_id, key, value) VALUES(?,?,?)', repo.id, v.key, String(v.value ?? ''));
  });
  audit(req.user.id, 'repo.env', `${repo.name}: ${vars.map((v) => v.key).join(', ')}`);
  res.json({ ok: true });
}));

// ---- database (scoped to the repository's own database) --------------------

router.get('/repos/:id/db/credentials', wrap(async (req, res) => {
  const repo = loadRepo(req);
  res.json({
    host: config.MYSQL_HOST, port: 3306, externalHost: config.BASE_DOMAIN, externalPort: config.MYSQL_PUBLIC_PORT,
    database: repo.db_name, username: repo.db_user, password: repo.db_pass, phpMyAdmin: config.PMA_URL,
  });
}));

router.get('/repos/:id/db/tables', wrap(async (req, res) => res.json(await mysql.listTables(loadRepo(req)))));

router.get('/repos/:id/db/tables/:table', wrap(async (req, res) => {
  res.json(await mysql.tableRows(loadRepo(req), req.params.table, 200));
}));

router.post('/repos/:id/db/query', wrap(async (req, res) => {
  const repo = loadRepo(req);
  try {
    res.json(await mysql.query(repo, String(req.body.sql || '')));
  } catch (e) {
    throw httpError(400, e.message);
  }
}));

// ---- web IDE ---------------------------------------------------------------

router.get('/repos/:id/commits', wrap(async (req, res) => res.json(await git.log(bareOf(loadRepo(req)), 'main', 200))));

router.get('/repos/:id/tree', wrap(async (req, res) => {
  res.json(await git.listFiles(bareOf(loadRepo(req)), req.query.ref || 'main'));
}));

router.get('/repos/:id/file', wrap(async (req, res) => {
  res.json(await git.readFile(bareOf(loadRepo(req)), req.query.ref || 'main', req.query.path));
}));

router.post('/repos/:id/commit', wrap(async (req, res) => {
  const repo = loadRepo(req, { write: 'owner' });
  const changes = (req.body.changes || []).map((c) => ({ path: git.safePath(c.path), content: c.delete ? null : String(c.content ?? '') }));
  if (!changes.length) throw httpError(400, 'Nothing to commit');
  const sha = await git.commitChanges(bareOf(repo), changes, req.body.message, req.user.name);
  if (!sha) return res.json({ sha: null, note: 'No changes' });
  const info = await git.commitInfo(bareOf(repo), sha);
  const dep = builder.enqueue(repo, { sha, message: info && info.message, trigger: 'web-ide', userId: req.user.id });
  audit(req.user.id, 'ide.commit', `${repo.name} ${sha.slice(0, 7)}`);
  res.json({ sha, deploymentId: dep });
}));

// ---- trainer console -------------------------------------------------------

/**
 * Assessment marks (no score / rank), trainer-only - never sent to competitors.
 * Each trainer marks each repository separately; the mark keeps the commit that was assessed.
 * A competitor is "assessed" when every one of their repositories has at least one trainer's mark.
 */
function repoMarks(repoId) {
  return q.all(`SELECT a.trainer_id AS trainerId, u.name AS trainer, a.commit_sha AS sha, a.created_at AS at
    FROM repo_assessments a LEFT JOIN users u ON u.id = a.trainer_id WHERE a.repo_id = ? ORDER BY a.created_at`, repoId);
}
function competitorAssessment(userId, viewerId) {
  const rs = q.all('SELECT id FROM repos WHERE user_id = ?', userId);
  const repos = {};
  let done = 0;
  let mine = 0;
  for (const r of rs) {
    repos[r.id] = repoMarks(r.id);
    if (repos[r.id].length) done++;
    if (repos[r.id].some((m) => m.trainerId === viewerId)) mine++;
  }
  const total = rs.length;
  const state = !total ? 'none' : done === total ? 'assessed' : done ? 'partial' : 'not';
  return { state, done, total, mine, repos };
}

router.get('/competitors', staff, wrap(async (req, res) => {
  const users = q.all("SELECT * FROM users WHERE role = 'competitor' ORDER BY name");
  res.json(users.map((u) => {
    const rs = q.all('SELECT * FROM repos WHERE user_id = ?', u.id);
    const lastPush = q.get(`SELECT d.created_at, d.commit_msg, d.status, r.name AS repo FROM deployments d JOIN repos r ON r.id = d.repo_id
      WHERE r.user_id = ? ORDER BY d.id DESC LIMIT 1`, u.id);
    return {
      ...publicUser(u),
      repos: rs.map((r) => repos.describe(r, req.user)).map(({ id, name, status, url }) => ({ id, name, status, url })),
      lastPush,
      assessment: competitorAssessment(u.id, req.user.id),
    };
  }));
}));

// A trainer marks / unmarks ONE repository as assessed by themselves (records the current commit).
router.put('/repos/:id/assessment', staff, wrap(async (req, res) => {
  const repo = loadRepo(req);
  if (req.body.assessed) {
    const sha = await git.headSha(bareOf(repo));
    q.run(`INSERT INTO repo_assessments(repo_id, trainer_id, commit_sha, created_at) VALUES(?,?,?,?)
      ON CONFLICT(repo_id, trainer_id) DO UPDATE SET commit_sha = excluded.commit_sha, created_at = excluded.created_at`,
      repo.id, req.user.id, sha, now());
  } else {
    q.run('DELETE FROM repo_assessments WHERE repo_id = ? AND trainer_id = ?', repo.id, req.user.id);
  }
  audit(req.user.id, req.body.assessed ? 'assessment.done' : 'assessment.undone', `repo ${repo.name} (#${repo.id})`);
  res.json({ marks: repoMarks(repo.id), competitor: competitorAssessment(repo.user_id, req.user.id) });
}));

router.get('/competitors/:id/history', staff, wrap(async (req, res) => {
  res.json(q.all(`SELECT d.id, d.commit_sha, d.commit_msg, d.status, d.trigger, d.error, d.created_at, d.finished_at, r.name AS repo, r.id AS repo_id
    FROM deployments d JOIN repos r ON r.id = d.repo_id WHERE r.user_id = ? ORDER BY d.id DESC LIMIT 300`, Number(req.params.id)));
}));

router.get('/users', staff, (req, res) => {
  const roles = req.user.role === 'admin' ? ['competitor', 'trainer', 'admin'] : ['competitor'];
  res.json(q.all(`SELECT * FROM users WHERE role IN (${roles.map(() => '?').join(',')}) ORDER BY role, name`, ...roles).map(publicUser));
});

router.post('/users', staff, wrap(async (req, res) => {
  const role = req.body.role || 'competitor';
  if (role !== 'competitor' && req.user.role !== 'admin') throw httpError(403, 'Only administrators can create staff accounts');
  const { id, code } = auth.createUser({ role, name: req.body.name });
  audit(req.user.id, 'user.create', `${role} ${req.body.name} (#${id})`);
  res.status(201).json({ user: publicUser(q.get('SELECT * FROM users WHERE id = ?', id)), accessCode: code });
}));

function staffTarget(req) {
  const u = q.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw httpError(404, 'User not found');
  if (u.role !== 'competitor' && req.user.role !== 'admin') throw httpError(403, 'Forbidden');
  return u;
}

router.post('/users/:id/reset-code', staff, wrap(async (req, res) => {
  const u = staffTarget(req);
  const code = auth.resetAccessCode(u.id);
  audit(req.user.id, 'user.reset_code', `${u.name} (#${u.id})`);
  res.json({ accessCode: code });
}));

router.post('/users/:id/rotate-git', staff, wrap(async (req, res) => {
  const u = staffTarget(req);
  auth.rotateGitPassword(u.id);
  audit(req.user.id, 'user.rotate_git', `${u.name} (#${u.id})`);
  res.json({ ok: true });
}));

router.delete('/users/:id', adminOnly, wrap(async (req, res) => {
  const u = staffTarget(req);
  if (u.id === req.user.id) throw httpError(400, 'You cannot delete yourself');
  for (const r of q.all('SELECT * FROM repos WHERE user_id = ?', u.id)) await repos.remove(r, req.user);
  q.run('DELETE FROM users WHERE id = ?', u.id);
  audit(req.user.id, 'user.delete', `${u.role} ${u.name} (#${u.id})`);
  res.json({ ok: true });
}));

// ---- push feed (visible to every logged-in user) ---------------------------

// Commit messages of every competitor's pushes (git push and Web IDE commits), newest first.
// Only metadata is shared (who, repository, message, status) - never code or credentials.
router.get('/pushes', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(q.all(`SELECT d.id, d.commit_sha AS sha, d.commit_msg AS message, d.trigger, d.status, d.created_at AS createdAt,
      r.name AS repo, u.name AS competitor, u.git_user AS gitUser
    FROM deployments d JOIN repos r ON r.id = d.repo_id JOIN users u ON u.id = r.user_id
    WHERE d.trigger IN ('push', 'web-ide') ORDER BY d.id DESC LIMIT ?`, limit));
});

// ---- announcements ---------------------------------------------------------

router.get('/announcements', (req, res) => {
  res.json(q.all('SELECT a.*, u.name AS author FROM announcements a LEFT JOIN users u ON u.id = a.author_id ORDER BY a.id DESC LIMIT 50'));
});

router.post('/announcements', staff, wrap(async (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) throw httpError(400, 'Announcement is empty');
  q.run('INSERT INTO announcements(body, author_id, created_at) VALUES(?,?,?)', body, req.user.id, now());
  res.status(201).json({ ok: true });
}));

router.delete('/announcements/:id', staff, (req, res) => {
  q.run('DELETE FROM announcements WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

// ---- administration --------------------------------------------------------

// Every account's access code and git password, readable by administrators at any time.
// Accounts created before credentials were stored encrypted show null until reset/rotated.
router.get('/admin/credentials', adminOnly, (req, res) => {
  const rows = q.all('SELECT * FROM users ORDER BY role, name').map((u) => ({
    ...publicUser(u),
    accessCode: auth.unseal(u.code_enc),
    gitPassword: u.role === 'competitor' ? auth.unseal(u.git_pass_enc) : undefined,
  }));
  audit(req.user.id, 'credentials.view', `${rows.length} accounts`);
  res.json(rows);
});

// Competition timer (administrators only)
router.get('/admin/timer', adminOnly, (req, res) => {
  res.json({
    ...timer.state(),
    competitors: q.all("SELECT id, name, extra_seconds AS extraSeconds FROM users WHERE role = 'competitor' ORDER BY name"),
  });
});

router.post('/admin/timer/:action', adminOnly, (req, res) => {
  const st = timer.control(req.params.action, req.body || {});
  audit(req.user.id, `timer.${req.params.action}`, JSON.stringify(req.body || {}));
  res.json(st);
});

router.put('/admin/competitors/:id/extra-time', adminOnly, (req, res) => {
  const r = timer.setExtra(Number(req.params.id), req.body || {});
  audit(req.user.id, 'timer.extra', `${r.name}: ${Math.round(r.extraSeconds / 60)} min extra`);
  res.json(r);
});

// Trainer locations: on the floor / in the marking room / off duty (null)
router.get('/admin/trainers', adminOnly, (req, res) => res.json(trainerBoard()));

router.put('/admin/trainers/:id/location', adminOnly, (req, res) => {
  const u = q.get("SELECT * FROM users WHERE id = ? AND role = 'trainer'", Number(req.params.id));
  if (!u) throw httpError(404, 'Trainer not found');
  const loc = req.body.location || null;
  if (loc !== null && !LOCATIONS.includes(loc)) throw httpError(400, 'Location must be "floor", "marking" or null');
  q.run('UPDATE users SET location = ?, location_at = ? WHERE id = ?', loc, loc ? now() : null, u.id);
  audit(req.user.id, 'trainer.location', `${u.name} -> ${loc || 'off duty'}`);
  res.json(trainerBoard().find((t) => t.id === u.id));
});

router.get('/admin/templates', adminOnly, (req, res) => res.json(templates.list()));

router.patch('/admin/templates/:id', adminOnly, (req, res) => {
  if (!templates.get(req.params.id)) throw httpError(404, 'Template not found');
  templates.setEnabled(req.params.id, !!req.body.enabled);
  audit(req.user.id, 'template.toggle', `${req.params.id} enabled=${!!req.body.enabled}`);
  res.json({ ok: true });
});

router.get('/admin/infra', adminOnly, wrap(async (req, res) => {
  res.json({
    docker: await docker.version(),
    mysql: await mysql.status(),
    builder: builder.stats(),
    containers: await docker.appContainers(),
    settings: {
      buildConcurrency: Number(getSetting('buildConcurrency', config.BUILD_CONCURRENCY)),
      idleMinutes: Number(getSetting('idleMinutes', config.IDLE_MINUTES)),
    },
    baseDomain: config.BASE_DOMAIN,
    dashboardUrl: config.DASHBOARD_URL,
    counts: {
      competitors: q.get("SELECT COUNT(*) n FROM users WHERE role='competitor'").n,
      repos: q.get('SELECT COUNT(*) n FROM repos').n,
      deployments: q.get('SELECT COUNT(*) n FROM deployments').n,
    },
  });
}));

router.put('/admin/settings', adminOnly, (req, res) => {
  if (req.body.buildConcurrency !== undefined) setSetting('buildConcurrency', Math.max(1, Math.min(16, Number(req.body.buildConcurrency) || 1)));
  if (req.body.idleMinutes !== undefined) setSetting('idleMinutes', Math.max(0, Number(req.body.idleMinutes) || 0));
  audit(req.user.id, 'settings.update', JSON.stringify(req.body));
  res.json({ ok: true });
});

router.get('/admin/audit', adminOnly, (req, res) => {
  res.json(q.all('SELECT a.*, u.name AS user FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500'));
});

router.get('/admin/deployments', adminOnly, (req, res) => {
  res.json(q.all(`SELECT d.id, d.status, d.commit_sha, d.commit_msg, d.created_at, d.finished_at, d.error, r.name AS repo, u.name AS owner
    FROM deployments d JOIN repos r ON r.id = d.repo_id JOIN users u ON u.id = r.user_id ORDER BY d.id DESC LIMIT 300`));
});

// ---- errors ----------------------------------------------------------------

// Unknown API paths are a JSON 404 (not the dashboard page)
router.use((req, res) => res.status(404).json({ error: 'Not found' }));

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: err.message || 'Server error' });
});

module.exports = router;
