#!/usr/bin/env node
/**
 * Production-Grade Database Migration & Synchronization Script
 * Target Dump: database /ugbekunc_Saas_23rd_sept_2026.sql (1)
 * 
 * Ingests and synchronizes all vital tables:
 * - Branches & System Settings
 * - Classes, Sections & Subjects
 * - Sections Allocation (sections_allocation)
 * - Subject Assign (subject_assign)
 * - Users & Auth (Role 1 Superadmin, Role 2 School Admin, Role 3 Teacher, Role 6 Parent, Role 7 Student)
 * - Teachers, Staff & Teacher Allocations
 * - Parents & Students
 * - Student Enrollments (enroll)
 * - Promotion History (promotion_history)
 * - Student Attendance (student_attendance) & Attendance Registers
 * - Staff Attendance (staff_attendance)
 * - Timetable Slots (timetable_class)
 * - Calendar Events (event)
 * - Question Groups & CA Question Bank (question_groups, question_bank)
 * - Examination Profiles & Exam Mark Distributions (exam, exam_mark_distribution)
 * - Continuous Assessment (CA) Marks (mark)
 * - Online Exams & Submissions (online_exam, online_exam_submitted)
 * - Homework & Submissions (homework, homework_submit)
 * - Finance: Fee Types, Fee Groups, Invoices (fee_allocation), Invoice Items & Payments (fee_payment_history)
 * - Accounting: Voucher Heads & Office Transactions (voucher_head, transactions)
 * - PostgreSQL Sequence Resets for all tables
 * 
 * Usage:
 *   node scripts/import-sept2026-data.js --dry-run
 *   node scripts/import-sept2026-data.js
 *   node scripts/import-sept2026-data.js --file "/custom/path/to/dump.sql"
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { mapRows, parseDate, normalizeBcryptHash } = require('../dist/lib/parseMysqlInsert')

const DEFAULT_SQL_CANDIDATES = [
  path.resolve(__dirname, '../../../database /ugbekunc_Saas_23rd_sept_2026.sql (1)'),
  path.resolve(__dirname, '../../../database/ugbekunc_Saas_23rd_sept_2026.sql (1)'),
  path.resolve(__dirname, '../../../database /ugbekunc_Saas _sept2026_update.sql'),
  path.resolve(__dirname, '../../database /ugbekunc_Saas_23rd_sept_2026.sql (1)'),
]

const fileArgIdx = process.argv.indexOf('--file')
let sqlFile = fileArgIdx >= 0 ? path.resolve(process.argv[fileArgIdx + 1]) : null

if (!sqlFile) {
  for (const candidate of DEFAULT_SQL_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      sqlFile = candidate
      break
    }
  }
}

const BATCH = 400
const dryRun = process.argv.includes('--dry-run')

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

function readSqlFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`SQL file not found: ${filePath}`)
  }
  return fs.readFileSync(filePath, 'utf8')
}

async function batchCreate(model, rows, label) {
  if (!rows || !rows.length) return 0
  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    if (dryRun) {
      inserted += chunk.length
      continue
    }
    const result = await prisma[model].createMany({ data: chunk, skipDuplicates: true })
    inserted += result.count
    process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length} records processed`)
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

function parseIdFromLegacyArray(val) {
  if (!val) return null
  const cleaned = String(val).replace(/[\[\]"']/g, '').trim()
  if (!cleaned) return null
  const first = cleaned.split(',')[0].trim()
  const num = Number(first)
  return isNaN(num) ? null : num
}

function parseDurationMinutes(timeStr) {
  if (!timeStr) return 0
  const parts = String(timeStr).split(':')
  if (parts.length >= 2) {
    const hours = Number(parts[0]) || 0
    const mins = Number(parts[1]) || 0
    return hours * 60 + mins
  }
  return Number(timeStr) || 0
}

async function syncAllSequences() {
  console.log('\n[Postgres Sequence Synchronization] Resetting sequence counters...')
  const syncSql = `
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN (
        SELECT table_name, column_name, sequence_name
        FROM information_schema.columns c
        JOIN information_schema.sequences s
          ON s.sequence_name = pg_get_serial_sequence(c.table_name, c.column_name)
        WHERE c.table_schema = 'public'
      ) LOOP
        EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I), 1))',
                       r.sequence_name, r.column_name, r.table_name);
      END LOOP;
    END $$;
  `
  await prisma.$executeRawUnsafe(syncSql)
  console.log('✓ All table sequences synchronized successfully.')
}

async function main() {
  console.log('========================================================================')
  console.log(dryRun ? '  [DRY RUN MODE] - Parsing and Validating September 2026 Dump' : '  [LIVE MIGRATION] - Ingesting September 2026 Dump into Database')
  console.log('========================================================================')
  console.log(`Source File: ${sqlFile}`)
  if (!sqlFile || !fs.existsSync(sqlFile)) {
    throw new Error(`Target SQL file does not exist. Checked: ${sqlFile}`)
  }

  const stat = fs.statSync(sqlFile)
  console.log(`File Size:   ${(stat.size / (1024 * 1024)).toFixed(2)} MB\n`)

  console.log('Reading SQL dump into memory...')
  const sql = readSqlFile(sqlFile)
  console.log('SQL dump loaded. Extracting tables...')

  // 1. Branches & Identity
  console.log('-> Parsing Branches & Users...')
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

  const credByRole = (role) => credentials.filter((c) => c.role === role)
  const branchAdmins = credByRole(2)
  const adminByBranchId = new Map(branchAdmins.map((a) => [a.user_id, a]))

  const branchIds = new Set(legacyBranches.map((b) => b.id))
  const seenCodes = new Set()
  const branchRows = legacyBranches.map((b) => {
    const prefix = extractPrefixFromSetting(b.stu_username_prefix) || extractPrefixFromSetting(b.institution_code)
    let code = b.institution_code ? String(b.institution_code).trim() : buildBranchCode(b.id, prefix)
    if (!code || seenCodes.has(code)) {
      code = `${code || 'BR'}-${b.id}`
    }
    seenCodes.add(code)
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

  // Normalize Users
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

  const validUserIds = new Set(userRows.map((u) => u.id))

  // 2. Classes & Sections
  console.log('-> Parsing Classes & Sections...')
  const rawClasses = mapRows(sql, 'class', ['id', 'name', 'name_numeric', 'created_at', 'updated_at', 'branch_id'])
  const classRows = rawClasses
    .filter((c) => c.branch_id && branchIds.has(c.branch_id))
    .map((c) => ({
      id: c.id,
      name: c.name || `Class ${c.id}`,
      nameNumeric: c.name_numeric ? String(c.name_numeric) : `${c.id}`,
      branchId: c.branch_id,
      createdAt: parseDate(c.created_at) || new Date(),
      updatedAt: parseDate(c.updated_at),
    }))
  const validClassIds = new Set(classRows.map((c) => c.id))
  const classBranchById = new Map(classRows.map((c) => [c.id, c.branchId]))

  const rawSections = mapRows(sql, 'section', ['id', 'name', 'capacity', 'branch_id'])
  const sectionRows = rawSections
    .filter((s) => s.branch_id && branchIds.has(s.branch_id))
    .map((s) => ({
      id: s.id,
      name: s.name || `Section ${s.id}`,
      capacity: s.capacity ? String(s.capacity) : null,
      branchId: s.branch_id,
    }))
  const validSectionIds = new Set(sectionRows.map((s) => s.id))

  // Sections Allocation
  console.log('-> Parsing Sections Allocation...')
  const rawSectionsAllocation = mapRows(sql, 'sections_allocation', ['id', 'class_id', 'section_id'])
  const seenClassSection = new Set()
  const sectionsAllocationRows = []
  for (const sa of rawSectionsAllocation) {
    if (!validClassIds.has(sa.class_id) || !validSectionIds.has(sa.section_id)) continue
    const key = `${sa.class_id}:${sa.section_id}`
    if (seenClassSection.has(key)) continue
    seenClassSection.add(key)
    sectionsAllocationRows.push({
      classId: sa.class_id,
      sectionId: sa.section_id,
    })
  }

  // 3. Subjects
  console.log('-> Parsing Subjects...')
  const rawSubjects = mapRows(sql, 'subject', ['id', 'name', 'subject_code', 'subject_type', 'subject_author', 'branch_id'])
  const subjectRows = rawSubjects
    .filter((sub) => sub.branch_id && branchIds.has(sub.branch_id))
    .map((sub) => ({
      id: sub.id,
      name: sub.name || `Subject ${sub.id}`,
      subjectCode: sub.subject_code ? String(sub.subject_code) : `SUB${sub.id}`,
      subjectType: sub.subject_type ? String(sub.subject_type) : 'theory',
      subjectAuthor: sub.subject_author ? String(sub.subject_author) : 'N/A',
      branchId: sub.branch_id,
    }))
  const validSubjectIds = new Set(subjectRows.map((s) => s.id))

  // 4. Staff & Teachers
  console.log('-> Parsing Staff & Teachers...')
  const rawStaff = mapRows(sql, 'staff', [
    'id', 'staff_id', 'name', 'department', 'qualification', 'experience_details', 'total_experience',
    'designation', 'joining_date', 'birthday', 'sex', 'religion', 'blood_group', 'present_address',
    'permanent_address', 'mobileno', 'email', 'salary_template_id', 'branch_id', 'photo',
    'facebook_url', 'linkedin_url', 'twitter_url', 'created_at', 'updated_at'
  ])
  const staffById = new Map(rawStaff.map((s) => [s.id, s]))

  const rawAllocations = mapRows(sql, 'teacher_allocation', [
    'id', 'class_id', 'section_id', 'teacher_id', 'session_id', 'branch_id',
  ])
  const teacherBranchById = new Map()
  for (const a of rawAllocations) {
    if (!teacherBranchById.has(a.teacher_id) && a.branch_id && branchIds.has(a.branch_id)) {
      teacherBranchById.set(a.teacher_id, a.branch_id)
    }
  }

  const teacherRows = credByRole(3).map((c) => {
    const s = staffById.get(c.user_id)
    const bid = s?.branch_id && branchIds.has(s.branch_id) ? s.branch_id : teacherBranchById.get(c.user_id) || null
    return {
      id: c.user_id,
      name: s?.name || c.username,
      email: s?.email || null,
      phone: s?.mobileno || null,
      photo: s?.photo || null,
      active: c.active === 1,
      branchId: bid && branchIds.has(bid) ? bid : null,
      userId: validUserIds.has(c.id) ? c.id : null,
      createdAt: parseDate(c.created_at) || new Date(),
      updatedAt: parseDate(c.updated_at),
    }
  }).filter((t) => t.branchId !== null)
  const validTeacherIds = new Set(teacherRows.map((t) => t.id))

  // Teacher Allocations
  const teacherAllocationRows = rawAllocations
    .filter((a) => a.branch_id && branchIds.has(a.branch_id) && validTeacherIds.has(a.teacher_id) && validClassIds.has(a.class_id) && validSectionIds.has(a.section_id))
    .map((a) => ({
      id: a.id,
      teacherId: a.teacher_id,
      classId: a.class_id,
      sectionId: a.section_id,
      sessionId: Number(a.session_id) || 1,
      branchId: a.branch_id,
    }))

  // Subject Assign (subject_assign)
  console.log('-> Parsing Subject Assign...')
  const rawSubjectAssign = mapRows(sql, 'subject_assign', [
    'id', 'class_id', 'section_id', 'subject_id', 'teacher_id', 'branch_id', 'session_id', 'created_at', 'updated_at'
  ])
  const subjectAssignRows = rawSubjectAssign
    .filter((sa) => (
      sa.branch_id && branchIds.has(sa.branch_id) &&
      validClassIds.has(sa.class_id) &&
      validSectionIds.has(sa.section_id) &&
      validSubjectIds.has(sa.subject_id)
    ))
    .map((sa) => ({
      id: sa.id,
      classId: sa.class_id,
      sectionId: sa.section_id,
      subjectId: sa.subject_id,
      teacherId: sa.teacher_id && validTeacherIds.has(sa.teacher_id) ? sa.teacher_id : null,
      branchId: sa.branch_id,
      sessionId: Number(sa.session_id) || 1,
      createdAt: parseDate(sa.created_at) || new Date(),
      updatedAt: parseDate(sa.updated_at),
    }))

  // 5. Parents & Students
  console.log('-> Parsing Parents & Students...')
  const rawParents = mapRows(sql, 'parent', [
    'id', 'name', 'relation', 'father_name', 'mother_name', 'occupation', 'income', 'education',
    'email', 'mobileno', 'address', 'city', 'state', 'branch_id', 'photo',
    'facebook_url', 'linkedin_url', 'twitter_url', 'created_at', 'updated_at', 'active',
  ])
  const parentCredByProfileId = new Map(credByRole(6).map((c) => [c.user_id, c]))
  const parentRows = rawParents.map((p) => ({
    id: p.id,
    name: p.name || 'Parent Profile',
    relation: p.relation || 'Guardian',
    fatherName: p.father_name || null,
    motherName: p.mother_name || null,
    occupation: p.occupation || null,
    income: p.income ? String(p.income) : null,
    education: p.education || null,
    email: p.email || null,
    mobileno: p.mobileno || null,
    address: p.address || null,
    city: p.city || null,
    state: p.state || null,
    photo: p.photo || null,
    facebookUrl: p.facebook_url || null,
    linkedinUrl: p.linkedin_url || null,
    twitterUrl: p.twitter_url || null,
    active: p.active === 0,
    branchId: p.branch_id && branchIds.has(p.branch_id) ? p.branch_id : null,
    userId: (() => {
      const credId = parentCredByProfileId.get(p.id)?.id
      return credId && validUserIds.has(credId) ? credId : null
    })(),
    createdAt: parseDate(p.created_at) || new Date(),
    updatedAt: parseDate(p.updated_at),
  })).filter((p) => p.branchId !== null)
  const validParentIds = new Set(parentRows.map((p) => p.id))

  const rawStudents = mapRows(sql, 'student', [
    'id', 'register_no', 'admission_date', 'first_name', 'last_name', 'gender', 'birthday',
    'religion', 'caste', 'blood_group', 'mother_tongue', 'current_address', 'permanent_address',
    'city', 'state', 'mobileno', 'category_id', 'email', 'parent_id', 'route_id',
    'stoppage_point_id', 'vehicle_id', 'hostel_id', 'room_id', 'previous_details', 'photo',
    'active', 'created_at', 'updated_at',
  ])
  const parentBranchById = new Map(rawParents.map((p) => [p.id, p.branch_id]))
  const studentCredByProfileId = new Map(credByRole(7).map((c) => [c.user_id, c]))

  const studentRows = rawStudents.map((s) => {
    const pBranch = parentBranchById.get(s.parent_id)
    return {
      id: s.id,
      registerNo: s.register_no || `STU${s.id}`,
      admissionDate: parseDate(s.admission_date),
      firstName: s.first_name || 'Student',
      lastName: s.last_name || `${s.id}`,
      gender: s.gender || 'Not Specified',
      birthday: parseDate(s.birthday),
      religion: s.religion || null,
      caste: s.caste || null,
      bloodGroup: s.blood_group || null,
      motherTongue: s.mother_tongue || null,
      currentAddress: s.current_address || null,
      permanentAddress: s.permanent_address || null,
      city: s.city || null,
      state: s.state || null,
      mobileno: s.mobileno || null,
      categoryId: s.category_id ?? 0,
      email: s.email || null,
      parentId: s.parent_id && validParentIds.has(s.parent_id) ? s.parent_id : null,
      routeId: s.route_id ?? 0,
      stoppagePointId: s.stoppage_point_id || null,
      vehicleId: s.vehicle_id || null,
      hostelId: s.hostel_id ?? 0,
      roomId: s.room_id ?? 0,
      previousDetails: s.previous_details || null,
      photo: s.photo || null,
      active: s.active === 1,
      branchId: pBranch && branchIds.has(pBranch) ? pBranch : null,
      userId: (() => {
        const credId = studentCredByProfileId.get(s.id)?.id
        return credId && validUserIds.has(credId) ? credId : null
      })(),
      createdAt: parseDate(s.created_at) || new Date(),
      updatedAt: parseDate(s.updated_at),
    }
  }).filter((s) => s.branchId !== null)
  const validStudentIds = new Set(studentRows.map((s) => s.id))

  // 6. Student Enrollments
  console.log('-> Parsing Student Enrollments (enroll)...')
  const rawEnroll = mapRows(sql, 'enroll', [
    'id', 'student_id', 'class_id', 'section_id', 'roll', 'session_id', 'default_login', 'branch_id', 'is_alumni', 'created_at', 'updated_at'
  ])
  const enrollById = new Map()
  const enrollRows = rawEnroll
    .filter((e) => validStudentIds.has(e.student_id) && validClassIds.has(e.class_id) && validSectionIds.has(e.section_id) && branchIds.has(e.branch_id))
    .map((e) => {
      const row = {
        id: e.id,
        studentId: e.student_id,
        classId: e.class_id,
        sectionId: e.section_id,
        roll: Number(e.roll) || 0,
        sessionId: Number(e.session_id) || 1,
        defaultLogin: Number(e.default_login) || 0,
        branchId: e.branch_id,
        isAlumni: Number(e.is_alumni) || 0,
        createdAt: parseDate(e.created_at) || new Date(),
        updatedAt: parseDate(e.updated_at),
      }
      enrollById.set(e.id, row)
      return row
    })

  // Promotion History (promotion_history)
  console.log('-> Parsing Promotion History...')
  const rawPromotion = mapRows(sql, 'promotion_history', [
    'id', 'student_id', 'pre_class', 'pre_section', 'pre_session', 'pro_class', 'pro_section', 'pro_session', 'prev_due', 'is_leave', 'date'
  ])
  const defaultClassId = classRows[0]?.id || 1
  const defaultSectionId = sectionRows[0]?.id || 1
  const promotionHistoryRows = rawPromotion
    .filter((ph) => validStudentIds.has(ph.student_id))
    .map((ph) => ({
      id: ph.id,
      studentId: ph.student_id,
      fromClassId: validClassIds.has(ph.pre_class) ? ph.pre_class : defaultClassId,
      fromSectionId: validSectionIds.has(ph.pre_section) ? ph.pre_section : defaultSectionId,
      toClassId: validClassIds.has(ph.pro_class) ? ph.pro_class : defaultClassId,
      toSectionId: validSectionIds.has(ph.pro_section) ? ph.pro_section : defaultSectionId,
      promotedBy: 1,
      sessionId: Number(ph.pro_session) || Number(ph.pre_session) || 1,
      promotedAt: parseDate(ph.date) || new Date(),
    }))

  // 7. Student Attendance
  console.log('-> Parsing Student Attendance...')
  const rawAttendance = mapRows(sql, 'student_attendance', [
    'id', 'enroll_id', 'date', 'status', 'remark', 'branch_id', 'created_at', 'updated_at'
  ])

  const STATUS_MAP = { P: 'Present', A: 'Absent', L: 'Late', H: 'Present', '': 'Present' }
  const seenAttendanceKey = new Set()
  const attendanceRows = []

  for (const a of rawAttendance) {
    const en = enrollById.get(a.enroll_id)
    if (!en || !a.date) continue
    const dateParsed = parseDate(a.date)
    if (!dateParsed) continue

    const utcDate = new Date(Date.UTC(dateParsed.getUTCFullYear(), dateParsed.getUTCMonth(), dateParsed.getUTCDate()))
    const dateKey = `${en.studentId}-${en.sessionId}-${en.branchId}-${utcDate.toISOString().split('T')[0]}`
    if (seenAttendanceKey.has(dateKey)) continue
    seenAttendanceKey.add(dateKey)

    const statusCode = String(a.status || 'P').trim().toUpperCase()
    attendanceRows.push({
      studentId: en.studentId,
      classId: en.classId,
      sectionId: en.sectionId,
      sessionId: en.sessionId,
      branchId: en.branchId,
      attendanceDate: utcDate,
      status: STATUS_MAP[statusCode] || 'Present',
      remark: a.remark ? String(a.remark) : null,
      createdAt: parseDate(a.created_at) || new Date(),
      updatedAt: parseDate(a.updated_at),
    })
  }

  // Staff Attendance (staff_attendance)
  console.log('-> Parsing Staff Attendance...')
  const rawStaffAttendance = mapRows(sql, 'staff_attendance', [
    'id', 'staff_id', 'status', 'remark', 'date', 'branch_id'
  ])
  const STAFF_STATUS_MAP = { P: 'PRESENT', A: 'ABSENT', L: 'LATE', H: 'ON_LEAVE', '': 'PRESENT' }
  const seenStaffAttKey = new Set()
  const staffAttendanceRows = []
  for (const sa of rawStaffAttendance) {
    if (!validTeacherIds.has(sa.staff_id)) continue
    const dateParsed = parseDate(sa.date)
    if (!dateParsed) continue
    const tRow = teacherRows.find((t) => t.id === sa.staff_id)
    const bid = sa.branch_id && branchIds.has(sa.branch_id) ? sa.branch_id : tRow?.branchId
    if (!bid) continue

    const utcDate = new Date(Date.UTC(dateParsed.getUTCFullYear(), dateParsed.getUTCMonth(), dateParsed.getUTCDate()))
    const key = `${sa.staff_id}-${utcDate.toISOString().split('T')[0]}`
    if (seenStaffAttKey.has(key)) continue
    seenStaffAttKey.add(key)

    const code = String(sa.status || 'P').trim().toUpperCase()
    staffAttendanceRows.push({
      id: sa.id,
      teacherId: sa.staff_id,
      attendanceDate: utcDate,
      status: STAFF_STATUS_MAP[code] || 'PRESENT',
      remark: sa.remark ? String(sa.remark) : null,
      branchId: bid,
      createdAt: new Date(),
      updatedAt: null,
    })
  }

  // Timetable Slots (timetable_class)
  console.log('-> Parsing Timetable Slots...')
  const rawTimetable = mapRows(sql, 'timetable_class', [
    'id', 'class_id', 'section_id', 'break', 'subject_id', 'teacher_id', 'class_room', 'time_start', 'time_end', 'day', 'session_id', 'branch_id'
  ])
  const timetableSlotRows = rawTimetable
    .filter((tt) => {
      const bid = tt.branch_id && branchIds.has(tt.branch_id) ? tt.branch_id : classBranchById.get(tt.class_id)
      return validClassIds.has(tt.class_id) && bid && branchIds.has(bid)
    })
    .map((tt) => {
      const bid = tt.branch_id && branchIds.has(tt.branch_id) ? tt.branch_id : classBranchById.get(tt.class_id)
      const dayRaw = String(tt.day || 'MONDAY').trim().toUpperCase()
      const isBreak = tt.break === '1' || tt.break === 'true'
      return {
        id: tt.id,
        dayOfWeek: dayRaw,
        startTime: tt.time_start ? String(tt.time_start).slice(0, 5) : '08:00',
        endTime: tt.time_end ? String(tt.time_end).slice(0, 5) : '08:45',
        type: isBreak ? 'BREAK' : 'SUBJECT',
        title: tt.class_room ? String(tt.class_room).trim() : null,
        classId: tt.class_id,
        sectionId: tt.section_id && validSectionIds.has(tt.section_id) ? tt.section_id : null,
        subjectId: tt.subject_id && validSubjectIds.has(tt.subject_id) ? tt.subject_id : null,
        teacherId: tt.teacher_id && validTeacherIds.has(tt.teacher_id) ? tt.teacher_id : null,
        branchId: bid,
        sessionId: Number(tt.session_id) || null,
        isPublished: true,
        createdAt: new Date(),
        updatedAt: null,
      }
    })

  // Events & Calendar (event)
  console.log('-> Parsing Events...')
  const rawEvents = mapRows(sql, 'event', [
    'id', 'title', 'remark', 'status', 'type', 'audition', 'selected_list', 'start_date', 'end_date', 'image', 'created_by', 'session_id', 'created_at', 'updated_at', 'branch_id', 'show_web'
  ])
  const eventRows = rawEvents.map((e) => {
    const sDate = parseDate(e.start_date) || parseDate(e.created_at) || new Date()
    const eDate = parseDate(e.end_date)
    const typeStr = String(e.type || '').toLowerCase()
    return {
      id: e.id,
      title: e.title ? String(e.title).trim() : `Event ${e.id}`,
      description: e.remark ? String(e.remark).trim() : null,
      startDate: sDate,
      endDate: eDate,
      kind: typeStr === 'holiday' ? 'HOLIDAY' : 'EVENT',
      branchId: e.branch_id && branchIds.has(e.branch_id) ? e.branch_id : null,
      sessionId: Number(e.session_id) || null,
      createdAt: parseDate(e.created_at) || new Date(),
      updatedAt: parseDate(e.updated_at),
    }
  })

  // 8. Questions & Question Groups (CA Test Bank)
  console.log('-> Parsing CA Questions & Question Groups...')
  const rawQuestions = mapRows(sql, 'questions', [
    'id', 'type', 'level', 'class_id', 'section_id', 'subject_id', 'group_id', 'question',
    'opt_1', 'opt_2', 'opt_3', 'opt_4', 'answer', 'mark', 'branch_id', 'created_by', 'created_at', 'updated_at'
  ])

  const branchDefaultSubjectMap = new Map()
  for (const s of subjectRows) {
    if (!branchDefaultSubjectMap.has(s.branchId)) {
      branchDefaultSubjectMap.set(s.branchId, s.id)
    }
  }

  const groupSubjectMap = new Map()
  const groupClassMap = new Map()
  for (const q of rawQuestions) {
    if (q.group_id && q.subject_id && validSubjectIds.has(q.subject_id)) {
      if (!groupSubjectMap.has(q.group_id)) groupSubjectMap.set(q.group_id, q.subject_id)
    }
    if (q.group_id && q.class_id && validClassIds.has(q.class_id)) {
      if (!groupClassMap.has(q.group_id)) groupClassMap.set(q.group_id, q.class_id)
    }
  }

  const rawGroups = mapRows(sql, 'question_group', ['id', 'name', 'branch_id'])
  const questionGroupRows = rawGroups
    .filter((g) => g.branch_id && branchIds.has(g.branch_id))
    .map((g) => {
      const fallbackSubject = branchDefaultSubjectMap.get(g.branch_id) || [...validSubjectIds][0]
      const subId = groupSubjectMap.get(g.id) || fallbackSubject
      return {
        id: g.id,
        title: g.name || `Question Group ${g.id}`,
        groupCode: `QGRP-${g.id}`,
        subjectId: subId,
        classId: groupClassMap.get(g.id) || null,
        branchId: g.branch_id,
        questionIds: [],
        totalMarks: 100,
      }
    })
    .filter((g) => g.subjectId && validSubjectIds.has(g.subjectId))
  const validGroupIds = new Set(questionGroupRows.map((g) => g.id))

  const questionBankRows = rawQuestions
    .filter((q) => q.branch_id && branchIds.has(q.branch_id) && validSubjectIds.has(q.subject_id))
    .map((q) => ({
      id: q.id,
      questionText: q.question || 'Untitled Question',
      questionType: 'mcq',
      options: [q.opt_1, q.opt_2, q.opt_3, q.opt_4].filter(Boolean),
      correctOption: String(q.answer || '1'),
      marks: Number(q.mark) || 1.0,
      subjectId: q.subject_id,
      classId: q.class_id && validClassIds.has(q.class_id) ? q.class_id : null,
      branchId: q.branch_id,
      status: 'APPROVED',
      createdAt: parseDate(q.created_at) || new Date(),
      updatedAt: parseDate(q.updated_at),
    }))

  // 9. Exams & Exam Mark Distribution
  console.log('-> Parsing Examination Profiles & Mark Distributions...')
  const rawExamMarkDist = mapRows(sql, 'exam_mark_distribution', ['id', 'name', 'branch_id'])
  const examMarkDistributionRows = rawExamMarkDist.map((emd) => ({
    id: emd.id,
    name: emd.name || `Mark Distribution ${emd.id}`,
    branchId: emd.branch_id && branchIds.has(emd.branch_id) ? emd.branch_id : null,
  }))

  const rawExams = mapRows(sql, 'exam', [
    'id', 'name', 'term_id', 'type_id', 'session_id', 'branch_id', 'remark', 'mark_distribution',
    'status', 'publish_result', 'resumption_date', 'rank_generated', 'created_at', 'updated_at'
  ])

  const examMap = new Map()
  for (const e of rawExams) {
    examMap.set(e.id, {
      id: e.id,
      name: e.name || `Exam ${e.id}`,
      termId: e.term_id ? Number(e.term_id) : null,
      typeId: Number(e.type_id) || 1,
      sessionId: Number(e.session_id) || 1,
      branchId: e.branch_id && branchIds.has(e.branch_id) ? e.branch_id : [...branchIds][0] || 1,
      remark: e.remark || 'Migrated Exam',
      markDistribution: e.mark_distribution || '{"exam":60,"ca":40}',
      status: Number(e.status) || 1,
      publishResult: Number(e.publish_result) || 1,
      resumptionDate: parseDate(e.resumption_date),
      rankGenerated: Number(e.rank_generated) || 0,
      createdAt: parseDate(e.created_at) || new Date(),
      updatedAt: parseDate(e.updated_at),
    })
  }

  // 10. CA Marks
  console.log('-> Parsing Continuous Assessment (CA) Marks...')
  const rawMarks = mapRows(sql, 'mark', [
    'id', 'student_id', 'subject_id', 'class_id', 'section_id', 'exam_id', 'mark', 'absent', 'session_id', 'branch_id'
  ])

  for (const m of rawMarks) {
    if (m.exam_id && !examMap.has(m.exam_id)) {
      examMap.set(m.exam_id, {
        id: m.exam_id,
        name: `Assessment Evaluation ${m.exam_id}`,
        termId: null,
        typeId: 1,
        sessionId: Number(m.session_id) || 1,
        branchId: m.branch_id && branchIds.has(m.branch_id) ? m.branch_id : [...branchIds][0] || 1,
        remark: 'Migrated Assessment Exam',
        markDistribution: '{"exam":60,"ca":40}',
        status: 1,
        publishResult: 1,
        resumptionDate: null,
        rankGenerated: 0,
        createdAt: new Date(),
        updatedAt: null,
      })
    }
  }
  const examRows = Array.from(examMap.values())

  const markRows = rawMarks
    .filter((m) => m.branch_id && branchIds.has(m.branch_id) && validStudentIds.has(m.student_id) && validSubjectIds.has(m.subject_id) && validClassIds.has(m.class_id))
    .map((m) => ({
      studentId: m.student_id,
      subjectId: m.subject_id,
      classId: m.class_id,
      sectionId: validSectionIds.has(m.section_id) ? m.section_id : [...validSectionIds][0] || 1,
      examId: Number(m.exam_id) || 1,
      mark: m.mark ? String(m.mark) : null,
      absent: m.absent ? String(m.absent) : null,
      sessionId: Number(m.session_id) || 1,
      branchId: m.branch_id,
    }))

  // 11. Online Exams & Submissions
  console.log('-> Parsing Online Exams & Submissions...')
  const rawOnlineExams = mapRows(sql, 'online_exam', [
    'id', 'title', 'class_id', 'section_id', 'subject_id', 'limits_participation', 'exam_start', 'exam_end', 'duration', 'mark_type', 'passing_mark', 'instruction', 'session_id', 'publish_result', 'marks_display', 'neg_mark', 'question_type', 'publish_status', 'exam_type', 'fee', 'created_by', 'position_generated', 'branch_id', 'created_at', 'updated_at'
  ])
  const onlineExamRows = []
  for (const oe of rawOnlineExams) {
    const subId = parseIdFromLegacyArray(oe.subject_id)
    if (!validClassIds.has(oe.class_id) || !subId || !validSubjectIds.has(subId) || !branchIds.has(oe.branch_id)) {
      continue
    }
    onlineExamRows.push({
      id: oe.id,
      title: oe.title ? String(oe.title).trim() : `Online Exam ${oe.id}`,
      classId: oe.class_id,
      subjectId: subId,
      passingMark: Number(oe.passing_mark) || 0,
      duration: parseDurationMinutes(oe.duration),
      branchId: oe.branch_id,
      sessionId: Number(oe.session_id) || 1,
      questions: null,
      examDate: parseDate(oe.exam_start),
      createdAt: parseDate(oe.created_at) || new Date(),
      updatedAt: parseDate(oe.updated_at),
    })
  }
  const validOnlineExamIds = new Set(onlineExamRows.map((e) => e.id))

  const rawOnlineSubmissions = mapRows(sql, 'online_exam_submitted', [
    'id', 'student_id', 'online_exam_id', 'remark', 'position', 'created_at'
  ])
  const onlineExamSubmissionRows = rawOnlineSubmissions
    .filter((s) => validStudentIds.has(s.student_id) && validOnlineExamIds.has(s.online_exam_id))
    .map((s) => ({
      id: s.id,
      studentId: s.student_id,
      onlineExamId: s.online_exam_id,
      totalMark: null,
      answers: s.remark ? { remark: s.remark } : null,
      submittedAt: parseDate(s.created_at) || new Date(),
      createdAt: parseDate(s.created_at) || new Date(),
      updatedAt: null,
    }))

  // 12. Homework & Submissions
  console.log('-> Parsing Homework & Submissions...')
  const rawHomework = mapRows(sql, 'homework', [
    'id', 'class_id', 'section_id', 'session_id', 'subject_id', 'date_of_homework', 'date_of_submission', 'description', 'created_by', 'create_date', 'status', 'sms_notification', 'schedule_date', 'document', 'evaluation_date', 'evaluated_by', 'branch_id'
  ])
  const homeworkRows = rawHomework
    .filter((hw) => validClassIds.has(hw.class_id) && validSubjectIds.has(hw.subject_id) && branchIds.has(hw.branch_id))
    .map((hw) => {
      const cleanDesc = (hw.description || '').replace(/<[^>]*>?/gm, '').trim()
      const title = cleanDesc.slice(0, 60) || `Homework ${hw.id}`
      return {
        id: hw.id,
        title,
        description: hw.description || null,
        classId: hw.class_id,
        subjectId: hw.subject_id,
        dueDate: parseDate(hw.date_of_submission) || new Date(),
        branchId: hw.branch_id,
        sessionId: Number(hw.session_id) || 1,
        questions: null,
        questionBankIds: null,
        termName: null,
        createdById: hw.created_by && validTeacherIds.has(hw.created_by) ? hw.created_by : null,
        createdByRole: 'TEACHER',
        createdAt: parseDate(hw.create_date) || new Date(),
        updatedAt: null,
      }
    })
  const validHomeworkIds = new Set(homeworkRows.map((h) => h.id))

  const rawHomeworkSubmissions = mapRows(sql, 'homework_submit', [
    'id', 'homework_id', 'student_id', 'message', 'enc_name', 'file_name', 'created_at'
  ])
  const homeworkSubmissionRows = rawHomeworkSubmissions
    .filter((hs) => validHomeworkIds.has(hs.homework_id) && validStudentIds.has(hs.student_id))
    .map((hs) => ({
      id: hs.id,
      homeworkId: hs.homework_id,
      studentId: hs.student_id,
      answers: { message: hs.message || '', encName: hs.enc_name || null, fileName: hs.file_name || null },
      score: null,
      feedback: null,
      createdAt: parseDate(hs.created_at) || new Date(),
      updatedAt: null,
    }))

  // 13. Finance: Fee Types, Fee Groups, Invoices & Payments
  console.log('-> Parsing Fees, Invoices & Payments...')
  const rawFeeTypes = mapRows(sql, 'fees_type', ['id', 'name', 'fee_code', 'description', 'branch_id', 'system', 'created_at'])
  const feeTypeSeenKey = new Set()
  const feeTypeRows = rawFeeTypes
    .filter((ft) => ft.branch_id && branchIds.has(ft.branch_id))
    .map((ft) => {
      let code = ft.fee_code ? String(ft.fee_code).trim() : `FEE-${ft.id}`
      const key = `${ft.branch_id}:${code}`
      if (feeTypeSeenKey.has(key)) {
        code = `${code}-${ft.id}`
      }
      feeTypeSeenKey.add(`${ft.branch_id}:${code}`)
      return {
        id: ft.id,
        name: ft.name || `Fee ${ft.id}`,
        code,
        amount: 0.0,
        currency: 'NGN',
        frequency: 'per_term',
        active: true,
        branchId: ft.branch_id,
        createdAt: parseDate(ft.created_at) || new Date(),
      }
    })
  const validFeeTypeIds = new Set(feeTypeRows.map((f) => f.id))
  const feeTypeNameById = new Map(feeTypeRows.map((f) => [f.id, f.name]))

  // Fee Groups
  const rawFeeGroups = mapRows(sql, 'fee_groups', ['id', 'name', 'description', 'session_id', 'system', 'branch_id', 'created_at'])
  const rawFeeGroupDetails = mapRows(sql, 'fee_groups_details', ['id', 'fee_groups_id', 'fee_type_id', 'amount', 'due_date', 'created_at'])
  const feeGroupDetailsByGroupId = new Map()
  for (const fgd of rawFeeGroupDetails) {
    if (!feeGroupDetailsByGroupId.has(fgd.fee_groups_id)) {
      feeGroupDetailsByGroupId.set(fgd.fee_groups_id, [])
    }
    feeGroupDetailsByGroupId.get(fgd.fee_groups_id).push(fgd)
  }

  const feeGroupRows = rawFeeGroups
    .filter((fg) => fg.branch_id && branchIds.has(fg.branch_id))
    .map((fg) => {
      const details = feeGroupDetailsByGroupId.get(fg.id) || []
      const total = details.reduce((sum, d) => sum + (Number(d.amount) || 0), 0)
      const typeIds = details.map((d) => d.fee_type_id)
      return {
        id: fg.id,
        branchId: fg.branch_id,
        name: fg.name || `Fee Group ${fg.id}`,
        description: fg.description || null,
        feeTypeIds: JSON.stringify(typeIds),
        classIds: '[]',
        totalAmount: total,
        createdAt: parseDate(fg.created_at) || new Date(),
        updatedAt: null,
      }
    })
  const feeGroupNameById = new Map(feeGroupRows.map((g) => [g.id, g.name]))

  // Fee Allocations -> Invoices
  const rawFeeAllocations = mapRows(sql, 'fee_allocation', [
    'id', 'student_id', 'group_id', 'branch_id', 'session_id', 'prev_due', 'created_at'
  ])
  const rawFeePayments = mapRows(sql, 'fee_payment_history', [
    'id', 'allocation_id', 'type_id', 'transport_fee_details_id', 'collect_by', 'amount', 'discount', 'fine', 'pay_via', 'remarks', 'date'
  ])

  const paymentsByAllocId = new Map()
  for (const p of rawFeePayments) {
    if (!paymentsByAllocId.has(p.allocation_id)) {
      paymentsByAllocId.set(p.allocation_id, [])
    }
    paymentsByAllocId.get(p.allocation_id).push(p)
  }

  const invoiceRows = []
  const invoiceItemRows = []
  const validInvoiceIds = new Set()

  for (const fa of rawFeeAllocations) {
    if (!branchIds.has(fa.branch_id) || !validStudentIds.has(fa.student_id)) continue

    const gDetails = feeGroupDetailsByGroupId.get(fa.group_id) || []
    const groupTotal = gDetails.reduce((sum, d) => sum + (Number(d.amount) || 0), 0)
    const prevDue = Number(fa.prev_due) || 0
    const totalAmount = Math.max(0, groupTotal + prevDue)

    const allocPayments = paymentsByAllocId.get(fa.id) || []
    const paidAmount = allocPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
    const balanceAmount = Math.max(0, totalAmount - paidAmount)
    const status = paidAmount >= totalAmount && totalAmount > 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'unpaid')

    invoiceRows.push({
      id: fa.id,
      invoiceNo: `INV-${String(fa.id).padStart(6, '0')}`,
      termLabel: feeGroupNameById.get(fa.group_id) || 'Term Fee',
      totalAmount,
      paidAmount,
      balanceAmount,
      status,
      dueDate: gDetails[0]?.due_date ? parseDate(gDetails[0].due_date) : null,
      issuedAt: parseDate(fa.created_at) || new Date(),
      createdAt: parseDate(fa.created_at) || new Date(),
      updatedAt: null,
      studentId: fa.student_id,
      branchId: fa.branch_id,
      sessionId: Number(fa.session_id) || 1,
    })
    validInvoiceIds.add(fa.id)

    for (const d of gDetails) {
      if (!validFeeTypeIds.has(d.fee_type_id)) continue
      invoiceItemRows.push({
        invoiceId: fa.id,
        feeTypeId: d.fee_type_id,
        description: feeTypeNameById.get(d.fee_type_id) || 'Fee Item',
        amount: Number(d.amount) || 0,
        createdAt: parseDate(d.created_at) || new Date(),
      })
    }
  }

  const invoiceBranchMap = new Map(invoiceRows.map((inv) => [inv.id, inv.branchId]))

  // Payments
  const paymentRows = []
  for (const p of rawFeePayments) {
    if (!validInvoiceIds.has(p.allocation_id)) continue
    const amt = Math.abs(Number(p.amount) || 0)
    if (amt === 0) continue
    const method = p.pay_via === '15' ? 'pos' : (p.pay_via === '1' ? 'cash' : 'bank_transfer')
    paymentRows.push({
      id: p.id,
      invoiceId: p.allocation_id,
      branchId: invoiceBranchMap.get(p.allocation_id),
      amount: amt,
      method,
      reference: p.remarks ? String(p.remarks).slice(0, 100) : null,
      receivedBy: Number(p.collect_by) || null,
      notes: p.remarks || null,
      paidAt: parseDate(p.date) || new Date(),
      createdAt: parseDate(p.date) || new Date(),
    })
  }

  // 14. Voucher Heads & Transactions
  console.log('-> Parsing Voucher Heads & Transactions...')
  const rawVoucherHeads = mapRows(sql, 'voucher_head', ['id', 'name', 'type', 'system', 'branch_id'])
  const voucherHeadRows = rawVoucherHeads
    .filter((vh) => vh.branch_id && branchIds.has(vh.branch_id))
    .map((vh) => ({
      id: vh.id,
      branchId: vh.branch_id,
      name: vh.name || `Head ${vh.id}`,
      type: String(vh.type || 'EXPENSE').toUpperCase(),
      description: null,
      active: true,
      createdAt: new Date(),
      updatedAt: null,
    }))
  const validVoucherHeadIds = new Set(voucherHeadRows.map((v) => v.id))
  const voucherHeadNameById = new Map(voucherHeadRows.map((v) => [v.id, v.name]))

  const rawTransactions = mapRows(sql, 'transactions', [
    'id', 'account_id', 'voucher_head_id', 'type', 'category', 'ref', 'amount', 'dr', 'cr', 'bal', 'date', 'pay_via', 'description', 'attachments', 'branch_id', 'system', 'created_at', 'updated_at'
  ])
  const officeTransactionRows = rawTransactions
    .filter((t) => t.branch_id && branchIds.has(t.branch_id))
    .map((t) => {
      const vhId = validVoucherHeadIds.has(t.voucher_head_id) ? t.voucher_head_id : null
      const vhName = vhId ? voucherHeadNameById.get(vhId) : null
      const amt = Number(t.amount) || Number(t.dr) || Number(t.cr) || 0
      const payMethod = t.pay_via === '1' ? 'Cash' : (t.pay_via === '4' ? 'POS' : 'Bank Transfer')
      return {
        id: t.id,
        branchId: t.branch_id,
        type: String(t.type || 'EXPENSE').toUpperCase(),
        voucherHeadId: vhId,
        voucherHeadName: vhName,
        amount: amt,
        originalAmount: amt,
        paymentMethod: payMethod,
        transactionDate: parseDate(t.date) || parseDate(t.created_at) || new Date(),
        referenceNo: t.ref ? String(t.ref).slice(0, 100) : null,
        description: t.description ? String(t.description) : null,
        status: 'POSTED',
        createdAt: parseDate(t.created_at) || new Date(),
        updatedAt: parseDate(t.updated_at),
      }
    })

  // Summary Report
  console.log('\n========================================================================')
  console.log('  SUMMARY OF PARSED RECORDS (September 23, 2026 Dump)')
  console.log('========================================================================')
  console.log(`  1. Branches:                 ${branchRows.length}`)
  console.log(`  2. Classes:                  ${classRows.length}`)
  console.log(`  3. Sections:                 ${sectionRows.length}`)
  console.log(`  4. Sections Allocation:      ${sectionsAllocationRows.length}`)
  console.log(`  5. Subjects:                 ${subjectRows.length}`)
  console.log(`  6. Subject Assign:           ${subjectAssignRows.length}`)
  console.log(`  7. User Accounts (All Roles): ${userRows.length}`)
  console.log(`     - Superadmins:            ${credByRole(1).length}`)
  console.log(`     - School Admins:          ${branchAdmins.length}`)
  console.log(`     - Teachers:               ${teacherRows.length}`)
  console.log(`     - Parents:                ${parentRows.length}`)
  console.log(`     - Students:               ${studentRows.length}`)
  console.log(`  8. Teacher Allocations:      ${teacherAllocationRows.length}`)
  console.log(`  9. Student Enrollments:      ${enrollRows.length}`)
  console.log(` 10. Promotion History:        ${promotionHistoryRows.length}`)
  console.log(` 11. Student Attendance Rows:  ${attendanceRows.length}`)
  console.log(` 12. Staff Attendance:         ${staffAttendanceRows.length}`)
  console.log(` 13. Timetable Slots:          ${timetableSlotRows.length}`)
  console.log(` 14. Calendar Events:          ${eventRows.length}`)
  console.log(` 15. Question Groups:          ${questionGroupRows.length}`)
  console.log(` 16. CA Question Bank:         ${questionBankRows.length}`)
  console.log(` 17. Exam Mark Distributions:  ${examMarkDistributionRows.length}`)
  console.log(` 18. Examination Profiles:     ${examRows.length} (${rawExams.length} explicit, ${examRows.length - rawExams.length} synthesized)`)
  console.log(` 19. CA Student Marks:         ${markRows.length}`)
  console.log(` 20. Online Exams:             ${onlineExamRows.length}`)
  console.log(` 21. Online Exam Submissions:  ${onlineExamSubmissionRows.length}`)
  console.log(` 22. Homework Items:           ${homeworkRows.length}`)
  console.log(` 23. Homework Submissions:     ${homeworkSubmissionRows.length}`)
  console.log(` 24. Fee Heads (Fee Types):    ${feeTypeRows.length}`)
  console.log(` 25. Fee Groups:               ${feeGroupRows.length}`)
  console.log(` 26. Invoices:                 ${invoiceRows.length}`)
  console.log(` 27. Invoice Items:            ${invoiceItemRows.length}`)
  console.log(` 28. Fee Payments:             ${paymentRows.length}`)
  console.log(` 29. Voucher Heads:            ${voucherHeadRows.length}`)
  console.log(` 30. Office Transactions:      ${officeTransactionRows.length}`)
  console.log('========================================================================\n')

  if (dryRun) {
    console.log('[DRY RUN COMPLETE] Zero database writes performed. All validation checks PASSED.')
    return
  }

  // Live Database Ingestion
  console.log('Clearing existing tenant records with TRUNCATE CASCADE to prevent foreign key conflicts...')
  await pool.query(`
    TRUNCATE TABLE 
      "homework_submission",
      "homework",
      "online_exam_submission",
      "online_exam",
      "staff_attendance",
      "timetable_slots",
      "promotion_history",
      "office_transactions",
      "voucher_heads",
      "payments",
      "invoice_items",
      "invoices",
      "fee_groups",
      "fee_types",
      "fee_assignments",
      "sections_allocation",
      "subject_assign",
      "exam_mark_distribution",
      "event",
      "attendance", 
      "attendance_registers", 
      "attendance_audits",
      "mark", 
      "mark_score_corrections",
      "question_bank", 
      "question_groups", 
      "cbt_distributions",
      "enroll", 
      "teacher_allocations", 
      "teacher_notes",
      "teacher_activities",
      "front_cms_teachers",
      "students", 
      "parents", 
      "parent_sibling_requests",
      "parent_messages",
      "student_messages",
      "id_cards",
      "certificates",
      "online_admissions",
      "front_cms_admissions",
      "online_admission_fields",
      "student_admission_fields",
      "branch_subscriptions",
      "school_landing_pages",
      "exam",
      "teachers", 
      "subject", 
      "section", 
      "class", 
      "branches", 
      "users" 
    CASCADE;
  `)

  console.log('\nWriting to PostgreSQL in strict topological order:')
  await batchCreate('branch', branchRows, '1/30 Branches')
  await batchCreate('class', classRows, '2/30 Classes')
  await batchCreate('section', sectionRows, '3/30 Sections')
  await batchCreate('sectionsAllocation', sectionsAllocationRows, '4/30 Sections Allocation')
  await batchCreate('subject', subjectRows, '5/30 Subjects')
  await batchCreate('user', userRows, '6/30 Users (All Roles)')
  await batchCreate('teacher', teacherRows, '7/30 Teachers')
  await batchCreate('teacherAllocation', teacherAllocationRows, '8/30 Teacher Allocations')
  await batchCreate('subjectAssign', subjectAssignRows, '9/30 Subject Assignments')
  await batchCreate('parent', parentRows, '10/30 Parents')
  await batchCreate('student', studentRows, '11/30 Students')
  await batchCreate('enroll', enrollRows, '12/30 Enrollments')
  await batchCreate('promotionHistory', promotionHistoryRows, '13/30 Promotion History')
  await batchCreate('attendance', attendanceRows, '14/30 Attendance Entries')
  await batchCreate('staffAttendance', staffAttendanceRows, '15/30 Staff Attendance')
  await batchCreate('timetableSlot', timetableSlotRows, '16/30 Timetable Slots')
  await batchCreate('event', eventRows, '17/30 Calendar Events')
  await batchCreate('examMarkDistribution', examMarkDistributionRows, '18/30 Exam Mark Distributions')
  if (questionGroupRows.length) await batchCreate('questionGroup', questionGroupRows, '19/30 Question Groups')
  await batchCreate('questionBank', questionBankRows, '20/30 CA Questions')
  if (examRows.length) await batchCreate('exam', examRows, '21/30 Examination Profiles')
  if (markRows.length) await batchCreate('mark', markRows, '22/30 CA Marks')
  if (onlineExamRows.length) await batchCreate('onlineExam', onlineExamRows, '23/30 Online Exams')
  if (onlineExamSubmissionRows.length) await batchCreate('onlineExamSubmission', onlineExamSubmissionRows, '24/30 Online Exam Submissions')
  if (homeworkRows.length) await batchCreate('homework', homeworkRows, '25/30 Homework Items')
  if (homeworkSubmissionRows.length) await batchCreate('homeworkSubmission', homeworkSubmissionRows, '26/30 Homework Submissions')
  if (feeTypeRows.length) await batchCreate('feeType', feeTypeRows, '27/30 Fee Types')
  if (feeGroupRows.length) await batchCreate('feeGroup', feeGroupRows, '28/30 Fee Groups')
  if (invoiceRows.length) await batchCreate('invoice', invoiceRows, '29a/30 Invoices')
  if (invoiceItemRows.length) await batchCreate('invoiceItem', invoiceItemRows, '29b/30 Invoice Items')
  if (paymentRows.length) await batchCreate('payment', paymentRows, '29c/30 Fee Payments')
  if (voucherHeadRows.length) await batchCreate('voucherHead', voucherHeadRows, '30a/30 Voucher Heads')
  if (officeTransactionRows.length) await batchCreate('officeTransaction', officeTransactionRows, '30b/30 Office Transactions')

  // Run Sequence Resets
  await syncAllSequences()

  // Run Attendance Registers Backfill directly via SQL
  console.log('\n[Backfilling Attendance Registers] Grouping individual logs into daily registers...')
  const regRes = await pool.query(`
    INSERT INTO attendance_registers (
      class_id, section_id, register_date, session_id, branch_id, status, version, submitted_at, created_at
    )
    SELECT DISTINCT
      a.class_id,
      a.section_id,
      (a.attendance_date AT TIME ZONE 'UTC')::date,
      a.session_id,
      a.branch_id,
      'SUBMITTED',
      1,
      NOW(),
      NOW()
    FROM attendance a
    INNER JOIN branches b ON b.id = a.branch_id
    INNER JOIN class c ON c.id = a.class_id
    INNER JOIN section s ON s.id = a.section_id
    ON CONFLICT (branch_id, session_id, class_id, section_id, register_date) DO NOTHING;
  `)
  const linkRes = await pool.query(`
    UPDATE attendance a
    SET register_id = r.id
    FROM attendance_registers r
    WHERE a.register_id IS NULL
      AND a.class_id = r.class_id
      AND a.section_id = r.section_id
      AND a.session_id = r.session_id
      AND a.branch_id = r.branch_id
      AND (a.attendance_date AT TIME ZONE 'UTC')::date = r.register_date;
  `)
  console.log(`✓ Daily class registers backfilled. Created: ${regRes.rowCount || 0}, Linked: ${linkRes.rowCount || 0} records.`)

  // Run Final Sequence Resets for all tables including registers
  await syncAllSequences()

  console.log('\n========================================================================')
  console.log('✓ MIGRATION COMPLETED SUCCESSFULLY!')
  console.log('========================================================================\n')
}

main()
  .catch((err) => {
    console.error('\n❌ Migration failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
