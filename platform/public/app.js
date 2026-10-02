'use strict';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const state = { me: null, platform: null, pending: null, timers: [], beforeLeave: null };

// Secrets are kept in memory and referenced by id, never placed in URLs or attributes.
const secrets = new Map();
let secretSeq = 0;
const secretRef = (value) => { const id = `s${++secretSeq}`; secrets.set(id, value); return id; };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login' && url !== '/api/me') { state.me = null; route(); }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = `toast${isErr ? ' err' : ''}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 2600);
}
const fail = (e) => toast(e.message || String(e), true);

function copyText(text) {
  // navigator.clipboard needs HTTPS; fall back to execCommand on plain-HTTP LAN addresses
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (!ok && navigator.clipboard) return navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', true));
  toast(ok ? 'Copied' : 'Copy failed', !ok);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy], [data-copy-secret]');
  if (!b) return;
  e.preventDefault();
  copyText(b.dataset.copy !== undefined ? b.dataset.copy : secrets.get(b.dataset.copySecret) || '');
});

const copyBtn = (value) => `<button class="btn sm" data-copy="${esc(value)}" title="Copy">Copy</button>`;
const copySecretBtn = (value) => `<button class="btn sm" data-copy-secret="${secretRef(value)}" title="Copy">Copy</button>`;

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtTime(iso);
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `~${sec}s`;
  return `~${Math.round(sec / 60)} min`;
}
const short = (sha) => (sha ? sha.slice(0, 7) : '');


function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
function every(ms, fn) { state.timers.push(setInterval(fn, ms)); }

function modal(html, { large = false } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal${large ? ' large' : ''}" role="dialog">${html}</div>`;
  document.body.append(bg);
  const close = () => bg.remove();
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  const first = $('input, textarea, select', bg);
  if (first) first.focus();
  return { el: bg, close };
}

function showOnce(title, label, value, note) {
  modal(`<h2>${esc(title)}</h2>
    <p class="muted">${esc(note || 'This is shown only once. Copy it now and hand it over securely.')}</p>
    <div class="row" style="margin:14px 0"><span class="mono" style="font-size:22px;letter-spacing:3px">${esc(value)}</span>${copySecretBtn(value)}</div>
    <p class="small muted">${esc(label)}</p>
    <div class="modal-actions"><button class="btn primary" data-close>Done</button></div>`);
}

// Deployment result of one push, as a pill
function deployPill(status) {
  const cls = status === 'running' || status === 'superseded' ? 'running' : status === 'failed' ? 'failed' : 'queued';
  return `<span class="pill ${cls}">${esc(status === 'superseded' ? 'deployed' : status)}</span>`;
}

// Live feed of every competitor's git push messages - visible to all users.
function mountPushFeed(el, { limit = 30 } = {}) {
  const draw = (list) => {
    if (!el.isConnected) return;
    el.innerHTML = `<div class="spread"><h2 style="margin:0">Recent pushes</h2><span class="small muted">all competitors · updates live</span></div>
      <div class="table-wrap" style="max-height:420px;margin-top:10px"><table>
      <thead><tr><th>When</th><th>Competitor</th><th>Repository</th><th>Commit message</th><th>Result</th></tr></thead><tbody>
      ${list.map((p) => `<tr><td class="small" title="${esc(fmtTime(p.createdAt))}">${ago(p.createdAt)}</td><td><b>${esc(p.competitor)}</b></td>
        <td class="mono small">${esc(p.repo)}</td>
        <td><span class="mono small muted">${short(p.sha)}</span> ${esc(p.message || '')}${p.trigger === 'web-ide' ? ' <span class="small muted">(Web IDE)</span>' : ''}</td>
        <td>${deployPill(p.status)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No pushes yet.</td></tr>'}
      </tbody></table></div>`;
  };
  const load = () => api('GET', `/api/pushes?limit=${limit}`).then(draw).catch(() => {});
  el.innerHTML = '<p class="muted">Loading pushes…</p>';
  load();
  every(5000, load);
}

// Assessment marks (no score / rank, trainer-only): per repository and per trainer.
// The competitor's status is derived: assessed when every repository has at least one trainer's mark.
function assessPill(a) {
  if (!a || a.state === 'none') return '<span class="pill">No repositories</span>';
  if (a.state === 'assessed') return `<span class="pill running">Assessed</span>`;
  if (a.state === 'partial') return `<span class="pill queued">Partly assessed ${a.done} / ${a.total}</span>`;
  return '<span class="pill">Not assessed</span>';
}
function marksHtml(repoId, marks) {
  if (!marks || !marks.length) return '<span class="small muted">Not assessed by any trainer yet.</span>';
  return marks.map((m) => `<div class="small">✓ <b>${esc(m.trainer || 'deleted trainer')}</b> · ${fmtTime(m.at)} · code
    ${m.sha ? `<a class="mono" href="#/ide/${repoId}?ref=${esc(m.sha)}" title="Open the code exactly as it was when assessed">${short(m.sha)}</a>` : '<span class="muted">(no commits)</span>'}</div>`).join('');
}
async function setRepoAssessed(repoId, assessed) {
  return api('PUT', `/api/repos/${repoId}/assessment`, { assessed });
}

function pill(status) { return `<span class="pill ${esc(status.state)}">${esc(status.label)}</span>`; }
function statusExtra(s) {
  if (s.state === 'queued') {
    return s.queue
      ? `<div class="small muted">Position ${s.queue.position} in the build queue · estimated wait ${fmtDur(s.queue.etaSeconds)}</div>`
      : '<div class="small muted">Waiting for a build worker…</div>';
  }
  if (s.state === 'building') return '<div class="small muted">Installing dependencies, building and starting the container…</div>';
  if (s.state === 'failed') return `<div class="err-text">${esc(s.error || 'Deployment failed')}${s.previousLive ? ' — the previous deployment is still live.' : ''}</div>`;
  if (s.state === 'awaiting') return '<div class="small muted">Push to <code>main</code> (or click Deploy now) to build and deploy.</div>';
  return '';
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------
window.addEventListener('hashchange', () => route());
window.addEventListener('beforeunload', (e) => { if (state.beforeLeave && state.beforeLeave()) { e.preventDefault(); e.returnValue = ''; } });

const defaultRoute = () => ({ competitor: '#/dash', trainer: '#/trainer', admin: '#/admin' }[state.me.role]);

// Navigations run one at a time and only the newest pending one renders. Logging in triggers two
// navigations back to back (#/ then the role's home); rendering them concurrently let the slower,
// outdated render write into a page that had already been replaced.
let routeSeq = 0;
let routeChain = Promise.resolve();
function route() {
  const id = ++routeSeq;
  routeChain = routeChain.then(() => (id === routeSeq ? renderRoute() : undefined)).catch((e) => console.error(e));
  return routeChain;
}

async function renderRoute() {
  clearTimers();
  if (state.beforeLeave && state.beforeLeave() && !confirm('You have unsaved changes in the IDE. Leave anyway?')) return;
  state.beforeLeave = null;
  app.classList.remove('wide');
  if (!state.me) {
    try {
      const r = await api('GET', '/api/me');
      state.me = r.user; state.platform = r.platform; state.pending = r.pendingSecrets;
    } catch { return renderLogin(); }
  }
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query || '');
  renderTopbar(parts[0]);
  app.innerHTML = '<p class="muted">Loading…</p>';
  try {
    switch (parts[0]) {
      case 'dash': return await renderDashboard(params.get('user'));
      case 'ide': return await renderIde(Number(parts[1]), params.get('ref'));
      case 'db': return await renderDb(Number(parts[1]));
      case 'trainer':
        if (state.me.role === 'competitor') break;
        return parts[1] ? await renderCompetitor(Number(parts[1])) : await renderTrainer(params.get('tab') || 'competitors');
      case 'admin':
        if (state.me.role !== 'admin') break;
        return await renderAdmin(params.get('tab') || 'users');
      default: break;
    }
    location.hash = defaultRoute();
  } catch (e) {
    app.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
  }
}

function renderTopbar(section) {
  $('#topbar').hidden = false;
  const links = state.me.role === 'competitor'
    ? [['dash', 'Dashboard']]
    : state.me.role === 'trainer' ? [['trainer', 'Trainer console']] : [['trainer', 'Trainer console'], ['admin', 'Administration']];
  $('#nav').innerHTML = links.map(([k, label]) => `<a href="#/${k}" class="${section === k ? 'active' : ''}">${label}</a>`).join('');
  $('#who').textContent = `${state.me.name} · ${state.me.role}`;
}

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  state.me = null;
  location.hash = '';
  route();
});

function renderLogin() {
  $('#topbar').hidden = true;
  app.innerHTML = `<div class="login"><form class="card" id="login-form">
    <div class="logo" style="margin:auto;width:48px;height:48px;font-size:24px">W</div>
    <h1 style="margin-top:14px">WorldSkills Deploy</h1>
    <p class="muted">Enter your access code</p>
    <input id="code" inputmode="numeric" autocomplete="off" maxlength="12" aria-label="Access code" autofocus>
    <button class="btn primary" style="width:100%;justify-content:center">Log in</button>
    <p class="err-text" id="login-err"></p>
  </form></div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/login', { code: $('#code').value });
      state.me = null;
      if (!location.hash || location.hash === '#/') location.hash = '#/';
      route();
    } catch (err) {
      $('#login-err').textContent = err.message;
    }
  });
}

// ---------------------------------------------------------------------------
// competitor dashboard
// ---------------------------------------------------------------------------
async function renderDashboard(userId) {
  const qs = userId ? `?user=${encodeURIComponent(userId)}` : '';
  let d = await api('GET', `/api/dashboard${qs}`);
  const isSelf = state.me.role === 'competitor';
  if (isSelf) {
    const me = await api('GET', '/api/me');
    state.pending = me.pendingSecrets;
  }
  const g = d.git;

  app.innerHTML = `
    ${!isSelf ? `<div class="banner info" style="margin-bottom:16px">Acting on <b>${esc(d.competitor.name)}</b>'s account as ${esc(state.me.role)}.
      <a href="#/trainer/${d.competitor.id}">Open trainer view →</a></div>` : ''}
    <div id="secret-banner"></div>
    <div class="spread"><div><h1>${isSelf ? `Welcome, ${esc(d.competitor.name)}` : esc(d.competitor.name)}</h1>
      <p class="muted">Push to <code>main</code> to deploy. Every repository gets its own container, database and subdomain.</p></div></div>
    <div id="announcements"></div>
    <div class="grid2 section">
      <div class="card">
        <h2>Git credentials</h2>
        <dl class="kv">
          <dt>Username</dt><dd><span class="mono">${esc(g.username)}</span>${copyBtn(g.username)}</dd>
          <dt>Password</dt><dd id="git-pass">${isSelf
            ? '<button class="btn sm" id="show-git-pass">Show password</button>'
            : '<span class="muted small">Visible to the competitor on their dashboard and to administrators under Administration → Accounts.</span>'}</dd>
          <dt>Server</dt><dd><span class="mono">${esc(g.host)}</span></dd>
        </dl>
      </div>
      <div class="card">
        <h2>How to deploy</h2>
        <ol class="small" style="margin:0;padding-left:18px">
          <li>Create a repository from a template (below).</li>
          <li><code>git clone &lt;git remote&gt;</code> and edit locally — or use the Web IDE.</li>
          <li><code>git push origin main</code> → build → live at the repository's URL.</li>
          <li>Database credentials per repository are under <b>Database</b> and are also injected as <code>DB_*</code> environment variables.</li>
        </ol>
      </div>
    </div>
    <div class="section">
      <div class="spread"><h2 style="margin:0">Repositories</h2><button class="btn primary" id="new-repo">+ New repository</button></div>
      <div id="repos" class="section" style="margin-top:12px"></div>
    </div>
    <div class="section card" id="logs"></div>
    <div class="section card" id="push-feed"></div>`;

  // shown-once credentials
  if (isSelf && state.pending && state.pending.gitPassword) {
    $('#secret-banner').innerHTML = `<div class="banner warn" style="margin-bottom:16px">
      <b>Your new git password:</b>
      <div class="row" style="margin:8px 0"><span class="mono secret" style="font-size:18px">${esc(state.pending.gitPassword)}</span>${copySecretBtn(state.pending.gitPassword)}</div>
      <div class="small">Use it with username <b>${esc(g.username)}</b> when git asks for credentials. You can show it again any time under <b>Git credentials</b>.</div>
      <button class="btn sm" id="ack-secret" style="margin-top:8px">Got it — hide</button></div>`;
    $('#ack-secret').addEventListener('click', async () => {
      await api('POST', '/api/me/ack-secrets');
      state.pending = null;
      route();
    });
  }
  const showPass = $('#show-git-pass');
  if (showPass) {
    showPass.addEventListener('click', async () => {
      try {
        const r = await api('GET', '/api/me/git-password');
        $('#git-pass').innerHTML = r.gitPassword
          ? `<span class="mono">${esc(r.gitPassword)}</span>${copySecretBtn(r.gitPassword)}`
          : '<span class="muted small">Not stored for this older account. Ask a trainer to rotate it (your repositories are not affected).</span>';
      } catch (err) { fail(err); }
    });
  }

  mountPushFeed($('#push-feed'));
  $('#announcements').innerHTML = d.announcements.length ? `<div class="card section"><h2>Announcements</h2>${d.announcements.map((a) =>
    `<div style="padding:8px 0;border-top:1px solid var(--border)"><div class="prewrap">${esc(a.body)}</div><div class="small muted">${esc(a.author || '')} · ${ago(a.created_at)}</div></div>`).join('')}</div>` : '';

  let lastJson = '';
  const drawRepos = () => {
    const json = JSON.stringify(d.repos);
    if (json === lastJson) return;
    lastJson = json;
    $('#repos').innerHTML = d.repos.length
      ? d.repos.map(repoCard).join('')
      : '<div class="card muted">No repositories yet. Click <b>+ New repository</b> and pick a framework template.</div>';
  };
  drawRepos();
  bindRepoActions($('#repos'), () => d.repos, () => refresh());
  const logViewer = mountLogViewer($('#logs'), () => d.repos);

  async function refresh() {
    try {
      d = await api('GET', `/api/dashboard${qs}`);
      drawRepos();
      logViewer.reposChanged();
    } catch { /* keep last view */ }
  }
  every(4000, refresh);

  $('#new-repo').addEventListener('click', () => newRepoModal(d, refresh));
}

function repoCard(r) {
  const latest = r.latestDeployment;
  const live = r.liveDeployment;
  const failed = r.status.state === 'failed';
  return `<div class="card repo" data-repo="${r.id}">
    <div class="repo-head">
      <div><div class="repo-title">${esc(r.name)}</div><div class="small muted">${esc(r.templateName)}</div></div>
      ${pill(r.status)}
    </div>
    ${statusExtra(r.status)}
    <div class="repo-meta">
      <div><span class="label">Live URL</span><a class="mono" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></div>
      <div><span class="label">Git remote</span><div class="row" style="flex-wrap:nowrap"><span class="mono" style="flex:1">${esc(r.gitRemote)}</span>${copyBtn(r.gitRemote)}</div></div>
      <div><span class="label">Last deploy</span>${latest
        ? `<span class="mono">${short(latest.sha)}</span> ${esc(latest.message || '')} <span class="muted">· ${ago(latest.createdAt)}</span>`
        : '<span class="muted">never</span>'}</div>
      <div><span class="label">Serving</span>${live
        ? `<span class="mono">${short(live.sha)}</span> ${esc(live.message || '')} <span class="muted">· since ${ago(live.finishedAt)}</span>`
        : '<span class="muted">nothing yet</span>'}</div>
    </div>
    <div class="repo-actions">
      <button class="btn sm ${failed ? 'primary' : ''}" data-act="deploy">${failed ? 'Retry deploy' : 'Deploy now'}</button>
      <a class="btn sm" href="#/ide/${r.id}">${r.canEditCode ? 'Web IDE' : 'View code'}</a>
      <a class="btn sm" href="#/db/${r.id}">Database</a>
      <button class="btn sm" data-act="env">Env vars</button>
      <button class="btn sm" data-act="logs">Logs</button>
      <button class="btn sm" data-act="subdomain">Edit subdomain</button>
      <button class="btn sm danger" data-act="delete">Delete</button>
    </div>
  </div>`;
}

function bindRepoActions(container, getRepos, refresh) {
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('[data-repo]');
    const repo = getRepos().find((r) => r.id === Number(card.dataset.repo));
    if (!repo) return;
    const act = btn.dataset.act;
    try {
      if (act === 'deploy') {
        btn.disabled = true;
        await api('POST', `/api/repos/${repo.id}/deploy`, { retry: repo.status.state === 'failed' });
        toast('Deployment queued');
        refresh();
      } else if (act === 'env') envModal(repo);
      else if (act === 'logs') {
        const lv = $('#logs');
        lv.dispatchEvent(new CustomEvent('select-repo', { detail: repo.id }));
        lv.scrollIntoView({ behavior: 'smooth' });
      } else if (act === 'subdomain') {
        const m = modal(`<form><h2>Edit subdomain</h2>
          <div class="field"><label>Subdomain</label><div class="row" style="flex-wrap:nowrap"><input name="sub" value="${esc(repo.subdomain)}"><span class="muted mono">.${esc(state.platform.baseDomain)}</span></div></div>
          <p class="small muted">A running app is redeployed so its APP_URL matches the new address.</p>
          <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
        $('form', m.el).addEventListener('submit', async (ev) => {
          ev.preventDefault();
          try {
            await api('PATCH', `/api/repos/${repo.id}`, { subdomain: $('[name=sub]', m.el).value });
            m.close(); toast('Subdomain updated'); refresh();
          } catch (err) { fail(err); }
        });
      } else if (act === 'delete') {
        const typed = prompt(`This permanently deletes "${repo.name}", its deployments and its database.\nType the repository name to confirm:`);
        if (typed !== repo.name) { if (typed !== null) toast('Name did not match — nothing deleted', true); return; }
        await api('DELETE', `/api/repos/${repo.id}`);
        toast('Repository deleted');
        refresh();
      }
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  });
}

function newRepoModal(d, refresh) {
  const gitUser = d.competitor.gitUser;
  const m = modal(`<form><h2>New repository</h2>
    <div class="field"><label>Framework template</label><select name="template">${d.templates.map((t) =>
      `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>
      <div class="small muted" id="tpl-desc" style="margin-top:4px"></div></div>
    <div class="field"><label>Repository name</label><input name="name" placeholder="module-a" pattern="[a-z0-9][a-z0-9\\-]*[a-z0-9]" required></div>
    <div class="field"><label>Subdomain</label><div class="row" style="flex-wrap:nowrap"><input name="subdomain" placeholder="module-a-${esc(gitUser)}"><span class="muted mono">.${esc(state.platform.baseDomain)}</span></div></div>
    <p class="small muted">A git repository with the template's starter code, its own MySQL database and its build/deploy setup are created automatically.</p>
    <p class="err-text" id="nr-err"></p>
    <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="nr-go">Create repository</button></div></form>`);
  const sel = $('[name=template]', m.el);
  const nameIn = $('[name=name]', m.el);
  const subIn = $('[name=subdomain]', m.el);
  let subTouched = false;
  const showDesc = () => { const t = d.templates.find((x) => x.id === sel.value); $('#tpl-desc', m.el).textContent = t ? t.description : ''; };
  sel.addEventListener('change', showDesc); showDesc();
  nameIn.addEventListener('input', () => {
    nameIn.value = nameIn.value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!subTouched) subIn.value = nameIn.value ? `${nameIn.value}-${gitUser}` : '';
  });
  subIn.addEventListener('input', () => { subTouched = true; subIn.value = subIn.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'); });
  $('form', m.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const go = $('#nr-go', m.el);
    go.disabled = true;
    go.textContent = sel.value === 'laravel' ? 'Creating… (Laravel takes up to a minute)' : 'Creating…';
    try {
      await api('POST', '/api/repos', { name: nameIn.value, template: sel.value, subdomain: subIn.value || undefined, userId: d.competitor.id });
      m.close();
      toast('Repository created — clone it and push to deploy');
      refresh();
    } catch (err) {
      $('#nr-err', m.el).textContent = err.message;
      go.disabled = false;
      go.textContent = 'Create repository';
    }
  });
}

async function envModal(repo) {
  const vars = await api('GET', `/api/repos/${repo.id}/env`);
  const rowHtml = (k = '', v = '') => `<div class="row env-row" style="flex-wrap:nowrap;margin-bottom:6px">
    <input class="mono" placeholder="NAME" value="${esc(k)}" style="flex:1"><input class="mono" placeholder="value" value="${esc(v)}" style="flex:2">
    <button type="button" class="btn sm ghost" data-del>✕</button></div>`;
  const m = modal(`<form><h2>Environment variables · ${esc(repo.name)}</h2>
    <p class="small muted">Available at runtime (and as build args, e.g. <code>VITE_API_URL</code>). The platform already sets
    <code>PORT</code>, <code>APP_URL</code> and <code>DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD</code>. Redeploy to apply changes.</p>
    <div id="env-rows">${vars.map((v) => rowHtml(v.key, v.value)).join('')}</div>
    <button type="button" class="btn sm" id="env-add">+ Add variable</button>
    <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button>
    <button type="button" class="btn" id="env-save">Save</button><button class="btn primary">Save &amp; redeploy</button></div></form>`, { large: true });
  const rows = $('#env-rows', m.el);
  if (!vars.length) rows.insertAdjacentHTML('beforeend', rowHtml());
  $('#env-add', m.el).addEventListener('click', () => rows.insertAdjacentHTML('beforeend', rowHtml()));
  rows.addEventListener('click', (e) => { if (e.target.closest('[data-del]')) e.target.closest('.env-row').remove(); });
  const save = async (redeploy) => {
    const list = $$('.env-row', rows).map((r) => { const [k, v] = $$('input', r); return { key: k.value.trim(), value: v.value }; }).filter((x) => x.key);
    try {
      await api('PUT', `/api/repos/${repo.id}/env`, { vars: list });
      if (redeploy) await api('POST', `/api/repos/${repo.id}/deploy`, {});
      m.close();
      toast(redeploy ? 'Saved — redeploying' : 'Saved');
    } catch (err) { fail(err); }
  };
  $('#env-save', m.el).addEventListener('click', () => save(false));
  $('form', m.el).addEventListener('submit', (e) => { e.preventDefault(); save(true); });
}

// Log viewer: per repository, build output (per deployment) or application output.
function mountLogViewer(el, getRepos) {
  let repoId = null;
  let source = 'build';
  let depId = null;
  let deployments = [];
  el.innerHTML = `<div class="spread"><h2 style="margin:0">Deployment logs</h2>
    <div class="row">
      <select id="lv-repo" style="width:auto"></select>
      <select id="lv-src" style="width:auto"><option value="build">Build output</option><option value="app">Application output</option></select>
      <select id="lv-dep" style="width:auto"></select>
      <label class="row small" style="margin:0;font-weight:500"><input type="checkbox" id="lv-follow" checked style="width:auto"> follow</label>
      <button class="btn sm" id="lv-refresh">Refresh</button>
    </div></div>
    <pre class="log" id="lv-out" style="margin-top:12px">Select a repository.</pre>`;
  const repoSel = $('#lv-repo', el);
  const srcSel = $('#lv-src', el);
  const depSel = $('#lv-dep', el);
  const out = $('#lv-out', el);

  function fillRepos() {
    const repos = getRepos();
    const cur = repoSel.value;
    repoSel.innerHTML = repos.length ? repos.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('') : '<option value="">(no repositories)</option>';
    if (repos.some((r) => String(r.id) === cur)) repoSel.value = cur;
    repoId = Number(repoSel.value) || null;
  }

  async function loadDeployments() {
    if (!repoId) { deployments = []; depSel.innerHTML = ''; return; }
    deployments = await api('GET', `/api/repos/${repoId}/deployments`);
    const keep = depId && deployments.some((x) => x.id === depId);
    depSel.innerHTML = deployments.length
      ? deployments.map((x) => `<option value="${x.id}">#${x.id} · ${short(x.commit_sha)} · ${esc(x.status)} · ${ago(x.created_at)}</option>`).join('')
      : '<option value="">(no deployments yet)</option>';
    depId = keep ? depId : (deployments[0] ? deployments[0].id : null);
    if (depId) depSel.value = String(depId);
  }

  async function load() {
    depSel.style.display = source === 'build' ? '' : 'none';
    if (!repoId) { out.textContent = 'No repository selected.'; return; }
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
    try {
      let text;
      if (source === 'build') {
        if (!depId) { out.textContent = 'No deployments yet. Push to main or click Deploy now.'; return; }
        const r = await api('GET', `/api/repos/${repoId}/deployments/${depId}/log`);
        text = r.log || (r.status === 'queued' ? 'Queued — waiting for a build worker…' : '(empty)');
      } else {
        const r = await api('GET', `/api/repos/${repoId}/app-logs?tail=1000`);
        text = r.log || r.note || '(no output yet)';
      }
      if (out.textContent !== text) {
        out.textContent = text;
        if (atBottom || $('#lv-follow', el).checked) out.scrollTop = out.scrollHeight;
      }
    } catch (e) { out.textContent = `Error: ${e.message}`; }
  }

  repoSel.addEventListener('change', async () => { repoId = Number(repoSel.value); depId = null; await loadDeployments(); load(); });
  srcSel.addEventListener('change', () => { source = srcSel.value; load(); });
  depSel.addEventListener('change', () => { depId = Number(depSel.value); load(); });
  $('#lv-refresh', el).addEventListener('click', async () => { await loadDeployments(); load(); });
  el.addEventListener('select-repo', async (e) => { repoSel.value = String(e.detail); repoId = e.detail; depId = null; await loadDeployments(); load(); });

  fillRepos();
  loadDeployments().then(load);
  every(3000, async () => {
    if (!$('#lv-follow', el).checked || !repoId) return;
    const active = deployments.find((x) => x.id === depId);
    const repo = getRepos().find((r) => r.id === repoId);
    const latestId = repo && repo.latestDeployment && repo.latestDeployment.id;
    if (source === 'build' && latestId && !deployments.some((x) => x.id === latestId)) { depId = null; await loadDeployments(); }
    if (source === 'app' || (active && ['queued', 'building'].includes(active.status)) || depId !== (deployments[0] && deployments[0].id)) {
      if (source === 'build') await loadDeployments();
      load();
    }
  });
  return { reposChanged: fillRepos };
}

// ---------------------------------------------------------------------------
// web IDE
// ---------------------------------------------------------------------------
function cmMode(file) {
  const f = file.toLowerCase();
  if (f.endsWith('.blade.php') || f.endsWith('.php')) return 'application/x-httpd-php';
  if (f.endsWith('.jsx') || f.endsWith('.tsx')) return 'jsx';
  if (f.endsWith('.json')) return { name: 'javascript', json: true };
  if (/\.(m|c)?js$|\.ts$/.test(f)) return 'javascript';
  if (/\.(html?|vue)$/.test(f)) return 'htmlmixed';
  if (/\.(s?css|less)$/.test(f)) return 'css';
  if (f.endsWith('.sql')) return 'sql';
  if (f.endsWith('.md')) return 'markdown';
  if (f.endsWith('.sh')) return 'shell';
  if (f.endsWith('dockerfile')) return 'dockerfile';
  if (f.endsWith('.xml') || f.endsWith('.svg')) return 'xml';
  return null;
}
const prefersDark = () => document.documentElement.dataset.theme === 'dark'
  || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

async function renderIde(repoId, ref) {
  ref = ref || 'main';
  const [repo, files, commits] = await Promise.all([
    api('GET', `/api/repos/${repoId}`),
    api('GET', `/api/repos/${repoId}/tree?ref=${encodeURIComponent(ref)}`),
    api('GET', `/api/repos/${repoId}/commits`),
  ]);
  const readOnly = !repo.canEditCode || ref !== 'main';
  const buffers = new Map(); // path -> { doc|text, original, deleted }
  let fileList = [...files].sort();
  let current = null;
  app.classList.add('wide');
  app.innerHTML = `<div class="ide">
    <aside class="ide-side">
      <div class="head stack">
        <div><a href="javascript:history.back()" class="small">← Back</a></div>
        <div><b>${esc(repo.owner.git_user)}/${esc(repo.name)}</b><div class="small muted">${esc(repo.templateName)}</div></div>
        <select id="ide-ref" title="Version">${[`<option value="main">main (latest)</option>`,
          ...commits.map((c) => `<option value="${c.sha}">${short(c.sha)} · ${esc(c.message.slice(0, 40))}</option>`)].join('')}</select>
        ${readOnly ? `<div class="small muted">${repo.canEditCode ? 'Viewing an older version (read-only).' : 'Read-only trainer view.'}</div>`
          : '<button class="btn sm" id="ide-new">+ New file</button>'}
      </div>
      <ul class="ide-files" id="ide-files"></ul>
    </aside>
    <section class="ide-main">
      <div class="ide-bar">
        <span class="mono" id="ide-path" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">Select a file</span>
        <span class="small muted" id="ide-status"></span>
        ${readOnly ? '' : '<button class="btn sm danger" id="ide-del" disabled>Delete file</button><button class="btn sm primary" id="ide-save" disabled>Commit &amp; deploy</button>'}
        <a class="btn sm" href="${esc(repo.url)}" target="_blank" rel="noopener">Open live site</a>
      </div>
      <div class="ide-editor" id="ide-editor"></div>
    </section></div>`;
  const refSel = $('#ide-ref');
  refSel.value = commits.some((c) => c.sha === ref) ? ref : 'main';
  refSel.addEventListener('change', () => { location.hash = `#/ide/${repoId}${refSel.value === 'main' ? '' : `?ref=${refSel.value}`}`; });

  const editorEl = $('#ide-editor');
  const hasCM = typeof window.CodeMirror === 'function';
  let cm = null;
  let ta = null;
  if (hasCM) {
    cm = window.CodeMirror(editorEl, { lineNumbers: true, readOnly, indentUnit: 2, tabSize: 2, theme: prefersDark() ? 'material-darker' : 'default', value: '' });
    cm.on('change', () => markDirty());
  } else {
    ta = document.createElement('textarea');
    ta.readOnly = readOnly;
    ta.spellcheck = false;
    editorEl.append(ta);
    ta.addEventListener('input', () => { if (current) buffers.get(current).text = ta.value; markDirty(); });
  }

  const contentOf = (b) => (cm ? b.doc.getValue() : b.text);
  const isDirty = (p) => { const b = buffers.get(p); return b && (b.deleted || b.isNew || contentOf(b) !== b.original); };
  const dirtyPaths = () => [...buffers.keys()].filter(isDirty);
  state.beforeLeave = () => !readOnly && dirtyPaths().length > 0;

  function drawFiles() {
    const printed = new Set();
    let html = '';
    for (const f of fileList) {
      const parts = f.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts.slice(0, i + 1).join('/');
        if (!printed.has(dir)) { printed.add(dir); html += `<li class="dir" style="padding-left:${12 + i * 14}px">${esc(parts[i])}/</li>`; }
      }
      const b = buffers.get(f);
      html += `<li data-file="${esc(f)}" class="${f === current ? 'active' : ''} ${isDirty(f) ? 'dirty' : ''}" style="padding-left:${12 + (parts.length - 1) * 14}px;${b && b.deleted ? 'text-decoration:line-through' : ''}">${esc(parts[parts.length - 1])}</li>`;
    }
    $('#ide-files').innerHTML = html;
  }
  function markDirty() {
    const n = dirtyPaths().length;
    $('#ide-status').textContent = n ? `${n} unsaved file${n > 1 ? 's' : ''}` : '';
    const save = $('#ide-save');
    if (save) save.disabled = !n;
    const li = current && $(`#ide-files li[data-file="${CSS.escape(current)}"]`);
    if (li) li.classList.toggle('dirty', isDirty(current));
  }

  async function open(path) {
    if (!buffers.has(path)) {
      const f = await api('GET', `/api/repos/${repoId}/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`);
      const text = f.binary ? '' : f.content;
      buffers.set(path, { original: text, binary: f.binary, doc: cm ? window.CodeMirror.Doc(text, cmMode(path)) : null, text });
    }
    current = path;
    const b = buffers.get(path);
    if (cm) { cm.swapDoc(b.doc); cm.setOption('readOnly', readOnly || b.binary); cm.refresh(); } else { ta.value = b.text; ta.readOnly = readOnly || b.binary; }
    $('#ide-path').textContent = b.binary ? `${path} (binary file — not editable here)` : path;
    const del = $('#ide-del');
    if (del) del.disabled = false;
    drawFiles();
    markDirty();
  }

  $('#ide-files').addEventListener('click', (e) => { const li = e.target.closest('[data-file]'); if (li) open(li.dataset.file).catch(fail); });

  if (!readOnly) {
    $('#ide-new').addEventListener('click', () => {
      const p = prompt('New file path (e.g. public/about.html):');
      if (!p) return;
      const path = p.replace(/\\/g, '/').replace(/^\/+/, '');
      if (fileList.includes(path)) return open(path);
      fileList = [...fileList, path].sort();
      buffers.set(path, { original: '', isNew: true, doc: cm ? window.CodeMirror.Doc('', cmMode(path)) : null, text: '' });
      open(path);
    });
    $('#ide-del').addEventListener('click', () => {
      if (!current || !confirm(`Delete ${current} in the next commit?`)) return;
      const b = buffers.get(current);
      if (b.isNew) { buffers.delete(current); fileList = fileList.filter((f) => f !== current); current = null; }
      else b.deleted = true;
      drawFiles(); markDirty();
    });
    $('#ide-save').addEventListener('click', async () => {
      const paths = dirtyPaths();
      if (!paths.length) return;
      const message = prompt('Commit message:', paths.length === 1 ? `Update ${paths[0]}` : `Update ${paths.length} files`);
      if (message === null) return;
      const changes = paths.map((p) => { const b = buffers.get(p); return b.deleted ? { path: p, delete: true } : { path: p, content: contentOf(b) }; });
      const btn = $('#ide-save');
      btn.disabled = true;
      try {
        const r = await api('POST', `/api/repos/${repoId}/commit`, { changes, message });
        for (const p of paths) {
          const b = buffers.get(p);
          if (b.deleted) { buffers.delete(p); fileList = fileList.filter((f) => f !== p); if (current === p) current = null; } else { b.original = contentOf(b); b.isNew = false; }
        }
        drawFiles(); markDirty();
        toast(r.sha ? `Committed ${short(r.sha)} — deploying` : 'No changes');
      } catch (err) { fail(err); btn.disabled = false; }
    });
    document.addEventListener('keydown', function onKey(e) {
      if (!document.body.contains(editorEl)) return document.removeEventListener('keydown', onKey);
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#ide-save').click(); }
    });
  }

  drawFiles();
  const first = ['README.md', 'WORLDSKILLS.md', 'public/index.php', 'src/App.jsx', 'server.js', 'routes/web.php'].find((f) => fileList.includes(f));
  if (first) await open(first);
}

// ---------------------------------------------------------------------------
// database browser (scoped to one repository's own database)
// ---------------------------------------------------------------------------
function resultTable(columns, rows) {
  if (!rows.length) return '<p class="muted">No rows.</p>';
  return `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) =>
    `<tr>${columns.map((c) => `<td class="mono">${r[c] === null ? '<span class="muted">NULL</span>' : esc(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

async function renderDb(repoId) {
  const [repo, cred] = await Promise.all([api('GET', `/api/repos/${repoId}`), api('GET', `/api/repos/${repoId}/db/credentials`)]);
  app.innerHTML = `<div class="spread"><div><a href="javascript:history.back()" class="small">← Back</a>
      <h1>Database · ${esc(repo.owner.git_user)}/${esc(repo.name)}</h1>
      <p class="muted">This database belongs to this repository only. Other repositories and accounts cannot see it.</p></div>
      <a class="btn" href="${esc(cred.phpMyAdmin)}" target="_blank" rel="noopener">Open phpMyAdmin ↗</a></div>
    <div class="grid2 section">
      <div class="card"><h2>Credentials</h2><dl class="kv">
        <dt>Database</dt><dd><span class="mono">${esc(cred.database)}</span>${copyBtn(cred.database)}</dd>
        <dt>Username</dt><dd><span class="mono">${esc(cred.username)}</span>${copyBtn(cred.username)}</dd>
        <dt>Password</dt><dd><span class="mono secret">••••••••••</span>${copySecretBtn(cred.password)}</dd>
        <dt>Host (from your app)</dt><dd><span class="mono">${esc(cred.host)}:${esc(cred.port)}</span></dd>
        <dt>Host (from your PC)</dt><dd><span class="mono">${esc(cred.externalHost)}:${esc(cred.externalPort)}</span></dd>
      </dl><p class="small muted">Deployed apps also receive these as <code>DB_HOST</code>, <code>DB_DATABASE</code>, <code>DB_USERNAME</code>, <code>DB_PASSWORD</code>. Log in to phpMyAdmin with the same username and password.</p></div>
      <div class="card"><h2>Tables</h2><div id="db-tables" class="muted">Loading…</div></div>
    </div>
    <div class="card section"><h2>SQL</h2>
      <textarea id="db-sql" class="mono" placeholder="SELECT * FROM users LIMIT 10"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="db-run">Run</button><span class="small muted">Runs with this repository's own credentials.</span></div>
    </div>
    <div class="card section" id="db-result"><p class="muted">Select a table or run a query.</p></div>`;

  async function loadTables() {
    try {
      const tables = await api('GET', `/api/repos/${repoId}/db/tables`);
      $('#db-tables').innerHTML = tables.length
        ? `<table><tbody>${tables.map((t) => `<tr class="clickable" data-table="${esc(t.name)}"><td class="mono">${esc(t.name)}</td><td class="muted small">~${esc(t.approxRows ?? 0)} rows</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">No tables yet. Run your migrations or create one.</p>';
    } catch (e) { $('#db-tables').innerHTML = `<p class="err-text">${esc(e.message)}</p>`; }
  }
  $('#db-tables').addEventListener('click', async (e) => {
    const tr = e.target.closest('[data-table]');
    if (!tr) return;
    try {
      const r = await api('GET', `/api/repos/${repoId}/db/tables/${encodeURIComponent(tr.dataset.table)}`);
      $('#db-result').innerHTML = `<h2>${esc(tr.dataset.table)} <span class="small muted">(first 200 rows)</span></h2>${resultTable(r.columns, r.rows)}`;
    } catch (err) { fail(err); }
  });
  $('#db-run').addEventListener('click', async () => {
    try {
      const r = await api('POST', `/api/repos/${repoId}/db/query`, { sql: $('#db-sql').value });
      $('#db-result').innerHTML = r.columns
        ? `<h2>Result${r.truncated ? ' (first 1000 rows)' : ''}</h2>${resultTable(r.columns, r.rows)}`
        : `<h2>OK</h2><p>${esc(r.affectedRows)} row(s) affected${r.insertId ? ` · insert id ${esc(r.insertId)}` : ''}</p>`;
      loadTables();
    } catch (err) { $('#db-result').innerHTML = `<div class="banner err">${esc(err.message)}</div>`; }
  });
  loadTables();
}

// ---------------------------------------------------------------------------
// trainer console
// ---------------------------------------------------------------------------
function tabs(active, items, base) {
  return `<div class="tabs">${items.map(([k, label]) => `<button data-tab="${k}" class="${k === active ? 'active' : ''}">${label}</button>`).join('')}</div>`;
}
function bindTabs(base) {
  $$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { location.hash = `${base}?tab=${b.dataset.tab}`; }));
}

async function renderTrainer(tab) {
  app.innerHTML = `<h1>Trainer console</h1><p class="muted">Competitors' work, everyone's pushes and announcements.</p>
    ${tabs(tab, [['competitors', 'Competitors'], ['pushes', 'Push feed'], ['announcements', 'Announcements']])}
    <div id="tab"></div>`;
  bindTabs('#/trainer');
  if (tab === 'pushes') { $('#tab').innerHTML = '<div class="card" id="push-feed"></div>'; return mountPushFeed($('#push-feed'), { limit: 100 }); }
  if (tab === 'announcements') return trainerAnnouncements();
  return trainerCompetitors();
}

async function trainerCompetitors() {
  const el = $('#tab');
  const draw = (list) => {
    const done = list.filter((c) => c.assessment && c.assessment.state === 'assessed').length;
    el.innerHTML = `<div class="spread" style="margin-bottom:12px"><span class="muted">${list.length} competitor(s) · <b>${done} of ${list.length} assessed</b></span>
      <button class="btn primary" id="add-comp">+ Add competitor</button></div>
      <div class="card table-wrap"><table><thead><tr><th>Competitor</th><th>Repositories</th><th>Last push</th><th>Assessment</th></tr></thead><tbody>
      ${list.map((c) => `<tr class="clickable" data-user="${c.id}">
        <td><b>${esc(c.name)}</b><div class="small muted mono">${esc(c.gitUser)}</div></td>
        <td>${c.repos.map((r) => `<div class="row small" style="margin-bottom:4px"><span class="mono">${esc(r.name)}</span>${pill(r.status)}</div>`).join('') || '<span class="muted small">none</span>'}</td>
        <td class="small">${c.lastPush ? `${esc(c.lastPush.repo)} · ${esc(c.lastPush.status)}<div class="muted">${ago(c.lastPush.created_at)}</div>` : '<span class="muted">—</span>'}</td>
        <td>${assessPill(c.assessment)}${c.assessment && c.assessment.total ? `<div class="small muted" style="margin-top:4px">by you: ${c.assessment.mine} / ${c.assessment.total} repos</div>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">No competitors yet.</td></tr>'}
      </tbody></table></div>`;
    el.querySelector('tbody').addEventListener('click', (e) => { const tr = e.target.closest('[data-user]'); if (tr) location.hash = `#/trainer/${tr.dataset.user}`; });
    el.querySelector('#add-comp').addEventListener('click', () => createUserModal('competitor', () => load()));
  };
  const load = async () => draw(await api('GET', '/api/competitors'));
  await load();
  every(6000, () => api('GET', '/api/competitors').then((l) => { if (el.isConnected && !document.querySelector('.modal-bg')) draw(l); }).catch(() => {}));
}

function createUserModal(role, done, allowRole = false) {
  const m = modal(`<form><h2>New ${allowRole ? 'user' : esc(role)}</h2>
    <div class="field"><label>Full name</label><input name="name" required></div>
    ${allowRole ? `<div class="field"><label>Role</label><select name="role"><option value="competitor">Competitor</option><option value="trainer">Trainer</option><option value="admin">Administrator</option></select></div>` : ''}
    <p class="small muted">An access code is generated. Competitors also get git credentials (always visible on their dashboard). Administrators can look up every code and password any time under Administration → Accounts.</p>
    <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create</button></div></form>`);
  $('form', m.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/users', { name: $('[name=name]', m.el).value, role: allowRole ? $('[name=role]', m.el).value : role });
      m.close();
      showOnce('Access code', `Access code for ${r.user.name} (${r.user.role}). They log in at ${state.platform.dashboardUrl}`, r.accessCode,
        'Copy it and hand it over. Administrators can also find it later under Administration → Accounts.');
      done && done();
    } catch (err) { fail(err); }
  });
}

async function trainerAnnouncements() {
  const el = $('#tab');
  const list = await api('GET', '/api/announcements');
  el.innerHTML = `<div class="card"><h2>Post an announcement</h2><textarea id="ann-body" placeholder="Visible on every competitor's dashboard"></textarea>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="ann-post">Post</button></div></div>
    <div class="card"><h2>Recent</h2>${list.map((a) => `<div class="spread" style="padding:8px 0;border-top:1px solid var(--border)">
      <div><div class="prewrap">${esc(a.body)}</div><div class="small muted">${esc(a.author || '')} · ${fmtTime(a.created_at)}</div></div>
      <button class="btn sm danger" data-del="${a.id}">Delete</button></div>`).join('') || '<p class="muted">None.</p>'}</div>`;
  $('#ann-post').onclick = async () => {
    try { await api('POST', '/api/announcements', { body: $('#ann-body').value }); toast('Posted'); route(); } catch (err) { fail(err); }
  };
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (b && confirm('Delete this announcement?')) { await api('DELETE', `/api/announcements/${b.dataset.del}`).catch(fail); route(); }
  });
}

async function renderCompetitor(userId) {
  const [d, history] = await Promise.all([
    api('GET', `/api/dashboard?user=${userId}`),
    api('GET', `/api/competitors/${userId}/history`),
  ]);
  const c = d.competitor;

  const a = d.assessment || { state: 'none', done: 0, total: 0, repos: {} };
  const meId = state.me.id;
  app.innerHTML = `<div class="spread"><div><a href="#/trainer" class="small">← All competitors</a><h1>${esc(c.name)}</h1>
      <div class="muted small">git user <span class="mono">${esc(c.gitUser)}</span> · ${d.repos.length} repositories</div></div>
    <div class="row"><a class="btn" href="#/dash?user=${c.id}">Manage repositories</a>
      <button class="btn" id="reset-code">Reset access code</button><button class="btn" id="rotate-git">Rotate git password</button></div></div>
    <div class="card section" id="assess-box"><h2 style="margin:0 0 4px">Assessment ${assessPill(a)}</h2>
      <div class="small muted">${a.total ? `${a.done} of ${a.total} repositories assessed by at least one trainer · by you: ${a.mine} of ${a.total}.` : 'This competitor has no repositories yet.'}
      Each trainer marks each repository below; the competitor counts as assessed when every repository is marked.
      No score or rank is recorded, and competitors never see these marks.</div></div>
    <div class="section"><h2>Repositories</h2><div id="c-repos"></div></div>
    <div class="section card" id="logs"></div>
    <div class="section card"><h2>Push &amp; deployment history</h2><div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Repository</th><th>Commit</th><th>Trigger</th><th>Result</th></tr></thead><tbody>
      ${history.map((h) => `<tr><td class="small">${fmtTime(h.created_at)}</td><td>${esc(h.repo)}</td>
        <td><a class="mono" href="#/ide/${h.repo_id}?ref=${esc(h.commit_sha)}">${short(h.commit_sha)}</a> <span class="small">${esc(h.commit_msg || '')}</span></td>
        <td class="small">${esc(h.trigger)}</td><td>${deployPill(h.status)}
        ${h.error ? `<div class="err-text small">${esc(h.error)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No pushes yet.</td></tr>'}
      </tbody></table></div></div>`;

  $('#c-repos').innerHTML = d.repos.map((r) => `<div class="card repo">
    <div class="repo-head"><div><div class="repo-title">${esc(r.name)}</div><div class="small muted">${esc(r.templateName)}</div></div>${pill(r.status)}</div>
    ${statusExtra(r.status)}
    <div class="repo-actions">
      <a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Live site ↗</a>
      <a class="btn sm" href="#/ide/${r.id}">Source (read-only)</a>
      <a class="btn sm" href="#/db/${r.id}">Database</a>
      <span class="small muted" style="align-self:center">${r.liveDeployment ? `serving ${short(r.liveDeployment.sha)} since ${ago(r.liveDeployment.finishedAt)}` : 'not deployed'}</span>
    </div>
    <div class="spread" style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px;align-items:flex-start">
      <div><div class="small"><b>Assessment</b></div>${marksHtml(r.id, a.repos[r.id])}</div>
      ${(a.repos[r.id] || []).some((m) => m.trainerId === meId)
        ? `<button class="btn sm" data-repo-assess="${r.id}" data-val="0">Remove my mark</button>`
        : `<button class="btn sm primary" data-repo-assess="${r.id}" data-val="1">Mark assessed by me</button>`}
    </div></div>`).join('') || '<div class="card muted">No repositories.</div>';
  mountLogViewer($('#logs'), () => d.repos);

  $('#c-repos').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-repo-assess]');
    if (!b) return;
    b.disabled = true;
    try {
      await setRepoAssessed(b.dataset.repoAssess, b.dataset.val === '1');
      toast(b.dataset.val === '1' ? 'Repository marked as assessed by you' : 'Your mark was removed');
      route();
    } catch (err) { fail(err); b.disabled = false; }
  });
  $('#reset-code').onclick = async () => {
    if (!confirm(`Generate a new access code for ${c.name}? The old code stops working and they are logged out.`)) return;
    try {
      const r = await api('POST', `/api/users/${c.id}/reset-code`);
      showOnce('New access code', `New access code for ${c.name}`, r.accessCode, 'Copy it and hand it over. Administrators can also find it later under Administration → Accounts.');
    } catch (err) { fail(err); }
  };
  $('#rotate-git').onclick = async () => {
    if (!confirm(`Issue a new git password for ${c.name}? It will be shown on their dashboard. Repositories are not affected.`)) return;
    try { await api('POST', `/api/users/${c.id}/rotate-git`); toast('New git password issued — visible on their dashboard and in Administration → Accounts'); } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// administration
// ---------------------------------------------------------------------------
async function renderAdmin(tab) {
  app.innerHTML = `<h1>Administration</h1><p class="muted">Accounts, templates, infrastructure and platform-wide activity.</p>
    ${tabs(tab, [['users', 'Accounts'], ['templates', 'Templates'], ['infra', 'Infrastructure'], ['activity', 'Activity']])}<div id="tab"></div>`;
  bindTabs('#/admin');
  const el = $('#tab');

  if (tab === 'templates') {
    const list = await api('GET', '/api/admin/templates');
    el.innerHTML = `<div class="card"><p class="small muted">Templates live in <code>platform/templates/&lt;id&gt;/</code> (template.json + files/). Only enable a template after verifying it deploys with zero manual fixes.</p>
      <table><thead><tr><th>Enabled</th><th>Template</th><th>Description</th></tr></thead><tbody>${list.map((t) => `<tr>
      <td><input type="checkbox" data-tpl="${esc(t.id)}" ${t.enabled ? 'checked' : ''} style="width:auto"></td><td><b>${esc(t.name)}</b><div class="mono small muted">${esc(t.id)}</div></td><td class="small">${esc(t.description)}</td></tr>`).join('')}</tbody></table></div>`;
    el.addEventListener('change', async (e) => {
      const cb = e.target.closest('[data-tpl]');
      if (cb) await api('PATCH', `/api/admin/templates/${cb.dataset.tpl}`, { enabled: cb.checked }).then(() => toast('Saved'), fail);
    });
    return;
  }

  if (tab === 'infra') {
    const i = await api('GET', '/api/admin/infra');
    el.innerHTML = `<div class="grid2">
      <div class="card"><h2>Status</h2><dl class="kv">
        <dt>Dashboard</dt><dd class="mono">${esc(i.dashboardUrl)}</dd>
        <dt>App domain</dt><dd class="mono">*.${esc(i.baseDomain)}</dd>
        <dt>Docker engine</dt><dd>${i.docker ? esc(i.docker) : '<span class="err-text">unreachable</span>'}</dd>
        <dt>MySQL</dt><dd>${i.mysql.ok ? `${esc(i.mysql.version)} · ${i.mysql.databases} repository databases` : `<span class="err-text">${esc(i.mysql.error)}</span>`}</dd>
        <dt>Build queue</dt><dd>${i.builder.building} building · ${i.builder.queued} queued · avg ${i.builder.avgBuildSeconds}s</dd>
        <dt>Totals</dt><dd>${i.counts.competitors} competitors · ${i.counts.repos} repos · ${i.counts.deployments} deployments</dd>
      </dl></div>
      <div class="card"><h2>Settings</h2><form id="settings">
        <div class="field"><label>Concurrent builds (build workers)</label><input type="number" name="buildConcurrency" min="1" max="16" value="${i.settings.buildConcurrency}"></div>
        <div class="field"><label>Scale idle apps to zero after (minutes, 0 = never)</label><input type="number" name="idleMinutes" min="0" value="${i.settings.idleMinutes}"></div>
        <div class="row" style="margin-top:12px"><button class="btn primary">Save</button></div></form></div>
    </div>
    <div class="card section"><h2>App containers</h2><div class="table-wrap"><table><thead><tr><th>Container</th><th>State</th><th>Status</th><th>Image</th></tr></thead><tbody>
      ${i.containers.map((c) => `<tr><td class="mono">${esc(c.name)}</td><td>${esc(c.state)}</td><td class="small">${esc(c.status)}</td><td class="mono small">${esc(c.image)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None.</td></tr>'}
    </tbody></table></div></div>`;
    $('#settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      await api('PUT', '/api/admin/settings', { buildConcurrency: Number(f.get('buildConcurrency')), idleMinutes: Number(f.get('idleMinutes')) }).then(() => toast('Saved'), fail);
    });
    return;
  }

  if (tab === 'activity') {
    const [auditRows, deps] = await Promise.all([api('GET', '/api/admin/audit'), api('GET', '/api/admin/deployments')]);
    el.innerHTML = `<div class="card"><h2>Recent deployments</h2><div class="table-wrap" style="max-height:420px"><table><thead><tr><th>#</th><th>When</th><th>Owner</th><th>Repo</th><th>Commit</th><th>Status</th></tr></thead><tbody>
      ${deps.map((x) => `<tr><td>${x.id}</td><td class="small">${fmtTime(x.created_at)}</td><td>${esc(x.owner)}</td><td>${esc(x.repo)}</td><td class="small"><span class="mono">${short(x.commit_sha)}</span> ${esc(x.commit_msg || '')}</td><td>${esc(x.status)}${x.error ? `<div class="err-text small">${esc(x.error)}</div>` : ''}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="card"><h2>Audit log</h2><div class="table-wrap" style="max-height:520px"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${auditRows.map((a) => `<tr><td class="small">${fmtTime(a.created_at)}</td><td>${esc(a.user || '—')}</td><td class="mono small">${esc(a.action)}</td><td class="small">${esc(a.detail || '')}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    return;
  }

  const users = await api('GET', '/api/admin/credentials');
  const cred = (value, resetHint) => (value
    ? `<div class="row" style="flex-wrap:nowrap"><span class="mono">${esc(value)}</span>${copySecretBtn(value)}</div>`
    : `<span class="small muted" title="Created before credentials were stored. ${resetHint} once to make it visible here.">not stored – ${resetHint.toLowerCase()} to view</span>`);
  el.innerHTML = `<div class="spread" style="margin-bottom:12px"><span class="muted">${users.length} accounts · log in with the <b>access code</b>; competitors use <b>git user + git password</b> for git</span><button class="btn primary" id="add-user">+ New account</button></div>
    <div class="card table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Access code</th><th>Git user</th><th>Git password</th><th>Created</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr data-user="${u.id}"><td><b>${esc(u.name)}</b></td><td>${esc(u.role)}</td>
      <td>${cred(u.accessCode, 'Reset code')}</td>
      <td class="mono small">${u.gitUser ? `${esc(u.gitUser)}` : '—'}</td>
      <td>${u.role === 'competitor' ? cred(u.gitPassword, 'Rotate git') : '<span class="muted">—</span>'}</td>
      <td class="small">${fmtTime(u.createdAt)}</td>
      <td><div class="row" style="justify-content:flex-end"><button class="btn sm" data-act="code">Reset code</button>
      ${u.role === 'competitor' ? '<button class="btn sm" data-act="git">Rotate git</button>' : ''}
      ${u.id !== state.me.id ? '<button class="btn sm danger" data-act="delete">Delete</button>' : ''}</div></td></tr>`).join('')}
    </tbody></table></div>`;
  $('#add-user').onclick = () => createUserModal('competitor', () => route(), true);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const u = users.find((x) => x.id === Number(b.closest('[data-user]').dataset.user));
    try {
      if (b.dataset.act === 'code' && confirm(`Reset the access code for ${u.name}?`)) {
        await api('POST', `/api/users/${u.id}/reset-code`);
        toast(`New access code for ${u.name} – shown in the table`); route();
      }
      if (b.dataset.act === 'git' && confirm(`Issue a new git password for ${u.name}?`)) {
        await api('POST', `/api/users/${u.id}/rotate-git`); toast(`New git password for ${u.name} – shown in the table`); route();
      }
      if (b.dataset.act === 'delete') {
        const typed = prompt(`Delete ${u.name} and ALL their repositories, deployments and databases?\nType DELETE to confirm:`);
        if (typed === 'DELETE') { await api('DELETE', `/api/users/${u.id}`); toast('Deleted'); route(); }
      }
    } catch (err) { fail(err); }
  });
}

route();
