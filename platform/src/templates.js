// Framework templates live in templates/<id>/ with a template.json and a files/ overlay.
// Tokens like __WS_DB_NAME__ in overlay files are replaced with the repository's values.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { getSetting, setSetting } = require('./db');
const { run, randomLower } = require('./util');

// Every dashboard poll describes each repository, so the list is cached briefly instead of
// re-reading template.json files from disk on every request.
let cache = null;
let cacheUntil = 0;
function list() {
  if (cache && cacheUntil > Date.now()) return cache;
  cache = readList();
  cacheUntil = Date.now() + 5000;
  return cache;
}

function readList() {
  if (!fs.existsSync(config.TEMPLATE_DIR)) return [];
  return fs.readdirSync(config.TEMPLATE_DIR)
    .filter((id) => fs.existsSync(path.join(config.TEMPLATE_DIR, id, 'template.json')))
    .map((id) => {
      const meta = JSON.parse(fs.readFileSync(path.join(config.TEMPLATE_DIR, id, 'template.json'), 'utf8'));
      const enabled = getSetting(`template.${id}.enabled`, meta.enabled === false ? '0' : '1') === '1';
      return { id, ...meta, enabled };
    })
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

const get = (id) => list().find((t) => t.id === id);
const setEnabled = (id, enabled) => { setSetting(`template.${id}.enabled`, enabled ? '1' : '0'); cache = null; };

function copyOverlay(src, dest, tokens) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyOverlay(from, to, tokens);
    } else {
      let content = fs.readFileSync(from);
      if (!content.includes(0)) {
        let text = content.toString('utf8').replace(/\r\n/g, '\n');
        for (const [k, v] of Object.entries(tokens)) text = text.split(`__WS_${k}__`).join(v);
        content = text;
      }
      fs.writeFileSync(to, content);
    }
  }
}

/** Laravel skeleton is fetched fresh with composer (inside a throwaway container). */
async function scaffoldLaravel(dest, log) {
  const name = `ws-scaffold-${randomLower(8)}`;
  log('Fetching the Laravel skeleton with composer (first time can take a minute)...');
  const r = await run('docker', ['run', '--name', name, 'composer:2', 'create-project', 'laravel/laravel', '/app',
    '--prefer-dist', '--no-install', '--no-scripts', '--no-interaction', '--no-progress'], { timeout: 10 * 60 * 1000 });
  try {
    if (r.code !== 0) throw new Error(`composer create-project failed: ${(r.stderr || r.stdout).slice(-1500)}`);
    const cp = await run('sh', ['-c', `docker cp ${name}:/app - | tar -x -C "${dest}" --strip-components=1`]);
    if (cp.code !== 0) throw new Error(`Copying the skeleton failed: ${cp.stderr}`);
  } finally {
    await run('docker', ['rm', '-f', name]);
  }
  // The production env file is meant to be committed (it holds this repository's own DB credentials).
  const gi = path.join(dest, '.gitignore');
  if (fs.existsSync(gi)) {
    fs.writeFileSync(gi, fs.readFileSync(gi, 'utf8').split('\n').filter((l) => l.trim() !== '.env.production').join('\n'));
  }
}

async function scaffold(templateId, ctx, dest, log = () => {}) {
  const tpl = get(templateId);
  if (!tpl) throw new Error(`Unknown template ${templateId}`);
  if (tpl.scaffold === 'laravel') await scaffoldLaravel(dest, log);
  const tokens = {
    APP_NAME: ctx.repoName,
    APP_URL: ctx.appUrl,
    APP_KEY: `base64:${crypto.randomBytes(32).toString('base64')}`,
    BASE_DOMAIN: config.BASE_DOMAIN,
    DB_HOST: config.MYSQL_HOST,
    DB_PORT: '3306',
    DB_NAME: ctx.dbName,
    DB_USER: ctx.dbUser,
    DB_PASS: ctx.dbPass,
  };
  copyOverlay(path.join(config.TEMPLATE_DIR, templateId, 'files'), dest, tokens);
}

module.exports = { list, get, setEnabled, scaffold };
