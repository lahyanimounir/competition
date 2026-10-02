const path = require('path');
const fs = require('fs');

const env = process.env;
const DATA_DIR = env.DATA_DIR || path.join(__dirname, '..', 'data');

const config = {
  DATA_DIR,
  REPO_DIR: path.join(DATA_DIR, 'repos'),
  LOG_DIR: path.join(DATA_DIR, 'logs'),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  DB_FILE: path.join(DATA_DIR, 'platform.db'),
  TEMPLATE_DIR: env.TEMPLATE_DIR || path.join(__dirname, '..', 'templates'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),

  BASE_DOMAIN: (env.BASE_DOMAIN || 'localtest.me').toLowerCase().replace(/^\.+|\.+$/g, ''),
  PUBLIC_PORT: String(env.PUBLIC_PORT || '80'),
  LISTEN_PORT: Number(env.LISTEN_PORT || 80),
  ADMIN_CODE: env.ADMIN_CODE || '',

  MYSQL_HOST: env.MYSQL_HOST || 'ws-mysql',
  MYSQL_PORT: Number(env.MYSQL_PORT || 3306),
  MYSQL_PUBLIC_PORT: String(env.MYSQL_PUBLIC_PORT || '3306'),
  MYSQL_ROOT_PASSWORD: env.MYSQL_ROOT_PASSWORD || '',
  PHPMYADMIN_HOST: env.PHPMYADMIN_HOST || 'ws-phpmyadmin',

  DOCKER_NETWORK: env.DOCKER_NETWORK || 'worldskills_net',
  BUILD_CONCURRENCY: Math.max(1, Number(env.BUILD_CONCURRENCY || 2)),
  IDLE_MINUTES: Number(env.IDLE_MINUTES ?? 30),
  // Lower on networks where many parallel downloads stall (VPNs, some proxies). Empty = tool defaults.
  NPM_MAXSOCKETS: env.NPM_MAXSOCKETS || '',
  BUILD_TIMEOUT_MS: 20 * 60 * 1000,
  START_TIMEOUT_MS: 180 * 1000,
  // Port every app container listens on (passed in as $PORT, never hardcoded by templates)
  APP_PORT: 8080,

  RESERVED_SUBDOMAINS: new Set(['pma', 'www', 'git', 'api', 'dashboard', 'admin', 'mysql', 'platform']),
};

const portSuffix = config.PUBLIC_PORT === '80' ? '' : `:${config.PUBLIC_PORT}`;
config.DASHBOARD_URL = `http://${config.BASE_DOMAIN}${portSuffix}`;
config.appUrl = (sub) => `http://${sub}.${config.BASE_DOMAIN}${portSuffix}`;
config.PMA_URL = config.appUrl('pma');

for (const dir of [config.DATA_DIR, config.REPO_DIR, config.LOG_DIR, config.TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = config;
