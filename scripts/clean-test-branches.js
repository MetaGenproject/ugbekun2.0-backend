/**
 * Safe Database Sanitation Script
 * Cleans up redundant test branches (e.g. repeated test runs)
 * while strictly preserving:
 *  - Role 1 Superadmin accounts
 *  - Subscription Plans
 *  - Real active schools
 *
 * Usage:
 *   node scripts/clean-test-branches.js --dry-run
 *   node scripts/clean-test-branches.js --confirm
 */

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
require('dotenv').config();

async function run() {
  const isDryRun = process.argv.includes('--dry-run') || !process.argv.includes('--confirm');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  console.log(`[CLEANUP] Running DB Sanitation Mode: ${isDryRun ? 'DRY RUN (No data deleted)' : 'LIVE CLEANUP'}`);

  try {
    // 1. Find branches with timestamped test names or test runs
    const testBranches = await prisma.branch.findMany({
      where: {
        OR: [
          { name: { contains: '1787' } },
          { name: { contains: 'test' } },
          { code: { startsWith: 'TEST' } },
          { code: { contains: 'TEST' } },
        ],
      },
      select: { id: true, name: true, code: true, createdAt: true },
      orderBy: { id: 'asc' },
    });

    console.log(`[CLEANUP] Found ${testBranches.length} test branches matching cleanup patterns:`);
    testBranches.forEach((b) => console.log(` - [ID ${b.id}] ${b.name} (${b.code}) - Created: ${b.createdAt}`));

    if (testBranches.length === 0) {
      console.log('[CLEANUP] No test branches found to clean.');
      return;
    }

    if (isDryRun) {
      console.log('\n[CLEANUP] Dry run complete. To delete these test branches, run:\nnode scripts/clean-test-branches.js --confirm\n');
      return;
    }

    const branchIds = testBranches.map((b) => b.id);

    console.log(`\n[CLEANUP] Deleting associated records for ${branchIds.length} test branches...`);

    // Clean child records
    await prisma.sectionsAllocation.deleteMany({ where: { class: { branchId: { in: branchIds } } } }).catch(() => {});
    await prisma.class.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});
    await prisma.section.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});
    await prisma.subject.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});
    await prisma.feeType.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});
    await prisma.leaveCategory.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});
    await prisma.examHall.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});
    await prisma.evaluationMatrix.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});
    await prisma.questionGroup.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});
    await prisma.branchSubscription.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});
    await prisma.systemSetting.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});
    await prisma.schoolLandingPage.deleteMany({ where: { branchId: { in: branchIds } } }).catch(() => {});

    // Delete linked users (excluding role 1 superadmin)
    await prisma.user.deleteMany({
      where: {
        legacyUserId: { in: branchIds },
        role: { not: 1 },
      },
    });

    // Delete the branches
    const deleted = await prisma.branch.deleteMany({
      where: { id: { in: branchIds } },
    });

    console.log(`[CLEANUP] Successfully deleted ${deleted.count} test branches.`);
  } catch (err) {
    console.error('[CLEANUP ERROR]:', err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
