#!/usr/bin/env node
/**
 * Import legacy MySQL dumps into Postgres (Prisma schema).
 *
 * Usage:
 *   node scripts/import-legacy-data.js
 *   node scripts/import-legacy-data.js --dry-run
 *   node scripts/import-legacy-data.js --file /path/to/dump.sql
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { mapRows, parseDate, normalizeBcryptHash } = require('../lib/parseMysqlInsert')

const DEFAULT_SQL = path.join(__dirname, '../ugbekunc_Saas_June2026.sql')
const LEGACY_SQL_FILES = {
  credentials: path.resolve(__dirname, '../../../ugbekunc_Saas (2).sql'),
  parents: path.resolve(__dirname, '../../../ugbekunc_Saas (Parents).sql'),
  students: path.resolve(__dirname, '../../../ugbekunc_Saas (Students).sql'),
  teachers: path.resolve(__dirname, '../../../ugbekunc_Saas (Teacher).sql'),
}

const BATCH = 400
const dryRun = process.argv.includes('--dry-run')
const fileArgIdx = process.argv.indexOf('--file')
const sqlFile = fileArgIdx >= 0
  ? path.resolve(process.argv[fileArgIdx + 1])
  : DEFAULT_SQL

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

function readSqlFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`SQL file not found: ${filePath}`)
  }
  return fs.readFileSync(filePath, 'utf8')
}

function readLegacySql(key) {
  const file = LEGACY_SQL_FILES[key]
  if (!fs.existsSync(file)) {
    throw new Error(`Legacy SQL file not found: ${file}`)
  }
  return fs.readFileSync(file, 'utf8')
}

async function batchCreate(model, rows, label) {
  if (!rows.length) return 0
  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    if (dryRun) {
      inserted += chunk.length
      continue
    }
    const result = await prisma[model].createMany({ data: chunk, skipDuplicates: true })
    inserted += result.count
    process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length}`)
  }
  if (!dryRun && rows.length) process.stdout.write('\n')
  return inserted
}

function buildBranchCode(branchId, prefix) {
  if (prefix) return `${prefix}${branchId}`
  return `BR${branchId}`
}

function extractPrefixFromSetting(value) {
  if (!value) return null
  const cleaned = String(value).trim()
  if (!cleaned) return null
  const token = cleaned.split(/[\s/]+/).find(Boolean)
  if (!token) return null
  return token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || null
}

function parseCombinedDump(sql) {
  const legacyBranches = mapRows(sql, 'branch', [
    'id', 'name', 'school_name', 'email', 'mobileno', 'currency', 'symbol', 'currency_formats',
    'symbol_position', 'city', 'state', 'address', 'stu_generate', 'stu_username_prefix',
    'stu_default_password', 'grd_generate', 'grd_username_prefix', 'grd_default_password',
    'teacher_restricted', 'due_days', 'due_with_fine', 'translation', 'timezone', 'weekends',
    'reg_prefix_enable', 'student_login', 'parent_login', 'teacher_mobile_visible',
    'teacher_email_visible', 'reg_start_from', 'institution_code', 'reg_prefix_digit',
    'offline_payments', 'attendance_type', 'show_own_question', 'status', 'unique_roll',
    'default_admitcard_temp', 'default_marksheet_temp', 'created_at', 'updated_at',
  ])

  const credentials = mapRows(sql, 'login_credential', [
    'id', 'user_id', 'username', 'password', 'role', 'active', 'last_login', 'created_at', 'updated_at',
  ])

  const parents = mapRows(sql, 'parent', [
    'id', 'name', 'relation', 'father_name', 'mother_name', 'occupation', 'income', 'education',
    'email', 'mobileno', 'address', 'city', 'state', 'branch_id', 'photo',
    'facebook_url', 'linkedin_url', 'twitter_url', 'created_at', 'updated_at', 'active',
  ])

  const students = mapRows(sql, 'student', [
    'id', 'register_no', 'admission_date', 'first_name', 'last_name', 'gender', 'birthday',
    'religion', 'caste', 'blood_group', 'mother_tongue', 'current_address', 'permanent_address',
    'city', 'state', 'mobileno', 'category_id', 'email', 'parent_id', 'route_id',
    'stoppage_point_id', 'vehicle_id', 'hostel_id', 'room_id', 'previous_details', 'photo',
    'active', 'created_at', 'updated_at',
  ])

  const allocations = mapRows(sql, 'teacher_allocation', [
    'id', 'class_id', 'section_id', 'teacher_id', 'session_id', 'branch_id',
  ])

  return { legacyBranches, credentials, parents, students, allocations }
}

function parseSplitLegacyDumps() {
  const credSql = readLegacySql('credentials')
  const parentSql = readLegacySql('parents')
  const studentSql = readLegacySql('students')
  const teacherSql = readLegacySql('teachers')

  const credentials = mapRows(credSql, 'login_credential', [
    'id', 'user_id', 'username', 'password', 'role', 'active', 'last_login', 'created_at', 'updated_at',
  ])

  const parents = mapRows(parentSql, 'parent', [
    'id', 'name', 'relation', 'father_name', 'mother_name', 'occupation', 'income', 'education',
    'email', 'mobileno', 'address', 'city', 'state', 'branch_id', 'photo',
    'facebook_url', 'linkedin_url', 'twitter_url', 'created_at', 'updated_at', 'active',
  ])

  const students = mapRows(studentSql, 'student', [
    'id', 'register_no', 'admission_date', 'first_name', 'last_name', 'gender', 'birthday',
    'religion', 'caste', 'blood_group', 'mother_tongue', 'current_address', 'permanent_address',
    'city', 'state', 'mobileno', 'category_id', 'email', 'parent_id', 'route_id',
    'stoppage_point_id', 'vehicle_id', 'hostel_id', 'room_id', 'previous_details', 'photo',
    'active', 'created_at', 'updated_at',
  ])

  const allocations = mapRows(teacherSql, 'teacher_allocation', [
    'id', 'class_id', 'section_id', 'teacher_id', 'session_id', 'branch_id',
  ])

  return { legacyBranches: null, credentials, parents, students, allocations }
}

function buildImportRows({ legacyBranches, credentials, parents, students, allocations }) {
  const credByRole = (role) => credentials.filter((c) => c.role === role)
  const branchAdmins = credByRole(2)
  const adminByBranchId = new Map(branchAdmins.map((a) => [a.user_id, a]))

  let branchIds
  let branchRows

  if (legacyBranches?.length) {
    branchIds = new Set(legacyBranches.map((b) => b.id))
    branchRows = legacyBranches.map((b) => {
      const prefix = extractPrefixFromSetting(b.stu_username_prefix)
        || extractPrefixFromSetting(b.institution_code)
      const code = b.institution_code
        ? String(b.institution_code)
        : buildBranchCode(b.id, prefix)

      return {
        id: b.id,
        name: b.school_name || b.name || `School Branch ${b.id}`,
        code,
        address: b.address || null,
        city: b.city || null,
        state: b.state || null,
        phone: b.mobileno || null,
        email: b.email || null,
        adminName: adminByBranchId.get(b.id)?.username || b.name || null,
        active: b.status === 1,
        createdAt: parseDate(b.created_at) || new Date(),
        updatedAt: parseDate(b.updated_at),
      }
    })
  } else {
    branchIds = new Set()
    for (const admin of branchAdmins) branchIds.add(admin.user_id)
    for (const p of parents) if (p.branch_id) branchIds.add(p.branch_id)
    for (const a of allocations) if (a.branch_id) branchIds.add(a.branch_id)

    const parentBranchById = new Map(parents.map((p) => [p.id, p.branch_id]))
    const branchPrefixVotes = new Map()

    for (const s of students) {
      const branchId = parentBranchById.get(s.parent_id)
      if (!branchId || !s.register_no) continue
      const prefix = String(s.register_no).split('/')[0] || null
      if (!prefix || prefix.length > 8) continue
      if (!branchPrefixVotes.has(branchId)) branchPrefixVotes.set(branchId, new Map())
      const votes = branchPrefixVotes.get(branchId)
      votes.set(prefix, (votes.get(prefix) || 0) + 1)
    }

    const branchPrefix = new Map()
    for (const [branchId, votes] of branchPrefixVotes) {
      let best = null
      let bestCount = 0
      for (const [prefix, count] of votes) {
        if (count > bestCount) {
          best = prefix
          bestCount = count
        }
      }
      if (best) branchPrefix.set(branchId, best)
    }

    branchRows = [...branchIds]
      .sort((a, b) => a - b)
      .map((id) => {
        const admin = adminByBranchId.get(id)
        const prefix = branchPrefix.get(id)
        const adminName = admin?.username || null
        const name = prefix ? `${prefix} School` : adminName ? `${adminName} School` : `School Branch ${id}`
        return {
          id,
          name,
          code: buildBranchCode(id, prefix),
          adminName,
          active: true,
          createdAt: parseDate(admin?.created_at) || new Date(),
          updatedAt: parseDate(admin?.updated_at),
        }
      })
  }

  const parentIds = new Set(parents.map((p) => p.id))
  const parentBranchById = new Map(parents.map((p) => [p.id, p.branch_id]))

  const parentCredByProfileId = new Map()
  const studentCredByProfileId = new Map()
  for (const c of credentials) {
    if (c.role === 6) parentCredByProfileId.set(c.user_id, c)
    if (c.role === 7) studentCredByProfileId.set(c.user_id, c)
  }

  const usernameSeen = new Map()
  function resolveUsername(c) {
    const base = String(c.username || `user_${c.id}`).trim()
    const count = usernameSeen.get(base) || 0
    usernameSeen.set(base, count + 1)
    if (count === 0) return base
    return `${base}#${c.id}`
  }

  const userRows = credentials.map((c) => ({
    id: c.id,
    legacyUserId: c.user_id,
    username: resolveUsername(c),
    password: normalizeBcryptHash(c.password),
    role: c.role,
    active: c.active === 1,
    lastLogin: parseDate(c.last_login),
    createdAt: parseDate(c.created_at) || new Date(),
    updatedAt: parseDate(c.updated_at),
  }))

  const parentRows = parents.map((p) => ({
    id: p.id,
    name: p.name,
    relation: p.relation,
    fatherName: p.father_name,
    motherName: p.mother_name,
    occupation: p.occupation,
    income: p.income,
    education: p.education,
    email: p.email,
    mobileno: p.mobileno,
    address: p.address,
    city: p.city,
    state: p.state,
    photo: p.photo,
    facebookUrl: p.facebook_url,
    linkedinUrl: p.linkedin_url,
    twitterUrl: p.twitter_url,
    active: p.active === 0,
    branchId: p.branch_id && branchIds.has(p.branch_id) ? p.branch_id : null,
    userId: (() => {
      const credId = parentCredByProfileId.get(p.id)?.id
      return credId && userRows.some((u) => u.id === credId) ? credId : null
    })(),
    createdAt: parseDate(p.created_at) || new Date(),
    updatedAt: parseDate(p.updated_at),
  }))

  const studentRows = students.map((s) => ({
    id: s.id,
    registerNo: s.register_no,
    admissionDate: parseDate(s.admission_date),
    firstName: s.first_name,
    lastName: s.last_name,
    gender: s.gender,
    birthday: parseDate(s.birthday),
    religion: s.religion,
    caste: s.caste,
    bloodGroup: s.blood_group,
    motherTongue: s.mother_tongue,
    currentAddress: s.current_address,
    permanentAddress: s.permanent_address,
    city: s.city,
    state: s.state,
    mobileno: s.mobileno,
    categoryId: s.category_id ?? 0,
    email: s.email,
    parentId: s.parent_id && parentIds.has(s.parent_id) ? s.parent_id : null,
    routeId: s.route_id ?? 0,
    stoppagePointId: s.stoppage_point_id,
    vehicleId: s.vehicle_id,
    hostelId: s.hostel_id ?? 0,
    roomId: s.room_id ?? 0,
    previousDetails: s.previous_details,
    photo: s.photo,
    active: s.active === 1,
    branchId: (() => {
      const bid = parentBranchById.get(s.parent_id)
      return bid && branchIds.has(bid) ? bid : null
    })(),
    userId: (() => {
      const credId = studentCredByProfileId.get(s.id)?.id
      return credId && userRows.some((u) => u.id === credId) ? credId : null
    })(),
    createdAt: parseDate(s.created_at) || new Date(),
    updatedAt: parseDate(s.updated_at),
  }))

  const teacherBranchById = new Map()
  for (const a of allocations) {
    if (!teacherBranchById.has(a.teacher_id) && a.branch_id) {
      teacherBranchById.set(a.teacher_id, a.branch_id)
    }
  }

  const teacherRows = credByRole(3).map((c) => ({
    id: c.user_id,
    name: c.username,
    active: c.active === 1,
    branchId: (() => {
      const bid = teacherBranchById.get(c.user_id)
      return bid && branchIds.has(bid) ? bid : null
    })(),
    userId: userRows.some((u) => u.id === c.id) ? c.id : null,
    createdAt: parseDate(c.created_at) || new Date(),
    updatedAt: parseDate(c.updated_at),
  }))

  return { branchRows, userRows, parentRows, studentRows, teacherRows }
}

async function main() {
  console.log(dryRun ? '[DRY RUN] Parsing legacy SQL dump...' : 'Importing legacy SQL dump...')
  console.log(`Source: ${sqlFile}`)

  const useCombined = fs.existsSync(sqlFile)
  if (!useCombined) {
    throw new Error(`SQL dump not found: ${sqlFile}`)
  }

  const sql = readSqlFile(sqlFile)
  const hasBranchTable = /CREATE TABLE `branch`/i.test(sql)
  const parsed = hasBranchTable ? parseCombinedDump(sql) : parseSplitLegacyDumps()
  const rows = buildImportRows(parsed)

  console.log('\nParsed legacy records:')
  console.log(`  Branches:  ${rows.branchRows.length}`)
  console.log(`  Users:     ${rows.userRows.length}`)
  console.log(`  Parents:   ${rows.parentRows.length}`)
  console.log(`  Students:  ${rows.studentRows.length}`)
  console.log(`  Teachers:  ${rows.teacherRows.length}`)

  if (dryRun) {
    console.log('\nDry run complete — no database writes.')
    return
  }

  console.log('\nClearing existing tenant data...')
  await prisma.teacherAllocation.deleteMany()
  await prisma.teacherNote.deleteMany()
  await prisma.student.deleteMany()
  await prisma.parent.deleteMany()
  await prisma.teacher.deleteMany()
  await prisma.branchSubscription.deleteMany()
  await prisma.branch.deleteMany()
  await prisma.user.deleteMany()

  console.log('Writing to database...')
  await batchCreate('branch', rows.branchRows, 'branches')
  await batchCreate('user', rows.userRows, 'users')
  await batchCreate('parent', rows.parentRows, 'parents')
  await batchCreate('student', rows.studentRows, 'students')
  await batchCreate('teacher', rows.teacherRows, 'teachers')

  const [branches, users, parentCount, studentCount, teacherCount] = await Promise.all([
    prisma.branch.count(),
    prisma.user.count(),
    prisma.parent.count(),
    prisma.student.count(),
    prisma.teacher.count(),
  ])

  console.log('\nImport complete:')
  console.log(`  Branches in DB: ${branches}`)
  console.log(`  Users in DB:    ${users}`)
  console.log(`  Parents in DB:  ${parentCount}`)
  console.log(`  Students in DB: ${studentCount}`)
  console.log(`  Teachers in DB: ${teacherCount}`)
}

main()
  .catch((err) => {
    console.error('\nImport failed:', err.message)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
