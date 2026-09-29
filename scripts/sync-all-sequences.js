require('dotenv').config();
const { Client } = require('pg');

const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });

async function syncSequences(targetClient, label) {
  console.log(`\n=== SYNCHRONIZING ALL DATABASE SEQUENCES (${label}) ===\n`);

  // 1. Get all sequences linked to columns
  const seqRes = await targetClient.query(`
    SELECT 
      c.table_name, 
      c.column_name, 
      pg_get_serial_sequence('"' || c.table_name || '"', c.column_name) as seq_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' 
      AND t.table_type = 'BASE TABLE'
      AND (c.column_default LIKE 'nextval%' OR c.is_identity = 'YES')
    ORDER BY c.table_name, c.column_name;
  `);

  console.log(`Found ${seqRes.rows.length} columns with sequences.\n`);

  let updatedCount = 0;
  for (const row of seqRes.rows) {
    if (!row.seq_name) continue;
    try {
      const maxRes = await targetClient.query(`SELECT MAX("${row.column_name}") as max_val FROM "${row.table_name}"`);
      const maxVal = maxRes.rows[0].max_val;

      const seqRes = await targetClient.query(`SELECT last_value, is_called FROM ${row.seq_name}`);
      const currVal = seqRes.rows[0].last_value;

      if (maxVal !== null) {
        await targetClient.query(`
          SELECT setval($1, $2, true);
        `, [row.seq_name, maxVal]);
        console.log(`✅ [${row.table_name}.${row.column_name}] max: ${maxVal} (was seq: ${currVal}) -> reset to ${maxVal}`);
        updatedCount++;
      } else {
        await targetClient.query(`
          SELECT setval($1, 1, false);
        `, [row.seq_name]);
        console.log(`ℹ️ [${row.table_name}.${row.column_name}] empty table -> reset seq to 1 (is_called: false)`);
      }
    } catch (err) {
      console.error(`❌ Error on ${row.table_name}.${row.column_name}:`, err.message);
    }
  }

  // 2. Also check any standalone sequences in the public schema
  const standaloneRes = await targetClient.query(`
    SELECT sequence_name 
    FROM information_schema.sequences 
    WHERE sequence_schema = 'public';
  `);
  console.log(`\nVerified all ${standaloneRes.rows.length} sequences in schema 'public'. Updated ${updatedCount} sequences.`);
}

async function main() {
  await client.connect();
  await syncSequences(client, "ACTIVE SUPABASE / LOCAL DB");
  await client.end();
}

main().catch(console.error);
