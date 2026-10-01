#!/usr/bin/env node
/**
 * Repair script to fix school admin (role 2 and role 9) legacyUserId mappings.
 *
 * Usage:
 *   node scripts/repair-branch-admin-legacy-userid.js
 *   node scripts/repair-branch-admin-legacy-userid.js --dry-run
 */

require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
function extractCodePrefix(code) {
  if (!code) return '';
  const match = String(code).match(/^([A-Za-z]+)/);
  return match ? match[1] : '';
}

function staffMatchesBranch(username, branch) {
  const normalized = String(username || '').trim();
  if (!normalized) return false;

  const lowerUsername = normalized.toLowerCase();
  const prefix = extractCodePrefix(branch.code);
  if (prefix && lowerUsername.startsWith(`${prefix.toLowerCase()}/`)) {
    return true;
  }

  const branchName = String(branch.name || '').trim();
  if (!branchName) return false;

  const lowerBranchName = branchName.toLowerCase();
  if (lowerUsername === lowerBranchName) return true;

  const branchSlug = lowerBranchName.split(/\s+/)[0];
  if (branchSlug && (lowerUsername === branchSlug || lowerBranchName.includes(lowerUsername))) {
    return true;
  }

  const cleanUser = lowerUsername.replace(/[^a-z0-9]/g, '');
  const cleanBranch = lowerBranchName.replace(/[^a-z0-9]/g, '');
  if (cleanUser.length >= 4 && cleanBranch.length >= 4) {
    if (cleanBranch.includes(cleanUser) || cleanUser.includes(cleanBranch)) {
      return true;
    }
  }

  return false;
}

const dryRun = process.argv.includes('--dry-run')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

// Explicit overrides verified by domain name & branch registry
const EXPLICIT_OVERRIDES = {
  'FortuneSprings': 11,    // Fortune Springs Montessori School (FSMS)
  'Fortunescholars': 43,   // FORTUNE SCHOLARS SCHOOL (001)
  'Greatrisingstars': 22,  // Great Legacy Rising Stars (BR22)
  'BISNIY': 12,            // BISNIY PRIVATE SCHOOL (BR12)
  'Nita-angel': 14,        // NITA ANGELS ACADEMY (BR14)
  'Gracious': 15,          // Gracious Daystar International Academy (GDSI15)
  'igbinovia': 16,         // Igbinovia Group of Schools (IGBS00116)
  'Bryte': 17,             // BRYTE STAR DIVINE ACADEMY (BSDA)
  'Ojomoh': 20,            // OJOMOH EDUCATION CENTRE (OJO)
  'Solidstone': 21,        // Solid Stone Kiddies Academy (SSKAS)
  'newera': 23,            // New Era International Schools (BR23)
  'scholastica': 25,       // Scholastica International Schools (BR25)
  'Psalm 23': 26,          // Psalm 23 international Academy (P2326)
  'Standardfresh': 27,     // ROYAL STANDARD FRESH ACADEMY (RSDF27)
  'hercleus': 28,          // Hercleus Academy (HERC)
  'Absiza': 29,            // Absiza International College (BR29)
  'Mayor': 30,             // MAYOR SCHOOL (Stud00130)
  'Mayor school': 30,      // MAYOR SCHOOL (Stud00130)
  'Joshdan': 31,           // JOSHDAN INTERNATIONAL ACADEMY (JIAS31)
  'Canaan Gate': 33,       // Canaan Gate Schools (CGS01)
  'Rufai': 34,             // CANAAN GATE SCHOOLS (RUFAI BRANCH) (CGSS)
  'Canaan Ilogbo': 35,     // CANAAN GATE SCHOOL (ILOGBO) (CLSIS00135)
  'Ilogbo': 35,            // CANAAN GATE SCHOOL (ILOGBO) (CLSIS00135)
  'Shadeb': 36,            // SHADEB COLLEGE (BR36)
  'Cradle': 37,            // CRADLE HOME CHILDREN SCHOOL (CHCSS00)
  'He Lives': 38,          // HE LIVES SCHOOL (HLSS00138)
  'Merit': 39,             // Merit Futures Academy (BR39)
  'ELCINTAR': 40,          // EL CINTAR CITY ACADEMY (ELCCAS)
  'Provident': 41,         // PROVIDENT DIRECTION SCHOOL (PDSS00)
  'Damzy': 42,             // DAMZY SCHOOLS (DAM001)
}

async function main() {
  console.log(`Starting branch-admin legacyUserId repair (dryRun: ${dryRun})...\n`)
  const branchAdmins = await prisma.user.findMany({
    where: { role: { in: [2, 9] } },
    select: { id: true, username: true, role: true, legacyUserId: true, active: true },
    orderBy: { id: 'asc' }
  })

  const branches = await prisma.branch.findMany({
    select: { id: true, name: true, code: true, active: true },
  })

  const branchById = new Map(branches.map((branch) => [branch.id, branch]))

  let fixed = 0
  let unchanged = 0
  let noMatch = 0

  for (const user of branchAdmins) {
    const username = String(user.username || '').trim()
    if (!username) {
      noMatch += 1
      continue
    }

    let targetBranch = null

    // 1. Check explicit overrides first (for known mismatches)
    if (EXPLICIT_OVERRIDES[username]) {
      targetBranch = branchById.get(EXPLICIT_OVERRIDES[username])
    } else if (user.legacyUserId && branchById.has(user.legacyUserId)) {
      // Already has a valid existing branch mapping, do not touch unless in EXPLICIT_OVERRIDES
      const currentBranch = branchById.get(user.legacyUserId)
      unchanged += 1
      console.log(`[VALID MAPPING] user id=${user.id} username="${username}" already points to valid branch id=${currentBranch.id} (${currentBranch.name})`)
      continue
    } else {
      // 2. Try staffMatchesBranch for unmapped or invalid legacyUserIds
      const matches = branches.filter((branch) => staffMatchesBranch(username, branch))
      if (matches.length === 1) {
        targetBranch = matches[0]
      } else if (matches.length > 1) {
        console.warn(`[AMBIGUOUS] user id=${user.id} username="${username}" matched multiple branches: ${matches.map(b => b.name).join(', ')}`)
      }
    }

    // 3. If target branch resolved:
    if (targetBranch) {
      if (user.legacyUserId === targetBranch.id) {
        unchanged += 1
        console.log(`[OK] user id=${user.id} username="${username}" already mapped to branch id=${targetBranch.id} (${targetBranch.name})`)
        continue
      }

      console.log(`[FIX] user id=${user.id} username="${username}" legacyUserId: ${user.legacyUserId} -> ${targetBranch.id} ("${targetBranch.name}")`)
      if (!dryRun) {
        await prisma.user.update({
          where: { id: user.id },
          data: { legacyUserId: targetBranch.id },
        })
      }
      fixed += 1
      continue
    }

    // If no target branch found, check if current legacyUserId is valid
    if (user.legacyUserId && branchById.has(user.legacyUserId)) {
      const currentBranch = branchById.get(user.legacyUserId)
      unchanged += 1
      console.log(`[UNMATCHED BUT VALID] user id=${user.id} username="${username}" retains branch id=${currentBranch.id} (${currentBranch.name})`)
    } else {
      noMatch += 1
      console.warn(`[NO MATCH & INVALID] user id=${user.id} username="${username}" legacyUserId=${user.legacyUserId}`)
    }
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
