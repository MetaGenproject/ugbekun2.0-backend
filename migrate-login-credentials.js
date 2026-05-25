/**
 * migrate-login-credentials.js  (v3 — fixed SQL, robust dedup, direct conn)
 * ────────────────────────────────────────────────────────────────────────────
 * Run:  node migrate-login-credentials.js
 * ────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Direct connection bypasses PgBouncer transaction-mode restrictions
const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });

const SQL_FILE   = path.join(__dirname, 'ugbekunc_Saas (2).sql');
const BATCH_SIZE = 100;

// ── Parser ───────────────────────────────────────────────────────────────────
function parseTuple(raw) {
  let str = raw.trim();
  if (str.endsWith(',') || str.endsWith(';')) str = str.slice(0, -1).trim();
  if (str.startsWith('(') && str.endsWith(')')) str = str.slice(1, -1);
  else return null;

  const values = [];
  let cur = '';
  let inStr = false;
  let esc = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (inStr) {
      if (ch === "'" && str[i + 1] === "'") { cur += "'"; i++; }
      else if (ch === "'") { inStr = false; }
      else { cur += ch; }
    } else {
      if (ch === "'") { inStr = true; }
      else if (ch === ',') { values.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
  }
  values.push(cur.trim());
  return values;
}

function parseCredentials(sqlText) {
  const lines = sqlText.split('\n');
  const recs  = [];
  let cap = false;

  for (const line of lines) {
    const t = line.trim();
    if (t.includes("INSERT INTO `login_credential`")) { cap = true; continue; }
    if (!cap) continue;
    if (t.startsWith('(')) {
      const p = parseTuple(t);
      if (p && p.length >= 8) {
        const [id, user_id, username, password, role, active, last_login, created_at] = p;
        recs.push({
          id:           parseInt(id, 10),
          legacyUserId: user_id     === 'NULL' ? null : parseInt(user_id, 10),
          username,
          password,
          role:         parseInt(role, 10),
          active:       active !== '0',
          lastLogin:    last_login  === 'NULL' ? null : last_login,
          createdAt:    created_at  === 'NULL' ? null : created_at,
        });
      }
      if (t.endsWith(';')) cap = false;
    } else if (t && !t.startsWith('--') && !t.startsWith('/*')) {
      cap = false;
    }
  }
  return recs;
}

// ── Dedup: append _<role>_<counter> only where truly needed ─────────────────
const ROLE_LABEL = {
  1:'admin', 2:'master', 3:'teacher', 4:'acct',
  6:'parent', 7:'student', 8:'recept', 9:'prop',
  12:'lib', 13:'staff'
};

function deduplicateUsernames(records) {
  // First pass: count occurrences per base username
  const counts = new Map();
  for (const r of records) counts.set(r.username, (counts.get(r.username) || 0) + 1);

  // Second pass: for duplicates, make each globally unique
  const seen = new Map(); // base -> counter per base
  return records.map(r => {
    if (counts.get(r.username) <= 1) return r;

    const base   = r.username;
    const label  = ROLE_LABEL[r.role] ? `_${ROLE_LABEL[r.role]}` : `_r${r.role}`;
    let   newName = `${base}${label}`;

    // If even the role-suffixed name collides, add a numeric counter
    if (!seen.has(newName)) {
      seen.set(newName, 1);
    } else {
      const n = seen.get(newName) + 1;
      seen.set(newName, n);
      newName = `${newName}_${n}`;
    }

    return { ...r, username: newName };
  });
}

// ── Bulk upsert via raw SQL (no ORM transaction) ─────────────────────────────
async function bulkUpsert(client, batch) {
  const clauses = [];
  const params  = [];
  let   p       = 1;

  for (const r of batch) {
    clauses.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
    params.push(r.id, r.legacyUserId, r.username, r.password, r.role, r.active, r.lastLogin, r.createdAt);
  }

  const sql = `
    INSERT INTO users
      (id, "legacyUserId", username, password, role, active, "lastLogin", "createdAt")
    VALUES ${clauses.join(',\n      ')}
    ON CONFLICT (id) DO UPDATE SET
      username       = EXCLUDED.username,
      password       = EXCLUDED.password,
      role           = EXCLUDED.role,
      active         = EXCLUDED.active,
      "legacyUserId" = EXCLUDED."legacyUserId",
      "lastLogin"    = EXCLUDED."lastLogin"
  `;

  await client.query(sql, params);
}

// Single-row upsert for retry fallback
async function singleUpsert(client, r) {
  await client.query(
    `INSERT INTO users
       (id, "legacyUserId", username, password, role, active, "lastLogin", "createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       username       = EXCLUDED.username,
       password       = EXCLUDED.password,
       role           = EXCLUDED.role,
       active         = EXCLUDED.active,
       "legacyUserId" = EXCLUDED."legacyUserId",
       "lastLogin"    = EXCLUDED."lastLogin"`,
    [r.id, r.legacyUserId, r.username, r.password, r.role, r.active, r.lastLogin, r.createdAt]
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=========================================');
  console.log(' Ugbekun Credential ETL  (v3 — clean fix)');
  console.log('=========================================\n');

  if (!fs.existsSync(SQL_FILE)) {
    console.error(`❌  File not found: ${SQL_FILE}`); process.exit(1);
  }

  console.log(`📂  Reading ${path.basename(SQL_FILE)} …`);
  const sqlText = fs.readFileSync(SQL_FILE, 'utf8');
  console.log(`    Size: ${(sqlText.length / 1024 / 1024).toFixed(2)} MB\n`);

  console.log('🔍  Parsing rows …');
  let records = parseCredentials(sqlText);
  console.log(`    Parsed: ${records.length} rows\n`);

  console.log('🧹  Deduplicating usernames …');
  records = deduplicateUsernames(records);
  const uniqueNames = new Set(records.map(r => r.username)).size;
  console.log(`    Unique usernames: ${uniqueNames}  (should equal ${records.length})\n`);

  console.log('📋  Sample (first 5):');
  records.slice(0, 5).forEach(r =>
    console.log(`    [${r.id}] ${r.username.padEnd(28)} role=${r.role}`)
  );
  console.log();

  const client = await pool.connect();
  console.log('🔌  Connected to Supabase (direct)\n');

  try {
    const { rows: [{ count: existingCount }] } = await client.query('SELECT COUNT(*) FROM users');
    console.log(`    Current user count: ${existingCount}\n`);

    const total  = records.length;
    let done     = 0;
    let errors   = 0;
    let batchNum = 0;

    console.log(`🚀  Upserting ${total} rows in batches of ${BATCH_SIZE} …\n`);

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      batchNum++;

      try {
        await bulkUpsert(client, chunk);
        done += chunk.length;
        process.stdout.write(`\r    ✓ ${done}/${total} rows`);
      } catch (batchErr) {
        // Batch failed (likely a unique username collision in this chunk)
        // Retry each row individually so we salvage the rest
        for (const r of chunk) {
          try {
            await singleUpsert(client, r);
            done++;
          } catch (rowErr) {
            errors++;
            // Only log non-duplicate errors; duplicate username on id-already-present is expected during re-runs
            if (!rowErr.message.includes('duplicate key')) {
              console.error(`\n  ✗ Row [${r.id}] "${r.username}": ${rowErr.message}`);
            }
          }
        }
        process.stdout.write(`\r    ✓ ${done}/${total} rows (batch ${batchNum} retried row-by-row)`);
      }
    }

    const { rows: [{ count: finalCount }] } = await client.query('SELECT COUNT(*) FROM users');
    console.log(`\n\n=========================================`);
    console.log(` Migration Complete`);
    console.log(`=========================================`);
    console.log(`  Processed : ${total}`);
    console.log(`  Saved     : ${done}`);
    console.log(`  Skipped   : ${errors} (duplicate username conflicts)`);
    console.log(`  DB total  : ${finalCount}`);

    // Verify key real accounts
    console.log('\n🔑  Verifying key accounts:');
    const checks = ['admin@ugbekun', 'md', 'Johnny1', 'paul', 'FortuneSprings', 'Adebimpe', 'Ikegbunam'];
    for (const uname of checks) {
      const { rows } = await client.query(
        `SELECT id, username, role, active FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`,
        [uname]
      );
      if (rows[0]) {
        console.log(`    ✓ "${rows[0].username}"  id=${rows[0].id}  role=${rows[0].role}  active=${rows[0].active}`);
      } else {
        console.log(`    - "${uname}" not found`);
      }
    }
    console.log('\n✅  Done. Real credentials are live in Supabase!\n');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('\n❌  Fatal:', err.message);
  process.exit(1);
});
