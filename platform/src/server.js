const http = require('http');
const express = require('express');
const config = require('./config');
const { q } = require('./db');
const auth = require('./auth');
const git = require('./git');
const mysql = require('./mysql');
const builder = require('./builder');
const proxy = require('./proxy');
const api = require('./api');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

// Git smart HTTP must see the raw request body, so it is mounted before any body parser.
app.use('/git', git.smartHttp(async (repo, sha, user) => {
  const info = await git.commitInfo(git.repoPath(user.git_user, repo.name), sha);
  builder.enqueue(repo, { sha, message: info && info.message, trigger: 'push', userId: user.id });
}));

app.use('/api', express.json({ limit: '5mb' }), api);
app.use(express.static(config.PUBLIC_DIR, { index: 'index.html' }));
app.get('*', (req, res) => res.sendFile('index.html', { root: config.PUBLIC_DIR }));

const server = http.createServer((req, res) => {
  const sub = proxy.subdomainOf(req.headers.host);
  if (sub) return proxy.handle(req, res, sub).catch((e) => { console.error('[proxy]', e); res.statusCode = 502; res.end('Bad gateway'); });
  app(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const sub = proxy.subdomainOf(req.headers.host);
  if (sub) return proxy.handleUpgrade(req, socket, head, sub);
  socket.destroy();
});

async function main() {
  auth.ensureAdmin();
  console.log('[platform] waiting for MySQL...');
  if (!(await mysql.waitReady(180))) console.error('[platform] MySQL is not reachable - repository creation will fail until it is.');
  await proxy.init();
  await builder.recover();
  server.listen(config.LISTEN_PORT, () => {
    console.log(`[platform] dashboard: ${config.DASHBOARD_URL}`);
    console.log(`[platform] apps:      ${config.appUrl('<subdomain>')}`);
    console.log(`[platform] users: ${q.get('SELECT COUNT(*) AS n FROM users').n}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
