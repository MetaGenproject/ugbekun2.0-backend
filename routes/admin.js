const express = require('express')
const jwt = require('jsonwebtoken')
const gamificationService = require('../lib/gamificationService')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { getBranchStats, listStaffForBranch, staffMatchesBranch, STAFF_ROLE_LABELS, extractCodePrefix } = require('../lib/branchStats')
const { generateRegistrationNumber, bindEvaluationMatrix, wipeEvaluationMatrix, generateSecurePassword } = require('../lib/studentService')
const { sendOnboardingCredentials, sendTeacherOnboardingCredentials } = require('../lib/emailService')
const {
  generateCredentialSlipPdf,
  generateStudentIdCardPdf,
  generateStaffIdCardPdf,
  generateCertificatePdf
} = require('../lib/pdfService')
const {
  provisionStudentIdCard,
  provisionStaffIdCard,
  provisionCertificate,
  revokeIdCard,
  batchProvisionStudentIdCards
} = require('../lib/idCardService')
const {
  generateInvoice,
  recordPayment,
  getFinancialOverview,
  exportFinancialReportCsv,
  exportFinancialReportPdf
} = require('../lib/accountingService')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const multer = require('multer')
const pdfParse = require('pdf-parse')
const { OpenAI } = require('openai')

let Tesseract
try {
  Tesseract = require('tesseract.js')
} catch (e) {
  console.warn('[ADMIN] Tesseract.js could not be loaded; OCR image parsing is disabled.')
}

const router = express.Router()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod'

function getBearerToken(req) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  return authHeader.slice('Bearer '.length)
}

async function resolveBranchForAdmin(decoded) {
  const requestedBranchId = decoded.legacyUserId ? Number(decoded.legacyUserId) : null
  if (requestedBranchId) {
    const branch = await prisma.branch.findUnique({
      where: { id: requestedBranchId },
      select: { id: true },
    })
    if (branch) {
      return branch.id
    }
  }

  if (!decoded.username) {
    return null
  }

  const branches = await prisma.branch.findMany({
    where: { active: true },
    select: { id: true, name: true, code: true },
  })

  const matched = branches.find((branch) => staffMatchesBranch(decoded.username, branch))
  if (matched) {
    console.warn('[ADMIN] Resolved branch for admin via username fallback:', decoded.username, '-> branch', matched.id)
    return matched.id
  }

  return null
}

async function assertBranchAdmin(req, res) {
  const token = getBearerToken(req)
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' })
    return null
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (!decoded || decoded.role !== 2) {
      res.status(403).json({ success: false, message: 'Forbidden.' })
      return null
    }

    const branchId = await resolveBranchForAdmin(decoded)
    if (!branchId) {
      res.status(403).json({
        success: false,
        message: 'Branch admin account is not linked to a school branch.',
      })
      return null
    }

    return { ...decoded, branchId }
  } catch {
    res.status(401).json({ success: false, message: 'Token is invalid or expired.' })
    return null
  }
}

/**
 * GET /api/admin/stats
 * Branch-scoped counts for the logged-in branch admin dashboard.
 */
router.get('/stats', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const stats = await getBranchStats(prisma, decoded.branchId)
    if (!stats) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found for this admin account.',
      })
    }

    return res.json({ success: true, data: stats })
  } catch (error) {
    console.error('[ADMIN] Stats error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load branch stats.',
    })
  }
})

/**
 * GET /api/admin/students-parents
 * Branch-scoped student and parent records for the Students & Parents section.
 */
router.get('/students-parents', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const [students, parents] = await Promise.all([
      prisma.student.findMany({
        where: { branchId: decoded.branchId },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: {
          id: true,
          registerNo: true,
          firstName: true,
          lastName: true,
          gender: true,
          mobileno: true,
          email: true,
          parentId: true,
          active: true,
          parent: { select: { name: true } },
          enrolls: {
            where: { sessionId },
            select: {
              class: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.parent.findMany({
        where: { branchId: decoded.branchId },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          relation: true,
          email: true,
          mobileno: true,
          city: true,
          state: true,
          active: true,
          _count: { select: { students: true } },
        },
      }),
    ])

    return res.json({
      success: true,
      data: {
        students: students.map((student) => ({
          id: student.id,
          registerNo: student.registerNo,
          firstName: student.firstName,
          lastName: student.lastName,
          gender: student.gender,
          mobileno: student.mobileno,
          email: student.email,
          active: student.active,
          parentName: student.parent?.name || null,
          className: student.enrolls[0]?.class?.name || 'Unassigned',
        })),
        parents: parents.map((parent) => ({
          id: parent.id,
          name: parent.name,
          relation: parent.relation,
          email: parent.email,
          mobileno: parent.mobileno,
          city: parent.city,
          state: parent.state,
          active: parent.active,
          studentCount: parent._count.students,
        })),
      },
    })
  } catch (error) {
    console.error('[ADMIN] Students/parents list error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load students and parents.',
    })
  }
})

/**
 * GET /api/admin/teachers-staff
 * Branch-scoped teacher and other staff records for the Teachers & Staff section.
 */
router.get('/teachers-staff', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const [teachers, staff] = await Promise.all([
      prisma.teacher.findMany({
        where: { branchId: decoded.branchId },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          qualifications: true,
          houseAddress: true,
          department: true,
          bankName: true,
          accountNumber: true,
          accountName: true,
          active: true,
          _count: { select: { allocations: true } },
        },
      }),
      listStaffForBranch(prisma, decoded.branchId),
    ])

    return res.json({
      success: true,
      data: {
        teachers: teachers.map((teacher) => ({
          id: teacher.id,
          name: teacher.name,
          email: teacher.email,
          phone: teacher.phone,
          qualifications: teacher.qualifications || null,
          houseAddress: teacher.houseAddress || null,
          department: teacher.department || null,
          bankName: teacher.bankName || null,
          accountNumber: teacher.accountNumber || null,
          accountName: teacher.accountName || null,
          active: teacher.active,
          classCount: teacher._count.allocations,
        })),
        staff,
      },
    })
  } catch (error) {
    console.error('[ADMIN] Teachers/staff list error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load teachers and staff.',
    })
  }
})

/**
 * GET /api/admin/classes-sections
 * Fetch classes and sections config for setup dropdowns.
 */
router.get('/classes-sections', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const classes = await prisma.class.findMany({
      where: { branchId: decoded.branchId },
      include: {
        sections: {
          include: {
            section: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })

    const sections = await prisma.section.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { name: 'asc' },
    })

    return res.json({ success: true, classes, sections })
  } catch (error) {
    console.error('[ADMIN] Get classes-sections error:', error)
    return res.status(500).json({ success: false, message: 'Failed to load classes and sections.' })
  }
})

/**
 * GET /api/admin/roles
 * Fetch all staff roles (standard system roles + branch-custom roles) with active staff counts.
 */
router.get('/roles', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const DEFAULT_SYSTEM_ROLES = [
      { roleCode: 3, name: 'Teacher', description: 'Form teacher or subject instructor', isSystem: true },
      { roleCode: 4, name: 'Accountant', description: 'Finance, fees, and payroll manager', isSystem: true },
      { roleCode: 8, name: 'Receptionist', description: 'Front desk and visitor management', isSystem: true },
      { roleCode: 9, name: 'Proprietor', description: 'School owner and executive oversight', isSystem: true },
      { roleCode: 12, name: 'Librarian', description: 'Library asset and book catalog manager', isSystem: true },
      { roleCode: 13, name: 'Staff', description: 'General administrative & support staff', isSystem: true },
    ]

    // Fetch custom roles created for this branch
    const customRoles = await prisma.staffRole.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { name: 'asc' },
    })

    // Combine system and custom roles
    const allRolesMap = new Map()

    DEFAULT_SYSTEM_ROLES.forEach((r) => {
      allRolesMap.set(r.roleCode, { ...r, id: `sys-${r.roleCode}` })
    })

    customRoles.forEach((r) => {
      allRolesMap.set(r.roleCode, {
        id: r.id,
        roleCode: r.roleCode,
        name: r.name,
        description: r.description || null,
        isSystem: false,
        createdAt: r.createdAt,
      })
    })

    const roleList = Array.from(allRolesMap.values())

    // Fetch active user count per role
    const userRoleCounts = await prisma.user.groupBy({
      by: ['role'],
      where: { active: true },
      _count: { role: true },
    })

    const countMap = new Map()
    userRoleCounts.forEach((c) => {
      countMap.set(c.role, c._count.role)
    })

    const rolesWithCounts = roleList.map((r) => ({
      ...r,
      staffCount: countMap.get(r.roleCode) || 0,
    }))

    return res.json({ success: true, roles: rolesWithCounts })
  } catch (error) {
    console.error('[ADMIN] Fetch roles error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch staff roles.' })
  }
})

/**
 * POST /api/admin/roles
 * Create a new custom staff role for the branch.
 */
router.post('/roles', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { name, description } = req.body
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Role name is required.' })
    }

    const trimmedName = name.trim()

    // Check if role name already exists for this branch
    const existing = await prisma.staffRole.findFirst({
      where: {
        branchId: decoded.branchId,
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    })

    if (existing) {
      return res.status(400).json({ success: false, message: 'A staff role with this name already exists.' })
    }

    // Resolve next custom roleCode starting from 101
    const maxCustomRole = await prisma.staffRole.findFirst({
      orderBy: { roleCode: 'desc' },
      select: { roleCode: true },
    })

    const nextRoleCode = maxCustomRole && maxCustomRole.roleCode >= 101 ? maxCustomRole.roleCode + 1 : 101

    const newRole = await prisma.staffRole.create({
      data: {
        name: trimmedName,
        roleCode: nextRoleCode,
        description: description ? description.trim() : null,
        isSystem: false,
        branchId: decoded.branchId,
      },
    })

    return res.json({ success: true, role: { ...newRole, staffCount: 0 } })
  } catch (error) {
    console.error('[ADMIN] Create role error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to create role.' })
  }
})

/**
 * PUT /api/admin/roles/:id
 * Update custom role details.
 */
router.put('/roles/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const roleId = Number(req.params.id)
  if (isNaN(roleId)) {
    return res.status(400).json({ success: false, message: 'System default roles cannot be edited.' })
  }

  try {
    const { name, description } = req.body
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Role name is required.' })
    }

    const role = await prisma.staffRole.findFirst({
      where: { id: roleId, branchId: decoded.branchId },
    })

    if (!role || role.isSystem) {
      return res.status(404).json({ success: false, message: 'Custom role not found or non-editable system role.' })
    }

    const updated = await prisma.staffRole.update({
      where: { id: roleId },
      data: {
        name: name.trim(),
        description: description ? description.trim() : null,
      },
    })

    return res.json({ success: true, role: updated })
  } catch (error) {
    console.error('[ADMIN] Update role error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update role.' })
  }
})

/**
 * DELETE /api/admin/roles/:id
 * Delete a custom staff role.
 */
router.delete('/roles/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const roleId = Number(req.params.id)
  if (isNaN(roleId)) {
    return res.status(400).json({ success: false, message: 'System default roles cannot be deleted.' })
  }

  try {
    const role = await prisma.staffRole.findFirst({
      where: { id: roleId, branchId: decoded.branchId },
    })

    if (!role || role.isSystem) {
      return res.status(404).json({ success: false, message: 'Custom role not found or system role.' })
    }

    // Check if any active user is assigned to this roleCode
    const assignedUserCount = await prisma.user.count({
      where: { role: role.roleCode, active: true },
    })

    if (assignedUserCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete role '${role.name}' because ${assignedUserCount} active staff member(s) are assigned to it.`,
      })
    }

    await prisma.staffRole.delete({
      where: { id: roleId },
    })

    return res.json({ success: true, message: 'Staff role deleted successfully.' })
  } catch (error) {
    console.error('[ADMIN] Delete role error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete staff role.' })
  }
})

/**
 * GET /api/admin/timetable
 * Fetch timetable slots for a class & section or teacher.
 */
router.get('/timetable', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId, teacherId } = req.query

    const where = { branchId: decoded.branchId }
    if (classId) where.classId = Number(classId)
    if (sectionId) where.sectionId = Number(sectionId)
    if (teacherId) where.teacherId = Number(teacherId)

    const slots = await prisma.timetableSlot.findMany({
      where,
      include: {
        class: { select: { id: true, name: true, nameNumeric: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        teacher: { select: { id: true, name: true, phone: true } },
      },
      orderBy: [{ startTime: 'asc' }],
    })

    // Group by day of week
    const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']
    const grouped = {}
    DAYS.forEach((d) => { grouped[d] = [] })

    slots.forEach((s) => {
      if (grouped[s.dayOfWeek]) {
        grouped[s.dayOfWeek].push(s)
      } else {
        grouped[s.dayOfWeek] = [s]
      }
    })

    return res.json({ success: true, slots, grouped })
  } catch (error) {
    console.error('[ADMIN] Fetch timetable error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch timetable.' })
  }
})

/**
 * POST /api/admin/timetable/slot
 * Create or update a timetable slot (Assembly, Break, or Subject).
 */
router.post('/timetable/slot', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const {
      id,
      classId,
      sectionId,
      dayOfWeek,
      startTime,
      endTime,
      type, // 'SUBJECT', 'ASSEMBLY', 'BREAK'
      title,
      subjectId,
      teacherId,
    } = req.body

    if (!classId || !dayOfWeek || !startTime || !endTime || !type) {
      return res.status(400).json({
        success: false,
        message: 'Class, Day of Week, Start Time, End Time, and Slot Type are required.',
      })
    }

    const validDays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']
    if (!validDays.includes(dayOfWeek.toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Invalid day of week.' })
    }

    const slotType = type.toUpperCase()
    if (!['SUBJECT', 'ASSEMBLY', 'BREAK'].includes(slotType)) {
      return res.status(400).json({ success: false, message: 'Invalid slot type. Must be SUBJECT, ASSEMBLY, or BREAK.' })
    }

    if (slotType === 'SUBJECT' && !subjectId) {
      return res.status(400).json({ success: false, message: 'Subject is required for Subject Time slots.' })
    }

    // Teacher Collision Check: check if teacher is assigned to another class at same day/time
    if (slotType === 'SUBJECT' && teacherId) {
      const conflict = await prisma.timetableSlot.findFirst({
        where: {
          branchId: decoded.branchId,
          teacherId: Number(teacherId),
          dayOfWeek: dayOfWeek.toUpperCase(),
          ...(id ? { id: { not: Number(id) } } : {}),
          OR: [
            { startTime: { lte: startTime }, endTime: { gt: startTime } },
            { startTime: { lt: endTime }, endTime: { gte: endTime } },
            { startTime: { gte: startTime }, endTime: { lte: endTime } },
          ],
        },
        include: {
          class: { select: { name: true } },
          section: { select: { name: true } },
          subject: { select: { name: true } },
        },
      })

      if (conflict) {
        return res.status(400).json({
          success: false,
          message: `Teacher Collision Warning: Teacher is already scheduled for ${conflict.subject?.name || 'Class'} in ${conflict.class?.name || ''} ${conflict.section?.name ? `(${conflict.section.name})` : ''} on ${dayOfWeek} between ${conflict.startTime} - ${conflict.endTime}.`,
        })
      }
    }

    let defaultTitle = title
    if (!defaultTitle) {
      if (slotType === 'ASSEMBLY') defaultTitle = 'Morning Assembly'
      if (slotType === 'BREAK') defaultTitle = 'Break Time'
    }

    let slot
    if (id) {
      slot = await prisma.timetableSlot.update({
        where: { id: Number(id) },
        data: {
          dayOfWeek: dayOfWeek.toUpperCase(),
          startTime,
          endTime,
          type: slotType,
          title: defaultTitle || null,
          subjectId: subjectId ? Number(subjectId) : null,
          teacherId: teacherId ? Number(teacherId) : null,
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
          teacher: { select: { id: true, name: true } },
        },
      })
    } else {
      slot = await prisma.timetableSlot.create({
        data: {
          branchId: decoded.branchId,
          classId: Number(classId),
          sectionId: sectionId ? Number(sectionId) : null,
          dayOfWeek: dayOfWeek.toUpperCase(),
          startTime,
          endTime,
          type: slotType,
          title: defaultTitle || null,
          subjectId: subjectId ? Number(subjectId) : null,
          teacherId: teacherId ? Number(teacherId) : null,
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
          teacher: { select: { id: true, name: true } },
        },
      })
    }

    return res.json({ success: true, slot })
  } catch (error) {
    console.error('[ADMIN] Save timetable slot error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to save timetable slot.' })
  }
})

/**
 * DELETE /api/admin/timetable/slot/:id
 */
router.delete('/timetable/slot/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const slotId = Number(req.params.id)
    await prisma.timetableSlot.delete({
      where: { id: slotId },
    })

    return res.json({ success: true, message: 'Timetable slot removed.' })
  } catch (error) {
    console.error('[ADMIN] Delete timetable slot error:', error)
    return res.status(500).json({ success: false, message: 'Failed to remove timetable slot.' })
  }
})

/**
 * POST /api/admin/timetable/clear
 */
router.post('/timetable/clear', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId } = req.body
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' })
    }

    const where = { branchId: decoded.branchId, classId: Number(classId) }
    if (sectionId) where.sectionId = Number(sectionId)

    await prisma.timetableSlot.deleteMany({ where })

    return res.json({ success: true, message: 'Timetable cleared for this class/section.' })
  } catch (error) {
    console.error('[ADMIN] Clear timetable error:', error)
    return res.status(500).json({ success: false, message: 'Failed to clear timetable.' })
  }
})

/**
 * POST /api/admin/timetable/ai-generate
 * AI-Assisted Timetable Generator.
 * Automatically schedules Assembly Time, Break Time, and Subject slots across Mon-Fri.
 */
router.post('/timetable/ai-generate', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const {
      classId,
      sectionId,
      assemblyStartTime = '08:00',
      assemblyEndTime = '08:30',
      breakStartTime = '11:00',
      breakEndTime = '11:30',
    } = req.body

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' })
    }

    const numClassId = Number(classId)
    const numSectionId = sectionId ? Number(sectionId) : null

    // Fetch subjects assigned to this class/section via SubjectAssign
    const assignedSubjects = await prisma.subjectAssign.findMany({
      where: {
        branchId: decoded.branchId,
        classId: numClassId,
        ...(numSectionId ? { sectionId: numSectionId } : {}),
      },
      include: {
        subject: { select: { id: true, name: true } },
        teacher: { select: { id: true, name: true } },
      },
    })

    // If no specific SubjectAssign records, fallback to all subjects for this branch
    let subjectTeacherPairs = assignedSubjects.map((sa) => ({
      subjectId: sa.subjectId,
      subjectName: sa.subject.name,
      teacherId: sa.teacherId,
      teacherName: sa.teacher.name,
    }))

    if (subjectTeacherPairs.length === 0) {
      const allBranchSubjects = await prisma.subject.findMany({
        where: { branchId: decoded.branchId },
        take: 8,
      })
      subjectTeacherPairs = allBranchSubjects.map((sub) => ({
        subjectId: sub.id,
        subjectName: sub.name,
        teacherId: null,
        teacherName: null,
      }))
    }

    if (subjectTeacherPairs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No subjects found for this class. Please assign subjects in Curriculum setup first.',
      })
    }

    const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']

    const subjectTimeSlots = [
      { startTime: '08:30', endTime: '09:15' },
      { startTime: '09:15', endTime: '10:00' },
      { startTime: '10:00', endTime: '10:45' },
      { startTime: '11:30', endTime: '12:15' },
      { startTime: '12:15', endTime: '13:00' },
      { startTime: '13:00', endTime: '13:45' },
    ]

    const newSlotsToCreate = []

    DAYS.forEach((day) => {
      // 1. Assembly Time
      newSlotsToCreate.push({
        branchId: decoded.branchId,
        classId: numClassId,
        sectionId: numSectionId,
        dayOfWeek: day,
        startTime: assemblyStartTime,
        endTime: assemblyEndTime,
        type: 'ASSEMBLY',
        title: 'Morning Assembly & Devotion',
        subjectId: null,
        teacherId: null,
      })

      // 2. Break Time
      newSlotsToCreate.push({
        branchId: decoded.branchId,
        classId: numClassId,
        sectionId: numSectionId,
        dayOfWeek: day,
        startTime: breakStartTime,
        endTime: breakEndTime,
        type: 'BREAK',
        title: 'Mid-Morning Recess & Break',
        subjectId: null,
        teacherId: null,
      })

      // 3. Subject Periods Distribution
      subjectTimeSlots.forEach((tSlot, pIdx) => {
        const pairIndex = (DAYS.indexOf(day) * subjectTimeSlots.length + pIdx) % subjectTeacherPairs.length
        const pair = subjectTeacherPairs[pairIndex]

        newSlotsToCreate.push({
          branchId: decoded.branchId,
          classId: numClassId,
          sectionId: numSectionId,
          dayOfWeek: day,
          startTime: tSlot.startTime,
          endTime: tSlot.endTime,
          type: 'SUBJECT',
          title: pair.subjectName,
          subjectId: pair.subjectId,
          teacherId: pair.teacherId,
        })
      })
    })

    // Execute in transaction: clear old slots and insert new AI-generated slots
    await prisma.$transaction(async (tx) => {
      await tx.timetableSlot.deleteMany({
        where: {
          branchId: decoded.branchId,
          classId: numClassId,
          ...(numSectionId ? { sectionId: numSectionId } : {}),
        },
      })

      await tx.timetableSlot.createMany({
        data: newSlotsToCreate,
      })
    })

    const generatedSlots = await prisma.timetableSlot.findMany({
      where: {
        branchId: decoded.branchId,
        classId: numClassId,
        ...(numSectionId ? { sectionId: numSectionId } : {}),
      },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
        teacher: { select: { id: true, name: true } },
      },
      orderBy: [{ startTime: 'asc' }],
    })

    return res.json({
      success: true,
      message: `AI Timetable generated successfully with ${newSlotsToCreate.length} slots.`,
      slots: generatedSlots,
    })
  } catch (error) {
    console.error('[ADMIN] AI Timetable generation error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate AI timetable.' })
  }
})

/**
 * GET /api/admin/evaluation-matrices
 * Fetch mark distribution matrices for the branch with default seed matrices.
 */
router.get('/evaluation-matrices', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    let matrices = await prisma.evaluationMatrix.findMany({
      where: { branchId: decoded.branchId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })

    // Seed initial matrices if none exist for this branch
    if (matrices.length === 0) {
      const defaultSeeds = [
        {
          branchId: decoded.branchId,
          name: 'Standard 40/60 Assessment Matrix',
          code: 'EVAL-4060',
          description: 'Standard Secondary School matrix: CA1 (15%), CA2 (25%), and Terminal Exam (60%).',
          totalMarks: 100,
          isDefault: true,
          components: [
            { name: 'Continuous Assessment 1', code: 'CA1', maxMarks: 15, passMarks: 6 },
            { name: 'Continuous Assessment 2', code: 'CA2', maxMarks: 25, passMarks: 10 },
            { name: 'Terminal Examination', code: 'EXAM', maxMarks: 60, passMarks: 24 },
          ],
        },
        {
          branchId: decoded.branchId,
          name: 'Primary School 30/70 Scheme',
          code: 'EVAL-3070',
          description: 'Primary Level matrix: Classwork/Attendance (10%), Mid-Term (20%), End of Term Exam (70%).',
          totalMarks: 100,
          isDefault: false,
          components: [
            { name: 'Classwork & Attendance', code: 'CA1', maxMarks: 10, passMarks: 4 },
            { name: 'Mid-Term Test', code: 'CA2', maxMarks: 20, passMarks: 8 },
            { name: 'Terminal Examination', code: 'EXAM', maxMarks: 70, passMarks: 28 },
          ],
        },
        {
          branchId: decoded.branchId,
          name: 'ECD / Nursery Competency Matrix',
          code: 'EVAL-ECD50',
          description: 'Early Childhood Development matrix: Practical Assessment (50%) & Terminal Evaluation (50%).',
          totalMarks: 100,
          isDefault: false,
          components: [
            { name: 'Practical & Behavioral CA', code: 'CA1', maxMarks: 50, passMarks: 25 },
            { name: 'Terminal Evaluation', code: 'EXAM', maxMarks: 50, passMarks: 25 },
          ],
        },
      ]

      for (const seed of defaultSeeds) {
        await prisma.evaluationMatrix.create({
          data: seed,
        })
      }

      matrices = await prisma.evaluationMatrix.findMany({
        where: { branchId: decoded.branchId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })
    }

    return res.json({ success: true, matrices })
  } catch (error) {
    console.error('[ADMIN] Fetch evaluation matrices error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch evaluation matrices.' })
  }
})

/**
 * POST /api/admin/evaluation-matrices
 * Create a new mark distribution matrix.
 */
router.post('/evaluation-matrices', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { name, code, description, totalMarks, isDefault, components } = req.body

    if (!name || !code) {
      return res.status(400).json({ success: false, message: 'Matrix Name and Matrix Code are required.' })
    }

    if (!Array.isArray(components) || components.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one assessment component is required.' })
    }

    if (isDefault) {
      await prisma.evaluationMatrix.updateMany({
        where: { branchId: decoded.branchId },
        data: { isDefault: false },
      })
    }

    const matrix = await prisma.evaluationMatrix.create({
      data: {
        branchId: decoded.branchId,
        name: name.trim(),
        code: code.trim().toUpperCase(),
        description: description ? description.trim() : null,
        totalMarks: totalMarks ? Number(totalMarks) : 100,
        isDefault: Boolean(isDefault),
        components: components,
      },
    })

    return res.json({ success: true, matrix, message: 'Evaluation Matrix created successfully.' })
  } catch (error) {
    console.error('[ADMIN] Create evaluation matrix error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to create evaluation matrix.' })
  }
})

/**
 * PUT /api/admin/evaluation-matrices/:id
 * Update an existing mark distribution matrix (editable even after creation).
 */
router.put('/evaluation-matrices/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const matrixId = Number(req.params.id)
    const { name, code, description, totalMarks, isDefault, components } = req.body

    const existing = await prisma.evaluationMatrix.findFirst({
      where: { id: matrixId, branchId: decoded.branchId },
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Evaluation Matrix not found.' })
    }

    if (isDefault && !existing.isDefault) {
      await prisma.evaluationMatrix.updateMany({
        where: { branchId: decoded.branchId },
        data: { isDefault: false },
      })
    }

    const updated = await prisma.evaluationMatrix.update({
      where: { id: matrixId },
      data: {
        name: name ? name.trim() : existing.name,
        code: code ? code.trim().toUpperCase() : existing.code,
        description: description !== undefined ? (description ? description.trim() : null) : existing.description,
        totalMarks: totalMarks !== undefined ? Number(totalMarks) : existing.totalMarks,
        isDefault: isDefault !== undefined ? Boolean(isDefault) : existing.isDefault,
        components: components !== undefined ? components : existing.components,
      },
    })

    return res.json({ success: true, matrix: updated, message: 'Evaluation Matrix updated successfully.' })
  } catch (error) {
    console.error('[ADMIN] Update evaluation matrix error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update evaluation matrix.' })
  }
})

/**
 * DELETE /api/admin/evaluation-matrices/:id
 * Delete a mark distribution matrix.
 */
router.delete('/evaluation-matrices/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const matrixId = Number(req.params.id)

    const existing = await prisma.evaluationMatrix.findFirst({
      where: { id: matrixId, branchId: decoded.branchId },
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Evaluation Matrix not found.' })
    }

    await prisma.evaluationMatrix.delete({
      where: { id: matrixId },
    })

    return res.json({ success: true, message: 'Evaluation Matrix deleted successfully.' })
  } catch (error) {
    console.error('[ADMIN] Delete evaluation matrix error:', error)
    return res.status(500).json({ success: false, message: 'Failed to delete evaluation matrix.' })
  }
})

/**
 * POST /api/admin/evaluation-matrices/:id/set-default
 * Set a matrix as default.
 */
router.post('/evaluation-matrices/:id/set-default', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const matrixId = Number(req.params.id)

    await prisma.$transaction([
      prisma.evaluationMatrix.updateMany({
        where: { branchId: decoded.branchId },
        data: { isDefault: false },
      }),
      prisma.evaluationMatrix.update({
        where: { id: matrixId },
        data: { isDefault: true },
      }),
    ])

    return res.json({ success: true, message: 'Default evaluation matrix updated.' })
  } catch (error) {
    console.error('[ADMIN] Set default matrix error:', error)
    return res.status(500).json({ success: false, message: 'Failed to update default evaluation matrix.' })
  }
})

/**
 * GET /api/admin/exam-halls
 * Fetch exam halls for the branch with default seed venues.
 */
router.get('/exam-halls', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    let halls = await prisma.examHall.findMany({
      where: { branchId: decoded.branchId },
      include: {
        invigilator: { select: { id: true, name: true, email: true, phone: true } },
      },
      orderBy: [{ createdAt: 'asc' }],
    })

    // Seed default exam halls if none exist for this branch
    if (halls.length === 0) {
      const defaultSeeds = [
        {
          branchId: decoded.branchId,
          name: 'Main Examination Hall Alpha',
          code: 'HALL-01',
          capacity: 120,
          location: 'Block A, Ground Floor',
          facilities: 'Air Conditioned, High Capacity Desk Seating, Public Address System',
          status: 'ACTIVE',
        },
        {
          branchId: decoded.branchId,
          name: 'CBT Centre Lab 1',
          code: 'CBT-LAB-1',
          capacity: 60,
          location: 'Innovation Building, 2nd Floor',
          facilities: '60 Computer Workstations, High-Speed LAN, UPS Power Backup, CCTV Monitored',
          status: 'ACTIVE',
        },
        {
          branchId: decoded.branchId,
          name: 'Multipurpose Auditorium',
          code: 'AUD-01',
          capacity: 200,
          location: 'Main Campus Center',
          facilities: 'Spacious Examination Layout, Audio System, Stage Invigilator Desk',
          status: 'ACTIVE',
        },
      ]

      for (const seed of defaultSeeds) {
        await prisma.examHall.create({
          data: seed,
        })
      }

      halls = await prisma.examHall.findMany({
        where: { branchId: decoded.branchId },
        include: {
          invigilator: { select: { id: true, name: true, email: true, phone: true } },
        },
        orderBy: [{ createdAt: 'asc' }],
      })
    }

    return res.json({ success: true, halls })
  } catch (error) {
    console.error('[ADMIN] Fetch exam halls error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch exam halls.' })
  }
})

/**
 * POST /api/admin/exam-halls
 * Create a new exam hall.
 */
router.post('/exam-halls', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { name, code, capacity, location, facilities, invigilatorId, status } = req.body

    if (!name || !code) {
      return res.status(400).json({ success: false, message: 'Hall Name and Hall Code are required.' })
    }

    const hall = await prisma.examHall.create({
      data: {
        branchId: decoded.branchId,
        name: name.trim(),
        code: code.trim().toUpperCase(),
        capacity: capacity ? Number(capacity) : 50,
        location: location ? location.trim() : null,
        facilities: facilities ? facilities.trim() : null,
        status: status ? status.toUpperCase() : 'ACTIVE',
        invigilatorId: invigilatorId ? Number(invigilatorId) : null,
      },
      include: {
        invigilator: { select: { id: true, name: true, email: true, phone: true } },
      },
    })

    return res.json({ success: true, hall, message: 'Exam Hall created successfully.' })
  } catch (error) {
    console.error('[ADMIN] Create exam hall error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to create exam hall.' })
  }
})

/**
 * PUT /api/admin/exam-halls/:id
 * Update an existing exam hall.
 */
router.put('/exam-halls/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const hallId = Number(req.params.id)
    const { name, code, capacity, location, facilities, invigilatorId, status } = req.body

    const existing = await prisma.examHall.findFirst({
      where: { id: hallId, branchId: decoded.branchId },
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Exam Hall not found.' })
    }

    const updated = await prisma.examHall.update({
      where: { id: hallId },
      data: {
        name: name ? name.trim() : existing.name,
        code: code ? code.trim().toUpperCase() : existing.code,
        capacity: capacity !== undefined ? Number(capacity) : existing.capacity,
        location: location !== undefined ? (location ? location.trim() : null) : existing.location,
        facilities: facilities !== undefined ? (facilities ? facilities.trim() : null) : existing.facilities,
        status: status ? status.toUpperCase() : existing.status,
        invigilatorId: invigilatorId !== undefined ? (invigilatorId ? Number(invigilatorId) : null) : existing.invigilatorId,
      },
      include: {
        invigilator: { select: { id: true, name: true, email: true, phone: true } },
      },
    })

    return res.json({ success: true, hall: updated, message: 'Exam Hall updated successfully.' })
  } catch (error) {
    console.error('[ADMIN] Update exam hall error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update exam hall.' })
  }
})

/**
 * DELETE /api/admin/exam-halls/:id
 * Delete an exam hall.
 */
router.delete('/exam-halls/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const hallId = Number(req.params.id)

    const existing = await prisma.examHall.findFirst({
      where: { id: hallId, branchId: decoded.branchId },
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Exam Hall not found.' })
    }

    await prisma.examHall.delete({
      where: { id: hallId },
    })

    return res.json({ success: true, message: 'Exam Hall deleted successfully.' })
  } catch (error) {
    console.error('[ADMIN] Delete exam hall error:', error)
    return res.status(500).json({ success: false, message: 'Failed to delete exam hall.' })
  }
})

/**
 * GET /api/admin/exam-schedule
 * Fetch exam schedule slots for a class & section or hall.
 */
router.get('/exam-schedule', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId, hallId } = req.query

    const where = { branchId: decoded.branchId }
    if (classId) where.classId = Number(classId)
    if (sectionId) where.sectionId = Number(sectionId)
    if (hallId) where.hallId = Number(hallId)

    const slots = await prisma.examScheduleSlot.findMany({
      where,
      include: {
        class: { select: { id: true, name: true, nameNumeric: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        hall: { select: { id: true, name: true, code: true, capacity: true, location: true } },
        invigilator: { select: { id: true, name: true, email: true, phone: true } },
      },
      orderBy: [{ examDate: 'asc' }, { startTime: 'asc' }],
    })

    return res.json({ success: true, slots })
  } catch (error) {
    console.error('[ADMIN] Fetch exam schedule error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch exam schedule.' })
  }
})

/**
 * POST /api/admin/exam-schedule/slot
 * Create or update an exam schedule slot.
 */
router.post('/exam-schedule/slot', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const {
      id,
      classId,
      sectionId,
      subjectId,
      examDate,
      startTime,
      endTime,
      hallId,
      invigilatorId,
      instructions,
      isPublished = true,
    } = req.body

    if (!classId || !subjectId || !examDate || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'Class, Subject, Exam Date, Start Time, and End Time are required.',
      })
    }

    const parsedDate = new Date(examDate)
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid exam date format.' })
    }

    // 1. Hall Double-Booking Collision Check
    if (hallId) {
      const hallConflict = await prisma.examScheduleSlot.findFirst({
        where: {
          branchId: decoded.branchId,
          hallId: Number(hallId),
          examDate: parsedDate,
          ...(id ? { id: { not: Number(id) } } : {}),
          OR: [
            { startTime: { lte: startTime }, endTime: { gt: startTime } },
            { startTime: { lt: endTime }, endTime: { gte: endTime } },
            { startTime: { gte: startTime }, endTime: { lte: endTime } },
          ],
        },
        include: {
          class: { select: { name: true } },
          subject: { select: { name: true } },
          hall: { select: { name: true } },
        },
      })

      if (hallConflict) {
        return res.status(400).json({
          success: false,
          message: `Venue Collision Warning: ${hallConflict.hall?.name || 'Exam Hall'} is already booked for ${hallConflict.subject?.name || 'an exam'} (${hallConflict.class?.name || 'Class'}) on ${examDate} between ${hallConflict.startTime} - ${hallConflict.endTime}.`,
        })
      }
    }

    // 2. Invigilator Double-Booking Collision Check
    if (invigilatorId) {
      const invigilatorConflict = await prisma.examScheduleSlot.findFirst({
        where: {
          branchId: decoded.branchId,
          invigilatorId: Number(invigilatorId),
          examDate: parsedDate,
          ...(id ? { id: { not: Number(id) } } : {}),
          OR: [
            { startTime: { lte: startTime }, endTime: { gt: startTime } },
            { startTime: { lt: endTime }, endTime: { gte: endTime } },
            { startTime: { gte: startTime }, endTime: { lte: endTime } },
          ],
        },
        include: {
          class: { select: { name: true } },
          subject: { select: { name: true } },
          invigilator: { select: { name: true } },
        },
      })

      if (invigilatorConflict) {
        return res.status(400).json({
          success: false,
          message: `Invigilator Collision Warning: Supervisor ${invigilatorConflict.invigilator?.name || ''} is already assigned to ${invigilatorConflict.subject?.name || 'an exam'} in ${invigilatorConflict.class?.name || 'another class'} on ${examDate} between ${invigilatorConflict.startTime} - ${invigilatorConflict.endTime}.`,
        })
      }
    }

    let slot
    if (id) {
      slot = await prisma.examScheduleSlot.update({
        where: { id: Number(id) },
        data: {
          classId: Number(classId),
          sectionId: sectionId ? Number(sectionId) : null,
          subjectId: Number(subjectId),
          examDate: parsedDate,
          startTime,
          endTime,
          hallId: hallId ? Number(hallId) : null,
          invigilatorId: invigilatorId ? Number(invigilatorId) : null,
          instructions: instructions ? instructions.trim() : null,
          isPublished: Boolean(isPublished),
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
          hall: { select: { id: true, name: true, code: true } },
          invigilator: { select: { id: true, name: true } },
        },
      })
    } else {
      slot = await prisma.examScheduleSlot.create({
        data: {
          branchId: decoded.branchId,
          classId: Number(classId),
          sectionId: sectionId ? Number(sectionId) : null,
          subjectId: Number(subjectId),
          examDate: parsedDate,
          startTime,
          endTime,
          hallId: hallId ? Number(hallId) : null,
          invigilatorId: invigilatorId ? Number(invigilatorId) : null,
          instructions: instructions ? instructions.trim() : null,
          isPublished: Boolean(isPublished),
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
          hall: { select: { id: true, name: true, code: true } },
          invigilator: { select: { id: true, name: true } },
        },
      })
    }

    return res.json({ success: true, slot, message: 'Exam timetable slot saved.' })
  } catch (error) {
    console.error('[ADMIN] Save exam schedule slot error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to save exam schedule slot.' })
  }
})

/**
 * DELETE /api/admin/exam-schedule/slot/:id
 */
router.delete('/exam-schedule/slot/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const slotId = Number(req.params.id)

    await prisma.examScheduleSlot.delete({
      where: { id: slotId },
    })

    return res.json({ success: true, message: 'Exam timetable slot removed.' })
  } catch (error) {
    console.error('[ADMIN] Delete exam schedule slot error:', error)
    return res.status(500).json({ success: false, message: 'Failed to remove exam schedule slot.' })
  }
})

/**
 * POST /api/admin/exam-schedule/publish
 * Distribute / Publish exam timetable to target class & section.
 */
router.post('/exam-schedule/publish', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId, isPublished = true } = req.body

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' })
    }

    const where = { branchId: decoded.branchId, classId: Number(classId) }
    if (sectionId) where.sectionId = Number(sectionId)

    await prisma.examScheduleSlot.updateMany({
      where,
      data: { isPublished: Boolean(isPublished) },
    })

    return res.json({
      success: true,
      message: isPublished
        ? 'Exam schedule published and distributed to class successfully.'
        : 'Exam schedule set to draft for class.',
    })
  } catch (error) {
    console.error('[ADMIN] Publish exam schedule error:', error)
    return res.status(500).json({ success: false, message: 'Failed to publish exam schedule.' })
  }
})

/**
 * POST /api/admin/exam-schedule/clear
 */
router.post('/exam-schedule/clear', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId } = req.body

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' })
    }

    const where = { branchId: decoded.branchId, classId: Number(classId) }
    if (sectionId) where.sectionId = Number(sectionId)

    await prisma.examScheduleSlot.deleteMany({ where })

    return res.json({ success: true, message: 'Exam schedule cleared for this class.' })
  } catch (error) {
    console.error('[ADMIN] Clear exam schedule error:', error)
    return res.status(500).json({ success: false, message: 'Failed to clear exam schedule.' })
  }
})

/**
 * POST /api/admin/evaluation-matrices/assign-class
 * Assign an Evaluation Matrix to a specific Class.
 */
router.post('/evaluation-matrices/assign-class', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, evaluationMatrixId } = req.body

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' })
    }

    const updatedClass = await prisma.class.update({
      where: { id: Number(classId) },
      data: {
        evaluationMatrixId: evaluationMatrixId ? Number(evaluationMatrixId) : null,
      },
      include: {
        evaluationMatrix: true,
      },
    })

    return res.json({
      success: true,
      class: updatedClass,
      message: 'Evaluation Matrix assigned to class successfully.',
    })
  } catch (error) {
    console.error('[ADMIN] Assign evaluation matrix to class error:', error)
    return res.status(500).json({ success: false, message: 'Failed to assign evaluation matrix to class.' })
  }
})

/**
 * GET /api/admin/marks-entry
 * Fetch class roster, assigned matrix, and existing marks for a class & subject.
 */
router.get('/marks-entry', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId, subjectId, sessionId } = req.query

    if (!classId || !subjectId) {
      return res.status(400).json({ success: false, message: 'classId and subjectId are required.' })
    }

    const cId = Number(classId)
    const subId = Number(subjectId)
    const secId = sectionId ? Number(sectionId) : undefined

    // 1. Fetch Class with assigned Evaluation Matrix
    const classData = await prisma.class.findFirst({
      where: { id: cId, branchId: decoded.branchId },
      include: { evaluationMatrix: true },
    })

    if (!classData) {
      return res.status(404).json({ success: false, message: 'Class not found.' })
    }

    // Fallback to default branch matrix if class has no assigned matrix
    let matrix = classData.evaluationMatrix
    if (!matrix) {
      matrix = await prisma.evaluationMatrix.findFirst({
        where: { branchId: decoded.branchId, isDefault: true },
      })
    }
    if (!matrix) {
      matrix = await prisma.evaluationMatrix.findFirst({
        where: { branchId: decoded.branchId },
      })
    }

    // 2. Fetch Students enrolled in this Class & Section
    const enrollWhere = { classId: cId }
    if (secId) enrollWhere.sectionId = secId

    const enrolls = await prisma.enroll.findMany({
      where: enrollWhere,
      include: {
        student: {
          select: { id: true, firstName: true, lastName: true, registerNo: true, gender: true },
        },
        section: { select: { id: true, name: true } },
      },
      orderBy: [{ roll: 'asc' }],
    })

    const students = enrolls.map((e) => ({
      id: e.student.id,
      name: [e.student.firstName, e.student.lastName].filter(Boolean).join(' ') || `Student #${e.student.id}`,
      roll: e.roll ? String(e.roll) : null,
      registerNo: e.student.registerNo,
      sectionName: e.section?.name,
    }))

    // 3. Fetch existing Marks
    const globalSetting = await prisma.globalSettings.findFirst()
    const activeSession = sessionId ? Number(sessionId) : globalSetting?.sessionId || 1

    const existingMarks = await prisma.mark.findMany({
      where: {
        branchId: decoded.branchId,
        classId: cId,
        subjectId: subId,
        sessionId: activeSession,
        ...(secId ? { sectionId: secId } : {}),
      },
    })

    const marksMap = {}
    existingMarks.forEach((m) => {
      let parsedComponents = {}
      try {
        if (m.mark && m.mark.startsWith('{')) {
          parsedComponents = JSON.parse(m.mark)
        }
      } catch (err) {
        // fallback plain string score
      }

      marksMap[m.studentId] = {
        id: m.id,
        mark: m.mark,
        cbtMark: m.cbtMark,
        absent: m.absent === '1' || m.absent === 'true',
        components: parsedComponents,
      }
    })

    return res.json({
      success: true,
      matrix,
      students,
      marksMap,
      classData: { id: classData.id, name: classData.name, evaluationMatrixId: classData.evaluationMatrixId },
    })
  } catch (error) {
    console.error('[ADMIN] Fetch marks entry error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch marks entry data.' })
  }
})

/**
 * POST /api/admin/marks-entry/batch-save
 * Batch save student assessment marks (supports offline sync payloads).
 */
router.post('/marks-entry/batch-save', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId, subjectId, sessionId, examId, marks } = req.body

    if (!classId || !subjectId || !Array.isArray(marks)) {
      return res.status(400).json({ success: false, message: 'Invalid batch save payload.' })
    }

    const cId = Number(classId)
    const subId = Number(subjectId)
    const secId = sectionId ? Number(sectionId) : 1
    const exId = examId ? Number(examId) : 1
    const globalSetting = await prisma.globalSettings.findFirst()
    const activeSession = sessionId ? Number(sessionId) : globalSetting?.sessionId || 1

    let savedCount = 0

    for (const item of marks) {
      if (!item.studentId) continue

      const sId = Number(item.studentId)
      const isAbsentStr = item.absent ? '1' : '0'

      // Store components breakdown as JSON in mark column, or raw total mark string
      const markValue = item.components ? JSON.stringify(item.components) : String(item.mark || '0')

      const existing = await prisma.mark.findFirst({
        where: {
          branchId: decoded.branchId,
          classId: cId,
          subjectId: subId,
          studentId: sId,
          sessionId: activeSession,
        },
      })

      if (existing) {
        await prisma.mark.update({
          where: { id: existing.id },
          data: {
            mark: markValue,
            absent: isAbsentStr,
          },
        })
      } else {
        await prisma.mark.create({
          data: {
            branchId: decoded.branchId,
            classId: cId,
            sectionId: secId,
            subjectId: subId,
            studentId: sId,
            examId: exId,
            sessionId: activeSession,
            mark: markValue,
            absent: isAbsentStr,
          },
        })
      }
      savedCount++
    }

    return res.json({
      success: true,
      savedCount,
      message: `Batch marks save completed (${savedCount} student records updated).`,
    })
  } catch (error) {
    console.error('[ADMIN] Batch save marks error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to batch save marks.' })
  }
})

/**
 * POST /api/admin/marks-entry/ai-distribute
 * AI Score Distribution Assistant based on Evaluation Matrix.
 */
router.post('/marks-entry/ai-distribute', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, matrixComponents, studentTotals, distributionMode = 'PROPORTIONAL' } = req.body

    if (!Array.isArray(matrixComponents) || matrixComponents.length === 0) {
      return res.status(400).json({ success: false, message: 'Matrix components are required.' })
    }

    if (!Array.isArray(studentTotals) || studentTotals.length === 0) {
      return res.status(400).json({ success: false, message: 'Student totals array is required.' })
    }

    // Calculate sum of max marks in matrix
    const matrixTotalMax = matrixComponents.reduce((sum, c) => sum + (Number(c.maxMarks) || 0), 0) || 100

    const distributedMarksMap = {}

    studentTotals.forEach((st) => {
      const studentId = st.studentId
      const totalScore = Math.min(Math.max(Number(st.totalScore) || 0, 0), matrixTotalMax)

      const components = {}
      let allocatedSum = 0

      // Distribute proportionally across matrix components
      matrixComponents.forEach((comp, idx) => {
        const compMax = Number(comp.maxMarks) || 0
        const isLast = idx === matrixComponents.length - 1

        if (isLast) {
          // Last component absorbs remaining score rounding to equal exactly totalScore
          const remaining = Math.max(0, totalScore - allocatedSum)
          components[comp.code || comp.name] = Math.min(remaining, compMax)
        } else {
          const ratio = compMax / matrixTotalMax
          const calculated = Math.round(totalScore * ratio)
          const compScore = Math.min(calculated, compMax)
          components[comp.code || comp.name] = compScore
          allocatedSum += compScore
        }
      })

      distributedMarksMap[studentId] = {
        totalScore,
        components,
      }
    })

    return res.json({
      success: true,
      distributedMarksMap,
      message: 'AI score distribution completed based on Evaluation Matrix.',
    })
  } catch (error) {
    console.error('[ADMIN] AI distribute marks error:', error)
    return res.status(500).json({ success: false, message: 'Failed to generate AI score distribution.' })
  }
})

/**
 * GET /api/admin/cbt/groups
 * Fetch Question Groups for branch with auto-seeding.
 */
router.get('/cbt/groups', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { subjectId } = req.query
    const where = { branchId: decoded.branchId }
    if (subjectId) where.subjectId = Number(subjectId)

    let groups = await prisma.questionGroup.findMany({
      where,
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
    })

    // Seed default question group if empty
    if (groups.length === 0) {
      const firstSubject = await prisma.subject.findFirst({
        where: { branchId: decoded.branchId },
      })

      if (firstSubject) {
        await prisma.questionGroup.create({
          data: {
            branchId: decoded.branchId,
            subjectId: firstSubject.id,
            title: `${firstSubject.name} General Practice Pack`,
            groupCode: `${firstSubject.subjectCode || 'SUB'}-GRP-01`,
            description: 'Standard practice question bundle for classroom test distribution.',
            questionIds: [],
          },
        })

        groups = await prisma.questionGroup.findMany({
          where,
          include: {
            subject: { select: { id: true, name: true, subjectCode: true } },
          },
          orderBy: [{ createdAt: 'desc' }],
        })
      }
    }

    return res.json({ success: true, groups })
  } catch (error) {
    console.error('[ADMIN] Fetch CBT question groups error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch question groups.' })
  }
})

/**
 * POST /api/admin/cbt/groups
 * Create or update a Question Group.
 */
router.post('/cbt/groups', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { id, title, description, groupCode, subjectId, questionIds = [] } = req.body

    if (!title || !subjectId) {
      return res.status(400).json({ success: false, message: 'Group Title and Subject are required.' })
    }

    let group
    if (id) {
      group = await prisma.questionGroup.update({
        where: { id: Number(id) },
        data: {
          title: title.trim(),
          description: description ? description.trim() : null,
          groupCode: groupCode ? groupCode.trim().toUpperCase() : 'GRP-01',
          subjectId: Number(subjectId),
          questionIds: Array.isArray(questionIds) ? questionIds : [],
        },
        include: {
          subject: { select: { id: true, name: true, subjectCode: true } },
        },
      })
    } else {
      group = await prisma.questionGroup.create({
        data: {
          branchId: decoded.branchId,
          title: title.trim(),
          description: description ? description.trim() : null,
          groupCode: groupCode ? groupCode.trim().toUpperCase() : `GRP-${Date.now().toString().slice(-4)}`,
          subjectId: Number(subjectId),
          questionIds: Array.isArray(questionIds) ? questionIds : [],
        },
        include: {
          subject: { select: { id: true, name: true, subjectCode: true } },
        },
      })
    }

    return res.json({ success: true, group, message: 'Question group saved successfully.' })
  } catch (error) {
    console.error('[ADMIN] Save question group error:', error)
    return res.status(500).json({ success: false, message: 'Failed to save question group.' })
  }
})

/**
 * DELETE /api/admin/cbt/groups/:id
 */
router.delete('/cbt/groups/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const groupId = Number(req.params.id)
    await prisma.questionGroup.delete({ where: { id: groupId } })
    return res.json({ success: true, message: 'Question group deleted.' })
  } catch (error) {
    console.error('[ADMIN] Delete question group error:', error)
    return res.status(500).json({ success: false, message: 'Failed to delete question group.' })
  }
})

/**
 * GET /api/admin/cbt/distributions
 * List CBT distributions for class & section.
 */
router.get('/cbt/distributions', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId, subjectId } = req.query
    const where = { branchId: decoded.branchId }
    if (classId) where.classId = Number(classId)
    if (sectionId) where.sectionId = Number(sectionId)
    if (subjectId) where.subjectId = Number(subjectId)

    const distributions = await prisma.cbtDistribution.findMany({
      where,
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        group: { select: { id: true, title: true, groupCode: true, questionIds: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
    })

    return res.json({ success: true, distributions })
  } catch (error) {
    console.error('[ADMIN] Fetch CBT distributions error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch CBT distributions.' })
  }
})

/**
 * POST /api/admin/cbt/distributions
 * Distribute a CBT test / Question Group to a target class.
 */
router.post('/cbt/distributions', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const {
      id,
      title,
      instructions,
      duration = 30,
      passingMark = 50.0,
      isPublished = true,
      shuffleQuestions = true,
      showResults = true,
      groupId,
      classId,
      sectionId,
      subjectId,
      startDate,
      endDate,
    } = req.body

    if (!title || !classId || !subjectId) {
      return res.status(400).json({ success: false, message: 'Title, Class, and Subject are required.' })
    }

    let dist
    if (id) {
      dist = await prisma.cbtDistribution.update({
        where: { id: Number(id) },
        data: {
          title: title.trim(),
          instructions: instructions ? instructions.trim() : null,
          duration: Number(duration) || 30,
          passingMark: Number(passingMark) || 50.0,
          isPublished: Boolean(isPublished),
          shuffleQuestions: Boolean(shuffleQuestions),
          showResults: Boolean(showResults),
          groupId: groupId ? Number(groupId) : null,
          classId: Number(classId),
          sectionId: sectionId ? Number(sectionId) : null,
          subjectId: Number(subjectId),
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true } },
          group: { select: { id: true, title: true, groupCode: true } },
        },
      })
    } else {
      dist = await prisma.cbtDistribution.create({
        data: {
          branchId: decoded.branchId,
          title: title.trim(),
          instructions: instructions ? instructions.trim() : null,
          duration: Number(duration) || 30,
          passingMark: Number(passingMark) || 50.0,
          isPublished: Boolean(isPublished),
          shuffleQuestions: Boolean(shuffleQuestions),
          showResults: Boolean(showResults),
          groupId: groupId ? Number(groupId) : null,
          classId: Number(classId),
          sectionId: sectionId ? Number(sectionId) : null,
          subjectId: Number(subjectId),
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true } },
          group: { select: { id: true, title: true, groupCode: true } },
        },
      })
    }

    return res.json({ success: true, distribution: dist, message: 'CBT Test distributed to class successfully.' })
  } catch (error) {
    console.error('[ADMIN] Create CBT distribution error:', error)
    return res.status(500).json({ success: false, message: 'Failed to distribute CBT test.' })
  }
})

/**
 * POST /api/admin/cbt/distributions/:id/toggle-publish
 */
router.post('/cbt/distributions/:id/toggle-publish', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const distId = Number(req.params.id)
    const { isPublished } = req.body

    const updated = await prisma.cbtDistribution.update({
      where: { id: distId },
      data: { isPublished: Boolean(isPublished) },
    })

    return res.json({
      success: true,
      distribution: updated,
      message: isPublished ? 'CBT test published live for students.' : 'CBT test unpublished (Draft Mode).',
    })
  } catch (error) {
    console.error('[ADMIN] Toggle CBT publish error:', error)
    return res.status(500).json({ success: false, message: 'Failed to toggle CBT publication status.' })
  }
})

/**
 * DELETE /api/admin/cbt/distributions/:id
 */
router.delete('/cbt/distributions/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const distId = Number(req.params.id)
    await prisma.cbtDistribution.delete({ where: { id: distId } })
    return res.json({ success: true, message: 'CBT distribution deleted.' })
  } catch (error) {
    console.error('[ADMIN] Delete CBT distribution error:', error)
    return res.status(500).json({ success: false, message: 'Failed to delete CBT distribution.' })
  }
})

/**
 * GET /api/admin/attendance/students
 * Fetch student attendance roster & summary for a class & date.
 */
router.get('/attendance/students', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId, date } = req.query

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' })
    }

    const cId = Number(classId)
    const secId = sectionId ? Number(sectionId) : undefined

    // Parse date as LOCAL midnight to avoid UTC off-by-one timezone issue
    let targetDate
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [y, m, d] = date.split('-').map(Number)
      targetDate = new Date(y, m - 1, d, 0, 0, 0, 0)
    } else {
      targetDate = new Date()
      targetDate.setHours(0, 0, 0, 0)
    }

    const nextDate = new Date(targetDate)
    nextDate.setDate(nextDate.getDate() + 1)

    // 1. Fetch Enrolled Students
    const enrollWhere = { classId: cId }
    if (secId) enrollWhere.sectionId = secId

    const enrolls = await prisma.enroll.findMany({
      where: enrollWhere,
      include: {
        student: {
          select: { id: true, firstName: true, lastName: true, registerNo: true, gender: true },
        },
        section: { select: { id: true, name: true } },
      },
      orderBy: [{ roll: 'asc' }],
    })

    const students = enrolls.map((e) => ({
      id: e.student.id,
      name: [e.student.firstName, e.student.lastName].filter(Boolean).join(' ') || `Student #${e.student.id}`,
      roll: e.roll ? String(e.roll) : null,
      registerNo: e.student.registerNo,
      sectionName: e.section?.name,
    }))

    // 2. Fetch Attendance Records for this Date
    const attendanceRecords = await prisma.attendance.findMany({
      where: {
        branchId: decoded.branchId,
        classId: cId,
        ...(secId ? { sectionId: secId } : {}),
        attendanceDate: {
          gte: targetDate,
          lt: nextDate,
        },
      },
    })

    const attendanceMap = {}
    let presentCount = 0
    let absentCount = 0
    let lateCount = 0
    let excusedCount = 0

    attendanceRecords.forEach((att) => {
      attendanceMap[att.studentId] = {
        id: att.id,
        status: att.status ? att.status.toUpperCase() : 'PRESENT',
        remark: att.remark,
      }

      const st = (att.status || '').toUpperCase()
      if (st === 'PRESENT' || st === 'H' || st === '1') presentCount++
      else if (st === 'ABSENT' || st === 'A') absentCount++
      else if (st === 'LATE' || st === 'L') lateCount++
      else if (st === 'EXCUSED' || st === 'E') excusedCount++
      else presentCount++
    })

    const totalEnrolled = students.length
    const attendanceRate = totalEnrolled > 0 ? Math.round(((presentCount + lateCount) / totalEnrolled) * 100) : 0

    return res.json({
      success: true,
      students,
      attendanceMap,
      metrics: {
        totalEnrolled,
        presentCount,
        absentCount,
        lateCount,
        excusedCount,
        attendanceRate,
      },
    })
  } catch (error) {
    console.error('[ADMIN] Fetch student attendance error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch student attendance.' })
  }
})

/**
 * POST /api/admin/attendance/students/batch-save
 * Batch save student attendance for a class & date.
 */
router.post('/attendance/students/batch-save', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId, date, attendance } = req.body

    if (!classId || !date || !Array.isArray(attendance)) {
      return res.status(400).json({ success: false, message: 'Invalid payload.' })
    }

    const cId = Number(classId)
    const secId = sectionId ? Number(sectionId) : null

    // Parse date as LOCAL midnight to avoid UTC off-by-one timezone issue
    let targetDate
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [y, m, d] = date.split('-').map(Number)
      targetDate = new Date(y, m - 1, d, 0, 0, 0, 0)
    } else {
      targetDate = new Date()
      targetDate.setHours(0, 0, 0, 0)
    }

    const nextDate = new Date(targetDate)
    nextDate.setDate(nextDate.getDate() + 1)

    const globalSetting = await prisma.globalSettings.findFirst()
    const activeSession = globalSetting?.sessionId || 1

    let savedCount = 0

    for (const item of attendance) {
      if (!item.studentId) continue
      const sId = Number(item.studentId)
      const statusStr = item.status ? String(item.status).toUpperCase() : 'PRESENT'
      const remarkStr = item.remark ? String(item.remark).trim() : null

      const existing = await prisma.attendance.findFirst({
        where: {
          branchId: decoded.branchId,
          classId: cId,
          studentId: sId,
          attendanceDate: {
            gte: targetDate,
            lt: nextDate,
          },
        },
      })

      if (existing) {
        await prisma.attendance.update({
          where: { id: existing.id },
          data: {
            status: statusStr,
            remark: remarkStr,
          },
        })
      } else {
        await prisma.attendance.create({
          data: {
            branchId: decoded.branchId,
            classId: cId,
            ...(secId ? { sectionId: secId } : {}),
            studentId: sId,
            attendanceDate: targetDate,
            status: statusStr,
            remark: remarkStr,
            sessionId: activeSession,
          },
        })
      }
      savedCount++
    }

    return res.json({
      success: true,
      savedCount,
      message: `Student attendance saved successfully (${savedCount} records).`,
    })
  } catch (error) {
    console.error('[ADMIN] Batch save student attendance error:', error)
    return res.status(500).json({ success: false, message: 'Failed to save student attendance.' })
  }
})

/**
 * GET /api/admin/attendance/staff
 * Fetch staff attendance roster & summary for a date.
 */
router.get('/attendance/staff', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { date } = req.query
    // Parse date as LOCAL midnight to avoid UTC off-by-one timezone issue
    let targetDate
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [y, m, d] = date.split('-').map(Number)
      targetDate = new Date(y, m - 1, d, 0, 0, 0, 0)
    } else {
      targetDate = new Date()
      targetDate.setHours(0, 0, 0, 0)
    }

    const nextDate = new Date(targetDate)
    nextDate.setDate(nextDate.getDate() + 1)

    // 1. Fetch Staff List
    const teachers = await prisma.teacher.findMany({
      where: { branchId: decoded.branchId },
      select: { id: true, name: true, email: true, phone: true, department: true },
      orderBy: [{ name: 'asc' }],
    })

    // 2. Fetch Staff Attendance Records
    const attendanceRecords = await prisma.staffAttendance.findMany({
      where: {
        branchId: decoded.branchId,
        attendanceDate: {
          gte: targetDate,
          lt: nextDate,
        },
      },
    })

    const attendanceMap = {}
    let presentCount = 0
    let absentCount = 0
    let lateCount = 0
    let halfDayCount = 0
    let onLeaveCount = 0

    attendanceRecords.forEach((att) => {
      attendanceMap[att.teacherId] = {
        id: att.id,
        status: att.status ? att.status.toUpperCase() : 'PRESENT',
        clockIn: att.clockIn || '',
        clockOut: att.clockOut || '',
        remark: att.remark || '',
      }

      const st = (att.status || '').toUpperCase()
      if (st === 'PRESENT') presentCount++
      else if (st === 'ABSENT') absentCount++
      else if (st === 'LATE') lateCount++
      else if (st === 'HALF_DAY') halfDayCount++
      else if (st === 'ON_LEAVE') onLeaveCount++
      else presentCount++
    })

    const totalStaff = teachers.length
    const attendanceRate = totalStaff > 0 ? Math.round(((presentCount + lateCount + halfDayCount) / totalStaff) * 100) : 0

    return res.json({
      success: true,
      teachers,
      attendanceMap,
      metrics: {
        totalStaff,
        presentCount,
        absentCount,
        lateCount,
        halfDayCount,
        onLeaveCount,
        attendanceRate,
      },
    })
  } catch (error) {
    console.error('[ADMIN] Fetch staff attendance error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch staff attendance.' })
  }
})

/**
 * POST /api/admin/attendance/staff/batch-save
 * Batch save staff attendance for a date.
 */
router.post('/attendance/staff/batch-save', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { date, attendance } = req.body

    if (!date || !Array.isArray(attendance)) {
      return res.status(400).json({ success: false, message: 'Invalid payload.' })
    }

    // Parse date as LOCAL midnight to avoid UTC off-by-one timezone issue
    let targetDate
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [y, m, d] = date.split('-').map(Number)
      targetDate = new Date(y, m - 1, d, 0, 0, 0, 0)
    } else {
      targetDate = new Date()
      targetDate.setHours(0, 0, 0, 0)
    }

    const nextDate = new Date(targetDate)
    nextDate.setDate(nextDate.getDate() + 1)

    let savedCount = 0

    for (const item of attendance) {
      if (!item.teacherId) continue
      const tId = Number(item.teacherId)
      const statusStr = item.status ? String(item.status).toUpperCase() : 'PRESENT'
      const clockInStr = item.clockIn ? String(item.clockIn).trim() : null
      const clockOutStr = item.clockOut ? String(item.clockOut).trim() : null
      const remarkStr = item.remark ? String(item.remark).trim() : null

      const existing = await prisma.staffAttendance.findFirst({
        where: {
          branchId: decoded.branchId,
          teacherId: tId,
          attendanceDate: {
            gte: targetDate,
            lt: nextDate,
          },
        },
      })

      if (existing) {
        await prisma.staffAttendance.update({
          where: { id: existing.id },
          data: {
            status: statusStr,
            clockIn: clockInStr,
            clockOut: clockOutStr,
            remark: remarkStr,
          },
        })
      } else {
        await prisma.staffAttendance.create({
          data: {
            branchId: decoded.branchId,
            teacherId: tId,
            attendanceDate: targetDate,
            status: statusStr,
            clockIn: clockInStr,
            clockOut: clockOutStr,
            remark: remarkStr,
          },
        })
      }
      savedCount++
    }

    return res.json({
      success: true,
      savedCount,
      message: `Staff attendance saved successfully (${savedCount} records).`,
    })
  } catch (error) {
    console.error('[ADMIN] Batch save staff attendance error:', error)
    return res.status(500).json({ success: false, message: 'Failed to save staff attendance.' })
  }
})

/**
 * POST /api/admin/classes
 * Create a new Class for the branch.
 */
router.post('/classes', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { name, nameNumeric, isEcd } = req.body
    if (!name) {
      return res.status(400).json({ success: false, message: 'Class name is required.' })
    }

    const newClass = await prisma.class.create({
      data: {
        name,
        nameNumeric: nameNumeric || '',
        isEcd: !!isEcd,
        branchId: decoded.branchId,
      },
    })

    return res.status(201).json({ success: true, class: newClass })
  } catch (error) {
    console.error('[ADMIN] Create class error:', error)
    return res.status(500).json({ success: false, message: 'Failed to create class.' })
  }
})

/**
 * POST /api/admin/classes/toggle-ecd
 * Toggle ECD status for a class.
 */
router.post('/classes/toggle-ecd', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, isEcd } = req.body
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' })
    }

    const updatedClass = await prisma.class.update({
      where: { id: Number(classId), branchId: decoded.branchId },
      data: { isEcd: !!isEcd },
    })

    return res.json({
      success: true,
      class: updatedClass,
      message: 'Class ECD status updated successfully.',
    })
  } catch (error) {
    console.error('[ADMIN] Toggle class ECD error:', error)
    return res.status(500).json({ success: false, message: 'Failed to update class ECD status.' })
  }
})

/**
 * POST /api/admin/sections
 * Create a new Section for the branch.
 */
router.post('/sections', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { name, capacity } = req.body
    if (!name) {
      return res.status(400).json({ success: false, message: 'Section name is required.' })
    }

    const newSection = await prisma.section.create({
      data: {
        name,
        capacity: capacity ? String(capacity) : '',
        branchId: decoded.branchId,
      },
    })

    return res.status(201).json({ success: true, section: newSection })
  } catch (error) {
    console.error('[ADMIN] Create section error:', error)
    return res.status(500).json({ success: false, message: 'Failed to create section.' })
  }
})

/**
 * POST /api/admin/classes/allocate-sections
 * Map sections to a class.
 */
router.post('/classes/allocate-sections', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionIds } = req.body
    if (!classId || !Array.isArray(sectionIds)) {
      return res.status(400).json({ success: false, message: 'Invalid payload: classId and sectionIds array required.' })
    }

    await prisma.$transaction(async (tx) => {
      // 1. Delete existing allocations
      await tx.sectionsAllocation.deleteMany({
        where: { classId },
      })

      // 2. Create new allocations
      if (sectionIds.length > 0) {
        await tx.sectionsAllocation.createMany({
          data: sectionIds.map((sid) => ({
            classId,
            sectionId: sid,
          })),
        })
      }
    })

    return res.json({ success: true, message: 'Sections allocated successfully.' })
  } catch (error) {
    console.error('[ADMIN] Allocate sections error:', error)
    return res.status(500).json({ success: false, message: 'Failed to allocate sections.' })
  }
})

/**
 * GET /api/admin/subjects
 * Fetch branch subjects and curriculum assignments.
 */
router.get('/subjects', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const subjects = await prisma.subject.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { name: 'asc' },
    })

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Get current subject assignments with class, section, teacher
    const assignments = await prisma.subjectAssign.findMany({
      where: { branchId: decoded.branchId, sessionId },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        teacher: { select: { id: true, name: true } },
      },
    })

    return res.json({ success: true, subjects, assignments })
  } catch (error) {
    console.error('[ADMIN] Get subjects error:', error)
    return res.status(500).json({ success: false, message: 'Failed to load subjects.' })
  }
})

/**
 * POST /api/admin/subjects
 * Create a new Subject.
 */
router.post('/subjects', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { name, subjectCode, subjectType, subjectAuthor } = req.body
    if (!name || !subjectCode) {
      return res.status(400).json({ success: false, message: 'Name and Subject Code are required.' })
    }

    const newSubject = await prisma.subject.create({
      data: {
        name,
        subjectCode,
        subjectType: subjectType || 'Mandatory',
        subjectAuthor: subjectAuthor || '',
        branchId: decoded.branchId,
      },
    })

    return res.status(201).json({ success: true, subject: newSubject })
  } catch (error) {
    console.error('[ADMIN] Create subject error:', error)
    return res.status(500).json({ success: false, message: 'Failed to create subject.' })
  }
})

/**
 * POST /api/admin/subjects/assign
 * Link subject to class, section, and teacher.
 */
router.post('/subjects/assign', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId, subjectId, teacherId } = req.body
    if (!classId || !sectionId || !subjectId || !teacherId) {
      return res.status(400).json({ success: false, message: 'Class, Section, Subject and Teacher are required.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Check if assignment already exists
    const existing = await prisma.subjectAssign.findFirst({
      where: {
        classId,
        sectionId,
        subjectId,
        branchId: decoded.branchId,
        sessionId,
      },
    })

    if (existing) {
      // Update teacher
      const updated = await prisma.subjectAssign.update({
        where: { id: existing.id },
        data: { teacherId },
      })
      return res.json({ success: true, assignment: updated, message: 'Subject assignment teacher updated.' })
    }

    const newAssign = await prisma.subjectAssign.create({
      data: {
        classId,
        sectionId,
        subjectId,
        teacherId,
        branchId: decoded.branchId,
        sessionId,
      },
    })

    return res.status(201).json({ success: true, assignment: newAssign, message: 'Subject assigned successfully.' })
  } catch (error) {
    console.error('[ADMIN] Assign subject error:', error)
    return res.status(500).json({ success: false, message: 'Failed to assign subject.' })
  }
})

/**
 * POST /api/admin/subjects/assign-bulk
 * Bulk link multiple subjects to a class, section, and teachers.
 */
router.post('/subjects/assign-bulk', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId, assignments } = req.body
    if (!classId || !sectionId || !Array.isArray(assignments)) {
      return res.status(400).json({ success: false, message: 'Class, Section, and Assignments are required.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    await prisma.$transaction(async (tx) => {
      for (const item of assignments) {
        const { subjectId, teacherId } = item
        if (!subjectId || !teacherId) continue

        // Check if assignment already exists
        const existing = await tx.subjectAssign.findFirst({
          where: {
            classId,
            sectionId,
            subjectId,
            branchId: decoded.branchId,
            sessionId,
          },
        })

        if (existing) {
          await tx.subjectAssign.update({
            where: { id: existing.id },
            data: { teacherId },
          })
        } else {
          await tx.subjectAssign.create({
            data: {
              classId,
              sectionId,
              subjectId,
              teacherId,
              branchId: decoded.branchId,
              sessionId,
            },
          })
        }
      }
    })

    return res.status(201).json({ success: true, message: 'Subjects bulk-assigned successfully.' })
  } catch (error) {
    console.error('[ADMIN] Bulk assign subjects error:', error)
    return res.status(500).json({ success: false, message: 'Failed to bulk-assign subjects.' })
  }
})


/**
 * GET /api/admin/exams
 * Fetch branch exams and mark distributions.
 */
router.get('/exams', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const exams = await prisma.exam.findMany({
      where: { branchId: decoded.branchId, sessionId },
      orderBy: { createdAt: 'desc' },
    })

    const distributions = await prisma.examMarkDistribution.findMany({
      where: { branchId: decoded.branchId },
    })

    return res.json({ success: true, exams, distributions })
  } catch (error) {
    console.error('[ADMIN] Get exams error:', error)
    return res.status(500).json({ success: false, message: 'Failed to load exams.' })
  }
})

/**
 * POST /api/admin/exams
 * Create exam with distributions.
 */
router.post('/exams', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { name, termId, typeId, markDistribution, remark } = req.body
    if (!name || !Array.isArray(markDistribution)) {
      return res.status(400).json({ success: false, message: 'Exam Name and Mark Distribution are required.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const resolvedIds = []
    for (const dist of markDistribution) {
      if (typeof dist === 'string' && isNaN(Number(dist))) {
        let existingDist = await prisma.examMarkDistribution.findFirst({
          where: { name: dist, branchId: decoded.branchId },
        })
        if (!existingDist) {
          existingDist = await prisma.examMarkDistribution.create({
            data: { name: dist, branchId: decoded.branchId },
          })
        }
        resolvedIds.push(String(existingDist.id))
      } else {
        resolvedIds.push(String(dist))
      }
    }

    const newExam = await prisma.exam.create({
      data: {
        name,
        termId: termId ? Number(termId) : 1,
        typeId: typeId ? Number(typeId) : 3,
        sessionId,
        branchId: decoded.branchId,
        remark: remark || '',
        markDistribution: JSON.stringify(resolvedIds),
      },
    })

    return res.status(201).json({ success: true, exam: newExam })
  } catch (error) {
    console.error('[ADMIN] Create exam error:', error)
    return res.status(500).json({ success: false, message: 'Failed to create exam.' })
  }
})

/**
 * POST /api/admin/students/onboard
 * Transactional student onboarding with email credential delivery.
 *
 * After the ACID transaction commits, the parent receives an email
 * containing both student and parent login credentials. Email dispatch
 * is fire-and-forget — failures never block the onboarding response.
 */
router.post('/students/onboard', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { student, parent } = req.body
    if (!student || !parent) {
      return res.status(400).json({ success: false, message: 'Student and Parent details are required.' })
    }

    const { firstName, lastName, gender, birthday, classId, sectionId, currentAddress, permanentAddress, previousDetails } = student
    const { name: parentName, email: parentEmail, mobileno: parentPhone, relation: parentRelation } = parent

    if (!firstName || !lastName || !classId || !sectionId) {
      return res.status(400).json({ success: false, message: 'Student first name, last name, class, and section are required.' })
    }

    if (!parentName || (!parentEmail && !parentPhone)) {
      return res.status(400).json({ success: false, message: 'Parent name and either email or phone are required.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Fetch branch info for email context
    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: { name: true, code: true },
    })

    const registerNo = await generateRegistrationNumber(prisma, decoded.branchId)
    const idCardToken = crypto.randomUUID()

    // Generate secure passwords upfront — plaintext held in memory only
    // long enough to hash for DB and compose the email
    const studentPlainPassword = generateSecurePassword()
    const parentPlainPassword = generateSecurePassword()

    // Track credential metadata for post-transaction email
    let isExistingParent = false
    let finalParentUsername = null
    let finalStudentUsername = null

    const result = await prisma.$transaction(async (tx) => {
      // 1. Resolve or Create Parent User & Profile
      let parentRecord = null
      let parentUserId = null

      if (parentEmail) {
        parentRecord = await tx.parent.findFirst({
          where: { email: parentEmail, branchId: decoded.branchId },
        })
      }

      if (!parentRecord && parentPhone) {
        parentRecord = await tx.parent.findFirst({
          where: { mobileno: parentPhone, branchId: decoded.branchId },
        })
      }

      if (parentRecord) {
        parentUserId = parentRecord.userId
        isExistingParent = true
      } else {
        const baseUsername = parentEmail || parentPhone
        const cleanUsername = `${baseUsername.split('@')[0]}_parent`
        
        let uniqueUsername = cleanUsername
        let counter = 1
        while (true) {
          const userCheck = await tx.user.findUnique({ where: { username: uniqueUsername }, select: { id: true } })
          if (!userCheck) break
          uniqueUsername = `${cleanUsername}_${counter++}`
        }

        finalParentUsername = uniqueUsername

        const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
        const nextUserId = maxUser ? maxUser.id + 1 : 1

        const hashedParentPassword = await bcrypt.hash(parentPlainPassword, 10)
        const parentUser = await tx.user.create({
          data: {
            id: nextUserId,
            username: uniqueUsername,
            password: hashedParentPassword,
            role: 6,
            active: true,
          },
        })
        parentUserId = parentUser.id

        const maxParent = await tx.parent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
        const nextParentId = maxParent ? maxParent.id + 1 : 1

        parentRecord = await tx.parent.create({
          data: {
            id: nextParentId,
            name: parentName,
            relation: parentRelation || 'Father',
            email: parentEmail || '',
            mobileno: parentPhone || '',
            active: true,
            branchId: decoded.branchId,
            userId: parentUserId,
          },
        })
      }

      // 2. Create Student User & Profile
      const studentUsername = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`
      let uniqueStudentUsername = studentUsername
      let sCounter = 1
      while (true) {
        const userCheck = await tx.user.findUnique({ where: { username: uniqueStudentUsername }, select: { id: true } })
        if (!userCheck) break
        uniqueStudentUsername = `${studentUsername}_${sCounter++}`
      }

      finalStudentUsername = uniqueStudentUsername

      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      const nextStudentUserId = maxUser ? maxUser.id + 1 : 1

      const hashedStudentPassword = await bcrypt.hash(studentPlainPassword, 10)
      const studentUser = await tx.user.create({
        data: {
          id: nextStudentUserId,
          username: uniqueStudentUsername,
          password: hashedStudentPassword,
          role: 7,
          active: true,
        },
      })

      const maxStudent = await tx.student.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      const nextStudentId = maxStudent ? maxStudent.id + 1 : 1

      const studentRecord = await tx.student.create({
        data: {
          id: nextStudentId,
          registerNo,
          firstName,
          lastName,
          gender: gender || 'Male',
          birthday: birthday ? new Date(birthday) : null,
          currentAddress: currentAddress || null,
          permanentAddress: permanentAddress || null,
          previousDetails: previousDetails || null,
          parentId: parentRecord.id,
          branchId: decoded.branchId,
          userId: studentUser.id,
          idCardToken,
          idCardStatus: 'active',
          active: true,
        },
      })

      // 3. Create Enroll Record
      const maxEnroll = await tx.enroll.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      const nextEnrollId = maxEnroll ? maxEnroll.id + 1 : 1

      await tx.enroll.create({
        data: {
          id: nextEnrollId,
          studentId: studentRecord.id,
          classId: Number(classId),
          sectionId: Number(sectionId),
          roll: 0,
          sessionId,
          branchId: decoded.branchId,
        },
      })

      // 4. Bind CA/Exam Evaluation Matrix
      await bindEvaluationMatrix(tx, {
        studentId: studentRecord.id,
        classId: Number(classId),
        sectionId: Number(sectionId),
        branchId: decoded.branchId,
        sessionId,
      })

      return { student: studentRecord, parent: parentRecord }
    })

    // ── Post-Transaction: Fire-and-Forget Email Delivery ────────────────
    // Email dispatch runs AFTER the transaction commits. Failures are
    // caught, logged, and reported in the response — never block onboarding.
    let emailSent = false
    let emailError = null

    if (parentEmail) {
      try {
        const emailResult = await sendOnboardingCredentials({
          parentEmail,
          parentName,
          studentName: `${firstName} ${lastName}`,
          registerNo,
          studentUsername: finalStudentUsername,
          studentPassword: studentPlainPassword,
          parentUsername: isExistingParent ? null : finalParentUsername,
          parentPassword: isExistingParent ? null : parentPlainPassword,
          isExistingParent,
          schoolName: branch?.name || 'Your School',
          branchCode: branch?.code || '',
          loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
        })
        emailSent = emailResult.success
        if (!emailResult.success) {
          emailError = emailResult.error
          console.warn('[ADMIN] Onboarding email failed (non-blocking):', emailResult.error)
        }
      } catch (err) {
        console.error('[ADMIN] Onboarding email dispatch error (non-blocking):', err.message)
        emailError = err.message
      }
    } else {
      console.warn('[ADMIN] No parent email provided — skipping credential email delivery.')
    }

    // ── Post-Transaction: Generate PDF Credential Slip ──────────────────
    let pdfBase64 = null
    try {
      const pdfBuffer = await generateCredentialSlipPdf({
        schoolName: branch?.name || 'Ugbekun School',
        branchCode: branch?.code || '',
        studentName: `${firstName} ${lastName}`,
        registerNo,
        studentUsername: finalStudentUsername,
        studentPassword: studentPlainPassword,
        parentName,
        parentUsername: isExistingParent ? null : finalParentUsername,
        parentPassword: isExistingParent ? null : parentPlainPassword,
        isExistingParent,
        loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
      })
      pdfBase64 = pdfBuffer.toString('base64')
    } catch (pdfErr) {
      console.error('[ADMIN] Failed to generate credential PDF slip:', pdfErr)
    }

    return res.status(201).json({
      success: true,
      data: result,
      emailSent,
      ...(emailError && { emailError }),
      credentials: {
        student: {
          username: finalStudentUsername,
          password: studentPlainPassword,
        },
        parent: isExistingParent ? null : {
          username: finalParentUsername,
          password: parentPlainPassword,
        },
      },
      pdfBase64,
    })
  } catch (error) {
    console.error('[ADMIN] Student onboarding error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to onboard student.' })
  }
})

/**
 * POST /api/admin/students/import-bulk
 * Bulk onboarding of students via JSON payload parsed from CSV.
 */
router.post('/students/import-bulk', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { students } = req.body
    if (!students || !Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ success: false, message: 'A non-empty list of students is required.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Fetch branch info
    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: { name: true, code: true },
    })

    // Fetch all classes, sections, and allocations in the branch for lookup and validation
    const dbClasses = await prisma.class.findMany({
      where: { branchId: decoded.branchId }
    })
    const dbSections = await prisma.section.findMany({
      where: { branchId: decoded.branchId }
    })
    const dbAllocations = await prisma.sectionsAllocation.findMany({
      include: {
        class: true,
        section: true
      }
    })

    const validationErrors = []
    
    // Validate all rows first
    for (let i = 0; i < students.length; i++) {
      const row = students[i]
      const rowNum = i + 1

      if (!row.firstName || !row.firstName.trim()) {
        validationErrors.push({ row: rowNum, error: 'Student first name is required.' })
      }
      if (!row.lastName || !row.lastName.trim()) {
        validationErrors.push({ row: rowNum, error: 'Student last name is required.' })
      }
      if (!row.parentName || !row.parentName.trim()) {
        validationErrors.push({ row: rowNum, error: 'Parent name is required.' })
      }
      if ((!row.parentEmail || !row.parentEmail.trim()) && (!row.parentPhone || !row.parentPhone.trim())) {
        validationErrors.push({ row: rowNum, error: 'Parent must have either an email or mobile phone number.' })
      }

      // Check class existence
      if (!row.className || !row.className.trim()) {
        validationErrors.push({ row: rowNum, error: 'Class name is required.' })
      } else {
        const matchedClass = dbClasses.find(c => c.name.trim().toLowerCase() === row.className.trim().toLowerCase())
        if (!matchedClass) {
          validationErrors.push({ row: rowNum, error: `Class '${row.className}' not found in this branch.` })
        } else {
          // Check section existence
          if (!row.sectionName || !row.sectionName.trim()) {
            validationErrors.push({ row: rowNum, error: 'Section name is required.' })
          } else {
            const matchedSection = dbSections.find(s => s.name.trim().toLowerCase() === row.sectionName.trim().toLowerCase())
            if (!matchedSection) {
              validationErrors.push({ row: rowNum, error: `Section '${row.sectionName}' not found in this branch.` })
            } else {
              // Check allocation
              const hasAllocation = dbAllocations.some(a => a.classId === matchedClass.id && a.sectionId === matchedSection.id)
              if (!hasAllocation) {
                validationErrors.push({ row: rowNum, error: `Section '${row.sectionName}' is not allocated to Class '${row.className}'.` })
              }
            }
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({ success: false, errors: validationErrors })
    }

    const results = []

    // Execute bulk registration inside transaction
    await prisma.$transaction(async (tx) => {
      // Find initial ID baselines to increment sequentially in memory to prevent key collision
      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      let nextUserId = maxUser ? maxUser.id + 1 : 1

      const maxParent = await tx.parent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      let nextParentId = maxParent ? maxParent.id + 1 : 1

      const maxStudent = await tx.student.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      let nextStudentId = maxStudent ? maxStudent.id + 1 : 1

      const maxEnroll = await tx.enroll.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      let nextEnrollId = maxEnroll ? maxEnroll.id + 1 : 1

      for (let i = 0; i < students.length; i++) {
        const row = students[i]
        
        // Resolve matching class/section (already validated)
        const matchedClass = dbClasses.find(c => c.name.trim().toLowerCase() === row.className.trim().toLowerCase())
        const matchedSection = dbSections.find(s => s.name.trim().toLowerCase() === row.sectionName.trim().toLowerCase())

        const registerNo = await generateRegistrationNumber(tx, decoded.branchId)
        const idCardToken = crypto.randomUUID()

        const studentPlainPassword = generateSecurePassword()
        const parentPlainPassword = generateSecurePassword()

        let parentRecord = null
        let parentUserId = null
        let isExistingParent = false
        let finalParentUsername = null

        // Resolve or create Parent Profile
        if (row.parentEmail) {
          parentRecord = await tx.parent.findFirst({
            where: { email: row.parentEmail, branchId: decoded.branchId },
          })
        }

        if (!parentRecord && row.parentPhone) {
          parentRecord = await tx.parent.findFirst({
            where: { mobileno: row.parentPhone, branchId: decoded.branchId },
          })
        }

        if (parentRecord) {
          parentUserId = parentRecord.userId
          isExistingParent = true
        } else {
          const baseUsername = row.parentEmail || row.parentPhone
          const cleanUsername = `${baseUsername.split('@')[0]}_parent`

          let uniqueUsername = cleanUsername
          let counter = 1
          while (true) {
            const userCheck = await tx.user.findUnique({ where: { username: uniqueUsername }, select: { id: true } })
            if (!userCheck) break
            uniqueUsername = `${cleanUsername}_${counter++}`
          }

          finalParentUsername = uniqueUsername

          const hashedParentPassword = await bcrypt.hash(parentPlainPassword, 10)
          const parentUser = await tx.user.create({
            data: {
              id: nextUserId++,
              username: uniqueUsername,
              password: hashedParentPassword,
              role: 6,
              active: true,
            },
          })
          parentUserId = parentUser.id

          parentRecord = await tx.parent.create({
            data: {
              id: nextParentId++,
              name: row.parentName,
              relation: row.parentRelation || 'Father',
              email: row.parentEmail || '',
              mobileno: row.parentPhone || '',
              active: true,
              branchId: decoded.branchId,
              userId: parentUserId,
            },
          })
        }

        // Create Student User
        const studentUsername = `${row.firstName.toLowerCase()}.${row.lastName.toLowerCase()}`
        let uniqueStudentUsername = studentUsername
        let sCounter = 1
        while (true) {
          const userCheck = await tx.user.findUnique({ where: { username: uniqueStudentUsername }, select: { id: true } })
          if (!userCheck) break
          uniqueStudentUsername = `${studentUsername}_${sCounter++}`
        }

        const hashedStudentPassword = await bcrypt.hash(studentPlainPassword, 10)
        const studentUser = await tx.user.create({
          data: {
            id: nextUserId++,
            username: uniqueStudentUsername,
            password: hashedStudentPassword,
            role: 7,
            active: true,
          },
        })

        const studentRecord = await tx.student.create({
          data: {
            id: nextStudentId++,
            registerNo,
            firstName: row.firstName,
            lastName: row.lastName,
            gender: row.gender || 'Male',
            birthday: row.birthday ? new Date(row.birthday) : null,
            parentId: parentRecord.id,
            branchId: decoded.branchId,
            userId: studentUser.id,
            idCardToken,
            idCardStatus: 'active',
            active: true,
          },
        })

        // Create Enroll Record
        await tx.enroll.create({
          data: {
            id: nextEnrollId++,
            studentId: studentRecord.id,
            classId: matchedClass.id,
            sectionId: matchedSection.id,
            roll: 0,
            sessionId,
            branchId: decoded.branchId,
          },
        })

        // Bind CA/Exam Evaluation Matrix
        await bindEvaluationMatrix(tx, {
          studentId: studentRecord.id,
          classId: matchedClass.id,
          sectionId: matchedSection.id,
          branchId: decoded.branchId,
          sessionId,
        })

        results.push({
          firstName: row.firstName,
          lastName: row.lastName,
          registerNo,
          parentName: row.parentName,
          parentEmail: row.parentEmail || null,
          credentials: {
            student: {
              username: uniqueStudentUsername,
              password: studentPlainPassword,
            },
            parent: isExistingParent ? null : {
              username: finalParentUsername,
              password: parentPlainPassword,
            }
          }
        })
      }
    })

    // Post-Transaction: Async email dispatch
    for (const resItem of results) {
      if (resItem.parentEmail) {
        sendOnboardingCredentials({
          parentEmail: resItem.parentEmail,
          parentName: resItem.parentName,
          studentName: `${resItem.firstName} ${resItem.lastName}`,
          registerNo: resItem.registerNo,
          studentUsername: resItem.credentials.student.username,
          studentPassword: resItem.credentials.student.password,
          parentUsername: resItem.credentials.parent ? resItem.credentials.parent.username : null,
          parentPassword: resItem.credentials.parent ? resItem.credentials.parent.password : null,
          isExistingParent: !resItem.credentials.parent,
          schoolName: branch?.name || 'Your School',
          branchCode: branch?.code || '',
          loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
        }).catch(err => {
          console.warn('[ADMIN] Async bulk onboarding email failed:', err.message)
        })
      }
    }

    return res.status(201).json({ success: true, createdCount: results.length, data: results })
  } catch (error) {
    console.error('[ADMIN] Bulk student onboarding error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to complete bulk student onboarding.' })
  }
})

/**
 * POST /api/admin/students/:id/promote
 * Student promotion event with historical archiving and matrix wiping.
 */
router.post('/students/:id/promote', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const studentId = Number(req.params.id)
  try {
    const { classId, sectionId } = req.body
    if (!classId || !sectionId) {
      return res.status(400).json({ success: false, message: 'Target classId and sectionId are required.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    await prisma.$transaction(async (tx) => {
      const currentEnroll = await tx.enroll.findFirst({
        where: { studentId, sessionId, branchId: decoded.branchId },
      })

      if (!currentEnroll) {
        throw new Error('Student has no current active enrollment in this session.')
      }

      await tx.promotionHistory.create({
        data: {
          studentId,
          fromClassId: currentEnroll.classId,
          fromSectionId: currentEnroll.sectionId,
          toClassId: Number(classId),
          toSectionId: Number(sectionId),
          promotedBy: decoded.sub,
          sessionId,
        },
      })

      await wipeEvaluationMatrix(tx, { studentId, sessionId })

      await tx.enroll.update({
        where: { id: currentEnroll.id },
        data: {
          classId: Number(classId),
          sectionId: Number(sectionId),
          updatedAt: new Date(),
        },
      })

      await bindEvaluationMatrix(tx, {
        studentId,
        classId: Number(classId),
        sectionId: Number(sectionId),
        branchId: decoded.branchId,
        sessionId,
      })
    })

    return res.json({ success: true, message: 'Student promoted successfully.' })
  } catch (error) {
    console.error('[ADMIN] Student promotion error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to promote student.' })
  }
})

/**
 * GET /api/admin/students/:id
 * Fetch single student details for editing
 */
router.get('/students/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const studentId = Number(req.params.id)
  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: {
        parent: true,
        enrolls: {
          where: { sessionId },
          include: {
            class: true,
            section: true,
          },
        },
      },
    })

    if (!student || student.branchId !== decoded.branchId) {
      return res.status(404).json({ success: false, message: 'Student not found or access denied.' })
    }

    const currentEnroll = student.enrolls[0] || null

    return res.json({
      success: true,
      student: {
        id: student.id,
        registerNo: student.registerNo || '',
        firstName: student.firstName || '',
        lastName: student.lastName || '',
        gender: student.gender || '',
        birthday: student.birthday ? student.birthday.toISOString().split('T')[0] : '',
        religion: student.religion || '',
        caste: student.caste || '',
        bloodGroup: student.bloodGroup || '',
        motherTongue: student.motherTongue || '',
        currentAddress: student.currentAddress || '',
        permanentAddress: student.permanentAddress || '',
        city: student.city || '',
        state: student.state || '',
        mobileno: student.mobileno || '',
        email: student.email || '',
        previousDetails: student.previousDetails || '',
        photo: student.photo || '',
        active: student.active,
        classId: currentEnroll?.classId || '',
        sectionId: currentEnroll?.sectionId || '',
        className: currentEnroll?.class?.name || '',
        sectionName: currentEnroll?.section?.name || '',
        parent: student.parent ? {
          id: student.parent.id,
          name: student.parent.name || '',
          email: student.parent.email || '',
          mobileno: student.parent.mobileno || '',
          relation: student.parent.relation || '',
        } : null,
      },
    })
  } catch (error) {
    console.error('[ADMIN] Get student details error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch student details.' })
  }
})

/**
 * PUT /api/admin/students/:id
 * Update full student profile, enrollment class/section, and parent details.
 */
router.put('/students/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const studentId = Number(req.params.id)
  try {
    const {
      firstName,
      lastName,
      gender,
      birthday,
      registerNo,
      religion,
      caste,
      bloodGroup,
      motherTongue,
      currentAddress,
      permanentAddress,
      city,
      state,
      mobileno,
      email,
      previousDetails,
      photo,
      active,
      classId,
      sectionId,
      parentName,
      parentEmail,
      parentPhone,
      parentRelation,
    } = req.body

    const existingStudent = await prisma.student.findUnique({
      where: { id: studentId },
      include: { parent: true },
    })

    if (!existingStudent || existingStudent.branchId !== decoded.branchId) {
      return res.status(404).json({ success: false, message: 'Student not found or access denied.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    await prisma.$transaction(async (tx) => {
      // 1. Update Student record
      const updateData = {}
      if (firstName !== undefined) updateData.firstName = firstName
      if (lastName !== undefined) updateData.lastName = lastName
      if (gender !== undefined) updateData.gender = gender
      if (birthday !== undefined) updateData.birthday = birthday ? new Date(birthday) : null
      if (registerNo !== undefined) updateData.registerNo = registerNo
      if (religion !== undefined) updateData.religion = religion
      if (caste !== undefined) updateData.caste = caste
      if (bloodGroup !== undefined) updateData.bloodGroup = bloodGroup
      if (motherTongue !== undefined) updateData.motherTongue = motherTongue
      if (currentAddress !== undefined) updateData.currentAddress = currentAddress
      if (permanentAddress !== undefined) updateData.permanentAddress = permanentAddress
      if (city !== undefined) updateData.city = city
      if (state !== undefined) updateData.state = state
      if (mobileno !== undefined) updateData.mobileno = mobileno
      if (email !== undefined) updateData.email = email
      if (previousDetails !== undefined) updateData.previousDetails = previousDetails
      if (photo !== undefined) updateData.photo = photo
      if (active !== undefined) updateData.active = Boolean(active)
      updateData.updatedAt = new Date()

      await tx.student.update({
        where: { id: studentId },
        data: updateData,
      })

      // 2. Update Associated User if present
      if (existingStudent.userId && (firstName || lastName || email)) {
        const userUpdate = {}
        if (firstName || lastName) {
          userUpdate.name = `${firstName || existingStudent.firstName || ''} ${lastName || existingStudent.lastName || ''}`.trim()
        }
        if (email) userUpdate.email = email
        await tx.user.update({
          where: { id: existingStudent.userId },
          data: userUpdate,
        })
      }

      // 3. Update or Upsert Enroll record for active session
      if (classId && sectionId) {
        const numClassId = Number(classId)
        const numSectionId = Number(sectionId)

        const existingEnroll = await tx.enroll.findFirst({
          where: { studentId, sessionId, branchId: decoded.branchId },
        })

        if (existingEnroll) {
          if (existingEnroll.classId !== numClassId || existingEnroll.sectionId !== numSectionId) {
            await tx.enroll.update({
              where: { id: existingEnroll.id },
              data: {
                classId: numClassId,
                sectionId: numSectionId,
                updatedAt: new Date(),
              },
            })
          }
        } else {
          // Create missing enrollment
          const maxEnroll = await tx.enroll.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
          await tx.enroll.create({
            data: {
              id: maxEnroll ? maxEnroll.id + 1 : 1,
              studentId,
              classId: numClassId,
              sectionId: numSectionId,
              sessionId,
              branchId: decoded.branchId,
              isAlumni: 0,
            },
          })
        }
      }

      // 4. Update Parent record if provided and linked
      if (existingStudent.parentId && (parentName || parentEmail || parentPhone || parentRelation)) {
        const parentUpdate = {}
        if (parentName) parentUpdate.name = parentName
        if (parentEmail) parentUpdate.email = parentEmail
        if (parentPhone) parentUpdate.mobileno = parentPhone
        if (parentRelation) parentUpdate.relation = parentRelation
        parentUpdate.updatedAt = new Date()

        await tx.parent.update({
          where: { id: existingStudent.parentId },
          data: parentUpdate,
        })

        // Also update parent User record if name or email changed
        if (existingStudent.parent?.userId && (parentName || parentEmail)) {
          const parentUserUpdate = {}
          if (parentName) parentUserUpdate.name = parentName
          if (parentEmail) parentUserUpdate.email = parentEmail
          await tx.user.update({
            where: { id: existingStudent.parent.userId },
            data: parentUserUpdate,
          })
        }
      }
    })

    return res.json({ success: true, message: 'Student information updated successfully.' })
  } catch (error) {
    console.error('[ADMIN] Update student error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update student information.' })
  }
})

/**
 * DELETE /api/admin/students/:id
 * Delete or deactivate student record.
 */
router.delete('/students/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const studentId = Number(req.params.id)
  try {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
    })

    if (!student || student.branchId !== decoded.branchId) {
      return res.status(404).json({ success: false, message: 'Student not found or access denied.' })
    }

    await prisma.student.update({
      where: { id: studentId },
      data: { active: false, updatedAt: new Date() },
    })

    return res.json({ success: true, message: 'Student record deactivated successfully.' })
  } catch (error) {
    console.error('[ADMIN] Delete student error:', error)
    return res.status(500).json({ success: false, message: 'Failed to deactivate student.' })
  }
})

/**
 * POST /api/admin/teachers/onboard
 * Onboard a teacher with email credential delivery.
 */
router.post('/teachers/onboard', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const {
      name,
      email,
      phone,
      qualifications,
      houseAddress,
      department,
      bankName,
      accountNumber,
      accountName,
      role = 3,
      isClassTeacher,
      classTeacherClassId,
      classTeacherSectionId,
      isSubjectTeacher,
      subjectTeacherClassId,
      subjectTeacherSectionId,
      subjectTeacherSubjectId,
    } = req.body

    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Name and email are required.' })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' })
    }

    const selectedRole = Number(role) || 3
    const systemRoleCodes = [3, 4, 8, 9, 12, 13]
    if (!systemRoleCodes.includes(selectedRole)) {
      const customRoleCheck = await prisma.staffRole.findFirst({
        where: { roleCode: selectedRole, branchId: decoded.branchId }
      })
      if (!customRoleCheck) {
        return res.status(400).json({ success: false, message: 'Invalid staff role.' })
      }
    }

    // Fetch branch info for email/PDF context
    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: { name: true, code: true },
    })

    const teacherPlainPassword = generateSecurePassword()

    // Track credentials for post-transaction email
    let finalUsername = null

    const result = await prisma.$transaction(async (tx) => {
      // 1. Resolve a unique username
      const branchCode = branch?.code || ''
      const prefix = extractCodePrefix(branchCode).toLowerCase()
      const emailUser = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '.')

      let baseUsername = emailUser
      if (selectedRole !== 3 && prefix) {
        baseUsername = `${prefix}/${emailUser}`
      }

      let uniqueUsername = baseUsername
      let counter = 1
      while (true) {
        const userCheck = await tx.user.findUnique({ where: { username: uniqueUsername }, select: { id: true } })
        if (!userCheck) break
        uniqueUsername = `${baseUsername}_${counter++}`
      }

      finalUsername = uniqueUsername

      // 2. Create User
      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      const nextUserId = maxUser ? maxUser.id + 1 : 1
      const hashedPassword = await bcrypt.hash(teacherPlainPassword, 10)

      const user = await tx.user.create({
        data: {
          id: nextUserId,
          username: uniqueUsername,
          password: hashedPassword,
          role: selectedRole,
          active: true,
        },
      })

      let teacher = null

      if (selectedRole === 3) {
        const maxTeacher = await tx.teacher.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
        const nextTeacherId = maxTeacher ? maxTeacher.id + 1 : 1

        // Update user to link legacyUserId
        await tx.user.update({
          where: { id: user.id },
          data: { legacyUserId: nextTeacherId }
        })

        // Create Teacher Profile
        teacher = await tx.teacher.create({
          data: {
            id: nextTeacherId,
            name,
            email,
            phone: phone || null,
            qualifications: qualifications || null,
            houseAddress: houseAddress || null,
            department: department || null,
            bankName: bankName || null,
            accountNumber: accountNumber || null,
            accountName: accountName || null,
            branchId: decoded.branchId,
            userId: user.id,
            active: true,
          },
        })

        const globalSetting = await tx.globalSettings.findFirst()
        const sessionId = globalSetting?.sessionId || 5

        // Allocate Form Class Teacher if specified
        if (isClassTeacher && classTeacherClassId && classTeacherSectionId) {
          const maxAlloc = await tx.teacherAllocation.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
          const nextAllocId = maxAlloc ? maxAlloc.id + 1 : 1

          const existingClassAlloc = await tx.teacherAllocation.findFirst({
            where: {
              classId: Number(classTeacherClassId),
              sectionId: Number(classTeacherSectionId),
              sessionId: sessionId,
              branchId: decoded.branchId,
            }
          })

          if (existingClassAlloc) {
            await tx.teacherAllocation.update({
              where: { id: existingClassAlloc.id },
              data: { teacherId: nextTeacherId }
            })
          } else {
            await tx.teacherAllocation.create({
              data: {
                id: nextAllocId,
                classId: Number(classTeacherClassId),
                sectionId: Number(classTeacherSectionId),
                sessionId: sessionId,
                teacherId: nextTeacherId,
                branchId: decoded.branchId,
              }
            })
          }
        }

        // Assign Subject if specified
        if (isSubjectTeacher && subjectTeacherClassId && subjectTeacherSectionId && subjectTeacherSubjectId) {
          const maxAssign = await tx.subjectAssign.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
          const nextAssignId = maxAssign ? maxAssign.id + 1 : 1

          const existingSubjectAssign = await tx.subjectAssign.findFirst({
            where: {
              classId: Number(subjectTeacherClassId),
              sectionId: Number(subjectTeacherSectionId),
              subjectId: Number(subjectTeacherSubjectId),
              branchId: decoded.branchId,
              sessionId: sessionId,
            }
          })

          if (existingSubjectAssign) {
            await tx.subjectAssign.update({
              where: { id: existingSubjectAssign.id },
              data: { teacherId: nextTeacherId }
            })
          } else {
            await tx.subjectAssign.create({
              data: {
                id: nextAssignId,
                classId: Number(subjectTeacherClassId),
                sectionId: Number(subjectTeacherSectionId),
                subjectId: Number(subjectTeacherSubjectId),
                teacherId: nextTeacherId,
                branchId: decoded.branchId,
                sessionId: sessionId,
              }
            })
          }
        }
      }

      return { teacher, user }
    })

    // ── Post-Transaction: Fire-and-Forget Email Delivery ────────────────
    let emailSent = false
    let emailError = null

    try {
      const emailResult = await sendTeacherOnboardingCredentials({
        teacherEmail: email,
        teacherName: name,
        username: finalUsername,
        password: teacherPlainPassword,
        schoolName: branch?.name || 'Your School',
        branchCode: branch?.code || '',
        loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
      })
      emailSent = emailResult.success
      if (!emailResult.success) {
        emailError = emailResult.error
      }
    } catch (err) {
      console.error('[ADMIN] Teacher/Staff onboarding email dispatch error (non-blocking):', err.message)
      emailError = err.message
    }

    // ── Post-Transaction: Generate PDF Credential Slip ──────────────────
    let pdfBase64 = null
    try {
      const pdfBuffer = await generateCredentialSlipPdf({
        schoolName: branch?.name || 'Ugbekun School',
        branchCode: branch?.code || '',
        studentName: name, // For staff/teacher slip, we put their name in the studentName slot
        registerNo: selectedRole === 3 ? 'TEACHER' : (STAFF_ROLE_LABELS[selectedRole] || 'STAFF').toUpperCase(),
        studentUsername: finalUsername,
        studentPassword: teacherPlainPassword,
        parentName: '',
        parentUsername: null,
        parentPassword: null,
        isExistingParent: true,
        loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
      })
      pdfBase64 = pdfBuffer.toString('base64')
    } catch (pdfErr) {
      console.error('[ADMIN] Failed to generate teacher/staff credential PDF slip:', pdfErr)
    }

    return res.status(201).json({
      success: true,
      data: result,
      emailSent,
      ...(emailError && { emailError }),
      credentials: {
        username: finalUsername,
        password: teacherPlainPassword,
      },
      pdfBase64,
    })
  } catch (error) {
    console.error('[ADMIN] Teacher/Staff onboarding error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to onboard teacher/staff.' })
  }
})

/**
 * PUT /api/admin/teachers/:id
 * Update teacher details.
 */
router.put('/teachers/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const teacherId = Number(req.params.id)
  try {
    const { name, email, phone, qualifications, houseAddress, department, bankName, accountNumber, accountName } = req.body
    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Name and email are required.' })
    }

    // Row-level check: ensure teacher belongs to this branch
    const teacher = await prisma.teacher.findFirst({
      where: { id: teacherId, branchId: decoded.branchId },
    })

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found or unauthorized.' })
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Update Teacher profile
      const updateData = {
        name,
        email,
        phone: phone || null,
        updatedAt: new Date(),
      }
      if (qualifications !== undefined) updateData.qualifications = qualifications || null
      if (houseAddress !== undefined) updateData.houseAddress = houseAddress || null
      if (department !== undefined) updateData.department = department || null
      if (bankName !== undefined) updateData.bankName = bankName || null
      if (accountNumber !== undefined) updateData.accountNumber = accountNumber || null
      if (accountName !== undefined) updateData.accountName = accountName || null

      const t = await tx.teacher.update({
        where: { id: teacherId },
        data: updateData,
      })

      return t
    })

    return res.json({ success: true, teacher: updated })
  } catch (error) {
    console.error('[ADMIN] Update teacher error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update teacher.' })
  }
})

/**
 * DELETE /api/admin/teachers/:id
 * Soft-deactivate a teacher.
 */
router.delete('/teachers/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const teacherId = Number(req.params.id)
  try {
    // Row-level check: ensure teacher belongs to this branch
    const teacher = await prisma.teacher.findFirst({
      where: { id: teacherId, branchId: decoded.branchId },
    })

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found or unauthorized.' })
    }

    await prisma.$transaction(async (tx) => {
      // 1. Soft-deactivate Teacher profile
      await tx.teacher.update({
        where: { id: teacherId },
        data: { active: false },
      })

      // 2. Soft-deactivate linked User account
      if (teacher.userId) {
        await tx.user.update({
          where: { id: teacher.userId },
          data: { active: false },
        })
      }
    })

    return res.json({ success: true, message: 'Teacher soft-deactivated successfully.' })
  } catch (error) {
    console.error('[ADMIN] Deactivate teacher error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to deactivate teacher.' })
  }
})

/**
 * GET /api/admin/sibling-requests
 * Fetch all sibling requests submitted by parents for review.
 */
router.get('/sibling-requests', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const requests = await prisma.parentSiblingRequest.findMany({
      where: { branchId: decoded.branchId },
      include: {
        parent: { select: { name: true, email: true, mobileno: true } },
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    const formatted = requests.map(r => ({
      id: r.id,
      parentId: r.parentId,
      parentName: r.parent.name,
      parentEmail: r.parent.email,
      parentPhone: r.parent.mobileno,
      firstName: r.firstName,
      lastName: r.lastName,
      gender: r.gender,
      birthday: r.birthday,
      status: r.status,
      rejectionReason: r.rejectionReason,
      className: r.class.name,
      sectionName: r.section.name,
      createdAt: r.createdAt,
    }))

    return res.json({ success: true, siblingRequests: formatted })
  } catch (error) {
    console.error('[ADMIN] Get sibling requests error:', error)
    return res.status(500).json({ success: false, message: 'Failed to load sibling requests.' })
  }
})

/**
 * POST /api/admin/sibling-requests/:id/approve
 * Approve a sibling request, create the student user, student profile, enroll record,
 * and bind evaluation matrix in an ACID transaction, then notify parent.
 */
router.post('/sibling-requests/:id/approve', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const requestId = parseInt(req.params.id, 10)
    if (isNaN(requestId)) {
      return res.status(400).json({ success: false, message: 'Invalid Request ID.' })
    }

    const request = await prisma.parentSiblingRequest.findFirst({
      where: { id: requestId, branchId: decoded.branchId },
      include: {
        parent: true,
        branch: true,
      },
    })

    if (!request) {
      return res.status(404).json({ success: false, message: 'Sibling request not found.' })
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Request is already ${request.status}.` })
    }

    const { firstName, lastName, gender, birthday, classId, sectionId, parentId } = request
    const parentEmail = request.parent.email
    const parentName = request.parent.name

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const registerNo = await generateRegistrationNumber(prisma, decoded.branchId)
    const idCardToken = crypto.randomUUID()
    const studentPlainPassword = generateSecurePassword()

    let finalStudentUsername = null

    await prisma.$transaction(async (tx) => {
      // 1. Generate unique student username
      const studentUsername = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`
      let uniqueStudentUsername = studentUsername
      let sCounter = 1
      while (true) {
        const userCheck = await tx.user.findUnique({ where: { username: uniqueStudentUsername }, select: { id: true } })
        if (!userCheck) break
        uniqueStudentUsername = `${studentUsername}_${sCounter++}`
      }
      finalStudentUsername = uniqueStudentUsername

      // 2. Create Student User
      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      const nextStudentUserId = maxUser ? maxUser.id + 1 : 1
      const hashedStudentPassword = await bcrypt.hash(studentPlainPassword, 10)

      const studentUser = await tx.user.create({
        data: {
          id: nextStudentUserId,
          username: finalStudentUsername,
          password: hashedStudentPassword,
          role: 7,
          active: true,
        },
      })

      // 3. Create Student Profile
      const maxStudent = await tx.student.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      const nextStudentId = maxStudent ? maxStudent.id + 1 : 1

      const studentRecord = await tx.student.create({
        data: {
          id: nextStudentId,
          registerNo,
          firstName,
          lastName,
          gender: gender || 'Male',
          birthday,
          parentId,
          branchId: decoded.branchId,
          userId: studentUser.id,
          idCardToken,
          idCardStatus: 'active',
          active: true,
        },
      })

      // 4. Create Enroll Record
      const maxEnroll = await tx.enroll.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      const nextEnrollId = maxEnroll ? maxEnroll.id + 1 : 1

      await tx.enroll.create({
        data: {
          id: nextEnrollId,
          studentId: studentRecord.id,
          classId: Number(classId),
          sectionId: Number(sectionId),
          roll: 0,
          sessionId,
          branchId: decoded.branchId,
        },
      })

      // 5. Bind CA/Exam Evaluation Matrix
      await bindEvaluationMatrix(tx, {
        studentId: studentRecord.id,
        classId: Number(classId),
        sectionId: Number(sectionId),
        branchId: decoded.branchId,
        sessionId,
      })

      // 6. Update Sibling Request status
      await tx.parentSiblingRequest.update({
        where: { id: requestId },
        data: { status: 'approved' },
      })
    })

    // ── Post-Transaction Email Dispatch ────────────────
    let emailSent = false
    if (parentEmail) {
      try {
        const emailResult = await sendOnboardingCredentials({
          parentEmail,
          parentName,
          studentName: `${firstName} ${lastName}`,
          registerNo,
          studentUsername: finalStudentUsername,
          studentPassword: studentPlainPassword,
          parentUsername: null,
          parentPassword: null,
          isExistingParent: true,
          schoolName: request.branch?.name || 'Your School',
          branchCode: request.branch?.code || '',
          loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
        })
        emailSent = emailResult.success
      } catch (err) {
        console.warn('[ADMIN] Sibling onboarding email failed:', err)
      }
    }

    return res.json({
      success: true,
      message: 'Sibling request approved and student registered successfully.',
      emailSent,
      credentials: {
        student: {
          username: finalStudentUsername,
          password: studentPlainPassword,
        },
      },
    })
  } catch (error) {
    console.error('[ADMIN] Approve sibling request error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to approve sibling request.' })
  }
})

/**
 * POST /api/admin/sibling-requests/:id/reject
 * Reject a sibling request with a reason.
 */
router.post('/sibling-requests/:id/reject', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const requestId = parseInt(req.params.id, 10)
    const { reason } = req.body || {}

    if (isNaN(requestId)) {
      return res.status(400).json({ success: false, message: 'Invalid Request ID.' })
    }

    const request = await prisma.parentSiblingRequest.findFirst({
      where: { id: requestId, branchId: decoded.branchId },
    })

    if (!request) {
      return res.status(404).json({ success: false, message: 'Sibling request not found.' })
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Request is already ${request.status}.` })
    }

    await prisma.parentSiblingRequest.update({
      where: { id: requestId },
      data: {
        status: 'rejected',
        rejectionReason: reason || 'Not specified',
      },
    })

    return res.json({ success: true, message: 'Sibling request rejected successfully.' })
  } catch (error) {
    console.error('[ADMIN] Reject sibling request error:', error)
    return res.status(500).json({ success: false, message: 'Failed to reject sibling request.' })
  }
})

/**
 * GET /api/admin/classroom-students
 * Fetch all students allocated to a specific classroom (class & section) for the current active session.
 */
router.get('/classroom-students', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { classId, sectionId } = req.query
    if (!classId || !sectionId) {
      return res.json({
        success: true,
        students: [],
        formTeacher: null,
        stats: { total: 0, male: 0, female: 0 }
      })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Fetch enroll records for this classroom
    const enrollments = await prisma.enroll.findMany({
      where: {
        branchId: decoded.branchId,
        sessionId: sessionId,
        classId: Number(classId),
        sectionId: Number(sectionId),
        isAlumni: 0,
      },
      include: {
        student: {
          include: {
            parent: true,
          },
        },
      },
      orderBy: {
        student: {
          lastName: 'asc',
        },
      },
    })

    // Fetch Form Teacher Allocation
    const formTeacherAllocation = await prisma.teacherAllocation.findFirst({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId: sessionId,
        branchId: decoded.branchId,
      },
      include: {
        teacher: true,
      },
    })

    const students = enrollments.map(e => ({
      id: e.student.id,
      registerNo: e.student.registerNo,
      firstName: e.student.firstName,
      lastName: e.student.lastName,
      gender: e.student.gender,
      mobileno: e.student.mobileno,
      email: e.student.email,
      active: e.student.active,
      parentName: e.student.parent?.name || null,
      parentRelation: e.student.parent?.relation || null,
      parentMobile: e.student.parent?.mobileno || null,
      parentEmail: e.student.parent?.email || null,
    }))

    const total = students.length
    const male = students.filter(s => s.gender?.toLowerCase() === 'male').length
    const female = total - male

    return res.json({
      success: true,
      students,
      formTeacher: formTeacherAllocation?.teacher?.name || 'Unassigned',
      stats: { total, male, female }
    })
  } catch (error) {
    console.error('[ADMIN] Get classroom students error:', error)
    return res.status(500).json({ success: false, message: 'Failed to load classroom students.' })
  }
})

/**
 * GET /api/admin/online-admissions
 * Fetch all online admissions for the branch, optional status filter.
 */
router.get('/online-admissions', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { status } = req.query
    const where = { branchId: decoded.branchId }

    if (status !== undefined && status !== '') {
      where.status = parseInt(status, 10)
    }

    const admissions = await prisma.onlineAdmission.findMany({
      where,
      orderBy: {
        applyDate: 'desc'
      }
    })

    return res.json({ success: true, admissions })
  } catch (error) {
    console.error('[ADMIN] Get online admissions error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch online admissions.' })
  }
})

/**
 * POST /api/admin/online-admissions/:id/status
 * Update the status of an online admission (Pending, Screening, Approved, Rejected).
 * If approved, onboards the student and parent.
 */
router.post('/online-admissions/:id/status', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const admissionId = parseInt(req.params.id, 10)
    if (isNaN(admissionId)) {
      return res.status(400).json({ success: false, message: 'Invalid Admission ID.' })
    }

    const { status, rejectionReason, reviewNotes, classId, sectionId } = req.body
    if (status === undefined) {
      return res.status(400).json({ success: false, message: 'Status is required.' })
    }

    const admission = await prisma.onlineAdmission.findFirst({
      where: { id: admissionId, branchId: decoded.branchId },
      include: { branch: true }
    })

    if (!admission) {
      return res.status(404).json({ success: false, message: 'Online admission record not found.' })
    }

    const targetStatus = parseInt(status, 10)

    // If status is Approved (3)
    if (targetStatus === 3) {
      if (admission.status === 3) {
        return res.status(400).json({ success: false, message: 'Admission has already been approved.' })
      }

      // Check if classId and sectionId are provided or use the ones from the request
      const finalClassId = classId ? Number(classId) : admission.classId
      const finalSectionId = sectionId ? Number(sectionId) : (admission.sectionId ? Number(admission.sectionId) : null)

      if (!finalClassId || !finalSectionId) {
        return res.status(400).json({ success: false, message: 'Class and section are required to approve admission.' })
      }

      // Verify class-section allocation exists
      const allocation = await prisma.sectionsAllocation.findFirst({
        where: {
          classId: finalClassId,
          sectionId: finalSectionId,
          class: {
            branchId: decoded.branchId
          }
        }
      })
      if (!allocation) {
        return res.status(400).json({ success: false, message: 'Selected Class and Section are not allocated together in this branch.' })
      }

      const globalSetting = await prisma.globalSettings.findFirst()
      const sessionId = globalSetting?.sessionId || 5

      const registerNo = await generateRegistrationNumber(prisma, decoded.branchId)
      const idCardToken = crypto.randomUUID()
      const studentPlainPassword = generateSecurePassword()
      const parentPlainPassword = generateSecurePassword()

      let isExistingParent = false
      let finalParentUsername = null
      let finalStudentUsername = null
      let parentRecord = null

      const parentEmail = admission.grdEmail
      const parentPhone = admission.grdMobileNo
      const parentName = admission.guardianName || `${admission.firstName}'s Guardian`
      const parentRelation = admission.guardianRelation || 'Father'

      await prisma.$transaction(async (tx) => {
        // 1. Resolve or Create Parent
        if (parentEmail) {
          parentRecord = await tx.parent.findFirst({
            where: { email: parentEmail, branchId: decoded.branchId },
          })
        }

        if (!parentRecord && parentPhone) {
          parentRecord = await tx.parent.findFirst({
            where: { mobileno: parentPhone, branchId: decoded.branchId },
          })
        }

        let parentUserId = null
        if (parentRecord) {
          parentUserId = parentRecord.userId
          isExistingParent = true
        } else {
          const baseUsername = parentEmail || parentPhone || `${admission.firstName.toLowerCase()}.${admission.lastName?.toLowerCase() || 'parent'}`
          const cleanUsername = `${baseUsername.split('@')[0]}_parent`

          let uniqueUsername = cleanUsername
          let counter = 1
          while (true) {
            const userCheck = await tx.user.findUnique({ where: { username: uniqueUsername }, select: { id: true } })
            if (!userCheck) break
            uniqueUsername = `${cleanUsername}_${counter++}`
          }

          finalParentUsername = uniqueUsername

          const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
          const nextUserId = maxUser ? maxUser.id + 1 : 1

          const hashedParentPassword = await bcrypt.hash(parentPlainPassword, 10)
          const parentUser = await tx.user.create({
            data: {
              id: nextUserId,
              username: finalParentUsername,
              password: hashedParentPassword,
              role: 6,
              active: true,
            },
          })

          const maxParent = await tx.parent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
          const nextParentId = maxParent ? maxParent.id + 1 : 1

          parentRecord = await tx.parent.create({
            data: {
              id: nextParentId,
              name: parentName,
              relation: parentRelation,
              email: parentEmail,
              mobileno: parentPhone,
              branchId: decoded.branchId,
              userId: parentUser.id,
            },
          })
        }

        // 2. Generate Student Username
        const studentUsername = `${admission.firstName.toLowerCase()}.${(admission.lastName || 'student').toLowerCase()}`
        let uniqueStudentUsername = studentUsername
        let sCounter = 1
        while (true) {
          const userCheck = await tx.user.findUnique({ where: { username: uniqueStudentUsername }, select: { id: true } })
          if (!userCheck) break
          uniqueStudentUsername = `${studentUsername}_${sCounter++}`
        }
        finalStudentUsername = uniqueStudentUsername

        // 3. Create Student User
        const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
        const nextStudentUserId = maxUser ? maxUser.id + 1 : 1
        const hashedStudentPassword = await bcrypt.hash(studentPlainPassword, 10)

        const studentUser = await tx.user.create({
          data: {
            id: nextStudentUserId,
            username: finalStudentUsername,
            password: hashedStudentPassword,
            role: 7,
            active: true,
          },
        })

        // 4. Create Student Profile
        const maxStudent = await tx.student.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
        const nextStudentId = maxStudent ? maxStudent.id + 1 : 1

        const studentRecord = await tx.student.create({
          data: {
            id: nextStudentId,
            registerNo,
            firstName: admission.firstName,
            lastName: admission.lastName || '',
            gender: admission.gender || 'Male',
            birthday: admission.birthday,
            religion: admission.religion,
            bloodGroup: admission.bloodGroup,
            mobileno: admission.mobileNo,
            email: admission.email,
            presentAddress: admission.presentAddress,
            permanentAddress: admission.permanentAddress,
            parentId: parentRecord.id,
            branchId: decoded.branchId,
            userId: studentUser.id,
            idCardToken,
            idCardStatus: 'active',
            active: true,
          },
        })

        // 5. Create Enroll Record
        const maxEnroll = await tx.enroll.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
        const nextEnrollId = maxEnroll ? maxEnroll.id + 1 : 1

        await tx.enroll.create({
          data: {
            id: nextEnrollId,
            studentId: studentRecord.id,
            classId: finalClassId,
            sectionId: finalSectionId,
            roll: 0,
            sessionId,
            branchId: decoded.branchId,
          },
        })

        // 6. Bind CA/Exam Evaluation Matrix
        await bindEvaluationMatrix(tx, {
          studentId: studentRecord.id,
          classId: finalClassId,
          sectionId: finalSectionId,
          branchId: decoded.branchId,
          sessionId,
        })

        // 7. Update Online Admission Status
        await tx.onlineAdmission.update({
          where: { id: admissionId },
          data: { status: 3 }
        })
      })

      // Send Email Notification
      let emailSent = false
      if (parentEmail) {
        try {
          const emailResult = await sendOnboardingCredentials({
            parentEmail,
            parentName,
            studentName: `${admission.firstName} ${admission.lastName || ''}`,
            registerNo,
            studentUsername: finalStudentUsername,
            studentPassword: studentPlainPassword,
            parentUsername: isExistingParent ? null : finalParentUsername,
            parentPassword: isExistingParent ? null : parentPlainPassword,
            isExistingParent,
            schoolName: admission.branch?.name || 'Your School',
            branchCode: admission.branch?.code || '',
            loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
          })
          emailSent = emailResult.success
        } catch (err) {
          console.warn('[ADMIN] Online admission onboarding email failed:', err)
        }
      }

      return res.json({
        success: true,
        message: 'Online admission approved and student registered successfully.',
        emailSent,
        credentials: {
          student: {
            username: finalStudentUsername,
            password: studentPlainPassword,
          },
          parent: isExistingParent ? null : {
            username: finalParentUsername,
            password: parentPlainPassword,
          }
        }
      })
    }

    // Otherwise, handle Rejected (0), Screening (2), or reset to Pending (1)
    const updateData = { status: targetStatus }
    if (targetStatus === 0) {
      updateData.rejectionReason = rejectionReason || 'Application does not meet requirements.'
    } else if (targetStatus === 2) {
      if (reviewNotes !== undefined) {
        updateData.reviewNotes = reviewNotes
      }
    }

    await prisma.onlineAdmission.update({
      where: { id: admissionId },
      data: updateData
    })

    const statusNames = { 0: 'rejected', 1: 'pending', 2: 'screening' }

    return res.json({
      success: true,
      message: `Online admission status updated to ${statusNames[targetStatus] || 'unknown'} successfully.`
    })

  } catch (error) {
    console.error('[ADMIN] Update online admission status error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update online admission status.' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// CREDENTIAL GENERATION & PROVISIONING ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/id-cards/provision/student/:studentId
 */
router.post('/id-cards/provision/student/:studentId', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const studentId = parseInt(req.params.studentId, 10);
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const card = await provisionStudentIdCard(prisma, {
      studentId,
      branchId: decoded.branchId,
      sessionId
    });

    return res.status(201).json({
      success: true,
      message: 'Student ID card provisioned successfully.',
      card
    });
  } catch (error) {
    console.error('[ADMIN] Student ID provisioning error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to provision ID card.' });
  }
});

/**
 * POST /api/admin/id-cards/provision/staff/:userId
 */
router.post('/id-cards/provision/staff/:userId', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const userId = parseInt(req.params.userId, 10);
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const card = await provisionStaffIdCard(prisma, {
      userId,
      branchId: decoded.branchId,
      sessionId
    });

    return res.status(201).json({
      success: true,
      message: 'Staff ID card provisioned successfully.',
      card
    });
  } catch (error) {
    console.error('[ADMIN] Staff ID provisioning error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to provision ID card.' });
  }
});

/**
 * POST /api/admin/id-cards/provision/batch
 */
router.post('/id-cards/provision/batch', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { classId, sectionId } = req.body;
    if (!classId || !sectionId) {
      return res.status(400).json({ success: false, message: 'Class ID and Section ID are required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const results = await batchProvisionStudentIdCards(prisma, {
      classId: parseInt(classId, 10),
      sectionId: parseInt(sectionId, 10),
      branchId: decoded.branchId,
      sessionId
    });

    const successCount = results.filter(r => r.success).length;

    return res.status(201).json({
      success: true,
      message: `Batch ID provisioning completed: ${successCount} successful, ${results.length - successCount} failed.`,
      results
    });
  } catch (error) {
    console.error('[ADMIN] Batch ID provisioning error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to run batch ID provisioning.' });
  }
});

/**
 * GET /api/admin/id-cards
 */
router.get('/id-cards', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { entityType, status, page = 1, limit = 20, search } = req.query;
    const p = parseInt(page, 10);
    const l = parseInt(limit, 10);
    const skip = (p - 1) * l;

    const where = {
      branchId: decoded.branchId
    };

    if (entityType) where.entityType = entityType;
    if (status) where.status = status;

    if (search) {
      where.OR = [
        { cardNumber: { contains: search, mode: 'insensitive' } },
        {
          student: {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } }
            ]
          }
        },
        {
          user: {
            username: { contains: search, mode: 'insensitive' }
          }
        }
      ];
    }

    const [cards, total] = await Promise.all([
      prisma.idCard.findMany({
        where,
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              registerNo: true,
              photo: true
            }
          },
          user: {
            select: {
              username: true,
              role: true
            }
          }
        },
        orderBy: { issuedAt: 'desc' },
        skip,
        take: l
      }),
      prisma.idCard.count({ where })
    ]);

    const mappedCards = cards.map(c => {
      let name = 'Unknown';
      let photo = null;
      let role = 'Staff';

      if (c.entityType === 'student' && c.student) {
        name = `${c.student.firstName} ${c.student.lastName}`;
        photo = c.student.photo;
        role = 'Student';
      } else if (c.entityType === 'staff' && c.user) {
        name = c.user.username;
        const roles = { 3: 'Teacher', 4: 'Accountant', 8: 'Receptionist', 9: 'Proprietor', 12: 'Librarian', 13: 'Staff' };
        role = roles[c.user.role] || 'Staff';
      }

      return {
        id: c.id,
        entityType: c.entityType,
        cardNumber: c.cardNumber,
        verifyToken: c.verifyToken,
        status: c.status,
        issuedAt: c.issuedAt,
        expiresAt: c.expiresAt,
        revokedAt: c.revokedAt,
        revokedReason: c.revokedReason,
        name,
        photo,
        role
      };
    });

    return res.json({
      success: true,
      data: mappedCards,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l)
      }
    });
  } catch (error) {
    console.error('[ADMIN] Get ID cards error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve ID cards list.' });
  }
});

/**
 * PUT /api/admin/id-cards/:cardId/revoke
 */
router.put('/id-cards/:cardId/revoke', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const cardId = parseInt(req.params.cardId, 10);
    const { reason } = req.body;

    const card = await prisma.idCard.findFirst({
      where: { id: cardId, branchId: decoded.branchId }
    });

    if (!card) {
      return res.status(404).json({ success: false, message: 'ID card not found.' });
    }

    const updated = await revokeIdCard(prisma, cardId, reason || 'Administrative revocation');

    return res.json({
      success: true,
      message: 'ID card has been successfully revoked.',
      card: updated
    });
  } catch (error) {
    console.error('[ADMIN] Revoke ID card error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to revoke ID card.' });
  }
});

/**
 * GET /api/admin/id-cards/:cardId/download
 */
router.get('/id-cards/:cardId/download', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const cardId = parseInt(req.params.cardId, 10);
    const card = await prisma.idCard.findFirst({
      where: { id: cardId, branchId: decoded.branchId },
      include: {
        student: {
          include: {
            enrolls: {
              where: { active: true },
              include: {
                class: true,
                section: true
              }
            }
          }
        },
        user: true,
        branch: true
      }
    });

    if (!card) {
      return res.status(404).json({ success: false, message: 'ID card not found.' });
    }

    const session = await prisma.schoolYear.findFirst({
      where: { id: card.sessionId }
    });

    const sessionName = session?.session || 'Current';

    const pdfParams = {
      schoolName: card.branch.name,
      branchName: card.branch.city || card.branch.name,
      primaryColor: card.branch.idCardPrimaryColor || '#1b5e20',
      secondaryColor: card.branch.idCardSecondaryColor || '#2e7d32',
      verifyToken: card.verifyToken,
      cardNumber: card.cardNumber
    };

    let pdfBuffer;
    if (card.entityType === 'student' && card.student) {
      const activeEnroll = card.student.enrolls[0];
      pdfBuffer = await generateStudentIdCardPdf({
        ...pdfParams,
        studentName: `${card.student.firstName} ${card.student.lastName}`,
        registerNo: card.student.registerNo,
        className: activeEnroll?.class?.name || 'Unassigned',
        sectionName: activeEnroll?.section?.name || 'Unassigned',
        sessionName,
        photoUrl: card.student.photo
      });
    } else if (card.entityType === 'staff' && card.user) {
      const roles = { 3: 'Teacher', 4: 'Accountant', 8: 'Receptionist', 9: 'Proprietor', 12: 'Librarian', 13: 'Staff' };
      pdfBuffer = await generateStaffIdCardPdf({
        ...pdfParams,
        staffName: card.user.username,
        roleName: roles[card.user.role] || 'Staff',
        username: card.user.username,
        photoUrl: null
      });
    } else {
      return res.status(400).json({ success: false, message: 'Entity profile missing on ID card.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=ID_Card_${card.cardNumber.replace(/\//g, '_')}.pdf`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Download ID PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate ID card PDF document.' });
  }
});

/**
 * POST /api/admin/certificates/issue
 */
router.post('/certificates/issue', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { studentId, certificateType, title, description } = req.body;
    if (!studentId || !certificateType || !title) {
      return res.status(400).json({ success: false, message: 'Student ID, Type, and Title are required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const cert = await provisionCertificate(prisma, {
      studentId: parseInt(studentId, 10),
      certificateType,
      title,
      description,
      branchId: decoded.branchId,
      sessionId
    });

    return res.status(201).json({
      success: true,
      message: 'Certificate issued successfully.',
      certificate: cert
    });
  } catch (error) {
    console.error('[ADMIN] Issue certificate error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to issue certificate.' });
  }
});

/**
 * GET /api/admin/certificates
 */
router.get('/certificates', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { certificateType, status, search, page = 1, limit = 20 } = req.query;
    const p = parseInt(page, 10);
    const l = parseInt(limit, 10);
    const skip = (p - 1) * l;

    const where = {
      branchId: decoded.branchId
    };

    if (certificateType) where.certificateType = certificateType;
    if (status) where.status = status;

    if (search) {
      where.OR = [
        { certificateNo: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
        {
          student: {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } }
            ]
          }
        }
      ];
    }

    const [certs, total] = await Promise.all([
      prisma.certificate.findMany({
        where,
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              registerNo: true
            }
          }
        },
        orderBy: { issuedAt: 'desc' },
        skip,
        take: l
      }),
      prisma.certificate.count({ where })
    ]);

    return res.json({
      success: true,
      data: certs,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l)
      }
    });
  } catch (error) {
    console.error('[ADMIN] Get certificates error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve certificates list.' });
  }
});

/**
 * GET /api/admin/certificates/:certId/download
 */
router.get('/certificates/:certId/download', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const certId = parseInt(req.params.certId, 10);
    const cert = await prisma.certificate.findFirst({
      where: { id: certId, branchId: decoded.branchId },
      include: {
        student: true,
        branch: true
      }
    });

    if (!cert) {
      return res.status(404).json({ success: false, message: 'Certificate not found.' });
    }

    const session = await prisma.schoolYear.findFirst({
      where: { id: cert.sessionId }
    });

    const sessionName = session?.session || 'Current';

    const pdfBuffer = await generateCertificatePdf({
      schoolName: cert.branch.name,
      branchName: cert.branch.city || cert.branch.name,
      primaryColor: cert.branch.idCardPrimaryColor || '#1b5e20',
      secondaryColor: cert.branch.idCardSecondaryColor || '#2e7d32',
      studentName: `${cert.student.firstName} ${cert.student.lastName}`,
      certificateType: cert.certificateType,
      certificateNo: cert.certificateNo,
      title: cert.title,
      description: cert.description,
      sessionName,
      verifyToken: cert.verifyToken
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Certificate_${cert.certificateNo.replace(/\//g, '_')}.pdf`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Download certificate PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate certificate PDF document.' });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL & ACCOUNTING DASHBOARD ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/finances/overview
 */
router.get('/finances/overview', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const data = await getFinancialOverview(prisma, {
      branchId: decoded.branchId,
      sessionId
    });

    return res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[ADMIN] Financial overview error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve financial overview data.' });
  }
});

/**
 * GET /api/admin/finances/fee-types
 */
router.get('/finances/fee-types', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const feeTypes = await prisma.feeType.findMany({
      where: { branchId: decoded.branchId, active: true },
      orderBy: { name: 'asc' }
    });

    return res.json({
      success: true,
      data: feeTypes
    });
  } catch (error) {
    console.error('[ADMIN] Get fee types error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve fee types.' });
  }
});

/**
 * POST /api/admin/finances/fee-types
 */
router.post('/finances/fee-types', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { name, code, amount, frequency = 'per_term' } = req.body;
    if (!name || !code || !amount) {
      return res.status(400).json({ success: false, message: 'Name, unique Code, and Amount are required.' });
    }

    const cleanCode = code.trim().toUpperCase();

    // Check if code is already used in this branch
    const existing = await prisma.feeType.findUnique({
      where: {
        branchId_code: {
          branchId: decoded.branchId,
          code: cleanCode
        }
      }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: `Fee code '${cleanCode}' is already registered.` });
    }

    const feeType = await prisma.feeType.create({
      data: {
        name,
        code: cleanCode,
        amount: parseFloat(amount),
        frequency,
        branchId: decoded.branchId
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Fee type created successfully.',
      data: feeType
    });
  } catch (error) {
    console.error('[ADMIN] Create fee type error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create fee type.' });
  }
});

/**
 * POST /api/admin/finances/fee-types/bulk
 * Batch creates multiple fee categories at once.
 */
router.post('/finances/fee-types/bulk', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { feeTypes } = req.body;
    if (!feeTypes || !Array.isArray(feeTypes) || feeTypes.length === 0) {
      return res.status(400).json({ success: false, message: 'Fee categories array is required.' });
    }

    const created = [];
    const skipped = [];

    for (const item of feeTypes) {
      const { name, code, amount, frequency = 'per_term' } = item;
      if (!name || !code || amount === undefined) {
        skipped.push({ name: name || 'Unknown', reason: 'Missing name, code, or amount' });
        continue;
      }

      const cleanCode = code.trim().toUpperCase();

      const existing = await prisma.feeType.findUnique({
        where: {
          branchId_code: {
            branchId: decoded.branchId,
            code: cleanCode
          }
        }
      });

      if (existing) {
        skipped.push({ name, code: cleanCode, reason: 'Duplicate unique code' });
        continue;
      }

      const newFee = await prisma.feeType.create({
        data: {
          name,
          code: cleanCode,
          amount: parseFloat(amount),
          frequency,
          branchId: decoded.branchId
        }
      });
      created.push(newFee);
    }

    return res.status(201).json({
      success: true,
      message: `Batch complete. Created: ${created.length}, Skipped: ${skipped.length}`,
      created,
      skipped
    });
  } catch (error) {
    console.error('[ADMIN] Bulk create fee types error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create fee categories.' });
  }
});

/**
 * GET /api/admin/finances/fee-assignments
 * Retrieves all fee allocations for the current branch.
 */
router.get('/finances/fee-assignments', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const assignments = await prisma.feeAssignment.findMany({
      where: {
        branchId: decoded.branchId,
        sessionId
      },
      include: {
        feeType: true,
        class: { select: { id: true, name: true } }
      }
    });

    return res.json({
      success: true,
      data: assignments
    });
  } catch (error) {
    console.error('[ADMIN] Get fee assignments error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve fee allocations.' });
  }
});

/**
 * POST /api/admin/finances/fee-assignments
 * Allocates fee types to a specific class.
 */
router.post('/finances/fee-assignments', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { classId, allocations } = req.body;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const parsedClassId = parseInt(classId, 10);
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    await prisma.$transaction(async (tx) => {
      // 1. Delete existing assignments for this class
      await tx.feeAssignment.deleteMany({
        where: {
          branchId: decoded.branchId,
          classId: parsedClassId,
          sessionId
        }
      });

      // 2. Create new allocations
      if (allocations && Array.isArray(allocations)) {
        const createData = allocations.map(alloc => ({
          feeTypeId: parseInt(alloc.feeTypeId, 10),
          isOptional: !!alloc.isOptional,
          classId: parsedClassId,
          branchId: decoded.branchId,
          sessionId
        }));

        if (createData.length > 0) {
          await tx.feeAssignment.createMany({
            data: createData
          });
        }
      }
    });

    return res.json({
      success: true,
      message: 'Class fee allocations updated successfully.'
    });
  } catch (error) {
    console.error('[ADMIN] Save fee assignments error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save fee allocations.' });
  }
});

/**
 * POST /api/admin/finances/invoices/bulk
 * Bulk generates invoices for all students in a class based on mandatory fee allocations.
 */
router.post('/finances/invoices/bulk', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { classId, termLabel, dueDate } = req.body;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const parsedClassId = parseInt(classId, 10);
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    // 1. Fetch mandatory fee allocations for the class
    const allocations = await prisma.feeAssignment.findMany({
      where: {
        branchId: decoded.branchId,
        classId: parsedClassId,
        sessionId,
        isOptional: false,
        active: true
      },
      select: { feeTypeId: true }
    });

    if (allocations.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No mandatory fee allocations found for this class. Please assign fees first.'
      });
    }

    const feeTypeIds = allocations.map(a => a.feeTypeId);

    // 2. Fetch all students enrolled in this class for the current session
    const enrollments = await prisma.enroll.findMany({
      where: {
        classId: parsedClassId,
        sessionId,
        branchId: decoded.branchId
      },
      select: { studentId: true }
    });

    if (enrollments.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No students enrolled in this class for the current session.'
      });
    }

    let successCount = 0;
    let errorCount = 0;

    for (const enroll of enrollments) {
      try {
        // Check if student already has an invoice for this term to prevent duplicate billing
        const existingInvoice = await prisma.invoice.findFirst({
          where: {
            studentId: enroll.studentId,
            termLabel: termLabel || 'First Term',
            sessionId,
            branchId: decoded.branchId
          }
        });

        if (existingInvoice) {
          // Skip if already billed for this term
          continue;
        }

        await generateInvoice(prisma, {
          studentId: enroll.studentId,
          termLabel: termLabel || 'First Term',
          feeTypeIds,
          branchId: decoded.branchId,
          sessionId,
          dueDate: dueDate || null
        });

        successCount++;
      } catch (err) {
        console.error(`[ADMIN] Bulk invoice fail for student ${enroll.studentId}:`, err);
        errorCount++;
      }
    }

    return res.status(201).json({
      success: true,
      message: `Bulk invoicing complete. Invoices generated: ${successCount}. Skipped or failed: ${errorCount}`
    });
  } catch (error) {
    console.error('[ADMIN] Bulk generate invoices error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to bulk generate invoices.' });
  }
});

/**
 * GET /api/admin/finances/invoices
 */
router.get('/finances/invoices', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const p = parseInt(page, 10);
    const l = parseInt(limit, 10);
    const skip = (p - 1) * l;

    const where = {
      branchId: decoded.branchId
    };

    if (status) where.status = status;

    if (search) {
      where.OR = [
        { invoiceNo: { contains: search, mode: 'insensitive' } },
        {
          student: {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } }
            ]
          }
        }
      ];
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              registerNo: true
            }
          },
          items: true,
          payments: true
        },
        orderBy: { issuedAt: 'desc' },
        skip,
        take: l
      }),
      prisma.invoice.count({ where })
    ]);

    return res.json({
      success: true,
      data: invoices,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l)
      }
    });
  } catch (error) {
    console.error('[ADMIN] Get invoices error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve invoices list.' });
  }
});

/**
 * POST /api/admin/finances/invoices
 */
router.post('/finances/invoices', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { studentId, termLabel, feeTypeIds, dueDate } = req.body;
    if (!studentId || !Array.isArray(feeTypeIds) || feeTypeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Student ID and at least one Fee Type selection are required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const invoice = await generateInvoice(prisma, {
      studentId: parseInt(studentId, 10),
      termLabel: termLabel || 'First Term',
      feeTypeIds: feeTypeIds.map(id => parseInt(id, 10)),
      branchId: decoded.branchId,
      sessionId,
      dueDate
    });

    return res.status(201).json({
      success: true,
      message: 'Invoice generated successfully.',
      invoice
    });
  } catch (error) {
    console.error('[ADMIN] Generate invoice error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate invoice.' });
  }
});

/**
 * POST /api/admin/finances/payments
 */
router.post('/finances/payments', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { invoiceId, amount, method, reference, notes } = req.body;
    if (!invoiceId || !amount || !method) {
      return res.status(400).json({ success: false, message: 'Invoice ID, Payment Amount, and Payment Method are required.' });
    }

    const payment = await recordPayment(prisma, {
      invoiceId: parseInt(invoiceId, 10),
      amount: parseFloat(amount),
      method,
      reference: reference || null,
      receivedBy: decoded.sub, // Admin User ID who recorded it
      notes: notes || null,
      branchId: decoded.branchId
    });

    return res.status(201).json({
      success: true,
      message: 'Payment recorded and invoice balance updated successfully.',
      payment
    });
  } catch (error) {
    console.error('[ADMIN] Record payment error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to record payment.' });
  }
});

/**
 * GET /api/admin/finances/export/csv
 */
router.get('/finances/export/csv', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const csvContent = await exportFinancialReportCsv(prisma, {
      branchId: decoded.branchId,
      sessionId
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=financial_outstanding_report.csv');
    return res.send(csvContent);
  } catch (error) {
    console.error('[ADMIN] Export CSV error:', error);
    return res.status(500).json({ success: false, message: 'Failed to export CSV report.' });
  }
});

/**
 * GET /api/admin/finances/export/pdf
 */
router.get('/finances/export/pdf', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: { name: true }
    });

    const pdfBuffer = await exportFinancialReportPdf(prisma, {
      branchId: decoded.branchId,
      sessionId,
      schoolName: branch?.name || 'Ugbekun School'
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=financial_outstanding_report.pdf');
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Export PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to export PDF report.' });
  }
});

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } })

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
})

/**
 * POST /api/admin/students/parse-document
 * Upload a document (PDF or image) and extract student onboarding details using Deepseek.
 */
router.post('/students/parse-document', upload.single('file'), async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No document file uploaded.' })
  }

  try {
    let rawText = ''
    const fileMimetype = req.file.mimetype

    if (fileMimetype === 'application/pdf') {
      const pdfBuffer = req.file.buffer
      const data = await pdfParse(pdfBuffer)
      rawText = data.text
    } else if (fileMimetype.startsWith('image/')) {
      if (!Tesseract) {
        return res.status(400).json({
          success: false,
          message: 'Image processing (OCR) is currently disabled on this server. Please upload a digital PDF instead.'
        })
      }
      const result = await Tesseract.recognize(req.file.buffer, 'eng')
      rawText = result.data.text
    } else {
      return res.status(400).json({ success: false, message: 'Unsupported file format. Please upload a PDF or an Image.' })
    }

    if (!rawText || rawText.trim().length < 5) {
      return res.status(400).json({ success: false, message: 'Could not extract text from the document. Please ensure it is legible.' })
    }

    const prompt = `
      You are an expert administrative assistant for Ugbekun Academy.
      Your task is to analyze the following raw text extracted from a school admission form, birth certificate, or previous academic transcript.
      Extract information to populate our student registration schema.

      Raw Document Text:
      """
      ${rawText}
      """

      Rules for extraction:
      1. Map the extracted values strictly to the JSON schema specified below.
      2. If a value is missing or cannot be inferred, set it to null or empty string.
      3. Format Date of Birth (birthday) as "YYYY-MM-DD".
      4. For "historicalPerformance", summarize previous school names, grades, key marks, and academic standing into a clean, readable text description.
      5. Output ONLY the raw JSON block. No markdown wrappers (like \`\`\`json), no additional introductory text.

      Required JSON Output Format:
      {
        "firstName": "Extract student's first name",
        "lastName": "Extract student's last name (surname)",
        "gender": "Extract Male/Female. Default to 'Male' if not found",
        "birthday": "YYYY-MM-DD",
        "homeAddress": "Extract complete home address",
        "historicalPerformance": "Summary of previous schools, report cards, grades, or transcripts",
        "parentName": "Extract guardian or parent's name",
        "parentRelation": "Extract relation (Father/Mother/Guardian)",
        "parentEmail": "Extract parent's email address",
        "parentPhone": "Extract parent's phone number"
      }
    `

    const completion = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You are a precise JSON extractor. Output valid, parsed JSON based on the user\'s guidelines without any explanations or formatting wrappers.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })

    const extractedData = JSON.parse(completion.choices[0].message.content.trim())

    return res.json({
      success: true,
      extractedData
    })

  } catch (error) {
    console.error('[ADMIN] Document parsing error:', error)
    return res.status(500).json({ success: false, message: 'Failed to process document. ' + error.message })
  }
})

/**
 * GET /api/admin/commentary/pending
 * Retrieve all student commentaries in the branch for review.
 */
router.get('/commentary/pending', assertBranchAdmin, async (req, res) => {
  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const commentaries = await prisma.studentCommentary.findMany({
      where: {
        branchId: req.branchId,
        sessionId,
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
          }
        }
      },
      orderBy: {
        updatedAt: 'desc'
      }
    })

    res.json({ success: true, commentaries })
  } catch (error) {
    console.error('[ADMIN] Fetch pending commentaries error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch commentaries.' })
  }
})

/**
 * POST /api/admin/commentary/review
 * Principal / Branch Admin reviews and signs off or rejects student report commentary.
 */
router.post('/commentary/review', assertBranchAdmin, async (req, res) => {
  const { commentaryId, status, reviewNotes } = req.body
  if (!commentaryId || !status) {
    return res.status(400).json({ success: false, message: 'commentaryId and status are required.' })
  }

  if (!['PRINCIPAL_SIGNED_OFF', 'REJECTED'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status. Must be PRINCIPAL_SIGNED_OFF or REJECTED.' })
  }

  try {
    const existing = await prisma.studentCommentary.findUnique({
      where: { id: Number(commentaryId) }
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Commentary record not found.' })
    }

    if (existing.branchId !== req.branchId) {
      return res.status(403).json({ success: false, message: 'Access denied: commentary belongs to another branch.' })
    }

    await prisma.studentCommentary.update({
      where: { id: existing.id },
      data: {
        status,
        reviewerId: req.adminId || null,
        reviewNotes: reviewNotes || null
      }
    })

    // Trigger gamification review check asynchronously
    gamificationService.checkStudentCommentaryApproval(prisma, existing.id, status, req.branchId)
      .catch(err => console.error('[Gamification] Error in commentary review trigger:', err.message))

    res.json({ success: true, message: `Commentary successfully marked as ${status}.` })
  } catch (error) {
    console.error('[ADMIN] Commentary review error:', error)
    res.status(500).json({ success: false, message: 'Failed to record commentary review.' })
  }
})

// GET /api/admin/gamification/config
router.get('/gamification/config', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    let config = await prisma.gamificationConfig.findUnique({
      where: { branchId: decoded.branchId }
    });

    if (!config) {
      config = {
        weeklyMintLimit: 5000,
        termStartDate: null
      };
    }

    res.json({ success: true, config });
  } catch (error) {
    console.error('[ADMIN] Get gamification config error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve gamification config.' });
  }
});

// POST /api/admin/gamification/config
router.post('/gamification/config', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const { weeklyMintLimit, termStartDate } = req.body;
  try {
    const config = await prisma.gamificationConfig.upsert({
      where: { branchId: decoded.branchId },
      update: {
        weeklyMintLimit: Number(weeklyMintLimit),
        termStartDate: termStartDate ? new Date(termStartDate) : null
      },
      create: {
        branchId: decoded.branchId,
        weeklyMintLimit: Number(weeklyMintLimit),
        termStartDate: termStartDate ? new Date(termStartDate) : null
      }
    });

    res.json({ success: true, message: 'Gamification config successfully saved.', config });
  } catch (error) {
    console.error('[ADMIN] Save gamification config error:', error);
    res.status(500).json({ success: false, message: 'Failed to save gamification config.' });
  }
});

/**
 * POST /api/admin/teachers/:id/toggle-status
 * Toggle active status of a teacher (and their associated login User account).
 */
router.post('/teachers/:id/toggle-status', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const teacherId = Number(req.params.id)
  try {
    const teacher = await prisma.teacher.findFirst({
      where: { id: teacherId, branchId: decoded.branchId },
    })

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found or unauthorized.' })
    }

    const newStatus = !teacher.active

    await prisma.$transaction(async (tx) => {
      // 1. Toggle Teacher profile active status
      await tx.teacher.update({
        where: { id: teacherId },
        data: { active: newStatus },
      })

      // 2. Toggle linked User account active status
      if (teacher.userId) {
        await tx.user.update({
          where: { id: teacher.userId },
          data: { active: newStatus },
        })
      }
    })

    return res.json({ success: true, active: newStatus, message: `Teacher status updated to ${newStatus ? 'active' : 'suspended'}.` })
  } catch (error) {
    console.error('[ADMIN] Toggle teacher status error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to toggle status.' })
  }
})

/**
 * POST /api/admin/students/:id/toggle-status
 * Toggle active status of a student (and their associated login User account).
 */
router.post('/students/:id/toggle-status', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const studentId = Number(req.params.id)
  try {
    const student = await prisma.student.findFirst({
      where: { id: studentId, branchId: decoded.branchId },
    })

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found or unauthorized.' })
    }

    const newStatus = !student.active

    await prisma.$transaction(async (tx) => {
      // 1. Toggle Student profile active status
      await tx.student.update({
        where: { id: studentId },
        data: { active: newStatus },
      })

      // 2. Toggle linked User account active status
      if (student.userId) {
        await tx.user.update({
          where: { id: student.userId },
          data: { active: newStatus },
        })
      }
    })

    return res.json({ success: true, active: newStatus, message: `Student status updated to ${newStatus ? 'active' : 'suspended'}.` })
  } catch (error) {
    console.error('[ADMIN] Toggle student status error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to toggle status.' })
  }
})

/**
 * POST /api/admin/staff/:id/toggle-status
 * Toggle active status of a staff member User account.
 */
router.post('/staff/:id/toggle-status', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const staffId = Number(req.params.id)
  try {
    // Make sure they belong to this branch by checking branch matches via helper
    const user = await prisma.user.findUnique({
      where: { id: staffId }
    })

    if (!user) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' })
    }

    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId }
    })

    if (!branch || !staffMatchesBranch(user.username, branch)) {
      return res.status(403).json({ success: false, message: 'Unauthorized branch access.' })
    }

    const newStatus = !user.active

    await prisma.user.update({
      where: { id: staffId },
      data: { active: newStatus }
    })

    return res.json({ success: true, active: newStatus, message: `Staff status updated to ${newStatus ? 'active' : 'suspended'}.` })
  } catch (error) {
    console.error('[ADMIN] Toggle staff status error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to toggle status.' })
  }
})

/**
 * GET /api/admin/reports/staff-activities
 * Fetches recent administrative and instructional activities carried out by staff and teachers in this branch.
 */
router.get('/reports/staff-activities', assertBranchAdmin, async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const branchId = decoded.branchId

  try {
    const activities = []

    // 1. Fetch Lesson Plans (up to 30)
    const lessonPlans = await prisma.lessonPlan.findMany({
      where: {
        teacher: { branchId }
      },
      take: 30,
      orderBy: { createdAt: 'desc' },
      include: {
        teacher: { select: { firstName: true, lastName: true } },
        class: { select: { name: true } },
        subject: { select: { name: true } }
      }
    })

    for (const lp of lessonPlans) {
      activities.push({
        id: `lp-${lp.id}`,
        type: 'LESSON_PLAN',
        category: 'Instructional',
        description: `Lesson plan created for Class ${lp.class.name} - ${lp.subject.name} on "${lp.coreTopic}"`,
        staffName: `${lp.teacher.firstName} ${lp.teacher.lastName}`,
        staffRole: 'Teacher',
        timestamp: lp.createdAt
      })
    }

    // 2. Fetch Student Commentaries (up to 30)
    const commentaries = await prisma.studentCommentary.findMany({
      where: { branchId },
      take: 30,
      orderBy: { updatedAt: 'desc' },
      include: {
        student: { select: { firstName: true, lastName: true } }
      }
    })

    for (const comm of commentaries) {
      activities.push({
        id: `comm-${comm.id}`,
        type: 'COMMENTARY',
        category: 'Academic Remarks',
        description: `Holistic report card commentary updated for ${comm.student.firstName} ${comm.student.lastName} (Status: ${comm.status})`,
        staffName: 'Form Teacher',
        staffRole: 'Teacher',
        timestamp: comm.updatedAt || comm.createdAt
      })
    }

    // 3. Fetch ID Cards (up to 30)
    const idCards = await prisma.idCard.findMany({
      where: { branchId },
      take: 30,
      orderBy: { createdAt: 'desc' },
      include: {
        student: { select: { firstName: true, lastName: true } },
        user: { select: { username: true } }
      }
    })

    for (const card of idCards) {
      const recipient = card.entityType === 'student' && card.student
        ? `${card.student.firstName} ${card.student.lastName}`
        : card.user
        ? card.user.username
        : 'Staff'

      activities.push({
        id: `idcard-${card.id}`,
        type: 'IDCARD',
        category: 'Administration',
        description: `Identity card provisioned (Card No: ${card.cardNumber}, Recipient: ${recipient}, Status: ${card.status})`,
        staffName: 'Admin Desk',
        staffRole: 'Branch Admin/Staff',
        timestamp: card.createdAt
      })
    }

    // 4. Fetch Certificates (up to 30)
    const certs = await prisma.certificate.findMany({
      where: { branchId },
      take: 30,
      orderBy: { createdAt: 'desc' },
      include: {
        student: { select: { firstName: true, lastName: true } }
      }
    })

    for (const cert of certs) {
      activities.push({
        id: `cert-${cert.id}`,
        type: 'CERTIFICATE',
        category: 'Administration',
        description: `Academic Certificate issued (${cert.title} to ${cert.student.firstName} ${cert.student.lastName})`,
        staffName: 'Admin Desk',
        staffRole: 'Branch Admin/Staff',
        timestamp: cert.createdAt
      })
    }

    // 5. Fetch Invoices (up to 30)
    const invoices = await prisma.invoice.findMany({
      where: { branchId },
      take: 30,
      orderBy: { createdAt: 'desc' },
      include: {
        student: { select: { firstName: true, lastName: true } }
      }
    })

    for (const inv of invoices) {
      activities.push({
        id: `invoice-${inv.id}`,
        type: 'INVOICE',
        category: 'Finance',
        description: `Invoice ${inv.invoiceNo} raised for ${inv.student.firstName} ${inv.student.lastName} (Amount: ₦${inv.totalAmount}, Status: ${inv.status})`,
        staffName: 'Accountant Desk',
        staffRole: 'Accountant/Staff',
        timestamp: inv.createdAt
      })
    }

    // 6. Fetch Payments (up to 30)
    const payments = await prisma.payment.findMany({
      where: { branchId },
      take: 30,
      orderBy: { createdAt: 'desc' },
      include: {
        invoice: {
          include: {
            student: { select: { firstName: true, lastName: true } }
          }
        }
      }
    })

    for (const pay of payments) {
      let collectorName = 'Accountant Desk'
      if (pay.receivedBy) {
        const user = await prisma.user.findUnique({
          where: { id: pay.receivedBy },
          select: { username: true }
        })
        if (user) {
          collectorName = user.username
        }
      }

      const payer = pay.invoice && pay.invoice.student
        ? `${pay.invoice.student.firstName} ${pay.invoice.student.lastName}`
        : 'Student'

      activities.push({
        id: `payment-${pay.id}`,
        type: 'PAYMENT',
        category: 'Finance',
        description: `Payment of ₦${pay.amount} received via ${pay.method} for ${payer} (Ref: ${pay.reference || 'N/A'})`,
        staffName: collectorName,
        staffRole: 'Finance Collector',
        timestamp: pay.createdAt
      })
    }

    // 7. Fetch Attendance Records Grouped (up to 30)
    const attendanceRecords = await prisma.attendance.findMany({
      where: { branchId },
      take: 50,
      orderBy: { createdAt: 'desc' },
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } }
      }
    })

    const seenAttendance = new Set()
    for (const att of attendanceRecords) {
      const dateStr = new Date(att.attendanceDate).toISOString().split('T')[0]
      const key = `${att.classId}-${att.sectionId}-${dateStr}`
      if (!seenAttendance.has(key)) {
        seenAttendance.add(key)
        activities.push({
          id: `att-${att.id}`,
          type: 'ATTENDANCE',
          category: 'Instructional',
          description: `Attendance register submitted for Class ${att.class.name} Section ${att.section.name} on date ${dateStr}`,
          staffName: 'Form Teacher',
          staffRole: 'Teacher',
          timestamp: att.createdAt
        })
      }
    }

    // 8. Fetch Marks Entered/Updated Grouped (up to 30)
    const marksRecords = await prisma.mark.findMany({
      where: { branchId },
      take: 100,
      orderBy: { id: 'desc' },
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
        subject: { select: { name: true } },
        exam: { select: { name: true } }
      }
    })

    const seenMarks = new Set()
    for (const m of marksRecords) {
      const key = `${m.classId}-${m.sectionId}-${m.subjectId}-${m.examId}`
      if (!seenMarks.has(key)) {
        seenMarks.add(key)
        activities.push({
          id: `mark-${m.id}`,
          type: 'MARKS',
          category: 'Academic Grading',
          description: `Student grades entered/updated for ${m.class.name} Section ${m.section.name} in "${m.subject.name}" (${m.exam.name})`,
          staffName: 'Subject Teacher',
          staffRole: 'Teacher',
          timestamp: new Date()
        })
      }
    }

    // Sort all activities chronologically descending
    activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    return res.json({ success: true, activities: activities.slice(0, 50) })
  } catch (error) {
    console.error('[ADMIN] Staff activity report error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to compile staff activity report.' })
  }
})

/**
 * GET /api/admin/events
 * Fetch all events for the current branch and session.
 */
router.get('/events', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const events = await prisma.event.findMany({
      where: {
        branchId: decoded.branchId,
        sessionId: sessionId
      },
      orderBy: {
        startDate: 'asc'
      }
    })

    return res.json({ success: true, events })
  } catch (error) {
    console.error('[ADMIN] Get events error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch events.' })
  }
})

/**
 * POST /api/admin/events
 * Create a new event.
 */
router.post('/events', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const { title, description, startDate, endDate } = req.body

  if (!title || !startDate) {
    return res.status(400).json({ success: false, message: 'Title and Start Date are required.' })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const newEvent = await prisma.event.create({
      data: {
        title,
        description,
        startDate: new Date(startDate),
        endDate: endDate ? new Date(endDate) : null,
        branchId: decoded.branchId,
        sessionId: sessionId
      }
    })

    return res.json({ success: true, event: newEvent, message: 'Event created successfully!' })
  } catch (error) {
    console.error('[ADMIN] Create event error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to create event.' })
  }
})

/**
 * PUT /api/admin/events/:id
 * Update an existing event.
 */
router.put('/events/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const eventId = Number(req.params.id)
  const { title, description, startDate, endDate } = req.body

  try {
    const existing = await prisma.event.findFirst({
      where: {
        id: eventId,
        branchId: decoded.branchId
      }
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Event not found or unauthorized.' })
    }

    const updated = await prisma.event.update({
      where: { id: eventId },
      data: {
        title: title !== undefined ? title : existing.title,
        description: description !== undefined ? description : existing.description,
        startDate: startDate ? new Date(startDate) : existing.startDate,
        endDate: endDate !== undefined ? (endDate ? new Date(endDate) : null) : existing.endDate
      }
    })

    return res.json({ success: true, event: updated, message: 'Event updated successfully!' })
  } catch (error) {
    console.error('[ADMIN] Update event error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update event.' })
  }
})

/**
 * DELETE /api/admin/events/:id
 * Delete an event.
 */
router.delete('/events/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const eventId = Number(req.params.id)

  try {
    const existing = await prisma.event.findFirst({
      where: {
        id: eventId,
        branchId: decoded.branchId
      }
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Event not found or unauthorized.' })
    }

    await prisma.event.delete({
      where: { id: eventId }
    })

    return res.json({ success: true, message: 'Event deleted successfully!' })
  } catch (error) {
    console.error('[ADMIN] Delete event error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete event.' })
  }
})

/**
 * POST /api/admin/cbt/sync
 * Syncs student CBT online exam scores into the Mark model (cbtMark field) for a target academic Exam.
 */
router.post('/cbt/sync', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  const { examId, onlineExamIds } = req.body
  if (!examId) {
    return res.status(400).json({ success: false, message: 'Academic examId is required for mapping.' })
  }

  try {
    const targetExam = await prisma.exam.findFirst({
      where: {
        id: Number(examId),
        branchId: decoded.branchId
      }
    })

    if (!targetExam) {
      return res.status(404).json({ success: false, message: 'Target academic exam not found.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Build query for online exam submissions
    const submissionFilter = {
      onlineExam: {
        branchId: decoded.branchId,
        sessionId: sessionId
      }
    }

    if (onlineExamIds && Array.isArray(onlineExamIds) && onlineExamIds.length > 0) {
      submissionFilter.onlineExamId = { in: onlineExamIds.map(Number) }
    }

    const submissions = await prisma.onlineExamSubmission.findMany({
      where: submissionFilter,
      include: {
        onlineExam: true
      }
    })

    let updatedCount = 0
    let createdCount = 0
    let skippedCount = 0

    for (const sub of submissions) {
      if (sub.totalMark === null || sub.totalMark === undefined) {
        skippedCount++
        continue
      }

      const { studentId, totalMark, onlineExam } = sub
      const { classId, subjectId } = onlineExam

      // Find enrollment to resolve sectionId
      const enroll = await prisma.enroll.findFirst({
        where: {
          studentId,
          sessionId,
          branchId: decoded.branchId
        },
        select: { sectionId: true }
      })

      if (!enroll) {
        skippedCount++
        continue
      }

      // Check if Mark record already exists for this student, subject, class, academic exam, session
      const existingMark = await prisma.mark.findFirst({
        where: {
          studentId,
          subjectId,
          classId,
          examId: Number(examId),
          sessionId,
          branchId: decoded.branchId
        }
      })

      if (existingMark) {
        await prisma.mark.update({
          where: { id: existingMark.id },
          data: {
            cbtMark: String(totalMark)
          }
        })
        updatedCount++
      } else {
        await prisma.mark.create({
          data: {
            studentId,
            subjectId,
            classId,
            sectionId: enroll.sectionId,
            examId: Number(examId),
            cbtMark: String(totalMark),
            sessionId,
            branchId: decoded.branchId
          }
        })
        createdCount++
      }
    }

    return res.json({
      success: true,
      message: `Sync completed successfully. Updated: ${updatedCount}, Created: ${createdCount}, Skipped: ${skippedCount}`
    })
  } catch (error) {
    console.error('[ADMIN] CBT marks sync error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to sync CBT marks.' })
  }
})

module.exports = router; // reload nodemon

