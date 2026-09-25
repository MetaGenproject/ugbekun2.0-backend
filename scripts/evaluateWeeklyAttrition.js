require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const { processStudentAttritionRisk } = require('../lib/attritionManager');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function run() {
  console.log('[Weekly Attrition Radar] Starting evaluation job...');
  try {
    // Fetch all active students
    const students = await prisma.student.findMany({
      where: { active: true },
      select: { id: true, firstName: true, lastName: true }
    });

    console.log(`[Weekly Attrition Radar] Found ${students.length} active students to evaluate.`);

    let countHigh = 0;
    let countMedium = 0;
    let countLow = 0;

    for (const student of students) {
      try {
        const result = await processStudentAttritionRisk(student.id, prisma);
        if (result.riskLevel === 'HIGH') countHigh++;
        else if (result.riskLevel === 'MEDIUM') countMedium++;
        else countLow++;
      } catch (err) {
        console.error(`[Weekly Attrition Radar] Failed to process student ID ${student.id}:`, err.message);
      }
    }

    console.log('[Weekly Attrition Radar] Job finished successfully.');
    console.log(`[Weekly Attrition Radar] Summary:`);
    console.log(`  - HIGH Risk (Flagged & Isolated): ${countHigh}`);
    console.log(`  - MEDIUM Risk (Flagged): ${countMedium}`);
    console.log(`  - LOW Risk: ${countLow}`);

  } catch (error) {
    console.error('[Weekly Attrition Radar] Job failed with critical error:', error);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

run();
