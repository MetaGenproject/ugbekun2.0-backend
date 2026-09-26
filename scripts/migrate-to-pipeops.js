const { Client } = require('pg');
const { execSync } = require('child_process');

const SOURCE_URL = process.env.SOURCE_DATABASE_URL || "postgresql://postgres.tvbnzpunfxgcsgdajxit:metagen%402026@aws-1-eu-central-2.pooler.supabase.com:5432/postgres?sslmode=disable";
const TARGET_URL = process.env.TARGET_DATABASE_URL || "postgresql://8v3cuZHtZ72Y:FvwG36CzuL9PUwpKGqKWprsc4@muddy-silence.repulsive-dolls-production.svc.cluster.local:5432/pipeops";

async function main() {
  console.log("=== UGBEKUN 2.0: DATABASE MIGRATION TO PIPEOPS ===");
  console.log("Source: Supabase PostgreSQL");
  console.log("Target: PipeOps PostgreSQL (Internal Cluster)\n");

  const sourceClient = new Client({ connectionString: SOURCE_URL });
  const targetClient = new Client({ connectionString: TARGET_URL });

  console.log("1. Connecting to Source and Target databases...");
  await sourceClient.connect();
  console.log("   ✅ Connected to Source (Supabase)");
  await targetClient.connect();
  console.log("   ✅ Connected to Target (PipeOps)\n");

  // Step 2: Push Prisma Schema to Target to create all tables, enums, indexes
  console.log("2. Ensuring all tables & schema exist on PipeOps database via Prisma...");
  try {
    let prismaBin = "./node_modules/.bin/prisma";
    try {
      require('fs').accessSync(prismaBin);
    } catch {
      prismaBin = "npx prisma";
    }
    execSync(`${prismaBin} db push --schema=./prisma/schema.prisma --accept-data-loss --url="${TARGET_URL}"`, {
      env: { ...process.env, DATABASE_URL: TARGET_URL },
      stdio: 'inherit'
    });
    console.log("   ✅ Prisma schema pushed successfully to PipeOps!\n");
  } catch (err) {
    console.error("   ⚠️ Warning on prisma db push:", err.message);
    console.log("   Proceeding with table inspection...\n");
  }

  // Step 3: Disable foreign keys & triggers on Target for fast, safe bulk loading
  console.log("3. Disabling foreign key constraints on target during data load...");
  await targetClient.query("SET session_replication_role = 'replica';");

  // Step 4: Get list of tables from Source
  const tablesRes = await sourceClient.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '_prisma%'
    ORDER BY table_name;
  `);

  const tables = tablesRes.rows.map(r => r.table_name);
  console.log(`4. Found ${tables.length} tables to migrate.\n`);

  let totalMigratedRows = 0;
  const results = [];

  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    const progress = `[${i + 1}/${tables.length}] ${table}`;
    process.stdout.write(`${progress.padEnd(45)} ... `);

    try {
      // Check source count
      const countRes = await sourceClient.query(`SELECT COUNT(*)::int as cnt FROM "${table}"`);
      const srcCount = countRes.rows[0].cnt;

      if (srcCount === 0) {
        process.stdout.write(`0 rows (empty)\n`);
        results.push({ table, src: 0, tgt: 0, status: 'EMPTY' });
        continue;
      }

      // Check if target table exists
      const targetTableExists = await targetClient.query(`
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = $1
      `, [table]);

      if (targetTableExists.rows.length === 0) {
        process.stdout.write(`⚠️ Target table does not exist, skipping\n`);
        results.push({ table, src: srcCount, tgt: 0, status: 'SKIPPED' });
        continue;
      }

      // Truncate target table
      await targetClient.query(`TRUNCATE TABLE "${table}" CASCADE`);

      // Get columns
      const colsRes = await sourceClient.query(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [table]);
      const columns = colsRes.rows.map(c => c.column_name);
      const quotedCols = columns.map(c => `"${c}"`).join(', ');

      // Stream / fetch in chunks (safe from Postgres 65,535 parameter limit)
      const CHUNK_SIZE = Math.min(1000, Math.floor(60000 / Math.max(columns.length, 1)));
      let offset = 0;
      let inserted = 0;

      while (offset < srcCount) {
        const rowsRes = await sourceClient.query(
          `SELECT ${quotedCols} FROM "${table}" LIMIT ${CHUNK_SIZE} OFFSET ${offset}`
        );
        const rows = rowsRes.rows;
        if (rows.length === 0) break;

        // Construct bulk INSERT
        const values = [];
        const valuePlaceholders = [];
        let paramIdx = 1;

        for (const row of rows) {
          const rowPlaceholders = [];
          for (const col of columns) {
            values.push(row[col]);
            rowPlaceholders.push(`$${paramIdx++}`);
          }
          valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
        }

        const insertQuery = `INSERT INTO "${table}" (${quotedCols}) VALUES ${valuePlaceholders.join(', ')}`;
        await targetClient.query(insertQuery, values);

        inserted += rows.length;
        offset += CHUNK_SIZE;
      }

      // Reset sequence if table has serial/auto-increment
      const seqRes = await targetClient.query(`
        SELECT column_name, pg_get_serial_sequence('"' || table_name || '"', column_name) as seq
        FROM information_schema.columns
        WHERE table_schema = 'public' 
          AND table_name = $1 
          AND column_default LIKE 'nextval%'
      `, [table]);

      for (const seqRow of seqRes.rows) {
        if (seqRow.seq) {
          await targetClient.query(`
            SELECT setval(
              $1, 
              COALESCE((SELECT MAX("${seqRow.column_name}") FROM "${table}"), 1), 
              (SELECT MAX("${seqRow.column_name}") FROM "${table}") IS NOT NULL
            )
          `, [seqRow.seq]);
        }
      }

      totalMigratedRows += inserted;
      process.stdout.write(`✅ ${inserted} rows\n`);
      results.push({ table, src: srcCount, tgt: inserted, status: 'COPIED' });

    } catch (tableErr) {
      process.stdout.write(`❌ Error: ${tableErr.message}\n`);
      results.push({ table, src: 0, tgt: 0, status: `ERROR: ${tableErr.message}` });
    }
  }

  // Step 5: Re-enable foreign keys & triggers
  console.log("\n5. Re-enabling foreign key constraints on target...");
  await targetClient.query("SET session_replication_role = 'origin';");
  console.log("   ✅ Constraints re-enabled.\n");

  console.log("=========================================");
  console.log(`MIGRATION COMPLETE!`);
  console.log(`Total Tables Processed: ${tables.length}`);
  console.log(`Total Rows Migrated:    ${totalMigratedRows.toLocaleString()}`);
  console.log("=========================================");

  await sourceClient.end();
  await targetClient.end();
}

main().catch(err => {
  console.error("FATAL MIGRATION ERROR:", err);
  process.exit(1);
});
