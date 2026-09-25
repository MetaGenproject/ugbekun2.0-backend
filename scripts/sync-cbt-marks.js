#!/usr/bin/env node
/**
 * Migration script to populate Mark.cbtMark for existing student records
 * by pulling historical data from OnlineExamSubmission results.
 *
 * Usage:
 *   node scripts/sync-cbt-marks.js
 *   node scripts/sync-cbt-marks.js --dry-run
 */

require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')

const dryRun = process.argv.includes('--dry-run')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  console.log(dryRun ? '[DRY RUN] Syncing CBT marks...' : 'Syncing CBT marks...')

  // 1. Fetch all online exam submissions
  const submissions = await prisma.onlineExamSubmission.findMany({
    include: {
      onlineExam: true
    }
  })

  console.log(`Found ${submissions.length} online exam submissions.`)

  let updatedCount = 0
  let createdCount = 0
  let skippedCount = 0

  for (const sub of submissions) {
    if (sub.totalMark === null || sub.totalMark === undefined) {
      skippedCount++
      continue
    }

    const { studentId, totalMark, onlineExam } = sub
    const { classId, subjectId, sessionId, branchId } = onlineExam

    // Find any existing Mark records for this student, subject, class, session
    const existingMarks = await prisma.mark.findMany({
      where: {
        studentId,
        subjectId,
        classId,
        sessionId,
        branchId
      }
    })

    if (existingMarks.length > 0) {
      // Update all matching marks with the CBT score
      for (const mark of existingMarks) {
        if (mark.cbtMark !== String(totalMark)) {
          console.log(`[UPDATE] Mark ID: ${mark.id} for Student ID: ${studentId}, Subject ID: ${subjectId}. Setting cbtMark to ${totalMark}`)
          if (!dryRun) {
            await prisma.mark.update({
              where: { id: mark.id },
              data: { cbtMark: String(totalMark) }
            })
          }
          updatedCount++
        }
      }
    } else {
      // Find the student's sectionId for this session
      const enroll = await prisma.enroll.findFirst({
        where: {
          studentId,
          sessionId,
          branchId
        },
        select: { sectionId: true }
      })

      if (!enroll) {
        console.warn(`[WARN] No enrollment record found for Student ID: ${studentId} in Session ID: ${sessionId}. Skipped creation.`)
        skippedCount++
        continue
      }

      // Find an exam to link to (defaulting to the first exam in the session/branch)
      const exam = await prisma.exam.findFirst({
        where: {
          sessionId,
          branchId
        },
        orderBy: { id: 'asc' }
      })

      if (!exam) {
        console.warn(`[WARN] No Exam found for Session ID: ${sessionId}, Branch ID: ${branchId}. Skipped creation.`)
        skippedCount++
        continue
      }

      console.log(`[CREATE] Creating new Mark for Student ID: ${studentId}, Subject ID: ${subjectId}, Exam ID: ${exam.id}. Setting cbtMark to ${totalMark}`)
      if (!dryRun) {
        await prisma.mark.create({
          data: {
            studentId,
            subjectId,
            classId,
            sectionId: enroll.sectionId,
            examId: exam.id,
            cbtMark: String(totalMark),
            sessionId,
            branchId
          }
        })
      }
      createdCount++
    }
  }

  console.log('\nSync Execution Summary:')
  console.log(`  Submissions processed: ${submissions.length}`)
  console.log(`  Existing Marks updated: ${updatedCount}`)
  console.log(`  New Marks created: ${createdCount}`)
  console.log(`  Records skipped: ${skippedCount}`)
  if (dryRun) {
    console.log('  (Dry run mode — no database updates were applied)')
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error('Sync failed:', error)
    await prisma.$disconnect()
    process.exit(1)
  })
  .finally(async () => {
    await pool.end()
  })
