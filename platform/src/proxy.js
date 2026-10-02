// Subdomain router: <subdomain>.<BASE_DOMAIN> -> that repository's current container.
// Also scales idle containers to zero and wakes them on the next request.
const httpProxy = require('http-proxy');
const net = require('net');
const config = require('./config');
const { q, getSetting } = require('./db');
const docker = require('./docker');

const proxy = httpProxy.createProxyServer({ xfwd: true, ws: true, proxyTimeout: 300_000 });
proxy.on('error', () => {}); // handled per request

const lastSeen = new Map();
const sleeping = new Set();
const waking = new Map();
const bootTime = Date.now();

function subdomainOf(hostHeader) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  const suffix = `.${config.BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;
  const sub = host.slice(0, -suffix.length);
  return sub && !sub.includes('.') ? sub : null;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(res, status, title, body, refresh) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f4f5f8;color:#1d2433;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{background:#fff;border:1px solid #dde1ea;border-radius:12px;padding:28px 32px;max-width:520px}h1{font-size:20px;margin:0 0 8px}
p{margin:0;color:#556}a{color:#2b5bd7}@media(prefers-color-scheme:dark){body{background:#12151c;color:#e6e9f0}main{background:#1b1f29;border-color:#2c3242}p{color:#a8afbf}}</style>
</head><body><main><h1>${esc(title)}</h1><p>${body}</p></main></body></html>`);
}

function tcpCheck(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1000 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

/** Start a stopped (scaled-to-zero) container and wait until it accepts connections. */
function wake(repo) {
  if (waking.has(repo.id)) return waking.get(repo.id);
  const p = (async () => {
    await docker.start(repo.current_container);
    for (let i = 0; i < 90; i++) {
      if (await tcpCheck(repo.current_container, config.APP_PORT)) { sleeping.delete(repo.id); return true; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  })().finally(() => waking.delete(repo.id));
  waking.set(repo.id, p);
  return p;
}

const markAwake = (repoId) => { sleeping.delete(repoId); lastSeen.set(repoId, Date.now()); };

function lookup(sub) {
  return q.get('SELECT * FROM repos WHERE subdomain = ?', sub);
}

function notDeployedPage(res, repo) {
  const latest = q.get('SELECT status FROM deployments WHERE repo_id = ? ORDER BY id DESC LIMIT 1', repo.id);
  if (latest && (latest.status === 'queued' || latest.status === 'building')) {
    return page(res, 503, 'Deploying…', 'This app is being built. This page refreshes automatically.', 3);
  }
  if (latest && latest.status === 'failed') {
    return page(res, 503, 'Deployment failed', 'The last deployment failed. Open the dashboard to view the build log and retry.');
  }
  return page(res, 503, 'Awaiting first push', 'Nothing is deployed here yet. Push to the <b>main</b> branch to deploy.');
}

async function handle(req, res, sub) {
  if (sub === 'pma') {
    return proxy.web(req, res, { target: `http://${config.PHPMYADMIN_HOST}:80` },
      () => page(res, 502, 'phpMyAdmin unavailable', 'The phpMyAdmin container is not reachable.'));
  }
  const repo = lookup(sub);
  if (!repo) return page(res, 404, 'No app here', `Nothing is registered at <b>${esc(sub)}.${esc(config.BASE_DOMAIN)}</b>.`);
  if (!repo.current_container) return notDeployedPage(res, repo);
  lastSeen.set(repo.id, Date.now());
  if (sleeping.has(repo.id)) {
    const ok = await wake(repo);
    if (!ok) return page(res, 503, 'Starting…', 'The app is waking up from idle. This page refreshes automatically.', 3);
  }
  proxy.web(req, res, { target: `http://${repo.current_container}:${config.APP_PORT}` }, (err) => {
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(err.code)) {
      sleeping.add(repo.id);
      wake(repo).catch(() => {});
      return page(res, 503, 'Starting…', 'The app is not answering yet (starting or waking up). This page refreshes automatically.', 3);
    }
    page(res, 502, 'Bad gateway', `The app did not respond correctly (${esc(err.code || err.message)}). Check the application logs on the dashboard.`);
  });
}

function handleUpgrade(req, socket, head, sub) {
  let target;
  if (sub === 'pma') target = `http://${config.PHPMYADMIN_HOST}:80`;
  else {
    const repo = lookup(sub);
    if (!repo || !repo.current_container || sleeping.has(repo.id)) return socket.destroy();
    lastSeen.set(repo.id, Date.now());
    target = `http://${repo.current_container}:${config.APP_PORT}`;
  }
  proxy.ws(req, socket, head, { target }, () => socket.destroy());
}

async function init() {
  for (const repo of q.all('SELECT id, current_container FROM repos WHERE current_container IS NOT NULL')) {
    const st = await docker.isRunning(repo.current_container);
    if (st.exists && !st.running) sleeping.add(repo.id);
  }
  setInterval(sweepIdle, 60_000).unref();
}

async function sweepIdle() {
  const minutes = Number(getSetting('idleMinutes', config.IDLE_MINUTES));
  if (!minutes || minutes <= 0) return;
  const cutoff = Date.now() - minutes * 60_000;
  for (const repo of q.all('SELECT id, current_container FROM repos WHERE current_container IS NOT NULL')) {
    if (sleeping.has(repo.id) || waking.has(repo.id)) continue;
    if ((lastSeen.get(repo.id) || bootTime) > cutoff) continue;
    const r = await docker.stop(repo.current_container);
    if (r.code === 0) sleeping.add(repo.id);
  }
}

const isSleeping = (repoId) => sleeping.has(repoId);

module.exports = { subdomainOf, handle, handleUpgrade, init, markAwake, isSleeping, wake };
