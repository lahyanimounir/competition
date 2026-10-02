// Build queue and deploy pipeline.
// push -> queued -> building (docker build from `git archive`) -> start new container ->
// wait until it listens -> switch traffic -> remove the old container.
// A failed build or start never touches the previous working deployment.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const config = require('./config');
const { q, getSetting, audit } = require('./db');
const git = require('./git');
const docker = require('./docker');
const proxy = require('./proxy');
const { now } = require('./util');

const queue = []; // deployment ids waiting for a worker
const active = new Set();

const concurrency = () => Math.max(1, Number(getSetting('buildConcurrency', config.BUILD_CONCURRENCY)));
const logFile = (id) => path.join(config.LOG_DIR, `deploy-${id}.log`);

function avgBuildSeconds() {
  const rows = q.all(`SELECT (julianday(finished_at) - julianday(started_at)) * 86400 AS d FROM deployments
    WHERE status IN ('running','superseded') AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 20`);
  if (!rows.length) return 90;
  return rows.reduce((s, r) => s + r.d, 0) / rows.length;
}

/** Position in the queue and estimated wait, so a queued build never looks like a stall. */
function queueInfo(deploymentId) {
  const i = queue.indexOf(deploymentId);
  if (i < 0) return null;
  const position = i + 1;
  const slotsAhead = Math.floor(i / concurrency()) + (active.size >= concurrency() ? 1 : 0);
  return { position, etaSeconds: Math.round(slotsAhead * avgBuildSeconds()) };
}

function enqueue(repo, { sha, message, trigger, userId }) {
  const r = q.run(`INSERT INTO deployments(repo_id, commit_sha, commit_msg, trigger, triggered_by, status, created_at)
    VALUES(?,?,?,?,?,'queued',?)`, repo.id, sha, message || '', trigger, userId, now());
  queue.push(r.id);
  pump();
  return r.id;
}

/** Redeploy the current head of main. */
async function deployHead(repo, trigger, userId) {
  const owner = q.get('SELECT git_user FROM users WHERE id = ?', repo.user_id);
  const bare = git.repoPath(owner.git_user, repo.name);
  const sha = await git.headSha(bare);
  if (!sha) throw new Error('Repository has no commits on main');
  const info = await git.commitInfo(bare, sha);
  return enqueue(repo, { sha, message: info && info.message, trigger, userId });
}

function pump() {
  while (active.size < concurrency() && queue.length) {
    const id = queue.shift();
    active.add(id);
    runDeploy(id).catch((e) => console.error('[builder]', e)).finally(() => { active.delete(id); pump(); });
  }
}

function buildImage(bare, sha, image, buildArgs, log) {
  return new Promise((resolve) => {
    const archive = spawn('git', ['--git-dir', bare, 'archive', '--format=tar', sha]);
    const build = spawn('docker', ['build', '--progress=plain', '-t', image, ...buildArgs, '-']);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; log(`!! Build timed out after ${config.BUILD_TIMEOUT_MS / 60000} minutes`); build.kill('SIGKILL'); }, config.BUILD_TIMEOUT_MS);
    archive.stdout.pipe(build.stdin);
    archive.stderr.on('data', (d) => log(d.toString()));
    build.stdout.on('data', (d) => log(d.toString()));
    build.stderr.on('data', (d) => log(d.toString()));
    build.on('error', (e) => { log(`!! ${e.message}`); });
    build.on('close', (code) => { clearTimeout(timer); resolve(timedOut ? 'timeout' : code); });
  });
}

function tcpCheck(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

async function waitListening(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await docker.isRunning(name);
    if (!st.exists) throw new Error('Container disappeared while starting');
    if (!st.running) throw new Error(`Container exited with code ${st.exitCode} before it started listening on $PORT`);
    if (await tcpCheck(name, config.APP_PORT)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`App did not start listening on $PORT (${config.APP_PORT}) within ${timeoutMs / 1000}s`);
}

function runtimeEnv(repo, containerName) {
  const custom = q.all('SELECT key, value FROM env_vars WHERE repo_id = ? ORDER BY key', repo.id);
  const url = config.appUrl(repo.subdomain);
  const base = {
    PORT: String(config.APP_PORT),
    HOST: '0.0.0.0',
    WS_INTERNAL_HOST: containerName,
    WS_BASE_DOMAIN: config.BASE_DOMAIN,
    PUBLIC_URL: url,
    APP_URL: url,
    NODE_ENV: 'production',
    DB_CONNECTION: 'mysql',
    DB_HOST: config.MYSQL_HOST,
    DB_PORT: '3306',
    DB_DATABASE: repo.db_name,
    DB_USERNAME: repo.db_user,
    DB_PASSWORD: repo.db_pass,
    DATABASE_URL: `mysql://${repo.db_user}:${encodeURIComponent(repo.db_pass)}@${config.MYSQL_HOST}:3306/${repo.db_name}`,
  };
  for (const { key, value } of custom) base[key] = value;
  return { env: base, custom };
}

async function runDeploy(id) {
  const dep = q.get('SELECT * FROM deployments WHERE id = ?', id);
  if (!dep) return;
  const repo = q.get('SELECT r.*, u.git_user FROM repos r JOIN users u ON u.id = r.user_id WHERE r.id = ?', dep.repo_id);
  if (!repo) {
    q.run("UPDATE deployments SET status='failed', error='Repository deleted', finished_at=? WHERE id=?", now(), id);
    return;
  }
  const out = fs.createWriteStream(logFile(id), { flags: 'a' });
  const log = (s) => out.write(s.endsWith('\n') ? s : `${s}\n`);
  const bare = git.repoPath(repo.git_user, repo.name);
  const image = `ws-app-${repo.id}:${id}`;
  const name = `ws-app-${repo.id}-${id}`;
  q.run("UPDATE deployments SET status='building', started_at=?, image=?, container=? WHERE id=?", now(), image, name, id);

  try {
    log(`==> Deployment #${id} of ${repo.git_user}/${repo.name} at ${dep.commit_sha.slice(0, 7)} "${dep.commit_msg || ''}"`);
    const { env, custom } = runtimeEnv(repo, name);
    // Custom variables are also available at build time (e.g. VITE_API_URL for front-end builds).
    const buildArgs = custom.flatMap(({ key, value }) => ['--build-arg', `${key}=${value}`]);
    if (config.NPM_MAXSOCKETS) {
      buildArgs.push('--build-arg', `NPM_CONFIG_MAXSOCKETS=${config.NPM_MAXSOCKETS}`,
        '--build-arg', `COMPOSER_MAX_PARALLEL_HTTP=${config.NPM_MAXSOCKETS}`);
    }
    log('==> Building container image (install dependencies, build step, image)');
    const code = await buildImage(bare, dep.commit_sha, image, buildArgs, log);
    if (code === 'timeout') throw new Error(`Image build timed out after ${config.BUILD_TIMEOUT_MS / 60000} minutes (often a stalled npm/composer download - see NPM_MAXSOCKETS in the README).`);
    if (code !== 0) throw new Error(`Image build failed (exit code ${code}). See the build output above.`);

    log(`==> Starting container ${name}`);
    const envFile = path.join(config.TMP_DIR, `${name}.env`);
    fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, ' ')}`).join('\n'), { mode: 0o600 });
    let r;
    try {
      r = await docker.docker(['run', '-d', '--name', name, '--hostname', name, '--network', config.DOCKER_NETWORK,
        '--env-file', envFile, '--restart', 'unless-stopped', '--memory', '1g',
        '--label', `ws.repo=${repo.id}`, '--label', `ws.deployment=${id}`, image]);
    } finally {
      fs.rmSync(envFile, { force: true });
    }
    if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim()}`);

    log(`==> Waiting for the app to listen on $PORT (${config.APP_PORT})...`);
    await waitListening(name, config.START_TIMEOUT_MS);

    // Switch traffic to the new container, then retire the old one.
    const current = q.get('SELECT current_container, current_deployment_id FROM repos WHERE id = ?', repo.id);
    if (!current) throw new Error('Repository was deleted during the deployment');
    q.run('UPDATE repos SET current_container=?, current_deployment_id=? WHERE id=?', name, id, repo.id);
    q.run("UPDATE deployments SET status='superseded' WHERE repo_id=? AND status='running' AND id<>?", repo.id, id);
    q.run("UPDATE deployments SET status='running', finished_at=? WHERE id=?", now(), id);
    proxy.markAwake(repo.id);
    log(`==> Live at ${config.appUrl(repo.subdomain)}`);
    if (current.current_container && current.current_container !== name) {
      const prev = q.get('SELECT image FROM deployments WHERE id = ?', current.current_deployment_id);
      await docker.rmForce(current.current_container);
      if (prev && prev.image) await docker.rmImage(prev.image);
    }
  } catch (e) {
    log(`\n!! DEPLOY FAILED: ${e.message}`);
    const appOut = await docker.logs(name, 200);
    if (appOut) log(`--- application output (last 200 lines) ---\n${appOut}`);
    await docker.rmForce(name);
    await docker.rmImage(image);
    q.run("UPDATE deployments SET status='failed', error=?, finished_at=? WHERE id=?", e.message, now(), id);
    const still = q.get('SELECT current_container FROM repos WHERE id = ?', repo.id);
    if (still && still.current_container) log('==> The previous deployment is still live and serving traffic.');
    audit(repo.user_id, 'deploy.failed', `${repo.name} #${id}: ${e.message}`);
  } finally {
    out.end();
  }
}

/** On platform start: re-queue jobs that never started, fail ones interrupted mid-build. */
async function recover() {
  for (const d of q.all("SELECT id FROM deployments WHERE status='building'")) {
    fs.appendFileSync(logFile(d.id), '\n!! Interrupted by a platform restart. Use Retry to deploy again.\n');
    q.run("UPDATE deployments SET status='failed', error='Interrupted by platform restart', finished_at=? WHERE id=?", now(), d.id);
    await docker.rmForce(`ws-app-${q.get('SELECT repo_id FROM deployments WHERE id=?', d.id).repo_id}-${d.id}`);
  }
  for (const repo of q.all('SELECT id, current_container FROM repos WHERE current_container IS NOT NULL')) {
    const st = await docker.isRunning(repo.current_container);
    if (!st.exists) q.run('UPDATE repos SET current_container=NULL, current_deployment_id=NULL WHERE id=?', repo.id);
  }
  for (const d of q.all("SELECT id FROM deployments WHERE status='queued' ORDER BY id")) queue.push(d.id);
  pump();
}

function stats() {
  return { queued: queue.length, building: active.size, concurrency: concurrency(), avgBuildSeconds: Math.round(avgBuildSeconds()) };
}

module.exports = { enqueue, deployHead, queueInfo, recover, stats, logFile };
