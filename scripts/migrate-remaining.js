const { Client } = require('pg');

const SOURCE_URL = process.env.SOURCE_DATABASE_URL || "postgresql://postgres.tvbnzpunfxgcsgdajxit:metagen%402026@aws-1-eu-central-2.pooler.supabase.com:5432/postgres?sslmode=disable";
const TARGET_URL = process.env.TARGET_DATABASE_URL || "postgresql://8v3cuZHtZ72Y:FvwG36CzuL9PUwpKGqKWprsc4@muddy-silence.repulsive-dolls-production.svc.cluster.local:5432/pipeops";

async function main() {
  console.log("=== COMPLETING MIGRATION FOR REMAINING TABLES ===");
  console.log("Migrating: users, question_bank, trivia_questions, staff_messages\n");

  const sourceClient = new Client({ connectionString: SOURCE_URL });
  const targetClient = new Client({ connectionString: TARGET_URL });

  await sourceClient.connect();
  console.log("✅ Connected to Source (Supabase)");
  await targetClient.connect();
  console.log("✅ Connected to Target (PipeOps)\n");

  // Step 1: Temporarily disable constraints
  await targetClient.query("SET session_replication_role = 'replica';");

  // ─────────────────────────────────────────────────────────────
  // 1. USERS
  // ─────────────────────────────────────────────────────────────
  console.log("[1/4] Migrating 'users' table...");
  // Add missing columns to users on target if not already present
  await targetClient.query(`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS email text,
    ADD COLUMN IF NOT EXISTS phone text,
    ADD COLUMN IF NOT EXISTS department text;
  `);

  await targetClient.query('TRUNCATE TABLE users CASCADE');
  const usersRes = await sourceClient.query('SELECT * FROM users');
  const userCols = Object.keys(usersRes.rows[0]);
  const quotedUserCols = userCols.map(c => `"${c}"`).join(', ');

  const CHUNK_SIZE = 500;
  for (let offset = 0; offset < usersRes.rows.length; offset += CHUNK_SIZE) {
    const chunk = usersRes.rows.slice(offset, offset + CHUNK_SIZE);
    const values = [];
    const placeholders = [];
    let p = 1;

    for (const row of chunk) {
      const rowPh = [];
      for (const col of userCols) {
        values.push(row[col]);
        rowPh.push(`$${p++}`);
      }
      placeholders.push(`(${rowPh.join(', ')})`);
    }

    await targetClient.query(
      `INSERT INTO users (${quotedUserCols}) VALUES ${placeholders.join(', ')}`,
      values
    );
  }

  // Reset users sequence
  await targetClient.query(`
    SELECT setval(
      pg_get_serial_sequence('users', 'id'), 
      COALESCE((SELECT MAX(id) FROM users), 1), 
      (SELECT MAX(id) FROM users) IS NOT NULL
    );
  `);
  console.log(`   ✅ Migrated ${usersRes.rows.length.toLocaleString()} users!\n`);

  // ─────────────────────────────────────────────────────────────
  // 2. QUESTION_BANK (Fix JSON serialization)
  // ─────────────────────────────────────────────────────────────
  console.log("[2/4] Migrating 'question_bank' table...");
  await targetClient.query('TRUNCATE TABLE question_bank CASCADE');
  const qbRes = await sourceClient.query('SELECT * FROM question_bank');
  if (qbRes.rows.length > 0) {
    const qbCols = Object.keys(qbRes.rows[0]);
    const quotedQbCols = qbCols.map(c => `"${c}"`).join(', ');

    for (let offset = 0; offset < qbRes.rows.length; offset += CHUNK_SIZE) {
      const chunk = qbRes.rows.slice(offset, offset + CHUNK_SIZE);
      const values = [];
      const placeholders = [];
      let p = 1;

      for (const row of chunk) {
        const rowPh = [];
        for (const col of qbCols) {
          let val = row[col];
          if (typeof val === 'object' && val !== null && !(val instanceof Date) && !Buffer.isBuffer(val)) {
            val = JSON.stringify(val);
          }
          values.push(val);
          rowPh.push(`$${p++}`);
        }
        placeholders.push(`(${rowPh.join(', ')})`);
      }

      await targetClient.query(
        `INSERT INTO question_bank (${quotedQbCols}) VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    await targetClient.query(`
      SELECT setval(
        pg_get_serial_sequence('question_bank', 'id'), 
        COALESCE((SELECT MAX(id) FROM question_bank), 1), 
        (SELECT MAX(id) FROM question_bank) IS NOT NULL
      );
    `);
    console.log(`   ✅ Migrated ${qbRes.rows.length.toLocaleString()} questions!\n`);
  }

  // ─────────────────────────────────────────────────────────────
  // 3. TRIVIA_QUESTIONS (Fix JSON serialization)
  // ─────────────────────────────────────────────────────────────
  console.log("[3/4] Migrating 'trivia_questions' table...");
  await targetClient.query('TRUNCATE TABLE trivia_questions CASCADE');
  const tqRes = await sourceClient.query('SELECT * FROM trivia_questions');
  if (tqRes.rows.length > 0) {
    const tqCols = Object.keys(tqRes.rows[0]);
    const quotedTqCols = tqCols.map(c => `"${c}"`).join(', ');

    const values = [];
    const placeholders = [];
    let p = 1;

    for (const row of tqRes.rows) {
      const rowPh = [];
      for (const col of tqCols) {
        let val = row[col];
        if (typeof val === 'object' && val !== null && !(val instanceof Date) && !Buffer.isBuffer(val)) {
          val = JSON.stringify(val);
        }
        values.push(val);
        rowPh.push(`$${p++}`);
      }
      placeholders.push(`(${rowPh.join(', ')})`);
    }

    await targetClient.query(
      `INSERT INTO trivia_questions (${quotedTqCols}) VALUES ${placeholders.join(', ')}`,
      values
    );

    await targetClient.query(`
      SELECT setval(
        pg_get_serial_sequence('trivia_questions', 'id'), 
        COALESCE((SELECT MAX(id) FROM trivia_questions), 1), 
        (SELECT MAX(id) FROM trivia_questions) IS NOT NULL
      );
    `);
    console.log(`   ✅ Migrated ${tqRes.rows.length.toLocaleString()} trivia questions!\n`);
  }

  // ─────────────────────────────────────────────────────────────
  // 4. STAFF_MESSAGES
  // ─────────────────────────────────────────────────────────────
  console.log("[4/4] Migrating 'staff_messages' table...");
  await targetClient.query(`
    CREATE TABLE IF NOT EXISTS staff_messages (
      id serial PRIMARY KEY,
      branch_id integer,
      sender_id integer,
      sender_type text,
      recipient_id integer,
      target_department text,
      subject text,
      message text,
      is_memo boolean DEFAULT false,
      created_at timestamp without time zone DEFAULT now()
    );
  `);
  await targetClient.query('TRUNCATE TABLE staff_messages CASCADE');
  const smRes = await sourceClient.query('SELECT * FROM staff_messages');
  if (smRes.rows.length > 0) {
    const smCols = Object.keys(smRes.rows[0]);
    const quotedSmCols = smCols.map(c => `"${c}"`).join(', ');

    const values = [];
    const placeholders = [];
    let p = 1;

    for (const row of smRes.rows) {
      const rowPh = [];
      for (const col of smCols) {
        values.push(row[col]);
        rowPh.push(`$${p++}`);
      }
      placeholders.push(`(${rowPh.join(', ')})`);
    }

    await targetClient.query(
      `INSERT INTO staff_messages (${quotedSmCols}) VALUES ${placeholders.join(', ')}`,
      values
    );

    await targetClient.query(`
      SELECT setval(
        pg_get_serial_sequence('staff_messages', 'id'), 
        COALESCE((SELECT MAX(id) FROM staff_messages), 1), 
        (SELECT MAX(id) FROM staff_messages) IS NOT NULL
      );
    `);
    console.log(`   ✅ Migrated ${smRes.rows.length.toLocaleString()} staff message!\n`);
  }

  // Re-enable constraints
  console.log("Re-enabling foreign key constraints on PipeOps...");
  await targetClient.query("SET session_replication_role = 'origin';");
  console.log("✅ Constraints re-enabled.\n");

  // FINAL VERIFICATION ACROSS ALL TABLES
  console.log("=========================================");
  console.log("VERIFYING FINAL ROW COUNT ON PIPEOPS:");
  const finalCountRes = await targetClient.query(`
    SELECT (xpath('/row/cnt/text()', xml_count))[1]::text::int as row_count
    FROM (
      SELECT query_to_xml(format('select count(*) as cnt from %I', table_name), false, true, '') as xml_count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ) t;
  `);
  const finalTotal = finalCountRes.rows.reduce((sum, r) => sum + (r.row_count || 0), 0);
  console.log(`🎉 GRAND TOTAL ROWS IN PIPEOPS: ${finalTotal.toLocaleString()} rows!`);
  console.log("=========================================");

  await sourceClient.end();
  await targetClient.end();
}

main().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
