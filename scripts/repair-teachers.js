#!/usr/bin/env node
/**
 * One-time repair script to fix teacher branchId, email, phone, and photo mappings.
 *
 * Usage:
 *   node scripts/repair-teachers.js
 *   node scripts/repair-teachers.js --dry-run
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { mapRows } = require('../lib/parseMysqlInsert')

const dryRun = process.argv.includes('--dry-run')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const sqlFile = '/home/ebordev/Documents/2026_jobs/ugbekun 2.0/ugbekunc_Saas_June2026.sql'

async function main() {
  console.log(dryRun ? '[DRY RUN] Repairing teacher profiles...' : 'Repairing teacher profiles...')
  
  if (!fs.existsSync(sqlFile)) {
    throw new Error(`Legacy SQL file not found: ${sqlFile}`)
  }

  console.log('Parsing legacy SQL dump for staff records...')
  const sql = fs.readFileSync(sqlFile, 'utf8')
  const staff = mapRows(sql, 'staff', [
    'id', 'staff_id', 'name', 'department', 'qualification', 'experience_details', 'total_experience', 'designation', 'joining_date', 'birthday', 'sex', 'religion', 'blood_group', 'present_address', 'permanent_address', 'mobileno', 'email', 'salary_template_id', 'branch_id', 'photo', 'facebook_url', 'linkedin_url', 'twitter_url', 'created_at', 'updated_at'
  ])

  const staffMap = new Map(staff.map(s => [s.id, s]))
  console.log(`Parsed ${staff.length} legacy staff records.`)

  const branches = await prisma.branch.findMany({ select: { id: true } })
  const validBranchIds = new Set(branches.map(b => b.id))
  console.log(`Found ${validBranchIds.size} valid branches in database.`)

  const teachers = await prisma.teacher.findMany({
    orderBy: { id: 'asc' }
  })
  console.log(`Found ${teachers.length} teachers in database.`)

  let updatedCount = 0
  let unchangedCount = 0
  let noMatchCount = 0

  for (const t of teachers) {
    const s = staffMap.get(t.id)
    if (!s) {
      console.warn(`[WARN] No legacy staff record found for teacher ID ${t.id} (${t.name})`)
      noMatchCount++
      continue
    }

    const updates = {}

    // 1. Resolve branchId
    const legacyBranchId = s.branch_id
    const targetBranchId = legacyBranchId && validBranchIds.has(legacyBranchId) ? legacyBranchId : null
    if (t.branchId !== targetBranchId) {
      updates.branchId = targetBranchId
    }

    // 2. Resolve email
    const targetEmail = s.email || null
    if (t.email !== targetEmail) {
      updates.email = targetEmail
    }

    // 3. Resolve phone
    const targetPhone = s.mobileno || null
    if (t.phone !== targetPhone) {
      updates.phone = targetPhone
    }

    // 4. Resolve photo
    const targetPhoto = s.photo || null
    if (t.photo !== targetPhoto) {
      updates.photo = targetPhoto
    }

    // 5. Resolve name (if name is different/stale)
    const targetName = s.name || t.name
    if (t.name !== targetName) {
      updates.name = targetName
    }

    if (Object.keys(updates).length > 0) {
      console.log(`[UPDATE] Teacher ID: ${t.id} (${t.name}) -> updates:`, updates)
      if (!dryRun) {
        await prisma.teacher.update({
          where: { id: t.id },
          data: updates
        })
      }
      updatedCount++
    } else {
      unchangedCount++
    }
  }

  console.log('\nRepair Execution Summary:')
  console.log(`  Total teachers audited: ${teachers.length}`)
  console.log(`  Updated teacher profiles: ${updatedCount}`)
  console.log(`  Unchanged teacher profiles: ${unchangedCount}`)
  console.log(`  Missing legacy staff matches: ${noMatchCount}`)
  if (dryRun) {
    console.log('  (Dry run mode — no database updates were applied)')
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error('Repair failed:', error)
    await prisma.$disconnect()
    process.exit(1)
  })
  .finally(async () => {
    await pool.end()
  })
