// Competition timer: one shared countdown controlled by administrators, plus extra time per
// competitor (users.extra_seconds). Clients receive the server time to correct their own clock.
const { q, getSetting, setSetting } = require('./db');
const { httpError } = require('./util');

const DEFAULT = { title: 'Competition', durationSec: 3 * 3600, status: 'idle', endsAt: null, remainingSec: 3 * 3600 };

function load() {
  try { return { ...DEFAULT, ...JSON.parse(getSetting('timer', '{}')) }; } catch { return { ...DEFAULT }; }
}
const save = (t) => setSetting('timer', JSON.stringify(t));

/** Seconds left on the shared timer (without any competitor's extra time). */
function remaining(t, nowMs = Date.now()) {
  if (t.status === 'running') return Math.max(0, Math.round((Date.parse(t.endsAt) - nowMs) / 1000));
  return Math.max(0, Math.round(t.remainingSec));
}

const competitorsWithExtra = () => q.all(
  "SELECT id, name, extra_seconds AS extraSeconds FROM users WHERE role = 'competitor' AND extra_seconds > 0 ORDER BY name",
);

/** Everything a screen needs to draw the countdown(s). */
function state() {
  const t = load();
  return {
    title: t.title,
    status: t.status, // idle | running | paused
    durationSec: t.durationSec,
    endsAt: t.status === 'running' ? t.endsAt : null,
    remainingSec: remaining(t),
    serverNow: new Date().toISOString(),
  };
}

/** Administrator actions. */
function control(action, body = {}) {
  const t = load();
  const nowMs = Date.now();
  switch (action) {
    case 'set': {
      const minutes = Number(body.minutes);
      if (!(minutes > 0 && minutes <= 24 * 60)) throw httpError(400, 'Duration must be 1-1440 minutes');
      if (t.status === 'running') throw httpError(409, 'Pause or reset the timer before changing its duration');
      t.title = String(body.title || t.title).trim().slice(0, 120) || DEFAULT.title;
      t.durationSec = Math.round(minutes * 60);
      if (t.status === 'idle') t.remainingSec = t.durationSec;
      break;
    }
    case 'start':
      if (t.status === 'running') throw httpError(409, 'The timer is already running');
      t.endsAt = new Date(nowMs + remaining(t, nowMs) * 1000).toISOString();
      t.status = 'running';
      break;
    case 'pause':
      if (t.status !== 'running') throw httpError(409, 'The timer is not running');
      t.remainingSec = remaining(t, nowMs);
      t.endsAt = null;
      t.status = 'paused';
      break;
    case 'reset':
      t.status = 'idle';
      t.endsAt = null;
      t.remainingSec = t.durationSec;
      if (body.clearExtra) q.run("UPDATE users SET extra_seconds = 0 WHERE role = 'competitor'");
      break;
    case 'add': { // add (or remove, if negative) minutes for EVERYONE
      const sec = Math.round(Number(body.minutes) * 60);
      if (!sec || Math.abs(sec) > 24 * 3600) throw httpError(400, 'Invalid number of minutes');
      if (t.status === 'running') t.endsAt = new Date(Math.max(nowMs, Date.parse(t.endsAt) + sec * 1000)).toISOString();
      else t.remainingSec = Math.max(0, remaining(t, nowMs) + sec);
      break;
    }
    default:
      throw httpError(400, 'Unknown timer action');
  }
  save(t);
  return state();
}

/** Extra time for one competitor: add minutes (may be negative) or clear. */
function setExtra(userId, { addMinutes, clear }) {
  const u = q.get("SELECT id, name, extra_seconds FROM users WHERE id = ? AND role = 'competitor'", userId);
  if (!u) throw httpError(404, 'Competitor not found');
  let extra = clear ? 0 : (u.extra_seconds || 0) + Math.round(Number(addMinutes) * 60);
  if (!clear && !Number.isFinite(extra)) throw httpError(400, 'Invalid number of minutes');
  extra = Math.max(0, Math.min(extra, 24 * 3600));
  q.run('UPDATE users SET extra_seconds = ? WHERE id = ?', extra, u.id);
  return { id: u.id, name: u.name, extraSeconds: extra };
}

module.exports = { state, control, setExtra, competitorsWithExtra };
