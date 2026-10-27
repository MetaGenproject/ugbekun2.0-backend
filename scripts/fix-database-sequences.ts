import { prisma } from '/home/ebordev/Documents/2026_jobs/ugbekun 2.0/ugbekun2.0-backend/ugbekun2.0-backend/lib/prisma';

async function fixSequences() {
  console.log('=== FIXING DATABASE SEQUENCES ===');

  // Fix enroll_id_seq
  const maxEnrollRes: any = await prisma.$queryRawUnsafe(`SELECT COALESCE(MAX(id), 1) as max_id FROM "enroll"`);
  const maxEnrollId = Number(maxEnrollRes[0].max_id);
  console.log(`Setting enroll_id_seq to ${maxEnrollId}...`);
  await prisma.$queryRawUnsafe(`SELECT setval('enroll_id_seq', ${maxEnrollId})`);

  // Verify
  const verifyEnroll: any = await prisma.$queryRawUnsafe(`SELECT last_value FROM enroll_id_seq`);
  console.log(`enroll_id_seq is now at:`, verifyEnroll[0].last_value);

  // Check and fix promotion_history_id_seq
  const maxPromoRes: any = await prisma.$queryRawUnsafe(`SELECT COALESCE(MAX(id), 1) as max_id FROM "promotion_history"`);
  const maxPromoId = Number(maxPromoRes[0].max_id);
  console.log(`Setting promotion_history_id_seq to ${maxPromoId}...`);
  await prisma.$queryRawUnsafe(`SELECT setval('promotion_history_id_seq', ${maxPromoId})`);

  // Check and fix all sequences in the public schema
  const seqs: any = await prisma.$queryRawUnsafe(`
    SELECT sequence_name 
    FROM information_schema.sequences 
    WHERE sequence_schema = 'public';
  `);

  let fixedCount = 0;
  for (const s of seqs) {
    const seqName = s.sequence_name;
    const tableName = seqName.replace(/_id_seq$/, '').replace(/_seq$/, '');
    try {
      const maxRes: any = await prisma.$queryRawUnsafe(`SELECT MAX(id) as max_id FROM "${tableName}"`);
      const maxId = maxRes[0]?.max_id;
      if (maxId !== null && maxId !== undefined) {
        const seqState: any = await prisma.$queryRawUnsafe(`SELECT last_value FROM "${seqName}"`);
        const lastVal = Number(seqState[0]?.last_value || 0);
        if (Number(maxId) > lastVal) {
          console.log(`Fixing ${seqName}: last_value was ${lastVal}, setting to ${maxId}`);
          await prisma.$queryRawUnsafe(`SELECT setval('${seqName}', ${Number(maxId)})`);
          fixedCount++;
        }
      }
    } catch {
      // Table name may differ, ignore
    }
  }

  console.log(`Finished sequence audit. Fixed ${fixedCount} additional sequences.`);
}

fixSequences()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
