// Repository lifecycle: create from template (with its own database), delete, describe.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { q, tx, audit } = require('./db');
const git = require('./git');
const mysql = require('./mysql');
const docker = require('./docker');
const templates = require('./templates');
const builder = require('./builder');
const proxy = require('./proxy');
const { randomLower, randomString, now, httpError } = require('./util');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

function validateSubdomain(sub, exceptRepoId) {
  sub = String(sub || '').toLowerCase().trim();
  if (!NAME_RE.test(sub)) throw httpError(400, 'Subdomain: 2-40 chars, lowercase letters, digits and dashes');
  if (config.RESERVED_SUBDOMAINS.has(sub)) throw httpError(400, `"${sub}" is reserved`);
  const taken = q.get('SELECT id FROM repos WHERE subdomain = ?', sub);
  if (taken && taken.id !== exceptRepoId) throw httpError(409, `Subdomain "${sub}" is already taken`);
  return sub;
}

async function create(owner, { name, template, subdomain }, actor) {
  if (owner.role !== 'competitor') throw httpError(400, 'Repositories belong to competitor accounts');
  name = String(name || '').toLowerCase().trim();
  if (!NAME_RE.test(name)) throw httpError(400, 'Name: 2-40 chars, lowercase letters, digits and dashes');
  if (q.get('SELECT 1 FROM repos WHERE user_id = ? AND name = ?', owner.id, name)) throw httpError(409, 'You already have a repository with that name');
  subdomain = validateSubdomain(subdomain || `${name}-${owner.git_user}`);
  const tpl = templates.get(template);
  if (!tpl || !tpl.enabled) throw httpError(400, 'Unknown or disabled template');

  // One database + one MySQL user per repository (never shared across an account).
  const suffix = randomLower(10);
  const db = { dbName: `ws_${suffix}`, dbUser: `ws_${suffix}`, dbPass: randomString(24) };
  await mysql.provision(db.dbName, db.dbUser, db.dbPass);

  const bare = git.repoPath(owner.git_user, name);
  const work = fs.mkdtempSync(path.join(config.TMP_DIR, 'scaffold-'));
  try {
    await templates.scaffold(template, { repoName: name, appUrl: config.appUrl(subdomain), ...db }, work);
    await git.initBareFromDir(bare, work, `Initial commit from the ${tpl.name} template`);
  } catch (e) {
    await mysql.drop(db.dbName, db.dbUser).catch(() => {});
    fs.rmSync(bare, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  const r = q.run(`INSERT INTO repos(user_id, name, template, subdomain, db_name, db_user, db_pass, created_at)
    VALUES(?,?,?,?,?,?,?,?)`, owner.id, name, template, subdomain, db.dbName, db.dbUser, db.dbPass, now());
  audit(actor.id, 'repo.create', `${owner.git_user}/${name} (${template})`);
  return q.get('SELECT * FROM repos WHERE id = ?', r.id);
}

async function remove(repo, actor) {
  const owner = q.get('SELECT git_user FROM users WHERE id = ?', repo.user_id);
  const deps = q.all('SELECT id, container, image FROM deployments WHERE repo_id = ?', repo.id);
  tx(() => {
    q.run('DELETE FROM repos WHERE id = ?', repo.id);
  });
  for (const d of deps) {
    if (d.container) await docker.rmForce(d.container);
    if (d.image) await docker.rmImage(d.image);
    fs.rmSync(builder.logFile(d.id), { force: true });
  }
  await mysql.drop(repo.db_name, repo.db_user).catch((e) => console.error('[repos] drop db', e.message));
  fs.rmSync(git.repoPath(owner.git_user, repo.name), { recursive: true, force: true });
  audit(actor.id, 'repo.delete', `${owner.git_user}/${repo.name}`);
}

function displayStatus(repo, latest) {
  if (!latest) return { state: 'awaiting', label: 'Awaiting first push' };
  switch (latest.status) {
    case 'queued': return { state: 'queued', label: 'Queued', queue: builder.queueInfo(latest.id) };
    case 'building': return { state: 'building', label: 'Building' };
    case 'failed': return { state: 'failed', label: 'Failed', error: latest.error, previousLive: !!repo.current_container };
    default:
      return repo.current_container
        ? { state: 'running', label: proxy.isSleeping(repo.id) ? 'Running (idle - wakes on request)' : 'Running' }
        : { state: 'awaiting', label: 'Not running' };
  }
}

function describe(repo, viewer) {
  const owner = q.get('SELECT id, name, git_user FROM users WHERE id = ?', repo.user_id);
  const latest = q.get('SELECT * FROM deployments WHERE repo_id = ? ORDER BY id DESC LIMIT 1', repo.id);
  const live = repo.current_deployment_id ? q.get('SELECT * FROM deployments WHERE id = ?', repo.current_deployment_id) : null;
  const tpl = templates.get(repo.template);
  return {
    id: repo.id,
    name: repo.name,
    owner,
    template: repo.template,
    templateName: tpl ? tpl.name : repo.template,
    subdomain: repo.subdomain,
    url: config.appUrl(repo.subdomain),
    gitRemote: git.remoteUrl(owner.git_user, repo.name),
    status: displayStatus(repo, latest),
    latestDeployment: latest && { id: latest.id, sha: latest.commit_sha, message: latest.commit_msg, status: latest.status, createdAt: latest.created_at, finishedAt: latest.finished_at },
    liveDeployment: live && { id: live.id, sha: live.commit_sha, message: live.commit_msg, finishedAt: live.finished_at },
    canEditCode: viewer.id === repo.user_id,
    createdAt: repo.created_at,
  };
}

module.exports = { create, remove, describe, validateSubdomain };
