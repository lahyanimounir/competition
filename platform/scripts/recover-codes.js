// One-off: make the access codes of accounts created before credentials were stored encrypted
// visible in Administration -> Accounts, WITHOUT changing them.
// Access codes are short digit strings stored as HMAC(server secret, code), so the server can find
// each one by trying every possible code. (Git passwords are long random strings and cannot be
// recovered - use "Rotate git" for those.)
// Run on the server:  docker exec ws-platform node scripts/recover-codes.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { q } = require('../src/db');
const auth = require('../src/auth');

const PEPPER = fs.readFileSync(path.join(config.DATA_DIR, 'secret'), 'utf8').trim();

function findCode(hash, len) {
  // Codes never start with 0 (see util.randomDigits).
  const lo = 10 ** (len - 1);
  const hi = 10 ** len;
  for (let n = lo; n < hi; n++) {
    const code = String(n);
    if (crypto.createHmac('sha256', PEPPER).update(code).digest('hex') === hash) return code;
  }
  return null;
}

const users = q.all('SELECT id, role, name, code_hash FROM users WHERE code_enc IS NULL');
if (!users.length) console.log('Nothing to do - every account already has its access code stored.');
for (const u of users) {
  const t0 = Date.now();
  let code = null;
  for (const len of u.role === 'competitor' ? [6] : [8, 6, 7, 9, 10]) {
    code = findCode(u.code_hash, len);
    if (code) break;
  }
  if (code && auth.hashCode(code) === u.code_hash) {
    q.run('UPDATE users SET code_enc = ? WHERE id = ?', auth.seal(code), u.id);
    console.log(`recovered: ${u.role} "${u.name}" (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`not found: ${u.role} "${u.name}" - use Reset code`);
  }
}
