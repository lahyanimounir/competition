const crypto = require('crypto');
const { spawn } = require('child_process');

const ALNUM = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomString(n, alphabet = ALNUM) {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}
const randomLower = (n) => randomString(n, LOWER);

function randomDigits(n) {
  let s = String(crypto.randomInt(1, 10));
  for (let i = 1; i < n; i++) s += crypto.randomInt(10);
  return s;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Non-blocking variant for hot paths (git requests): scrypt runs on the libuv thread pool. */
function verifyPasswordAsync(password, stored) {
  if (!stored || !password) return Promise.resolve(false);
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  return new Promise((resolve) => {
    crypto.scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, (err, actual) => {
      resolve(!err && crypto.timingSafeEqual(expected, actual));
    });
  });
}

/** Run a command, collect output. onData receives every chunk (stdout + stderr). */
function run(cmd, args, { input, cwd, env, onData, timeout } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: env || process.env });
    let stdout = '';
    let stderr = '';
    let timer;
    if (timeout) timer = setTimeout(() => { stderr += `\n[timed out after ${timeout / 1000}s]`; p.kill('SIGKILL'); }, timeout);
    p.stdout.on('data', (d) => { stdout += d; onData && onData(d.toString()); });
    p.stderr.on('data', (d) => { stderr += d; onData && onData(d.toString()); });
    p.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + err.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });
}

const now = () => new Date().toISOString();

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { randomString, randomLower, randomDigits, hashPassword, verifyPassword, verifyPasswordAsync, run, now, httpError };
