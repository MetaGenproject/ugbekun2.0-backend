#!/usr/bin/env node
/**
 * One-time repair script to fix branch admin legacyUserId mappings.
 *
 * Usage:
 *   node scripts/repair-branch-admin-legacy-userid.js
 *   node scripts/repair-branch-admin-legacy-userid.js --dry-run
 */

require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { staffMatchesBranch } = require('../lib/branchStats')

const dryRun = process.argv.includes('--dry-run')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  console.log('Repairing branch-admin legacyUserId mappings...')
  const branchAdmins = await prisma.user.findMany({
    where: { role: 2 },
    select: { id: true, username: true, legacyUserId: true, active: true },
  })

  const branches = await prisma.branch.findMany({
    select: { id: true, name: true, code: true, active: true },
  })

  const branchById = new Map(branches.map((branch) => [branch.id, branch]))

  let fixed = 0
  let unchanged = 0
  let noMatch = 0

  for (const user of branchAdmins) {
    const hasValidBranch = user.legacyUserId && branchById.has(user.legacyUserId)
    if (hasValidBranch) {
      unchanged += 1
      continue
    }

    const username = String(user.username || '').trim()
    if (!username) {
      noMatch += 1
      console.warn(`[SKIP] user id=${user.id} has no username`) // impossible, but defend.
      continue
    }

    const matches = branches.filter((branch) => staffMatchesBranch(username, branch))
    if (matches.length === 1) {
      const branch = matches[0]
      console.log(`[FIX] user id=${user.id} username=${username} -> branch id=${branch.id} name="${branch.name}" code="${branch.code}"`)
      if (!dryRun) {
        await prisma.user.update({
          where: { id: user.id },
          data: { legacyUserId: branch.id },
        })
      }
      fixed += 1
      continue
    }

    if (matches.length > 1) {
      const matchList = matches.map((b) => `${b.id}:${b.code || b.name}`).join(', ')
      console.warn(`[AMBIGUOUS] user id=${user.id} username=${username} matched multiple branches: ${matchList}`)
      noMatch += 1
      continue
    }

    console.warn(`[NO MATCH] user id=${user.id} username=${username} legacyUserId=${user.legacyUserId}`)
    noMatch += 1
  }

  console.log('\nRepair summary:')
  console.log(`  branch-admin users scanned: ${branchAdmins.length}`)
  console.log(`  already valid mappings: ${unchanged}`)
  console.log(`  fixed mappings: ${fixed}`)
  console.log(`  unresolved users: ${noMatch}`)
  if (dryRun) {
    console.log('  (dry-run mode: no database changes were applied)')
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error('Repair failed:', error)
    await prisma.$disconnect()
    process.exit(1)
  })
