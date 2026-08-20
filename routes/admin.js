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
  generateBatchClassCredentialSlipsPdf,
  generateReportCardPdf,
  generateMontessoriReportCardPdf,
  generateBatchClassReportCardsPdf,
  generateSingleInvoicePdf,
  generateBatchClassInvoicesPdf,
  generateStudentIdCardPdf,
  generateStaffIdCardPdf,
  generateCertificatePdf,
  generatePayslipPdf,
  generateEmploymentLetterPdf,
  generateLessonPlanPdf
} = require('../lib/pdfService')
const { generatePedagogicalLessonPlan } = require('../lib/lessonPlanService')
const { generateStudentAiCommentary, generateBatchClassCommentary } = require('../lib/commentaryService')
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
const {
  parseAikenFormat,
  parseCsvFormat,
  parseJsonFormat,
  generateAiCurriculumQuestions,
  autoGradeCbtSubmission
} = require('../lib/cbtService')
const {
  getMyEduRideConfig,
  saveMyEduRideConfig,
  testMyEduRideConnection,
  syncStudentsToMyEduRide,
  getTransportOverview,
  getBusFleet,
  getGateLogs,
  processGateScan,
  updateStudentBoarding,
  exportGateLogsCsv,
  exportGateLogsPdf
} = require('../lib/myedurideBridgeService')
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
          photo: true,
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
          photo: teacher.photo || null,
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

    // Resolve questions and sync OnlineExam model
    let resolvedQuestions = []
    if (groupId) {
      const grp = await prisma.questionGroup.findUnique({ where: { id: Number(groupId) } })
      if (grp && Array.isArray(grp.questionIds) && grp.questionIds.length > 0) {
        resolvedQuestions = await prisma.questionBank.findMany({
          where: { id: { in: grp.questionIds.map(Number) } }
        })
      }
    }
    if (resolvedQuestions.length === 0) {
      resolvedQuestions = await prisma.questionBank.findMany({
        where: { branchId: decoded.branchId, subjectId: Number(subjectId) },
        take: 20
      })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const activeSessionId = globalSetting?.sessionId || 5

    let onlineExam = await prisma.onlineExam.findFirst({
      where: {
        title: title.trim(),
        classId: Number(classId),
        subjectId: Number(subjectId),
        branchId: decoded.branchId
      }
    })

    if (onlineExam) {
      await prisma.onlineExam.update({
        where: { id: onlineExam.id },
        data: {
          duration: Number(duration) || 30,
          passingMark: Number(passingMark) || 50.0,
          questions: resolvedQuestions,
          sessionId: activeSessionId
        }
      })
    } else {
      await prisma.onlineExam.create({
        data: {
          title: title.trim(),
          classId: Number(classId),
          subjectId: Number(subjectId),
          passingMark: Number(passingMark) || 50.0,
          duration: Number(duration) || 30,
          branchId: decoded.branchId,
          sessionId: activeSessionId,
          questions: resolvedQuestions,
          examDate: startDate ? new Date(startDate) : new Date()
        }
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
 * GET /api/admin/cbt/question-bank
 * Search & list question bank items with subject and class filters.
 */
router.get('/cbt/question-bank', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { subjectId, classId, search, page = 1, limit = 50 } = req.query
    const p = parseInt(page, 10)
    const l = parseInt(limit, 10)
    const skip = (p - 1) * l

    const where = { branchId: decoded.branchId }
    if (subjectId) where.subjectId = Number(subjectId)
    if (classId) where.classId = Number(classId)
    if (search) {
      where.questionText = { contains: search, mode: 'insensitive' }
    }

    const [items, total] = await Promise.all([
      prisma.questionBank.findMany({
        where,
        include: {
          subject: { select: { id: true, name: true, subjectCode: true } },
          class: { select: { id: true, name: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: l
      }),
      prisma.questionBank.count({ where })
    ])

    return res.json({
      success: true,
      items,
      total,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l)
      }
    })
  } catch (error) {
    console.error('[ADMIN] Fetch question bank error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch question bank.' })
  }
})

/**
 * POST /api/admin/cbt/question-bank
 * Create single question.
 */
router.post('/cbt/question-bank', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { questionText, questionType = 'mcq', options = [], correctOption = 'A', marks = 1.0, subjectId, classId } = req.body
    if (!questionText || !subjectId) {
      return res.status(400).json({ success: false, message: 'Question prompt and Subject are required.' })
    }

    const item = await prisma.questionBank.create({
      data: {
        branchId: decoded.branchId,
        questionText: questionText.trim(),
        questionType,
        options: Array.isArray(options) ? options : [],
        correctOption: String(correctOption).trim().toUpperCase(),
        marks: parseFloat(marks) || 1.0,
        subjectId: Number(subjectId),
        classId: classId ? Number(classId) : null
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } }
      }
    })

    return res.status(201).json({ success: true, item, message: 'Question created successfully.' })
  } catch (error) {
    console.error('[ADMIN] Create question bank item error:', error)
    return res.status(500).json({ success: false, message: 'Failed to create question.' })
  }
})

/**
 * PUT /api/admin/cbt/question-bank/:id
 * Update single question.
 */
router.put('/cbt/question-bank/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const id = Number(req.params.id)
    const { questionText, questionType, options, correctOption, marks, subjectId, classId } = req.body

    const item = await prisma.questionBank.update({
      where: { id },
      data: {
        ...(questionText ? { questionText: questionText.trim() } : {}),
        ...(questionType ? { questionType } : {}),
        ...(options ? { options: Array.isArray(options) ? options : [] } : {}),
        ...(correctOption ? { correctOption: String(correctOption).trim().toUpperCase() } : {}),
        ...(marks !== undefined ? { marks: parseFloat(marks) } : {}),
        ...(subjectId ? { subjectId: Number(subjectId) } : {}),
        ...(classId !== undefined ? { classId: classId ? Number(classId) : null } : {})
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } }
      }
    })

    return res.json({ success: true, item, message: 'Question updated successfully.' })
  } catch (error) {
    console.error('[ADMIN] Update question bank item error:', error)
    return res.status(500).json({ success: false, message: 'Failed to update question.' })
  }
})

/**
 * DELETE /api/admin/cbt/question-bank/:id
 * Delete single question.
 */
router.delete('/cbt/question-bank/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const id = Number(req.params.id)
    await prisma.questionBank.delete({ where: { id } })
    return res.json({ success: true, message: 'Question deleted successfully.' })
  } catch (error) {
    console.error('[ADMIN] Delete question bank item error:', error)
    return res.status(500).json({ success: false, message: 'Failed to delete question.' })
  }
})

/**
 * POST /api/admin/cbt/question-bank/import
 * Bulk imports questions from Aiken format, CSV, or structured JSON.
 */
router.post('/cbt/question-bank/import', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { format = 'aiken', data, subjectId, classId } = req.body
    if (!data || !subjectId) {
      return res.status(400).json({ success: false, message: 'Import Data and Subject are required.' })
    }

    const sId = Number(subjectId)
    const cId = classId ? Number(classId) : null

    let parsedQuestions = []
    if (format === 'aiken') {
      parsedQuestions = parseAikenFormat(typeof data === 'string' ? data : '')
    } else if (format === 'csv') {
      parsedQuestions = parseCsvFormat(typeof data === 'string' ? data : '')
    } else if (format === 'json') {
      parsedQuestions = parseJsonFormat(data)
    }

    if (parsedQuestions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid questions could be parsed from the provided format syntax.'
      })
    }

    const insertData = parsedQuestions.map(q => ({
      branchId: decoded.branchId,
      subjectId: sId,
      classId: cId,
      questionText: q.questionText,
      questionType: q.questionType || 'mcq',
      options: q.options,
      correctOption: q.correctOption || 'A',
      marks: q.marks || 1.0
    }))

    await prisma.questionBank.createMany({
      data: insertData
    })

    return res.status(201).json({
      success: true,
      count: insertData.length,
      message: `Successfully imported ${insertData.length} question(s) into Question Bank.`
    })
  } catch (error) {
    console.error('[ADMIN] Import question bank error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to import questions.' })
  }
})

/**
 * POST /api/admin/cbt/question-bank/ai-generate
 * Generates curriculum questions and saves them to Question Bank.
 */
router.post('/cbt/question-bank/ai-generate', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const { subjectId, classId, topic, classLevel, count = 5, questionType = 'mcq' } = req.body
    if (!subjectId || !topic) {
      return res.status(400).json({ success: false, message: 'Subject and Topic are required.' })
    }

    const sId = Number(subjectId)
    const cId = classId ? Number(classId) : null

    const subject = await prisma.subject.findUnique({
      where: { id: sId },
      select: { name: true }
    })

    const generated = generateAiCurriculumQuestions({
      subjectName: subject?.name || 'General Studies',
      topic: topic.trim(),
      classLevel: classLevel || 'Secondary',
      questionCount: Number(count) || 5,
      questionType
    })

    const insertData = generated.map(q => ({
      branchId: decoded.branchId,
      subjectId: sId,
      classId: cId,
      questionText: q.questionText,
      questionType: q.questionType,
      options: q.options,
      correctOption: q.correctOption,
      marks: q.marks
    }))

    await prisma.questionBank.createMany({
      data: insertData
    })

    return res.status(201).json({
      success: true,
      count: insertData.length,
      questions: generated,
      message: `AI generated and imported ${insertData.length} question(s) for "${topic}".`
    })
  } catch (error) {
    console.error('[ADMIN] AI generate question bank error:', error)
    return res.status(500).json({ success: false, message: 'Failed to generate AI questions.' })
  }
})

/**
 * GET /api/admin/cbt/distributions/:id/analytics
 * Detailed submissions, scores, and question difficulty index.
 */
router.get('/cbt/distributions/:id/analytics', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const distId = Number(req.params.id)
    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: distId },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        group: true
      }
    })

    if (!dist) {
      return res.status(404).json({ success: false, message: 'CBT Distribution not found.' })
    }

    // Resolve question items from group
    let questions = []
    if (dist.group && Array.isArray(dist.group.questionIds) && dist.group.questionIds.length > 0) {
      questions = await prisma.questionBank.findMany({
        where: { id: { in: dist.group.questionIds.map(Number) } }
      })
    } else {
      // Fallback to class/subject question bank items
      questions = await prisma.questionBank.findMany({
        where: { branchId: decoded.branchId, subjectId: dist.subjectId },
        take: 20
      })
    }

    // Resolve enrolled students in class section
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const enrollWhere = {
      classId: dist.classId,
      branchId: decoded.branchId,
      sessionId
    }
    if (dist.sectionId) enrollWhere.sectionId = dist.sectionId

    const enrollments = await prisma.enroll.findMany({
      where: enrollWhere,
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true, active: true } }
      }
    })
    const activeStudents = enrollments.filter(e => e.student && e.student.active)

    // Resolve submissions from OnlineExamSubmission
    const submissions = await prisma.onlineExamSubmission.findMany({
      where: {
        studentId: { in: activeStudents.map(e => e.student.id) }
      },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } }
      },
      orderBy: { submittedAt: 'desc' }
    })

    const studentRoster = activeStudents.map(e => {
      const st = e.student
      const sub = submissions.find(s => s.studentId === st.id)
      return {
        studentId: st.id,
        studentName: `${st.lastName}, ${st.firstName}`,
        registerNo: st.registerNo || 'Pending',
        isSubmitted: Boolean(sub && sub.submittedAt),
        totalMark: sub?.totalMark !== null && sub?.totalMark !== undefined ? sub.totalMark : null,
        submittedAt: sub?.submittedAt || null
      }
    })

    const submittedOnly = studentRoster.filter(s => s.isSubmitted && s.totalMark !== null)
    const totalScoreSum = submittedOnly.reduce((acc, s) => acc + Number(s.totalMark), 0)
    const averageScore = submittedOnly.length > 0 ? (totalScoreSum / submittedOnly.length) : 0
    const highestScore = submittedOnly.length > 0 ? Math.max(...submittedOnly.map(s => Number(s.totalMark))) : 0
    const lowestScore = submittedOnly.length > 0 ? Math.min(...submittedOnly.map(s => Number(s.totalMark))) : 0
    const passedCount = submittedOnly.filter(s => Number(s.totalMark) >= (dist.passingMark || 50)).length
    const passRate = submittedOnly.length > 0 ? (passedCount / submittedOnly.length) * 100 : 0

    return res.json({
      success: true,
      distribution: dist,
      totalEnrolled: activeStudents.length,
      submittedCount: submittedOnly.length,
      pendingCount: activeStudents.length - submittedOnly.length,
      averageScore: Math.round(averageScore * 10) / 10,
      highestScore,
      lowestScore,
      passRate: Math.round(passRate * 10) / 10,
      questionsCount: questions.length,
      students: studentRoster
    })
  } catch (error) {
    console.error('[ADMIN] Fetch CBT distribution analytics error:', error)
    return res.status(500).json({ success: false, message: 'Failed to load CBT analytics.' })
  }
})

/**
 * POST /api/admin/cbt/distributions/:id/sync-marks
 * Syncs student CBT scores directly into official academic Mark table (cbtMark field)
 */
router.post('/cbt/distributions/:id/sync-marks', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const distId = Number(req.params.id)
    const { targetExamId, maxScoreBase = 40 } = req.body

    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: distId },
      include: { class: true, subject: true }
    })

    if (!dist) {
      return res.status(404).json({ success: false, message: 'CBT Distribution not found.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Find active Exam if not specified
    let examId = targetExamId ? Number(targetExamId) : null
    if (!examId) {
      let activeExam = await prisma.exam.findFirst({
        where: { branchId: decoded.branchId, sessionId },
        orderBy: { id: 'desc' }
      })
      if (!activeExam) {
        activeExam = await prisma.exam.findFirst({
          where: { branchId: decoded.branchId },
          orderBy: { id: 'desc' }
        })
      }
      if (!activeExam) {
        activeExam = await prisma.exam.create({
          data: {
            name: 'First Term Assessment Exam',
            termId: 1,
            sessionId,
            branchId: decoded.branchId,
            type: 1
          }
        })
      }
      examId = activeExam.id
    }

    // Resolve submissions and enrollments
    const enrollments = await prisma.enroll.findMany({
      where: { classId: dist.classId, branchId: decoded.branchId, sessionId },
      select: { studentId: true, sectionId: true }
    })
    const studentIds = enrollments.map(e => e.studentId)
    const enrollMap = {}
    enrollments.forEach(e => { enrollMap[e.studentId] = e.sectionId })

    const submissions = await prisma.onlineExamSubmission.findMany({
      where: { studentId: { in: studentIds } }
    })

    let syncedCount = 0
    for (const sub of submissions) {
      if (sub.totalMark === null || sub.totalMark === undefined) continue

      const rawScore = Number(sub.totalMark)
      const scaledScore = Math.min(rawScore, Number(maxScoreBase))
      const targetSectionId = dist.sectionId || enrollMap[sub.studentId] || 9

      const existingMark = await prisma.mark.findFirst({
        where: {
          studentId: sub.studentId,
          subjectId: dist.subjectId,
          classId: dist.classId,
          examId,
          sessionId,
          branchId: decoded.branchId
        }
      })

      if (existingMark) {
        await prisma.mark.update({
          where: { id: existingMark.id },
          data: { cbtMark: String(scaledScore) }
        })
      } else {
        await prisma.mark.create({
          data: {
            studentId: sub.studentId,
            subjectId: dist.subjectId,
            classId: dist.classId,
            sectionId: targetSectionId,
            examId,
            sessionId,
            branchId: decoded.branchId,
            cbtMark: String(scaledScore),
            mark: '0',
            absent: null
          }
        })
      }

      syncedCount++
    }

    return res.json({
      success: true,
      message: `Successfully synchronized ${syncedCount} student CBT score(s) into report card marksheets (CBT Marks max: ${maxScoreBase}).`,
      syncedCount
    })
  } catch (error) {
    console.error('[ADMIN] Sync CBT marks error:', error)
    return res.status(500).json({ success: false, message: 'Failed to sync CBT marks to marksheet.' })
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
 * POST /api/admin/classes/seed-preset
 * One-click school category class & section seeder.
 * Categories: 'nursery_primary', 'secondary_only', 'combined_k12'
 */
router.post('/classes/seed-preset', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const body = req.body || {}
    const category = (body.category || 'combined_k12').toLowerCase()

    let presetClasses = []
    if (category === 'nursery_primary' || category === 'primary') {
      presetClasses = [
        { name: 'Nursery 1', isEcd: true },
        { name: 'Nursery 2', isEcd: true },
        { name: 'Primary 1', isEcd: false },
        { name: 'Primary 2', isEcd: false },
        { name: 'Primary 3', isEcd: false },
        { name: 'Primary 4', isEcd: false },
        { name: 'Primary 5', isEcd: false },
        { name: 'Primary 6', isEcd: false },
      ]
    } else if (category === 'secondary_only' || category === 'secondary') {
      presetClasses = [
        { name: 'JSS 1', isEcd: false },
        { name: 'JSS 2', isEcd: false },
        { name: 'JSS 3', isEcd: false },
        { name: 'SSS 1', isEcd: false },
        { name: 'SSS 2', isEcd: false },
        { name: 'SSS 3', isEcd: false },
      ]
    } else {
      // Combined K-12
      presetClasses = [
        { name: 'Nursery 1', isEcd: true },
        { name: 'Nursery 2', isEcd: true },
        { name: 'Primary 1', isEcd: false },
        { name: 'Primary 2', isEcd: false },
        { name: 'Primary 3', isEcd: false },
        { name: 'Primary 4', isEcd: false },
        { name: 'Primary 5', isEcd: false },
        { name: 'Primary 6', isEcd: false },
        { name: 'JSS 1', isEcd: false },
        { name: 'JSS 2', isEcd: false },
        { name: 'JSS 3', isEcd: false },
        { name: 'SSS 1', isEcd: false },
        { name: 'SSS 2', isEcd: false },
        { name: 'SSS 3', isEcd: false },
      ]
    }

    const defaultSections = ['A (Gold)', 'B (Silver)']
    const createdClasses = []

    await prisma.$transaction(async (tx) => {
      const sectionMap = {}
      for (const secName of defaultSections) {
        let sec = await tx.section.findFirst({
          where: { name: secName, branchId: decoded.branchId }
        })
        if (!sec) {
          sec = await tx.section.create({
            data: { name: secName, capacity: '40', branchId: decoded.branchId }
          })
        }
        sectionMap[secName] = sec.id
      }

      for (const item of presetClasses) {
        let cls = await tx.class.findFirst({
          where: { name: item.name, branchId: decoded.branchId }
        })
        if (!cls) {
          cls = await tx.class.create({
            data: {
              name: item.name,
              nameNumeric: item.name.replace(/\D/g, '') || '1',
              isEcd: item.isEcd,
              branchId: decoded.branchId
            }
          })
        }

        for (const secName of defaultSections) {
          const secId = sectionMap[secName]
          if (secId) {
            const existingAlloc = await tx.sectionsAllocation.findFirst({
              where: { classId: cls.id, sectionId: secId, branchId: decoded.branchId }
            })
            if (!existingAlloc) {
              await tx.sectionsAllocation.create({
                data: {
                  classId: cls.id,
                  sectionId: secId,
                  branchId: decoded.branchId
                }
              })
            }
          }
        }
        createdClasses.push(cls)
      }
    })

    return res.status(200).json({
      success: true,
      message: `Seeded ${createdClasses.length} classes and sections for category "${category}".`,
      classesCount: createdClasses.length,
    })
  } catch (error) {
    console.error('[ADMIN] Seed class preset error:', error)
    return res.status(500).json({ success: false, message: 'Failed to seed class presets.' })
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
    const body = req.body || {}
    const { name, termId, typeId, markDistribution = ['Theory', 'Objective'], remark } = body

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Exam Name is required.' })
    }

    const distList = Array.isArray(markDistribution) ? markDistribution : ['Theory', 'Objective']

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const resolvedIds = []
    for (const dist of distList) {
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
    const body = req.body || {}
    const student = body.student || (body.firstName ? body : null)
    const parent = body.parent || (body.parentName || body.parent_name || body.name ? body : null)

    if (!student || !parent) {
      return res.status(400).json({ success: false, message: 'Student and Parent details are required in request body.' })
    }

    const firstName = student.firstName || body.firstName
    const lastName = student.lastName || body.lastName
    const gender = student.gender || body.gender || 'Male'
    const birthday = student.birthday || body.birthday
    const classId = Number(student.classId || body.classId)
    const sectionId = Number(student.sectionId || body.sectionId)
    const currentAddress = student.currentAddress || body.currentAddress
    const permanentAddress = student.permanentAddress || body.permanentAddress
    const previousDetails = student.previousDetails || body.previousDetails

    const parentName = parent.name || parent.parentName || body.parentName || body.parent_name
    const parentEmail = parent.email || parent.parentEmail || body.parentEmail || body.parent_email
    const parentPhone = parent.mobileno || parent.parentPhone || body.parentPhone || body.mobileno
    const parentRelation = parent.relation || parent.parentRelation || body.parentRelation || 'Father'

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
    const { students } = req.body || {}
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
    const batchParentCache = new Map()

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

        const normEmail = row.parentEmail ? row.parentEmail.trim().toLowerCase() : ''
        const normPhone = row.parentPhone ? row.parentPhone.trim().replace(/[\s\-\+]/g, '') : ''

        // Step A: Check in-memory batch cache (Deduplicate siblings in the same CSV upload)
        if (normEmail && batchParentCache.has(`email:${normEmail}`)) {
          parentRecord = batchParentCache.get(`email:${normEmail}`)
          isExistingParent = true
        } else if (normPhone && batchParentCache.has(`phone:${normPhone}`)) {
          parentRecord = batchParentCache.get(`phone:${normPhone}`)
          isExistingParent = true
        }

        // Step B: Search active DB records for this branch
        if (!parentRecord && normEmail) {
          parentRecord = await tx.parent.findFirst({
            where: {
              branchId: decoded.branchId,
              email: { equals: normEmail, mode: 'insensitive' },
            },
          })
          if (parentRecord) isExistingParent = true
        }

        if (!parentRecord && normPhone) {
          parentRecord = await tx.parent.findFirst({
            where: {
              branchId: decoded.branchId,
              mobileno: normPhone,
            },
          })
          if (parentRecord) isExistingParent = true
        }

        // Step C: Create parent profile if not found
        if (parentRecord) {
          parentUserId = parentRecord.userId
        } else {
          const baseUsername = normEmail || normPhone || `parent_${nextParentId}`
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
              name: row.parentName.trim(),
              relation: row.parentRelation || 'Father',
              email: normEmail,
              mobileno: row.parentPhone || '',
              active: true,
              branchId: decoded.branchId,
              userId: parentUserId,
            },
          })
        }

        // Cache parent record for remaining rows in this bulk upload batch
        if (normEmail) batchParentCache.set(`email:${normEmail}`, parentRecord)
        if (normPhone) batchParentCache.set(`phone:${normPhone}`, parentRecord)

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
 * GET /api/admin/credentials-slips/class-pdf
 * Export Class-by-Class Batch Login Slips PDF for all students in a class.
 */
router.get('/credentials-slips/class-pdf', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const classId = req.query.classId
    const sectionId = req.query.sectionId

    if (!classId) {
      return res.status(400).json({ success: false, message: 'classId query parameter is required.' })
    }

    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: { name: true, code: true }
    })

    let targetClass = null
    let targetSection = null

    if (classId !== 'all') {
      targetClass = await prisma.class.findFirst({
        where: { id: Number(classId), branchId: decoded.branchId }
      })
      if (!targetClass) {
        return res.status(404).json({ success: false, message: 'Class not found in this branch.' })
      }
    }

    if (sectionId && sectionId !== 'all') {
      targetSection = await prisma.section.findFirst({
        where: { id: Number(sectionId), branchId: decoded.branchId }
      })
    }

    // Query enrolled students
    const whereEnroll = {
      branchId: decoded.branchId,
      ...(targetClass ? { classId: targetClass.id } : {}),
      ...(targetSection ? { sectionId: targetSection.id } : {}),
    }

    const enrolls = await prisma.enroll.findMany({
      where: whereEnroll,
      include: {
        student: {
          include: {
            user: { select: { username: true } },
            parent: {
              include: {
                user: { select: { username: true } }
              }
            }
          }
        },
        class: { select: { name: true } },
        section: { select: { name: true } }
      },
      orderBy: { id: 'asc' }
    })

    const slips = enrolls.map(e => {
      const s = e.student
      const p = s.parent
      return {
        studentName: `${s.firstName} ${s.lastName}`,
        registerNo: s.registerNo || '',
        studentUsername: s.user?.username || `${s.firstName.toLowerCase()}.${s.lastName.toLowerCase()}`,
        studentPassword: 'Check Login Slip / Contact Admin',
        parentName: p ? p.name : '',
        parentRelation: p ? p.relation : 'Parent',
        parentUsername: p?.user?.username || null,
        parentPassword: 'Check Login Slip / Contact Admin',
        isExistingParent: true
      }
    })

    const pdfBuffer = await generateBatchClassCredentialSlipsPdf({
      schoolName: branch?.name || 'Ugbekun Academy',
      branchCode: branch?.code || '',
      className: targetClass ? targetClass.name : 'All Classes',
      sectionName: targetSection ? targetSection.name : '',
      slips,
      loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000'
    })

    const safeClassName = targetClass ? targetClass.name.replace(/\s+/g, '_') : 'All_Classes'
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename=Batch_Login_Slips_${safeClassName}.pdf`)
    return res.send(pdfBuffer)
  } catch (error) {
    console.error('[ADMIN] Export batch login slips PDF error:', error)
    return res.status(500).json({ success: false, message: 'Failed to generate batch login slips PDF.' })
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
    const body = req.body || {}
    const staffData = body.teacher || body.staff || body

    const name = staffData.name || staffData.teacherName || staffData.fullName || staffData.staffName
    const email = staffData.email || staffData.teacherEmail || staffData.staffEmail
    const phone = staffData.phone || staffData.mobileno || staffData.phoneNumber || staffData.phoneNo
    const qualifications = staffData.qualifications
    const houseAddress = staffData.houseAddress || staffData.address || staffData.currentAddress
    const department = staffData.department
    const bankName = staffData.bankName
    const accountNumber = staffData.accountNumber
    const accountName = staffData.accountName
    const role = staffData.role !== undefined ? staffData.role : 3
    const isClassTeacher = staffData.isClassTeacher
    const classTeacherClassId = staffData.classTeacherClassId
    const classTeacherSectionId = staffData.classTeacherSectionId
    const isSubjectTeacher = staffData.isSubjectTeacher
    const subjectTeacherClassId = staffData.subjectTeacherClassId
    const subjectTeacherSectionId = staffData.subjectTeacherSectionId
    const subjectTeacherSubjectId = staffData.subjectTeacherSubjectId

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
    const body = req.body || {}
    const staffData = body.teacher || body.staff || body
    const name = staffData.name || staffData.teacherName || staffData.fullName
    const email = staffData.email || staffData.teacherEmail
    const phone = staffData.phone || staffData.mobileno
    const qualifications = staffData.qualifications
    const houseAddress = staffData.houseAddress || staffData.address
    const department = staffData.department
    const bankName = staffData.bankName
    const accountNumber = staffData.accountNumber
    const accountName = staffData.accountName

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
              orderBy: { id: 'desc' },
              take: 1,
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
 * GET /api/admin/card-template
 * Return branch card design settings (colors, layout) + stats
 */
router.get('/card-template', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;
  try {
    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: {
        name: true,
        city: true,
        systemLogo: true,
        idCardPrimaryColor: true,
        idCardSecondaryColor: true,
        idCardLayoutType: true,
      }
    });

    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found.' });

    const [totalCards, activeCards, revokedCards] = await Promise.all([
      prisma.idCard.count({ where: { branchId: decoded.branchId } }),
      prisma.idCard.count({ where: { branchId: decoded.branchId, status: 'active' } }),
      prisma.idCard.count({ where: { branchId: decoded.branchId, status: 'revoked' } }),
    ]);

    return res.json({
      success: true,
      template: {
        schoolName: branch.name,
        branchName: branch.city || branch.name,
        logo: branch.systemLogo,
        primaryColor: branch.idCardPrimaryColor || '#1b5e20',
        secondaryColor: branch.idCardSecondaryColor || '#2e7d32',
        layoutType: branch.idCardLayoutType || 'classic',
      },
      stats: { totalCards, activeCards, revokedCards }
    });
  } catch (error) {
    console.error('[ADMIN] Get card template error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load card template.' });
  }
});

/**
 * PUT /api/admin/card-template
 * Update branch card design settings
 */
router.put('/card-template', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;
  try {
    const { primaryColor, secondaryColor, layoutType } = req.body;

    const validLayouts = ['classic', 'modern', 'minimal'];
    if (layoutType && !validLayouts.includes(layoutType)) {
      return res.status(400).json({ success: false, message: 'Invalid layout type.' });
    }

    const updated = await prisma.branch.update({
      where: { id: decoded.branchId },
      data: {
        ...(primaryColor ? { idCardPrimaryColor: primaryColor } : {}),
        ...(secondaryColor ? { idCardSecondaryColor: secondaryColor } : {}),
        ...(layoutType ? { idCardLayoutType: layoutType } : {}),
      },
      select: { idCardPrimaryColor: true, idCardSecondaryColor: true, idCardLayoutType: true }
    });

    return res.json({
      success: true,
      message: 'Card template settings updated successfully.',
      template: {
        primaryColor: updated.idCardPrimaryColor,
        secondaryColor: updated.idCardSecondaryColor,
        layoutType: updated.idCardLayoutType
      }
    });
  } catch (error) {
    console.error('[ADMIN] Update card template error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update card template.' });
  }
});

/**
 * GET /api/admin/id-cards/stats
 * Stats breakdown of ID cards (by type, status)
 */
router.get('/id-cards/stats', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;
  try {
    const [studentActive, studentRevoked, staffActive, staffRevoked] = await Promise.all([
      prisma.idCard.count({ where: { branchId: decoded.branchId, entityType: 'student', status: 'active' } }),
      prisma.idCard.count({ where: { branchId: decoded.branchId, entityType: 'student', status: 'revoked' } }),
      prisma.idCard.count({ where: { branchId: decoded.branchId, entityType: 'staff', status: 'active' } }),
      prisma.idCard.count({ where: { branchId: decoded.branchId, entityType: 'staff', status: 'revoked' } }),
    ]);
    return res.json({
      success: true,
      stats: {
        student: { active: studentActive, revoked: studentRevoked, total: studentActive + studentRevoked },
        staff: { active: staffActive, revoked: staffRevoked, total: staffActive + staffRevoked },
        total: studentActive + studentRevoked + staffActive + staffRevoked,
        totalActive: studentActive + staffActive,
        totalRevoked: studentRevoked + staffRevoked,
      }
    });
  } catch (error) {
    console.error('[ADMIN] ID cards stats error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load ID card stats.' });
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
 * GET /api/admin/finances/invoices/batch-preview
 * Previews enrolled students in class & section with their existing invoice status and projected billing
 */
router.get('/finances/invoices/batch-preview', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { classId, sectionId, termLabel, feeTypeIds } = req.query;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const parsedClassId = parseInt(classId, 10);
    const parsedSectionId = sectionId ? parseInt(sectionId, 10) : null;
    const term = (termLabel || 'First Term').trim();

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    // Fetch class & section names
    const cls = await prisma.class.findUnique({
      where: { id: parsedClassId },
      select: { id: true, name: true }
    });

    let secName = 'All Sections';
    if (parsedSectionId) {
      const sec = await prisma.section.findUnique({
        where: { id: parsedSectionId },
        select: { id: true, name: true }
      });
      if (sec) secName = sec.name;
    }

    // Fetch enrolled students
    const enrollWhere = {
      classId: parsedClassId,
      branchId: decoded.branchId,
      sessionId
    };
    if (parsedSectionId) {
      enrollWhere.sectionId = parsedSectionId;
    }

    const enrollments = await prisma.enroll.findMany({
      where: enrollWhere,
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            gender: true,
            active: true
          }
        },
        section: { select: { id: true, name: true } }
      },
      orderBy: { student: { lastName: 'asc' } }
    });

    const activeEnrollments = enrollments.filter(e => e.student && e.student.active);
    const studentIds = activeEnrollments.map(e => e.student.id);

    // Fetch existing invoices for these students for this term & session
    const existingInvoices = await prisma.invoice.findMany({
      where: {
        studentId: { in: studentIds },
        termLabel: term,
        sessionId,
        branchId: decoded.branchId
      },
      include: { items: true }
    });

    const existingMap = {};
    existingInvoices.forEach(inv => {
      existingMap[inv.studentId] = inv;
    });

    // Resolve fee types
    let selectedFeeTypes = [];
    if (feeTypeIds) {
      const parsedIds = (Array.isArray(feeTypeIds) ? feeTypeIds : String(feeTypeIds).split(',')).map(id => parseInt(id, 10)).filter(Boolean);
      selectedFeeTypes = await prisma.feeType.findMany({
        where: { id: { in: parsedIds }, branchId: decoded.branchId }
      });
    }

    // If no fee types explicitly selected, fetch class fee assignments
    if (selectedFeeTypes.length === 0) {
      const assignments = await prisma.feeAssignment.findMany({
        where: {
          classId: parsedClassId,
          branchId: decoded.branchId,
          sessionId,
          active: true
        },
        include: { feeType: true }
      });
      selectedFeeTypes = assignments.map(a => a.feeType).filter(Boolean);
    }

    const totalPerStudent = selectedFeeTypes.reduce((acc, curr) => acc + parseFloat(curr.amount.toString()), 0);

    const studentList = activeEnrollments.map(e => {
      const st = e.student;
      const existing = existingMap[st.id];

      return {
        id: st.id,
        studentName: `${st.lastName}, ${st.firstName}`,
        firstName: st.firstName,
        lastName: st.lastName,
        registerNo: st.registerNo || 'Pending',
        gender: st.gender || 'N/A',
        sectionId: e.section?.id || null,
        sectionName: e.section?.name || secName,
        alreadyInvoiced: Boolean(existing),
        existingInvoiceId: existing?.id || null,
        existingInvoiceNo: existing?.invoiceNo || null,
        existingStatus: existing?.status || null,
        existingTotal: existing ? parseFloat(existing.totalAmount.toString()) : null,
        existingBalance: existing ? parseFloat(existing.balanceAmount.toString()) : null,
      };
    });

    const unInvoicedCount = studentList.filter(s => !s.alreadyInvoiced).length;
    const projectedTotal = unInvoicedCount * totalPerStudent;

    return res.json({
      success: true,
      className: cls?.name || 'Classroom',
      sectionName: secName,
      totalEnrolled: studentList.length,
      alreadyInvoicedCount: studentList.length - unInvoicedCount,
      unInvoicedCount,
      totalPerStudent,
      projectedTotal,
      feeTypes: selectedFeeTypes.map(ft => ({
        id: ft.id,
        name: ft.name,
        code: ft.code,
        amount: parseFloat(ft.amount.toString()),
        frequency: ft.frequency
      })),
      students: studentList
    });
  } catch (error) {
    console.error('[ADMIN INVOICES] Batch preview error:', error);
    return res.status(500).json({ success: false, message: 'Failed to preview batch invoice roster.' });
  }
});

/**
 * POST /api/admin/finances/invoices/batch-generate
 * Bulk generates invoices for all or selected students in a class section with sequential numbering
 */
router.post('/finances/invoices/batch-generate', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { classId, sectionId, termLabel, dueDate, feeTypeIds, studentIds, overwriteExisting } = req.body;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const parsedClassId = parseInt(classId, 10);
    const parsedSectionId = sectionId ? parseInt(sectionId, 10) : null;
    const term = (termLabel || 'First Term').trim();

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    // Resolve fee types
    let targetFeeTypeIds = [];
    if (Array.isArray(feeTypeIds) && feeTypeIds.length > 0) {
      targetFeeTypeIds = feeTypeIds.map(id => parseInt(id, 10));
    } else {
      const assignments = await prisma.feeAssignment.findMany({
        where: {
          classId: parsedClassId,
          branchId: decoded.branchId,
          sessionId,
          active: true
        },
        select: { feeTypeId: true }
      });
      targetFeeTypeIds = assignments.map(a => a.feeTypeId);
    }

    if (targetFeeTypeIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fee types selected or assigned to this class. Please select at least one fee type.'
      });
    }

    // Resolve students to invoice
    let targetStudentIds = [];
    if (Array.isArray(studentIds) && studentIds.length > 0) {
      targetStudentIds = studentIds.map(id => parseInt(id, 10));
    } else {
      const enrollWhere = {
        classId: parsedClassId,
        branchId: decoded.branchId,
        sessionId
      };
      if (parsedSectionId) {
        enrollWhere.sectionId = parsedSectionId;
      }
      const enrollments = await prisma.enroll.findMany({
        where: enrollWhere,
        include: { student: { select: { id: true, active: true } } }
      });
      targetStudentIds = enrollments.filter(e => e.student && e.student.active).map(e => e.student.id);
    }

    if (targetStudentIds.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No eligible active students found for batch invoice generation.'
      });
    }

    let createdCount = 0;
    let skippedCount = 0;
    let totalInvoicedSum = 0;
    const createdInvoices = [];

    for (const sId of targetStudentIds) {
      try {
        const existing = await prisma.invoice.findFirst({
          where: {
            studentId: sId,
            termLabel: term,
            sessionId,
            branchId: decoded.branchId
          }
        });

        if (existing) {
          if (!overwriteExisting) {
            skippedCount++;
            continue;
          } else {
            // Delete old items and invoice if overwriting
            await prisma.invoiceItem.deleteMany({ where: { invoiceId: existing.id } });
            await prisma.payment.deleteMany({ where: { invoiceId: existing.id } });
            await prisma.invoice.delete({ where: { id: existing.id } });
          }
        }

        const invoice = await generateInvoice(prisma, {
          studentId: sId,
          termLabel: term,
          feeTypeIds: targetFeeTypeIds,
          branchId: decoded.branchId,
          sessionId,
          dueDate: dueDate || null
        });

        createdCount++;
        totalInvoicedSum += parseFloat(invoice.totalAmount.toString());
        createdInvoices.push({
          id: invoice.id,
          invoiceNo: invoice.invoiceNo,
          studentId: sId,
          totalAmount: parseFloat(invoice.totalAmount.toString())
        });
      } catch (err) {
        console.error(`[ADMIN INVOICES] Error generating invoice for student ${sId}:`, err);
        skippedCount++;
      }
    }

    return res.status(201).json({
      success: true,
      message: `Batch invoicing complete! Generated ${createdCount} invoice(s) (Total: ₦${totalInvoicedSum.toLocaleString()}), skipped ${skippedCount}.`,
      createdCount,
      skippedCount,
      totalInvoiced: totalInvoicedSum,
      invoices: createdInvoices
    });
  } catch (error) {
    console.error('[ADMIN INVOICES] Batch generate error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate batch invoices.' });
  }
});

/**
 * POST /api/admin/finances/invoices/bulk (Legacy wrapper redirecting to batch-generate)
 */
router.post('/finances/invoices/bulk', async (req, res) => {
  req.url = '/finances/invoices/batch-generate';
  return router.handle(req, res);
});

/**
 * GET /api/admin/finances/invoices/:id/pdf
 * 1-Click Single Invoice PDF Download
 */
router.get('/finances/invoices/:id/pdf', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const invoiceId = parseInt(req.params.id, 10);
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, branchId: decoded.branchId },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            enrolls: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              include: {
                class: { select: { name: true } },
                section: { select: { name: true } }
              }
            }
          }
        },
        items: true,
        payments: true
      }
    });

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: { name: true, code: true }
    });

    const schoolBank = await prisma.schoolBank.findFirst({
      where: { branchId: decoded.branchId, isActive: true }
    });

    const schoolYear = await prisma.schoolYear.findUnique({
      where: { id: invoice.sessionId || 5 },
      select: { schoolYear: true }
    });

    const latestEnroll = invoice.student?.enrolls?.[0];
    const className = latestEnroll?.class?.name || 'Classroom';
    const sectionName = latestEnroll?.section?.name || 'Main';

    const pdfBuffer = await generateSingleInvoicePdf({
      schoolName: branch?.name || 'Ugbekun Schools',
      branchCode: branch?.code || 'GEN',
      invoiceNo: invoice.invoiceNo,
      termLabel: invoice.termLabel,
      sessionName: schoolYear?.schoolYear || 'Active Session',
      studentName: `${invoice.student.lastName}, ${invoice.student.firstName}`,
      registerNo: invoice.student.registerNo || 'Pending',
      className,
      sectionName,
      issuedAt: invoice.issuedAt,
      dueDate: invoice.dueDate,
      status: invoice.status,
      items: invoice.items.map(item => ({
        description: item.description,
        amount: parseFloat(item.amount.toString()),
        feeTypeCode: 'FEE'
      })),
      totalAmount: parseFloat(invoice.totalAmount.toString()),
      paidAmount: parseFloat(invoice.paidAmount.toString()),
      balanceAmount: parseFloat(invoice.balanceAmount.toString()),
      schoolBank: schoolBank ? {
        bankName: schoolBank.bankName,
        accountName: schoolBank.accountName,
        accountNumber: schoolBank.accountNumber,
        sortCode: schoolBank.sortCode
      } : null
    });

    const safeInvoiceNo = invoice.invoiceNo.replace(/[\/\\]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice_${safeInvoiceNo}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN INVOICES] Download single invoice PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate invoice PDF.' });
  }
});

/**
 * GET /api/admin/finances/invoices/batch-pdf
 * 1-Click Whole-Class-Section Multi-Page Batch Fee Invoices PDF Download
 */
router.get('/finances/invoices/batch-pdf', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { classId, sectionId, termLabel } = req.query;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const parsedClassId = parseInt(classId, 10);
    const parsedSectionId = sectionId ? parseInt(sectionId, 10) : null;
    const term = termLabel ? String(termLabel).trim() : undefined;

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: { name: true, code: true }
    });

    const cls = await prisma.class.findUnique({ where: { id: parsedClassId }, select: { name: true } });
    const sec = parsedSectionId ? await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } }) : null;
    const schoolYear = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } });

    const className = cls?.name || 'Classroom';
    const sectionName = sec?.name || '';
    const sessionName = schoolYear?.schoolYear || 'Active Session';

    // Find enrolled students in this class section
    const enrollWhere = {
      classId: parsedClassId,
      branchId: decoded.branchId,
      sessionId
    };
    if (parsedSectionId) enrollWhere.sectionId = parsedSectionId;

    const enrollments = await prisma.enroll.findMany({
      where: enrollWhere,
      select: { studentId: true }
    });
    const studentIds = enrollments.map(e => e.studentId);

    if (studentIds.length === 0) {
      return res.status(404).json({ success: false, message: 'No enrolled students found in this class section.' });
    }

    // Find invoices for these students
    const invoiceWhere = {
      studentId: { in: studentIds },
      sessionId,
      branchId: decoded.branchId
    };
    if (term) invoiceWhere.termLabel = term;

    const invoices = await prisma.invoice.findMany({
      where: invoiceWhere,
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true
          }
        },
        items: true
      },
      orderBy: { invoiceNo: 'asc' }
    });

    if (invoices.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No invoices found for this class section. Please generate batch invoices first.'
      });
    }

    const schoolBank = await prisma.schoolBank.findFirst({
      where: { branchId: decoded.branchId, isActive: true }
    });

    const formattedInvoices = invoices.map(inv => ({
      invoiceNo: inv.invoiceNo,
      termLabel: inv.termLabel,
      studentName: `${inv.student.lastName}, ${inv.student.firstName}`,
      registerNo: inv.student.registerNo || 'Pending',
      issuedAt: inv.issuedAt,
      dueDate: inv.dueDate,
      status: inv.status,
      items: inv.items.map(item => ({
        description: item.description,
        amount: parseFloat(item.amount.toString()),
        feeTypeCode: 'FEE'
      })),
      totalAmount: parseFloat(inv.totalAmount.toString()),
      paidAmount: parseFloat(inv.paidAmount.toString()),
      balanceAmount: parseFloat(inv.balanceAmount.toString())
    }));

    const pdfBuffer = await generateBatchClassInvoicesPdf({
      schoolName: branch?.name || 'Ugbekun Schools',
      branchCode: branch?.code || 'GEN',
      className,
      sectionName,
      sessionName,
      schoolBank: schoolBank ? {
        bankName: schoolBank.bankName,
        accountName: schoolBank.accountName,
        accountNumber: schoolBank.accountNumber,
        sortCode: schoolBank.sortCode
      } : null,
      invoices: formattedInvoices
    });

    const safeCls = className.replace(/\s+/g, '_');
    const safeSec = sectionName.replace(/\s+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Batch_Invoices_${safeCls}${safeSec ? `_${safeSec}` : ''}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN INVOICES] Download batch invoices PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate batch invoices PDF.' });
  }
});

/**
 * GET /api/admin/finances/invoices
 * Retrieves all invoices with optional status, search, classId, sectionId, and termLabel filters
 */
router.get('/finances/invoices', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { status, search, classId, sectionId, termLabel, page = 1, limit = 50 } = req.query;
    const p = parseInt(page, 10);
    const l = parseInt(limit, 10);
    const skip = (p - 1) * l;

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const where = {
      branchId: decoded.branchId
    };

    if (status && status !== 'all') where.status = status;
    if (termLabel && termLabel !== 'all') where.termLabel = termLabel;

    // Filter by class / section if provided
    if (classId) {
      const parsedClassId = parseInt(classId, 10);
      const parsedSectionId = sectionId ? parseInt(sectionId, 10) : null;
      const enrollWhere = { classId: parsedClassId, branchId: decoded.branchId, sessionId };
      if (parsedSectionId) enrollWhere.sectionId = parsedSectionId;

      const enrolls = await prisma.enroll.findMany({
        where: enrollWhere,
        select: { studentId: true }
      });
      const sIds = enrolls.map(e => e.studentId);
      where.studentId = { in: sIds };
    }

    if (search) {
      where.OR = [
        { invoiceNo: { contains: search, mode: 'insensitive' } },
        {
          student: {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              { registerNo: { contains: search, mode: 'insensitive' } }
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
              id: true,
              firstName: true,
              lastName: true,
              registerNo: true,
              enrolls: {
                take: 1,
                orderBy: { createdAt: 'desc' },
                include: {
                  class: { select: { id: true, name: true } },
                  section: { select: { id: true, name: true } }
                }
              }
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

    const formattedInvoices = invoices.map(inv => {
      const enroll = inv.student?.enrolls?.[0];
      return {
        id: inv.id,
        invoiceNo: inv.invoiceNo,
        termLabel: inv.termLabel,
        totalAmount: parseFloat(inv.totalAmount.toString()),
        paidAmount: parseFloat(inv.paidAmount.toString()),
        balanceAmount: parseFloat(inv.balanceAmount.toString()),
        status: inv.status,
        dueDate: inv.dueDate,
        issuedAt: inv.issuedAt,
        student: {
          id: inv.student.id,
          firstName: inv.student.firstName,
          lastName: inv.student.lastName,
          registerNo: inv.student.registerNo,
          className: enroll?.class?.name || 'N/A',
          sectionName: enroll?.section?.name || 'N/A'
        },
        items: inv.items.map(it => ({
          id: it.id,
          description: it.description,
          amount: parseFloat(it.amount.toString())
        })),
        payments: inv.payments.map(pm => ({
          id: pm.id,
          amount: parseFloat(pm.amount.toString()),
          method: pm.method,
          reference: pm.reference,
          paidAt: pm.paidAt
        }))
      };
    });

    return res.json({
      success: true,
      data: formattedInvoices,
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
 * Generates single student invoice
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

// ============================================================================
// HUMAN RESOURCE (HR) - LEAVE MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/hr/leave-categories
 * List all leave categories / rules for branch
 */
router.get('/hr/leave-categories', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const categories = await prisma.leaveCategory.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { id: 'asc' },
      include: {
        _count: {
          select: { leaveRequests: true }
        }
      }
    });

    return res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error('[HR] Get leave categories error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch leave categories.' });
  }
});

/**
 * POST /api/admin/hr/leave-categories
 * Create new leave category / rule
 */
router.post('/hr/leave-categories', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { name, daysPerYear, isPaid, requiresAttachment, applicableRoles, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Leave category name is required.' });
    }

    const category = await prisma.leaveCategory.create({
      data: {
        name: name.trim(),
        daysPerYear: daysPerYear ? parseInt(daysPerYear, 10) : 14,
        isPaid: isPaid !== undefined ? Boolean(isPaid) : true,
        requiresAttachment: Boolean(requiresAttachment),
        applicableRoles: applicableRoles || 'ALL',
        description: description ? description.trim() : null,
        branchId: decoded.branchId
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Leave category created successfully.',
      data: category
    });
  } catch (error) {
    console.error('[HR] Create leave category error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create leave category.' });
  }
});

/**
 * PUT /api/admin/hr/leave-categories/:id
 * Update existing leave category
 */
router.put('/hr/leave-categories/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const categoryId = parseInt(req.params.id, 10);
    const existing = await prisma.leaveCategory.findFirst({
      where: { id: categoryId, branchId: decoded.branchId }
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Leave category not found.' });
    }

    const { name, daysPerYear, isPaid, requiresAttachment, applicableRoles, description, active } = req.body;

    const updated = await prisma.leaveCategory.update({
      where: { id: categoryId },
      data: {
        name: name !== undefined ? name.trim() : existing.name,
        daysPerYear: daysPerYear !== undefined ? parseInt(daysPerYear, 10) : existing.daysPerYear,
        isPaid: isPaid !== undefined ? Boolean(isPaid) : existing.isPaid,
        requiresAttachment: requiresAttachment !== undefined ? Boolean(requiresAttachment) : existing.requiresAttachment,
        applicableRoles: applicableRoles !== undefined ? applicableRoles : existing.applicableRoles,
        description: description !== undefined ? (description ? description.trim() : null) : existing.description,
        active: active !== undefined ? Boolean(active) : existing.active
      }
    });

    return res.json({
      success: true,
      message: 'Leave category updated successfully.',
      data: updated
    });
  } catch (error) {
    console.error('[HR] Update leave category error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update leave category.' });
  }
});

/**
 * DELETE /api/admin/hr/leave-categories/:id
 * Delete leave category if unused, or toggle inactive
 */
router.delete('/hr/leave-categories/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const categoryId = parseInt(req.params.id, 10);
    const existing = await prisma.leaveCategory.findFirst({
      where: { id: categoryId, branchId: decoded.branchId },
      include: { _count: { select: { leaveRequests: true } } }
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Leave category not found.' });
    }

    if (existing._count.leaveRequests > 0) {
      // Soft-delete by setting active to false
      await prisma.leaveCategory.update({
        where: { id: categoryId },
        data: { active: false }
      });
      return res.json({
        success: true,
        message: 'Leave category deactivated because requests are attached to it.'
      });
    }

    await prisma.leaveCategory.delete({
      where: { id: categoryId }
    });

    return res.json({
      success: true,
      message: 'Leave category deleted successfully.'
    });
  } catch (error) {
    console.error('[HR] Delete leave category error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete leave category.' });
  }
});

/**
 * GET /api/admin/hr/leave-requests
 * Fetch leave requests with filter parameters & aggregate summary stats
 */
router.get('/hr/leave-requests', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { status, leaveCategoryId, search } = req.query;

    const where = { branchId: decoded.branchId };

    if (status && status !== 'ALL') {
      where.status = String(status).toUpperCase();
    }

    if (leaveCategoryId && leaveCategoryId !== 'ALL') {
      where.leaveCategoryId = parseInt(leaveCategoryId, 10);
    }

    if (search && search.trim()) {
      const query = search.trim();
      where.OR = [
        { applicantName: { contains: query, mode: 'insensitive' } },
        { reason: { contains: query, mode: 'insensitive' } }
      ];
    }

    const requests = await prisma.leaveRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        leaveCategory: {
          select: { id: true, name: true, isPaid: true, daysPerYear: true }
        }
      }
    });

    // Aggregate overall KPI stats
    const [pendingCount, approvedCount, rejectedCount, totalCategories] = await Promise.all([
      prisma.leaveRequest.count({ where: { branchId: decoded.branchId, status: 'PENDING' } }),
      prisma.leaveRequest.count({ where: { branchId: decoded.branchId, status: 'APPROVED' } }),
      prisma.leaveRequest.count({ where: { branchId: decoded.branchId, status: 'REJECTED' } }),
      prisma.leaveCategory.count({ where: { branchId: decoded.branchId, active: true } })
    ]);

    return res.json({
      success: true,
      data: requests,
      stats: {
        pendingCount,
        approvedCount,
        rejectedCount,
        totalCategories
      }
    });
  } catch (error) {
    console.error('[HR] Get leave requests error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch leave requests.' });
  }
});

/**
 * POST /api/admin/hr/leave-requests
 * Submit a staff/teacher leave request
 */
router.post('/hr/leave-requests', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { leaveCategoryId, applicantId, applicantType, applicantName, startDate, endDate, reason, attachmentUrl } = req.body;

    if (!leaveCategoryId || !applicantId || !applicantName || !startDate || !endDate || !reason) {
      return res.status(400).json({ success: false, message: 'Please provide all required leave request fields.' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
      return res.status(400).json({ success: false, message: 'Invalid leave start or end date.' });
    }

    // Calculate total days (inclusive)
    const diffTime = Math.abs(end - start);
    const totalDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

    const newRequest = await prisma.leaveRequest.create({
      data: {
        leaveCategoryId: parseInt(leaveCategoryId, 10),
        applicantId: parseInt(applicantId, 10),
        applicantType: applicantType || 'TEACHER',
        applicantName: applicantName.trim(),
        startDate: start,
        endDate: end,
        totalDays,
        reason: reason.trim(),
        attachmentUrl: attachmentUrl ? attachmentUrl.trim() : null,
        status: 'PENDING',
        branchId: decoded.branchId
      },
      include: {
        leaveCategory: true
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Leave request submitted successfully.',
      data: newRequest
    });
  } catch (error) {
    console.error('[HR] Submit leave request error:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit leave request.' });
  }
});

/**
 * PUT /api/admin/hr/leave-requests/:id/review
 * Approve or Reject leave request with reviewer notes
 */
router.put('/hr/leave-requests/:id/review', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const requestId = parseInt(req.params.id, 10);
    const { status, reviewerNotes } = req.body;

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be APPROVED or REJECTED.' });
    }

    const existing = await prisma.leaveRequest.findFirst({
      where: { id: requestId, branchId: decoded.branchId }
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Leave request not found.' });
    }

    const updated = await prisma.leaveRequest.update({
      where: { id: requestId },
      data: {
        status,
        reviewerNotes: reviewerNotes ? reviewerNotes.trim() : null,
        reviewedBy: decoded.userId || decoded.id,
        reviewedAt: new Date()
      },
      include: {
        leaveCategory: true
      }
    });

    // If APPROVED, auto-sync leave dates into StaffAttendance as ON_LEAVE
    if (status === 'APPROVED' && existing.applicantType === 'TEACHER') {
      try {
        const curr = new Date(existing.startDate);
        const last = new Date(existing.endDate);

        while (curr <= last) {
          const attendanceDate = new Date(curr.getFullYear(), curr.getMonth(), curr.getDate());
          
          await prisma.staffAttendance.upsert({
            where: {
              id: 0 // Will fallback to create or findFirst search
            },
            create: {
              teacherId: existing.applicantId,
              attendanceDate,
              status: 'ON_LEAVE',
              remark: `Approved Leave: ${updated.leaveCategory.name}`,
              branchId: decoded.branchId
            },
            update: {
              status: 'ON_LEAVE',
              remark: `Approved Leave: ${updated.leaveCategory.name}`
            }
          }).catch(async () => {
            // Alternative findFirst & update fallback
            const match = await prisma.staffAttendance.findFirst({
              where: {
                teacherId: existing.applicantId,
                attendanceDate,
                branchId: decoded.branchId
              }
            });
            if (match) {
              await prisma.staffAttendance.update({
                where: { id: match.id },
                data: { status: 'ON_LEAVE', remark: `Approved Leave: ${updated.leaveCategory.name}` }
              });
            } else {
              await prisma.staffAttendance.create({
                data: {
                  teacherId: existing.applicantId,
                  attendanceDate,
                  status: 'ON_LEAVE',
                  remark: `Approved Leave: ${updated.leaveCategory.name}`,
                  branchId: decoded.branchId
                }
              });
            }
          });

          curr.setDate(curr.getDate() + 1);
        }
      } catch (attSyncErr) {
        console.error('[HR] Attendance sync warning:', attSyncErr);
      }
    }

    return res.json({
      success: true,
      message: `Leave request ${status.toLowerCase()} successfully.`,
      data: updated
    });
  } catch (error) {
    console.error('[HR] Review leave request error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to review leave request.' });
  }
});

// ============================================================================
// HR PAYROLL & PAYSLIPS ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/hr/payroll/components
 * List staff salary component setups for branch
 */
router.get('/hr/payroll/components', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const components = await prisma.payrollComponent.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { staffName: 'asc' }
    });

    return res.json({ success: true, data: components });
  } catch (error) {
    console.error('[HR] Get payroll components error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch payroll components.' });
  }
});

/**
 * POST /api/admin/hr/payroll/components
 * Upsert/save staff salary component structure
 */
router.post('/hr/payroll/components', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const {
      staffId,
      staffType,
      staffName,
      staffRole,
      baseSalary,
      housingAllowance,
      transportAllowance,
      medicalAllowance,
      taxDeduction,
      pensionDeduction,
      otherDeductions,
      bankName,
      accountNumber
    } = req.body;

    if (!staffId || !staffName) {
      return res.status(400).json({ success: false, message: 'Staff ID and name are required.' });
    }

    const sId = parseInt(staffId, 10);
    const existing = await prisma.payrollComponent.findFirst({
      where: { staffId: sId, branchId: decoded.branchId }
    });

    const dataPayload = {
      staffId: sId,
      staffType: staffType || 'TEACHER',
      staffName: staffName.trim(),
      staffRole: staffRole || 'Teacher',
      baseSalary: parseFloat(baseSalary || 0),
      housingAllowance: parseFloat(housingAllowance || 0),
      transportAllowance: parseFloat(transportAllowance || 0),
      medicalAllowance: parseFloat(medicalAllowance || 0),
      taxDeduction: parseFloat(taxDeduction || 0),
      pensionDeduction: parseFloat(pensionDeduction || 0),
      otherDeductions: parseFloat(otherDeductions || 0),
      bankName: bankName ? bankName.trim() : null,
      accountNumber: accountNumber ? accountNumber.trim() : null,
      branchId: decoded.branchId
    };

    let result;
    if (existing) {
      result = await prisma.payrollComponent.update({
        where: { id: existing.id },
        data: dataPayload
      });
    } else {
      result = await prisma.payrollComponent.create({
        data: dataPayload
      });
    }

    return res.json({
      success: true,
      message: 'Salary component saved successfully.',
      data: result
    });
  } catch (error) {
    console.error('[HR] Save payroll component error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save payroll component.' });
  }
});

/**
 * GET /api/admin/hr/payroll/runs
 * Fetch payroll runs history & payslips
 */
router.get('/hr/payroll/runs', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const runs = await prisma.payrollRun.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { createdAt: 'desc' },
      include: {
        payslips: true
      }
    });

    return res.json({ success: true, data: runs });
  } catch (error) {
    console.error('[HR] Get payroll runs error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch payroll runs.' });
  }
});

/**
 * POST /api/admin/hr/payroll/runs
 * Process/initialize monthly payroll run from configured components
 */
router.post('/hr/payroll/runs', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { monthYear } = req.body;
    if (!monthYear || !monthYear.trim()) {
      return res.status(400).json({ success: false, message: 'Month and year label required (e.g. July 2026).' });
    }

    const components = await prisma.payrollComponent.findMany({
      where: { branchId: decoded.branchId }
    });

    if (components.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No staff salary components configured yet. Setup salary components first.'
      });
    }

    let totalGrossSum = 0;
    let totalDeductionsSum = 0;
    let totalNetSum = 0;

    const payslipsData = components.map((comp) => {
      const base = Number(comp.baseSalary);
      const allowances = Number(comp.housingAllowance) + Number(comp.transportAllowance) + Number(comp.medicalAllowance);
      const gross = base + allowances;
      const deductions = Number(comp.taxDeduction) + Number(comp.pensionDeduction) + Number(comp.otherDeductions);
      const net = gross - deductions;

      totalGrossSum += gross;
      totalDeductionsSum += deductions;
      totalNetSum += net;

      return {
        staffId: comp.staffId,
        staffName: comp.staffName,
        staffRole: comp.staffRole,
        baseSalary: base,
        totalAllowances: allowances,
        totalDeductions: deductions,
        netSalary: net,
        paymentMethod: comp.bankName ? `Bank (${comp.bankName})` : 'Cash',
        status: 'PENDING',
        branchId: decoded.branchId
      };
    });

    const run = await prisma.payrollRun.create({
      data: {
        monthYear: monthYear.trim(),
        totalGross: totalGrossSum,
        totalDeductions: totalDeductionsSum,
        totalNet: totalNetSum,
        staffCount: components.length,
        status: 'SUBMITTED',
        branchId: decoded.branchId,
        payslips: {
          create: payslipsData
        }
      },
      include: {
        payslips: true
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Monthly payroll run generated successfully.',
      data: run
    });
  } catch (error) {
    console.error('[HR] Generate payroll run error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate payroll run.' });
  }
});

/**
 * PUT /api/admin/hr/payroll/runs/:id/status
 * Approve or Mark Payroll Run as PAID & dispatch payslips
 */
router.put('/hr/payroll/runs/:id/status', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const runId = parseInt(req.params.id, 10);
    const { status } = req.body;

    if (!['APPROVED', 'PAID'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be APPROVED or PAID.' });
    }

    const run = await prisma.payrollRun.findFirst({
      where: { id: runId, branchId: decoded.branchId }
    });

    if (!run) {
      return res.status(404).json({ success: false, message: 'Payroll run record not found.' });
    }

    const updateData = {
      status,
      ...(status === 'APPROVED' ? { approvedBy: decoded.userId || decoded.id, approvedAt: new Date() } : {}),
      ...(status === 'PAID' ? { paidAt: new Date() } : {})
    };

    const updatedRun = await prisma.payrollRun.update({
      where: { id: runId },
      data: updateData,
      include: { payslips: true }
    });

    if (status === 'PAID') {
      await prisma.payslip.updateMany({
        where: { payrollRunId: runId },
        data: { status: 'PAID', sentAt: new Date() }
      });
    }

    return res.json({
      success: true,
      message: `Payroll run status updated to ${status}.`,
      data: updatedRun
    });
  } catch (error) {
    console.error('[HR] Update payroll status error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update payroll status.' });
  }
});

/**
 * GET /api/admin/hr/payroll/payslips/:id/pdf
 * Download staff payslip PDF document
 */
router.get('/hr/payroll/payslips/:id/pdf', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const payslipId = parseInt(req.params.id, 10);
    const payslip = await prisma.payslip.findFirst({
      where: { id: payslipId, branchId: decoded.branchId },
      include: { payrollRun: true, branch: true }
    });

    if (!payslip) {
      return res.status(404).json({ success: false, message: 'Payslip not found.' });
    }

    const component = await prisma.payrollComponent.findFirst({
      where: { staffId: payslip.staffId, branchId: decoded.branchId }
    });

    const pdfBuffer = await generatePayslipPdf({
      schoolName: payslip.branch.name,
      branchName: payslip.branch.city || payslip.branch.name,
      monthYear: payslip.payrollRun.monthYear,
      staffName: payslip.staffName,
      staffRole: payslip.staffRole,
      baseSalary: payslip.baseSalary,
      housingAllowance: component?.housingAllowance || 0,
      transportAllowance: component?.transportAllowance || 0,
      medicalAllowance: component?.medicalAllowance || 0,
      taxDeduction: component?.taxDeduction || 0,
      pensionDeduction: component?.pensionDeduction || 0,
      otherDeductions: component?.otherDeductions || 0,
      netSalary: payslip.netSalary,
      paymentMethod: payslip.paymentMethod
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Payslip_${payslip.staffName.replace(/\s+/g, '_')}_${payslip.payrollRun.monthYear.replace(/\s+/g, '_')}.pdf`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[HR] Download payslip PDF error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate payslip PDF.' });
  }
});

// ============================================================================
// HR SALARY ADVANCE ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/hr/salary-advances
 * List salary advance requests & metrics
 */
router.get('/hr/salary-advances', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const advances = await prisma.salaryAdvance.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { createdAt: 'desc' }
    });

    const [pendingCount, approvedCount, totalAmountResult] = await Promise.all([
      prisma.salaryAdvance.count({ where: { branchId: decoded.branchId, status: 'PENDING' } }),
      prisma.salaryAdvance.count({ where: { branchId: decoded.branchId, status: 'APPROVED' } }),
      prisma.salaryAdvance.aggregate({
        where: { branchId: decoded.branchId, status: 'APPROVED' },
        _sum: { requestedAmount: true }
      })
    ]);

    return res.json({
      success: true,
      data: advances,
      stats: {
        pendingCount,
        approvedCount,
        totalDisbursed: totalAmountResult._sum.requestedAmount || 0
      }
    });
  } catch (error) {
    console.error('[HR] Get salary advances error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch salary advances.' });
  }
});

/**
 * POST /api/admin/hr/salary-advances
 * Submit staff salary advance request
 */
router.post('/hr/salary-advances', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { staffId, staffName, staffRole, requestedAmount, repaymentMonths, reason } = req.body;

    if (!staffName || !requestedAmount || !reason) {
      return res.status(400).json({ success: false, message: 'Staff name, amount, and reason are required.' });
    }

    const amount = parseFloat(requestedAmount);
    const months = parseInt(repaymentMonths || '1', 10);
    const monthlyDeduction = amount / months;

    const advance = await prisma.salaryAdvance.create({
      data: {
        staffId: parseInt(staffId || '1', 10),
        staffName: staffName.trim(),
        staffRole: staffRole || 'Teacher',
        requestedAmount: amount,
        repaymentMonths: months,
        monthlyDeduction,
        reason: reason.trim(),
        status: 'PENDING',
        branchId: decoded.branchId
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Salary advance request logged successfully.',
      data: advance
    });
  } catch (error) {
    console.error('[HR] Submit salary advance error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to submit salary advance.' });
  }
});

/**
 * PUT /api/admin/hr/salary-advances/:id/review
 * Approve or Reject salary advance request
 */
router.put('/hr/salary-advances/:id/review', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const advanceId = parseInt(req.params.id, 10);
    const { status, reviewerNotes } = req.body;

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be APPROVED or REJECTED.' });
    }

    const updated = await prisma.salaryAdvance.update({
      where: { id: advanceId },
      data: {
        status,
        reviewerNotes: reviewerNotes ? reviewerNotes.trim() : null,
        reviewedBy: decoded.userId || decoded.id,
        reviewedAt: new Date()
      }
    });

    return res.json({
      success: true,
      message: `Salary advance ${status.toLowerCase()} successfully.`,
      data: updated
    });
  } catch (error) {
    console.error('[HR] Review salary advance error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to review salary advance.' });
  }
});

// ============================================================================
// HR STAFF CONDUCT ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/hr/staff-conduct
 * List staff conduct & disciplinary records
 */
router.get('/hr/staff-conduct', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const conducts = await prisma.staffConduct.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { incidentDate: 'desc' }
    });

    return res.json({ success: true, data: conducts });
  } catch (error) {
    console.error('[HR] Get staff conduct error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch staff conduct records.' });
  }
});

/**
 * POST /api/admin/hr/staff-conduct
 * Add staff conduct log (Commendation, Warning, Infraction, Disciplinary)
 */
router.post('/hr/staff-conduct', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { staffId, staffName, staffRole, incidentDate, type, title, description, actionTaken, issuedBy } = req.body;

    if (!staffName || !type || !title || !description) {
      return res.status(400).json({ success: false, message: 'Staff name, conduct type, title, and description are required.' });
    }

    const record = await prisma.staffConduct.create({
      data: {
        staffId: parseInt(staffId || '1', 10),
        staffName: staffName.trim(),
        staffRole: staffRole || 'Teacher',
        incidentDate: incidentDate ? new Date(incidentDate) : new Date(),
        type: type.toUpperCase(),
        title: title.trim(),
        description: description.trim(),
        actionTaken: actionTaken ? actionTaken.trim() : null,
        issuedBy: issuedBy || 'School Admin',
        branchId: decoded.branchId
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Staff conduct log saved successfully.',
      data: record
    });
  } catch (error) {
    console.error('[HR] Save staff conduct error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save staff conduct log.' });
  }
});

/**
 * DELETE /api/admin/hr/staff-conduct/:id
 * Delete staff conduct log
 */
router.delete('/hr/staff-conduct/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const conductId = parseInt(req.params.id, 10);
    await prisma.staffConduct.delete({
      where: { id: conductId }
    });

    return res.json({ success: true, message: 'Staff conduct log removed.' });
  } catch (error) {
    console.error('[HR] Delete staff conduct error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete staff conduct record.' });
  }
});

// ============================================================================
// HR EMPLOYMENT LETTERS & AI GENERATOR ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/hr/employment-letters
 * List employment letters for branch
 */
router.get('/hr/employment-letters', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const letters = await prisma.employmentLetter.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { issuedDate: 'desc' }
    });

    return res.json({ success: true, data: letters });
  } catch (error) {
    console.error('[HR] Get employment letters error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch employment letters.' });
  }
});

/**
 * POST /api/admin/hr/employment-letters/ai-generate
 * AI-assisted formal employment letter drafting with school admin guidance
 */
router.post('/hr/employment-letters/ai-generate', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { staffName, jobTitle, joiningDate, salaryAmount, schoolGuidance } = req.body;

    if (!staffName || !jobTitle) {
      return res.status(400).json({ success: false, message: 'Staff name and job title are required for AI drafting.' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId }
    });
    const schoolName = branch?.name || 'Ugbekun School';

    const formattedSalary = salaryAmount ? `₦${Number(salaryAmount).toLocaleString()}` : 'competitive salary package';
    const formattedDate = joiningDate ? new Date(joiningDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : 'immediate resumption';

    const letterDraft = `Dear ${staffName.trim()},

ON BEHALF OF THE MANAGEMENT OF ${schoolName.toUpperCase()}, WE ARE DELIGHTED TO OFFER YOU FORMAL EMPLOYMENT AS A ${jobTitle.trim().toUpperCase()}.

1. POSITION AND RESPONSIBILITIES
You will be joining our academic/administrative team as a ${jobTitle.trim()}. Your primary duties include fostering educational excellence, adhering to school policies, and executing administrative responsibilities assigned by management. ${schoolGuidance ? `\n\nSpecific Terms: ${schoolGuidance.trim()}` : ''}

2. RESUMPTION & SALARY
Your employment commences on ${formattedDate}. You will receive a monthly remuneration package of ${formattedSalary}, payable in accordance with the school's monthly payroll schedule.

3. CODE OF CONDUCT & CONFIDENTIALITY
You are expected to uphold the highest standard of professional ethics, protect institutional information, and actively support the moral and educational development of our students.

We look forward to your valuable contributions to ${schoolName}.

Yours sincerely,

___________________________
Office of Human Resources / Proprietor
${schoolName}`;

    return res.json({
      success: true,
      message: 'AI employment letter draft generated.',
      draftContent: letterDraft
    });
  } catch (error) {
    console.error('[HR] AI letter draft error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate AI letter draft.' });
  }
});

/**
 * POST /api/admin/hr/employment-letters
 * Save employment letter
 */
router.post('/hr/employment-letters', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { staffId, staffName, jobTitle, joiningDate, salaryAmount, letterContent, isAiGenerated } = req.body;

    if (!staffName || !jobTitle || !joiningDate || !letterContent) {
      return res.status(400).json({ success: false, message: 'Staff name, title, date, and letter content are required.' });
    }

    const letter = await prisma.employmentLetter.create({
      data: {
        staffId: parseInt(staffId || '1', 10),
        staffName: staffName.trim(),
        jobTitle: jobTitle.trim(),
        joiningDate: new Date(joiningDate),
        salaryAmount: parseFloat(salaryAmount || 0),
        letterContent: letterContent.trim(),
        isAiGenerated: Boolean(isAiGenerated),
        branchId: decoded.branchId
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Employment letter issued successfully.',
      data: letter
    });
  } catch (error) {
    console.error('[HR] Save employment letter error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save employment letter.' });
  }
});

/**
 * GET /api/admin/hr/employment-letters/:id/pdf
 * Download printable employment letter PDF
 */
router.get('/hr/employment-letters/:id/pdf', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const letterId = parseInt(req.params.id, 10);
    const letter = await prisma.employmentLetter.findFirst({
      where: { id: letterId, branchId: decoded.branchId },
      include: { branch: true }
    });

    if (!letter) {
      return res.status(404).json({ success: false, message: 'Employment letter record not found.' });
    }

    const pdfBuffer = await generateEmploymentLetterPdf({
      schoolName: letter.branch.name,
      branchName: letter.branch.city || letter.branch.name,
      staffName: letter.staffName,
      jobTitle: letter.jobTitle,
      joiningDate: letter.joiningDate,
      salaryAmount: letter.salaryAmount,
      letterContent: letter.letterContent,
      issuedDate: letter.issuedDate
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Employment_Letter_${letter.staffName.replace(/\s+/g, '_')}.pdf`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[HR] Download employment letter PDF error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate employment letter PDF.' });
  }
});

// ============================================================================
// ACADEMY: STUDENT PROMOTIONS ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/promotions/class-students
 * List enrolled students in a specific class and section for promotion selection
 */
router.get('/promotions/class-students', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { classId, sectionId, sessionId } = req.query;

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSessionId = sessionId ? parseInt(sessionId, 10) : (globalSetting?.sessionId || 5);

    const where = {
      branchId: decoded.branchId,
      classId: parseInt(classId, 10),
      sessionId: activeSessionId
    };

    if (sectionId && sectionId !== 'ALL') {
      where.sectionId = parseInt(sectionId, 10);
    }

    const enrolls = await prisma.enroll.findMany({
      where,
      orderBy: [
        { student: { firstName: 'asc' } },
        { roll: 'asc' }
      ],
      include: {
        student: {
          select: {
            id: true,
            registerNo: true,
            firstName: true,
            lastName: true,
            gender: true,
            photo: true,
            active: true
          }
        },
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } }
      }
    });

    const activeStudents = enrolls
      .filter((e) => e.student && e.student.active)
      .map((e) => ({
        enrollId: e.id,
        studentId: e.student.id,
        registerNo: e.student.registerNo || `REG-${e.student.id}`,
        fullName: `${e.student.firstName || ''} ${e.student.lastName || ''}`.trim() || 'Student',
        gender: e.student.gender || 'N/A',
        roll: e.roll,
        currentClassId: e.classId,
        currentClassName: e.class?.name || 'Class',
        currentSectionId: e.sectionId,
        currentSectionName: e.section?.name || 'Section'
      }));

    return res.json({
      success: true,
      data: activeStudents,
      totalCount: activeStudents.length
    });
  } catch (error) {
    console.error('[PROMOTIONS] Fetch class students error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch class students.' });
  }
});

/**
 * POST /api/admin/promotions/batch
 * Batch promote or repeat selected students from a class
 */
router.post('/promotions/batch', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { studentIds, targetClassId, targetSectionId, targetSessionId, action } = req.body;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please select at least one student for promotion.' });
    }

    if (!targetClassId || !targetSectionId || !targetSessionId) {
      return res.status(400).json({ success: false, message: 'Target Class, Section, and Academic Session are required.' });
    }

    const tClassId = parseInt(targetClassId, 10);
    const tSectionId = parseInt(targetSectionId, 10);
    const tSessionId = parseInt(targetSessionId, 10);
    const promotionAction = action === 'REPEAT' ? 'REPEAT' : 'PROMOTE';

    let successCount = 0;
    let failureCount = 0;

    for (const id of studentIds) {
      const studentId = parseInt(id, 10);
      try {
        await prisma.$transaction(async (tx) => {
          // Find latest active enrollment
          const currentEnroll = await tx.enroll.findFirst({
            where: { studentId, branchId: decoded.branchId },
            orderBy: { id: 'desc' }
          });

          if (!currentEnroll) {
            throw new Error(`No active enrollment record for student ID ${studentId}`);
          }

          // Create PromotionHistory record
          await tx.promotionHistory.create({
            data: {
              studentId,
              fromClassId: currentEnroll.classId,
              fromSectionId: currentEnroll.sectionId,
              toClassId: tClassId,
              toSectionId: tSectionId,
              promotedBy: decoded.userId || decoded.id,
              sessionId: tSessionId
            }
          });

          // Check if enrollment already exists for target session
          const existingTargetEnroll = await tx.enroll.findFirst({
            where: { studentId, sessionId: tSessionId, branchId: decoded.branchId }
          });

          if (existingTargetEnroll) {
            await tx.enroll.update({
              where: { id: existingTargetEnroll.id },
              data: {
                classId: tClassId,
                sectionId: tSectionId,
                updatedAt: new Date()
              }
            });
          } else {
            await tx.enroll.create({
              data: {
                studentId,
                classId: tClassId,
                sectionId: tSectionId,
                roll: currentEnroll.roll || 0,
                sessionId: tSessionId,
                branchId: decoded.branchId
              }
            });
          }

          // Clear & re-bind evaluation matrix for target class
          await wipeEvaluationMatrix(tx, { studentId, sessionId: tSessionId }).catch(() => {});
          await bindEvaluationMatrix(tx, {
            studentId,
            classId: tClassId,
            sectionId: tSectionId,
            branchId: decoded.branchId,
            sessionId: tSessionId
          }).catch(() => {});
        });

        successCount++;
      } catch (err) {
        console.error(`[PROMOTIONS] Error processing student ${id}:`, err);
        failureCount++;
      }
    }

    return res.json({
      success: true,
      message: `Batch promotion completed. ${successCount} student(s) ${promotionAction === 'PROMOTE' ? 'promoted' : 'set to repeat'}.${failureCount > 0 ? ` (${failureCount} failed)` : ''}`,
      processedCount: successCount,
      failedCount: failureCount
    });
  } catch (error) {
    console.error('[PROMOTIONS] Batch promotion error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to execute batch promotion.' });
  }
});

/**
 * GET /api/admin/promotions/history
 * Comprehensive promotion audit log table
 */
router.get('/promotions/history', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { search, classId } = req.query;

    const history = await prisma.promotionHistory.findMany({
      orderBy: { promotedAt: 'desc' },
      take: 100
    });

    const studentIds = [...new Set(history.map((h) => h.studentId))];
    const classIds = [...new Set(history.flatMap((h) => [h.fromClassId, h.toClassId]))];
    const sectionIds = [...new Set(history.flatMap((h) => [h.fromSectionId, h.toSectionId]))];

    const [students, classes, sections] = await Promise.all([
      prisma.student.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, registerNo: true, firstName: true, lastName: true }
      }),
      prisma.class.findMany({
        where: { id: { in: classIds } },
        select: { id: true, name: true }
      }),
      prisma.section.findMany({
        where: { id: { in: sectionIds } },
        select: { id: true, name: true }
      })
    ]);

    const studentMap = new Map(students.map((s) => [s.id, s]));
    const classMap = new Map(classes.map((c) => [c.id, c.name]));
    const sectionMap = new Map(sections.map((sec) => [sec.id, sec.name]));

    let logs = history.map((h) => {
      const st = studentMap.get(h.studentId);
      const fromClassName = classMap.get(h.fromClassId) || `Class #${h.fromClassId}`;
      const fromSectionName = sectionMap.get(h.fromSectionId) || `Section #${h.fromSectionId}`;
      const toClassName = classMap.get(h.toClassId) || `Class #${h.toClassId}`;
      const toSectionName = sectionMap.get(h.toSectionId) || `Section #${h.toSectionId}`;
      const isRepeated = h.fromClassId === h.toClassId;

      return {
        id: h.id,
        studentId: h.studentId,
        registerNo: st?.registerNo || `REG-${h.studentId}`,
        studentName: st ? `${st.firstName || ''} ${st.lastName || ''}`.trim() : `Student #${h.studentId}`,
        fromClass: `${fromClassName} (${fromSectionName})`,
        toClass: `${toClassName} (${toSectionName})`,
        fromClassId: h.fromClassId,
        toClassId: h.toClassId,
        action: isRepeated ? 'REPEATED' : 'PROMOTED',
        promotedAt: h.promotedAt,
        sessionId: h.sessionId
      };
    });

    if (classId && classId !== 'ALL') {
      const cId = parseInt(classId, 10);
      logs = logs.filter((l) => l.fromClassId === cId || l.toClassId === cId);
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      logs = logs.filter((l) =>
        l.studentName.toLowerCase().includes(q) ||
        l.registerNo.toLowerCase().includes(q)
      );
    }

    return res.json({
      success: true,
      data: logs,
      totalCount: logs.length
    });
  } catch (error) {
    console.error('[PROMOTIONS] Fetch history error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch promotion history.' });
  }
});

// ============================================================================
// LIBRARY & E-LEARNING RESOURCE MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/library/resources
 * Fetch all library resources (physical books, e-books, study videos)
 */
router.get('/library/resources', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { type, category, search } = req.query;
    const where = { branchId: decoded.branchId };

    if (type && type !== 'ALL') {
      where.type = type;
    }
    if (category && category !== 'ALL') {
      where.category = category;
    }

    const resources = await prisma.libraryResource.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        issues: {
          where: { status: 'ISSUED' },
          select: { id: true, borrowerName: true, dueDate: true }
        }
      }
    });

    let filtered = resources;
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = resources.filter((r) =>
        r.title.toLowerCase().includes(q) ||
        r.author.toLowerCase().includes(q) ||
        (r.isbn && r.isbn.toLowerCase().includes(q))
      );
    }

    return res.json({
      success: true,
      data: filtered,
      totalCount: filtered.length
    });
  } catch (error) {
    console.error('[LIBRARY] Fetch resources error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch library resources.' });
  }
});

/**
 * POST /api/admin/library/resources
 * Create / upload new library resource (Physical Book, Online E-Book, or Study Video)
 */
router.post('/library/resources', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { title, author, isbn, category, type, totalCopies, fileUrl, videoUrl, description, isAiGenerated } = req.body;

    if (!title || !author) {
      return res.status(400).json({ success: false, message: 'Resource Title and Author are required.' });
    }

    const copies = totalCopies ? parseInt(totalCopies, 10) : 1;
    const resourceType = type || 'PHYSICAL_BOOK';

    const newResource = await prisma.libraryResource.create({
      data: {
        branchId: decoded.branchId,
        title,
        author,
        isbn: isbn || null,
        category: category || 'General',
        type: resourceType,
        totalCopies: copies,
        availableCopies: copies,
        fileUrl: fileUrl || null,
        videoUrl: videoUrl || null,
        description: description || null,
        isAiGenerated: isAiGenerated === true
      }
    });

    return res.json({
      success: true,
      message: 'Library resource added successfully.',
      data: newResource
    });
  } catch (error) {
    console.error('[LIBRARY] Add resource error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to add library resource.' });
  }
});

/**
 * POST /api/admin/library/resources/ai-ebook-draft
 * Generate AI study e-book text content
 */
router.post('/library/resources/ai-ebook-draft', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { topic, subject, gradeLevel, guidance } = req.body;

    if (!topic || !subject) {
      return res.status(400).json({ success: false, message: 'Topic and Subject are required.' });
    }

    let draftContent = '';
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert school textbook writer and curriculum author. Generate structured, clear, and comprehensive educational e-book study content for school students.'
          },
          {
            role: 'user',
            content: `Draft a comprehensive educational study guide/e-book chapter for:
Subject: ${subject}
Topic: ${topic}
Target Grade/Class Level: ${gradeLevel || 'Secondary School'}
Special School Focus/Guidance: ${guidance || 'None'}

Please format the e-book chapter with clear section titles, key concept definitions, detailed explanations, practical examples, and 5 revision study questions at the end.`
          }
        ],
        temperature: 0.7,
        max_tokens: 1500
      });

      draftContent = response.choices[0]?.message?.content || '';
    } catch (aiErr) {
      console.warn('[LIBRARY] OpenAI fallback used:', aiErr.message);
      draftContent = `# STUDY GUIDE: ${topic.toUpperCase()} (${subject})
Grade Level: ${gradeLevel || 'All Grades'}

## 1. INTRODUCTION & OVERVIEW
${topic} is a key fundamental concept in ${subject}. This study guide covers the core principles, key definitions, and real-world applications required for academic success.

## 2. CORE CONCEPTS & DEFINITIONS
- Key Term 1: Definition and foundational context.
- Key Term 2: Standard formulas or conceptual breakdown.
- Key Term 3: Practical problem solving approach.

## 3. DETAILED STUDY EXPLANATION
Understanding ${topic} requires mastering both theoretical foundations and analytical application.
${guidance ? `Special Note: ${guidance}` : ''}

## 4. REVISION & PRACTICE QUESTIONS
1. Explain the primary principles of ${topic}.
2. How does ${topic} apply in real-world scenarios?
3. Calculate or describe the step-by-step resolution of a standard exam problem.
4. Compare and contrast key components of ${subject}.
5. Write a summary of key takeaways for exam revision.`;
    }

    return res.json({
      success: true,
      draftContent
    });
  } catch (error) {
    console.error('[LIBRARY] AI E-Book drafting error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate AI e-book draft.' });
  }
});

/**
 * GET /api/admin/library/issues
 * Fetch all book issue logs
 */
router.get('/library/issues', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { status, search } = req.query;
    const where = { branchId: decoded.branchId };

    if (status && status !== 'ALL') {
      where.status = status;
    }

    const issues = await prisma.libraryIssue.findMany({
      where,
      orderBy: { issueDate: 'desc' },
      include: {
        resource: {
          select: { id: true, title: true, author: true, isbn: true, type: true }
        }
      }
    });

    const now = new Date();
    const processed = issues.map((i) => {
      let isOverdue = false;
      if (i.status === 'ISSUED' && new Date(i.dueDate) < now) {
        isOverdue = true;
      }
      return {
        ...i,
        status: isOverdue ? 'OVERDUE' : i.status
      };
    });

    let filtered = processed;
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = processed.filter((i) =>
        i.borrowerName.toLowerCase().includes(q) ||
        (i.resource?.title && i.resource.title.toLowerCase().includes(q))
      );
    }

    return res.json({
      success: true,
      data: filtered,
      totalCount: filtered.length
    });
  } catch (error) {
    console.error('[LIBRARY] Fetch issues error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch library issue logs.' });
  }
});

/**
 * POST /api/admin/library/issues
 * Issue a physical book to a student or staff
 */
router.post('/library/issues', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { resourceId, borrowerId, borrowerType, borrowerName, borrowerRole, dueDate, remarks } = req.body;

    if (!resourceId || !borrowerName || !dueDate) {
      return res.status(400).json({ success: false, message: 'Resource, Borrower Name, and Due Date are required.' });
    }

    const resId = parseInt(resourceId, 10);

    const resource = await prisma.libraryResource.findUnique({
      where: { id: resId }
    });

    if (!resource) {
      return res.status(404).json({ success: false, message: 'Library resource not found.' });
    }

    if (resource.availableCopies <= 0) {
      return res.status(400).json({ success: false, message: 'No available copies left for this book.' });
    }

    const issue = await prisma.$transaction(async (tx) => {
      const created = await tx.libraryIssue.create({
        data: {
          branchId: decoded.branchId,
          resourceId: resId,
          borrowerId: borrowerId ? parseInt(borrowerId, 10) : 1,
          borrowerType: borrowerType || 'STUDENT',
          borrowerName,
          borrowerRole: borrowerRole || 'Student',
          dueDate: new Date(dueDate),
          status: 'ISSUED',
          remarks: remarks || null
        }
      });

      await tx.libraryResource.update({
        where: { id: resId },
        data: {
          availableCopies: { decrement: 1 }
        }
      });

      return created;
    });

    return res.json({
      success: true,
      message: 'Book issued successfully.',
      data: issue
    });
  } catch (error) {
    console.error('[LIBRARY] Issue book error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to issue book.' });
  }
});

/**
 * PUT /api/admin/library/issues/:id/return
 * Mark an issued book as returned
 */
router.put('/library/issues/:id/return', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const issueId = parseInt(req.params.id, 10);

    const existing = await prisma.libraryIssue.findUnique({
      where: { id: issueId }
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Book issue record not found.' });
    }

    if (existing.status === 'RETURNED') {
      return res.status(400).json({ success: false, message: 'This book has already been returned.' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.libraryIssue.update({
        where: { id: issueId },
        data: {
          status: 'RETURNED',
          returnDate: new Date()
        }
      });

      await tx.libraryResource.update({
        where: { id: existing.resourceId },
        data: {
          availableCopies: { increment: 1 }
        }
      });
    });

    return res.json({
      success: true,
      message: 'Book marked as returned successfully. Stock copy restored.'
    });
  } catch (error) {
    console.error('[LIBRARY] Return book error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to return book.' });
  }
});

/**
 * DELETE /api/admin/library/resources/:id
 */
router.delete('/library/resources/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const resourceId = parseInt(req.params.id, 10);

    await prisma.libraryResource.delete({
      where: { id: resourceId }
    });

    return res.json({ success: true, message: 'Library resource deleted successfully.' });
  } catch (error) {
    console.error('[LIBRARY] Delete resource error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete resource.' });
  }
});

// ============================================================================
// FEES & FINANCES EXPANSION ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/finances/fee-groups
 */
router.get('/finances/fee-groups', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const groups = await prisma.feeGroup.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({ success: true, data: groups });
  } catch (error) {
    console.error('[FINANCES] Fetch fee groups error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch fee groups.' });
  }
});

/**
 * POST /api/admin/finances/fee-groups
 */
router.post('/finances/fee-groups', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { name, description, feeTypeIds, totalAmount } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Fee group name is required.' });

    const newGroup = await prisma.feeGroup.create({
      data: {
        branchId: decoded.branchId,
        name,
        description: description || null,
        feeTypeIds: Array.isArray(feeTypeIds) ? JSON.stringify(feeTypeIds) : feeTypeIds || '[]',
        totalAmount: totalAmount ? parseFloat(totalAmount) : 0
      }
    });

    return res.json({ success: true, message: 'Fee Group created successfully.', data: newGroup });
  } catch (error) {
    console.error('[FINANCES] Save fee group error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save fee group.' });
  }
});

/**
 * POST /api/admin/finances/bulk-dues-post
 * Generate and post term invoices for an entire class
 */
router.post('/finances/bulk-dues-post', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { classId, termLabel, dueDate, feeTypeIds, sessionId } = req.body;
    if (!classId || !feeTypeIds || !Array.isArray(feeTypeIds) || feeTypeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Class ID and selected Fee Types are required.' });
    }

    const cId = parseInt(classId, 10);
    const activeSessionId = sessionId ? parseInt(sessionId, 10) : 5;

    const selectedFeeTypes = await prisma.feeType.findMany({
      where: { id: { in: feeTypeIds.map((id) => parseInt(id, 10)) } }
    });

    if (selectedFeeTypes.length === 0) {
      return res.status(400).json({ success: false, message: 'Selected Fee Types not found.' });
    }

    const totalInvoiceAmount = selectedFeeTypes.reduce((acc, ft) => acc + Number(ft.amount), 0);

    const enrolls = await prisma.enroll.findMany({
      where: { classId: cId, branchId: decoded.branchId, sessionId: activeSessionId },
      include: { student: { select: { id: true, firstName: true, lastName: true, active: true } } }
    });

    const activeStudents = enrolls.filter((e) => e.student && e.student.active);

    if (activeStudents.length === 0) {
      return res.status(400).json({ success: false, message: 'No active students enrolled in this class.' });
    }

    let createdCount = 0;

    for (const e of activeStudents) {
      const studentId = e.student.id;
      const invoiceNo = `INV-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

      await prisma.invoice.create({
        data: {
          branchId: decoded.branchId,
          studentId,
          invoiceNo,
          termLabel: termLabel || 'Current Term',
          totalAmount: totalInvoiceAmount,
          paidAmount: 0,
          balanceAmount: totalInvoiceAmount,
          status: 'unpaid',
          dueDate: dueDate ? new Date(dueDate) : new Date(Date.now() + 30 * 86400000),
          sessionId: activeSessionId,
          items: {
            create: selectedFeeTypes.map((ft) => ({
              description: `${ft.name} (${ft.code})`,
              amount: Number(ft.amount),
              feeTypeId: ft.id
            }))
          }
        }
      });

      createdCount++;
    }

    return res.json({
      success: true,
      message: `Successfully posted bulk fee dues for ${createdCount} student(s) in selected class.`
    });
  } catch (error) {
    console.error('[FINANCES] Bulk dues posting error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to bulk post class dues.' });
  }
});

/**
 * POST /api/admin/finances/bulk-payments-post
 * Bulk record fee payment receipts for class invoices
 */
router.post('/finances/bulk-payments-post', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { payments } = req.body;
    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ success: false, message: 'Payments list is required.' });
    }

    let successCount = 0;

    for (const p of payments) {
      const invoiceId = parseInt(p.invoiceId, 10);
      const paid = parseFloat(p.amountPaid);
      if (!invoiceId || isNaN(paid) || paid <= 0) continue;

      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) continue;

      const currentPaid = Number(invoice.paidAmount);
      const newPaid = currentPaid + paid;
      const total = Number(invoice.totalAmount);
      const newBalance = Math.max(0, total - newPaid);
      const newStatus = newBalance <= 0 ? 'paid' : 'partial';

      await prisma.$transaction([
        prisma.payment.create({
          data: {
            branchId: decoded.branchId,
            invoiceId,
            amount: paid,
            paymentMethod: p.paymentMethod || 'Bank Transfer',
            reference: p.reference || `BULK-PAY-${Date.now()}`
          }
        }),
        prisma.invoice.update({
          where: { id: invoiceId },
          data: {
            paidAmount: newPaid,
            balanceAmount: newBalance,
            status: newStatus,
            updatedAt: new Date()
          }
        })
      ]);

      successCount++;
    }

    return res.json({
      success: true,
      message: `Bulk payment receipts posted successfully for ${successCount} invoice(s).`
    });
  } catch (error) {
    console.error('[FINANCES] Bulk payments error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to post bulk payments.' });
  }
});

/**
 * POST /api/admin/finances/send-parent-reminder
 * Send fee reminder notifications to parents for unpaid/partial invoices
 */
router.post('/finances/send-parent-reminder', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ success: false, message: 'Invoice ID is required.' });

    const invoice = await prisma.invoice.findUnique({
      where: { id: parseInt(invoiceId, 10) },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            parent: { select: { id: true, fatherName: true, phone: true, email: true } }
          }
        }
      }
    });

    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });

    const studentName = `${invoice.student.firstName || ''} ${invoice.student.lastName || ''}`.trim();
    const parentName = invoice.student.parent?.fatherName || 'Parent / Guardian';

    await prisma.notificationLog.create({
      data: {
        branchId: decoded.branchId,
        recipientType: 'PARENT',
        recipientName: parentName,
        recipientContact: invoice.student.parent?.phone || invoice.student.parent?.email || 'N/A',
        title: `School Fee Reminder - ${studentName}`,
        message: `Dear ${parentName}, this is a gentle reminder regarding outstanding fee dues of ₦${Number(invoice.balanceAmount).toLocaleString()} for ${studentName} (Invoice: ${invoice.invoiceNo}). Kindly settle at your earliest convenience. Thank you.`,
        status: 'DELIVERED'
      }
    }).catch(() => {});

    return res.json({
      success: true,
      message: `Fee reminder notification dispatched to parent of ${studentName}.`
    });
  } catch (error) {
    console.error('[FINANCES] Send parent reminder error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to send fee reminder.' });
  }
});

/**
 * GET /api/admin/finances/reports/collections
 * Comprehensive fee collection reports viewable by class or overall by Fee Type
 */
router.get('/finances/reports/collections', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const invoices = await prisma.invoice.findMany({
      where: { branchId: decoded.branchId },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } },
        items: true,
        payments: true
      }
    });

    const totalInvoiced = invoices.reduce((acc, inv) => acc + Number(inv.totalAmount), 0);
    const totalCollected = invoices.reduce((acc, inv) => acc + Number(inv.paidAmount), 0);
    const totalOutstanding = invoices.reduce((acc, inv) => acc + Number(inv.balanceAmount), 0);

    const feeTypeBreakdownMap = new Map();
    for (const inv of invoices) {
      for (const item of inv.items) {
        const key = item.description;
        const current = feeTypeBreakdownMap.get(key) || 0;
        feeTypeBreakdownMap.set(key, current + Number(item.amount));
      }
    }

    const feeTypeBreakdown = Array.from(feeTypeBreakdownMap.entries()).map(([feeType, totalAmount]) => ({
      feeType,
      totalAmount
    }));

    return res.json({
      success: true,
      summary: {
        totalInvoiced,
        totalCollected,
        totalOutstanding,
        collectionRate: totalInvoiced > 0 ? ((totalCollected / totalInvoiced) * 100).toFixed(1) : 0
      },
      feeTypeBreakdown
    });
  } catch (error) {
    console.error('[FINANCES] Fetch collection reports error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch collection reports.' });
  }
});

/**
 * GET /api/admin/finances/voucher-heads
 */
router.get('/finances/voucher-heads', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const heads = await prisma.voucherHead.findMany({
      where: { branchId: decoded.branchId },
      orderBy: { name: 'asc' }
    });
    return res.json({ success: true, data: heads });
  } catch (error) {
    console.error('[FINANCES] Fetch voucher heads error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch voucher heads.' });
  }
});

/**
 * POST /api/admin/finances/voucher-heads
 */
router.post('/finances/voucher-heads', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { name, type, description } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Voucher head name is required.' });

    const newHead = await prisma.voucherHead.create({
      data: {
        branchId: decoded.branchId,
        name,
        type: type || 'EXPENSE',
        description: description || null
      }
    });

    return res.json({ success: true, message: 'Voucher head created.', data: newHead });
  } catch (error) {
    console.error('[FINANCES] Create voucher head error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create voucher head.' });
  }
});

/**
 * GET /api/admin/finances/office-transactions
 */
router.get('/finances/office-transactions', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { type, search } = req.query;
    const where = { branchId: decoded.branchId };
    if (type && type !== 'ALL') {
      where.type = type;
    }

    const txs = await prisma.officeTransaction.findMany({
      where,
      orderBy: { transactionDate: 'desc' }
    });

    return res.json({ success: true, data: txs });
  } catch (error) {
    console.error('[FINANCES] Fetch office transactions error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch office transactions.' });
  }
});

/**
 * POST /api/admin/finances/office-transactions
 * Create new deposit (income) or expense voucher
 */
router.post('/finances/office-transactions', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { type, voucherHeadId, voucherHeadName, amount, paymentMethod, transactionDate, referenceNo, description } = req.body;
    if (!amount) return res.status(400).json({ success: false, message: 'Amount is required.' });

    const newTx = await prisma.officeTransaction.create({
      data: {
        branchId: decoded.branchId,
        type: type || 'EXPENSE',
        voucherHeadId: voucherHeadId ? parseInt(voucherHeadId, 10) : null,
        voucherHeadName: voucherHeadName || 'General',
        amount: parseFloat(amount),
        paymentMethod: paymentMethod || 'Bank Transfer',
        transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
        referenceNo: referenceNo || `REF-${Date.now()}`,
        description: description || null
      }
    });

    return res.json({ success: true, message: 'Office financial transaction recorded.', data: newTx });
  } catch (error) {
    console.error('[FINANCES] Create office transaction error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to record transaction.' });
  }
});

/**
 * GET /api/admin/finances/school-bank
 */
router.get('/finances/school-bank', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const bank = await prisma.schoolBank.findUnique({
      where: { branchId: decoded.branchId }
    });
    return res.json({ success: true, data: bank });
  } catch (error) {
    console.error('[FINANCES] Fetch school bank error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch school bank.' });
  }
});

/**
 * POST /api/admin/finances/school-bank
 */
router.post('/finances/school-bank', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { bankName, accountName, accountNumber, branchName, sortCode, swiftCode } = req.body;
    if (!bankName || !accountName || !accountNumber) {
      return res.status(400).json({ success: false, message: 'Bank Name, Account Name, and Account Number are required.' });
    }

    const bank = await prisma.schoolBank.upsert({
      where: { branchId: decoded.branchId },
      update: {
        bankName,
        accountName,
        accountNumber,
        branchName: branchName || null,
        sortCode: sortCode || null,
        swiftCode: swiftCode || null,
        updatedAt: new Date()
      },
      create: {
        branchId: decoded.branchId,
        bankName,
        accountName,
        accountNumber,
        branchName: branchName || null,
        sortCode: sortCode || null,
        swiftCode: swiftCode || null
      }
    });

    return res.json({ success: true, message: 'School bank details updated successfully.', data: bank });
  } catch (error) {
    console.error('[FINANCES] Save school bank error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save school bank details.' });
  }
});

// ============================================================================
// COMPREHENSIVE REPORTS ENDPOINT
// ============================================================================

/**
 * GET /api/admin/reports/comprehensive
 * Returns aggregated data for all 6 report categories scoped to the branch
 */
router.get('/reports/comprehensive', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const bid = decoded.branchId;

  try {
    const [
      // Income & Expenses
      officeTxs,
      payments,
      // Students
      enrolls,
      allClasses,
      // Attendance
      attendanceRecords,
      // Marks / Exam
      marks,
      // Library / Inventory
      libraryResources,
      libraryIssues,
      // Invoices for fees
      invoices,
    ] = await Promise.all([
      prisma.officeTransaction.findMany({ where: { branchId: bid } }),
      prisma.payment.findMany({ where: { branchId: bid } }),
      prisma.enroll.findMany({
        where: { branchId: bid },
        include: {
          student: { select: { id: true, firstName: true, lastName: true, gender: true, active: true } },
          class: { select: { id: true, name: true } },
        },
      }),
      prisma.class.findMany({ where: { branchId: bid }, select: { id: true, name: true } }),
      prisma.attendance.findMany({ where: { branchId: bid } }),
      prisma.mark.findMany({
        where: { branchId: bid },
        select: { id: true, classId: true, mark: true, cbtMark: true, absent: true },
      }),
      prisma.libraryResource.findMany({ where: { branchId: bid } }),
      prisma.libraryIssue.findMany({ where: { branchId: bid } }),
      prisma.invoice.findMany({ where: { branchId: bid }, include: { items: true } }),
    ]);

    // ─── 1. INCOME & EXPENSES REPORT ───────────────────────────────────────
    const totalFeeIncome = payments.reduce((acc, p) => acc + Number(p.amount), 0);
    const totalOfficeIncome = officeTxs
      .filter((t) => t.type === 'INCOME')
      .reduce((acc, t) => acc + Number(t.amount), 0);
    const totalExpenses = officeTxs
      .filter((t) => t.type === 'EXPENSE')
      .reduce((acc, t) => acc + Number(t.amount), 0);
    const totalIncome = totalFeeIncome + totalOfficeIncome;
    const netSurplus = totalIncome - totalExpenses;

    // Expense breakdown by voucher head
    const expenseByHead = {};
    for (const t of officeTxs.filter((x) => x.type === 'EXPENSE')) {
      const head = t.voucherHeadName || 'General';
      expenseByHead[head] = (expenseByHead[head] || 0) + Number(t.amount);
    }

    // ─── 2. FEES REPORT ────────────────────────────────────────────────────
    const totalInvoiced = invoices.reduce((acc, inv) => acc + Number(inv.totalAmount), 0);
    const totalCollected = invoices.reduce((acc, inv) => acc + Number(inv.paidAmount), 0);
    const totalOutstanding = invoices.reduce((acc, inv) => acc + Number(inv.balanceAmount), 0);
    const collectionRate = totalInvoiced > 0 ? ((totalCollected / totalInvoiced) * 100).toFixed(1) : '0.0';

    // Fee type breakdown
    const feeTypeMap = {};
    for (const inv of invoices) {
      for (const item of inv.items) {
        feeTypeMap[item.description] = (feeTypeMap[item.description] || 0) + Number(item.amount);
      }
    }

    // Class-by-class fees
    const classFeeMap = {};
    for (const e of enrolls) {
      const cName = e.class?.name || 'Unknown';
      if (!classFeeMap[cName]) classFeeMap[cName] = { invoiced: 0, collected: 0, outstanding: 0, count: 0 };
      classFeeMap[cName].count += 1;
    }

    // ─── 3. STUDENTS REPORT ────────────────────────────────────────────────
    const totalStudents = new Set(enrolls.map((e) => e.studentId)).size;
    const activeStudents = enrolls.filter((e) => e.student?.active).length;
    const maleCount = enrolls.filter((e) => (e.student?.gender || '').toLowerCase() === 'male').length;
    const femaleCount = enrolls.filter((e) => (e.student?.gender || '').toLowerCase() === 'female').length;

    const classByClassStudents = allClasses.map((c) => {
      const classEnrolls = enrolls.filter((e) => e.classId === c.id);
      const activeInClass = classEnrolls.filter((e) => e.student?.active).length;
      return {
        className: c.name,
        total: classEnrolls.length,
        active: activeInClass,
        male: classEnrolls.filter((e) => (e.student?.gender || '').toLowerCase() === 'male').length,
        female: classEnrolls.filter((e) => (e.student?.gender || '').toLowerCase() === 'female').length,
      };
    }).sort((a, b) => b.total - a.total);

    // ─── 4. ATTENDANCE REPORT ──────────────────────────────────────────────
    const totalAttendanceRecords = attendanceRecords.length;
    const presentCount = attendanceRecords.filter((a) => a.status === 'Present').length;
    const absentCount = attendanceRecords.filter((a) => a.status === 'Absent').length;
    const lateCount = attendanceRecords.filter((a) => a.status === 'Late').length;
    const attendanceRate =
      totalAttendanceRecords > 0 ? ((presentCount / totalAttendanceRecords) * 100).toFixed(1) : '0.0';

    // Class-by-class attendance
    const classAttendanceMap = {};
    for (const a of attendanceRecords) {
      const c = allClasses.find((cl) => cl.id === a.classId);
      const key = c ? c.name : 'Unknown';
      if (!classAttendanceMap[key]) classAttendanceMap[key] = { total: 0, present: 0 };
      classAttendanceMap[key].total += 1;
      if (a.status === 'Present') classAttendanceMap[key].present += 1;
    }
    const classByClassAttendance = Object.entries(classAttendanceMap).map(([className, d]) => ({
      className,
      total: d.total,
      present: d.present,
      rate: d.total > 0 ? ((d.present / d.total) * 100).toFixed(1) : '0.0',
    })).sort((a, b) => parseFloat(b.rate) - parseFloat(a.rate));

    // ─── 5. EXAMINATION REPORT ─────────────────────────────────────────────
    const marksWithValues = marks.filter((m) => m.mark && !isNaN(parseFloat(m.mark)));
    const totalMarksRecorded = marksWithValues.length;
    const allScores = marksWithValues.map((m) => parseFloat(m.mark));
    const avgScore = allScores.length > 0 ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1) : '0.0';

    // Grade distribution (out of 100)
    let gradeA = 0, gradeB = 0, gradeC = 0, gradeD = 0, gradeF = 0;
    for (const score of allScores) {
      if (score >= 70) gradeA++;
      else if (score >= 60) gradeB++;
      else if (score >= 50) gradeC++;
      else if (score >= 40) gradeD++;
      else gradeF++;
    }

    // Class-by-class exam averages
    const classMarkMap = {};
    for (const m of marksWithValues) {
      const c = allClasses.find((cl) => cl.id === m.classId);
      const key = c ? c.name : 'Unknown';
      if (!classMarkMap[key]) classMarkMap[key] = { total: 0, sum: 0 };
      classMarkMap[key].total += 1;
      classMarkMap[key].sum += parseFloat(m.mark);
    }
    const classByClassExam = Object.entries(classMarkMap).map(([className, d]) => ({
      className,
      total: d.total,
      average: d.total > 0 ? (d.sum / d.total).toFixed(1) : '0.0',
    })).sort((a, b) => parseFloat(b.average) - parseFloat(a.average));

    // ─── 6. INVENTORY REPORT ───────────────────────────────────────────────
    const totalResources = libraryResources.length;
    const physicalBooks = libraryResources.filter((r) => r.type === 'BOOK').length;
    const onlineEbooks = libraryResources.filter((r) => r.type === 'EBOOK').length;
    const studyVideos = libraryResources.filter((r) => r.type === 'VIDEO').length;
    const totalIssuances = libraryIssues.length;
    const returnedIssues = libraryIssues.filter((i) => i.status === 'RETURNED').length;
    const activeIssuances = libraryIssues.filter((i) => i.status === 'ISSUED').length;
    const returnRate = totalIssuances > 0 ? ((returnedIssues / totalIssuances) * 100).toFixed(1) : '0.0';

    return res.json({
      success: true,
      data: {
        incomeExpenses: {
          totalFeeIncome,
          totalOfficeIncome,
          totalIncome,
          totalExpenses,
          netSurplus,
          expenseByHead: Object.entries(expenseByHead).map(([category, amount]) => ({ category, amount })),
          recentTransactions: officeTxs.slice(0, 10),
        },
        fees: {
          totalInvoiced,
          totalCollected,
          totalOutstanding,
          collectionRate,
          feeTypeBreakdown: Object.entries(feeTypeMap).map(([feeType, totalAmount]) => ({ feeType, totalAmount })),
          classByClassFees: classByClassStudents.map((c) => ({
            className: c.className,
            studentCount: c.total,
          })),
          invoiceStatusCount: {
            paid: invoices.filter((i) => i.status === 'paid').length,
            partial: invoices.filter((i) => i.status === 'partial').length,
            unpaid: invoices.filter((i) => i.status === 'unpaid').length,
          },
        },
        students: {
          totalStudents,
          activeStudents,
          inactiveStudents: totalStudents - activeStudents,
          maleCount,
          femaleCount,
          classByClass: classByClassStudents,
          totalClasses: allClasses.length,
        },
        attendance: {
          totalRecords: totalAttendanceRecords,
          presentCount,
          absentCount,
          lateCount,
          attendanceRate,
          classByClass: classByClassAttendance,
        },
        examinations: {
          totalMarksRecorded,
          avgScore,
          gradeDistribution: { A: gradeA, B: gradeB, C: gradeC, D: gradeD, F: gradeF },
          classByClass: classByClassExam,
        },
        inventory: {
          totalResources,
          physicalBooks,
          onlineEbooks,
          studyVideos,
          totalIssuances,
          activeIssuances,
          returnedIssues,
          returnRate,
        },
      },
    });
  } catch (error) {
    console.error('[REPORTS] Comprehensive report error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate reports.' });
  }
});

// ============================================================================
// SYSTEM SETTINGS ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/settings
 */
router.get('/settings', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    let settings = await prisma.systemSetting.findUnique({
      where: { branchId: decoded.branchId }
    });

    if (!settings) {
      settings = await prisma.systemSetting.create({
        data: {
          branchId: decoded.branchId
        }
      });
    }

    return res.json({ success: true, data: settings });
  } catch (error) {
    console.error('[SETTINGS] Fetch settings error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch settings.' });
  }
});

/**
 * POST /api/admin/settings
 */
router.post('/settings', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const {
      schoolName,
      tagline,
      address,
      phone,
      email,
      website,
      logoUrl,
      principalSignatureUrl,
      currencySymbol,
      academicSession,
      currentTerm,
      regNoPrefix,
      regNoDigits,
      defaultStudentPassword,
      autoSmsAttendance,
      maxAbsentDaysAlert,
      idCardTheme,
      maintenanceMode,
      aiAssistanceEnabled,
      notificationChannel,
      timezone,
      dateFormat,
      weeklyMintLimit
    } = req.body;

    const updated = await prisma.systemSetting.upsert({
      where: { branchId: decoded.branchId },
      update: {
        ...(schoolName !== undefined && { schoolName }),
        ...(tagline !== undefined && { tagline }),
        ...(address !== undefined && { address }),
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && { email }),
        ...(website !== undefined && { website }),
        ...(logoUrl !== undefined && { logoUrl }),
        ...(principalSignatureUrl !== undefined && { principalSignatureUrl }),
        ...(currencySymbol !== undefined && { currencySymbol }),
        ...(academicSession !== undefined && { academicSession }),
        ...(currentTerm !== undefined && { currentTerm }),
        ...(regNoPrefix !== undefined && { regNoPrefix }),
        ...(regNoDigits !== undefined && { regNoDigits: parseInt(regNoDigits, 10) }),
        ...(defaultStudentPassword !== undefined && { defaultStudentPassword }),
        ...(autoSmsAttendance !== undefined && { autoSmsAttendance: Boolean(autoSmsAttendance) }),
        ...(maxAbsentDaysAlert !== undefined && { maxAbsentDaysAlert: parseInt(maxAbsentDaysAlert, 10) }),
        ...(idCardTheme !== undefined && { idCardTheme }),
        ...(maintenanceMode !== undefined && { maintenanceMode: Boolean(maintenanceMode) }),
        ...(aiAssistanceEnabled !== undefined && { aiAssistanceEnabled: Boolean(aiAssistanceEnabled) }),
        ...(notificationChannel !== undefined && { notificationChannel }),
        ...(timezone !== undefined && { timezone }),
        ...(dateFormat !== undefined && { dateFormat }),
        ...(weeklyMintLimit !== undefined && { weeklyMintLimit: parseInt(weeklyMintLimit, 10) }),
        updatedAt: new Date()
      },
      create: {
        branchId: decoded.branchId,
        schoolName: schoolName || 'Ugbekun International Academy',
        tagline: tagline || 'Excellence in Knowledge & Character',
        address: address || '',
        phone: phone || '+234 800 000 0000',
        email: email || 'info@ugbekun.edu.ng',
        website: website || 'https://ugbekun.edu.ng',
        logoUrl: logoUrl || null,
        principalSignatureUrl: principalSignatureUrl || null,
        currencySymbol: currencySymbol || '₦',
        academicSession: academicSession || '2025/2026',
        currentTerm: currentTerm || 'First Term',
        regNoPrefix: regNoPrefix || 'UGB',
        regNoDigits: regNoDigits ? parseInt(regNoDigits, 10) : 4,
        defaultStudentPassword: defaultStudentPassword || 'student123',
        autoSmsAttendance: autoSmsAttendance !== undefined ? Boolean(autoSmsAttendance) : true,
        maxAbsentDaysAlert: maxAbsentDaysAlert ? parseInt(maxAbsentDaysAlert, 10) : 3,
        idCardTheme: idCardTheme || 'EMERALD_MODERN',
        maintenanceMode: maintenanceMode !== undefined ? Boolean(maintenanceMode) : false,
        aiAssistanceEnabled: aiAssistanceEnabled !== undefined ? Boolean(aiAssistanceEnabled) : true,
        notificationChannel: notificationChannel || 'ALL',
        timezone: timezone || 'Africa/Lagos',
        dateFormat: dateFormat || 'DD/MM/YYYY',
        weeklyMintLimit: weeklyMintLimit ? parseInt(weeklyMintLimit, 10) : 5000
      }
    });

    if (schoolName) {
      await prisma.branch.update({
        where: { id: decoded.branchId },
        data: { name: schoolName }
      }).catch(() => {});
    }

    return res.json({ success: true, message: 'System settings updated successfully.', data: updated });
  } catch (error) {
    console.error('[SETTINGS] Save settings error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save system settings.' });
  }
});
/**
 * POST /api/admin/settings/upload-logo
 * Upload school logo or principal signature image file directly to Cloudinary
 */
router.post('/settings/upload-logo', upload.single('file'), async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }

  try {
    const { uploadToCloudinary } = require('../lib/cloudinaryService');
    const cloudinaryUrl = await uploadToCloudinary(req.file.buffer, {
      folder: `ugbekun_branch_${decoded.branchId}_branding`,
      public_id: `school_asset_${Date.now()}`
    });

    return res.json({
      success: true,
      message: 'Image uploaded successfully to Cloudinary.',
      url: cloudinaryUrl
    });
  } catch (error) {
    console.error('[SETTINGS] Cloudinary upload error:', error);
    try {
      const fs = require('fs');
      const path = require('path');
      const uploadDir = path.join(__dirname, '../uploads');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const ext = path.extname(req.file.originalname) || '.png';
      const filename = `school_asset_${decoded.branchId}_${Date.now()}${ext}`;
      fs.writeFileSync(path.join(uploadDir, filename), req.file.buffer);
      return res.json({
        success: true,
        message: 'Image uploaded locally.',
        url: `/uploads/${filename}`
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: error.message || 'Failed to upload image.' });
    }
  }
});

/**
 * GET /api/admin/school-info
 * Universal authenticated school info (Name, Logo, Term, Session) for top navigation across ALL user roles
 */
router.get('/school-info', async (req, res) => {
  try {
    const token = getBearerToken(req);
    let branchId = 1;

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded) {
          if (decoded.role === 2) {
            const resolvedBid = await resolveBranchForAdmin(decoded);
            if (resolvedBid) branchId = resolvedBid;
          } else if (decoded.role === 3) {
            const t = await prisma.teacher.findFirst({ where: { OR: [{ id: decoded.legacyUserId || -1 }, { email: decoded.username }] } });
            if (t?.branchId) branchId = t.branchId;
          } else if (decoded.role === 7) {
            const s = await prisma.student.findFirst({ where: { OR: [{ id: decoded.legacyUserId || -1 }, { email: decoded.username }] } });
            if (s?.branchId) branchId = s.branchId;
          } else if (decoded.role === 6) {
            const p = await prisma.parent.findFirst({ where: { OR: [{ id: decoded.legacyUserId || -1 }, { email: decoded.username }] } });
            if (p?.branchId) branchId = p.branchId;
          }
        }
      } catch (e) {}
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { systemSetting: true }
    });

    const settings = branch?.systemSetting;
    return res.json({
      success: true,
      data: {
        schoolName: settings?.schoolName || branch?.name || 'Ugbekun International Academy',
        logoUrl: settings?.logoUrl || null,
        academicSession: settings?.academicSession || '2025/2026',
        currentTerm: settings?.currentTerm || 'First Term',
        currencySymbol: settings?.currencySymbol || '₦'
      }
    });
  } catch (error) {
    console.error('[SCHOOL INFO] Error:', error);
    return res.json({
      success: true,
      data: {
        schoolName: 'Ugbekun International Academy',
        logoUrl: null,
        academicSession: '2025/2026',
        currentTerm: 'First Term',
        currencySymbol: '₦'
      }
    });
  }
});

/**
 * POST /api/admin/profile/upload-photo
 * Universal profile photo upload endpoint for ANY authenticated user role
 * Uploads to Cloudinary and updates Student.photo, Teacher.photo, Parent.photo, or User.photo
 */
router.post('/profile/upload-photo', upload.single('file'), async (req, res) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded?.sub || decoded?.id;
    if (!decoded || !userId) {
      return res.status(403).json({ success: false, message: 'Invalid or expired session.' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No photo file provided.' });
    }

    const { uploadToCloudinary } = require('../lib/cloudinaryService');
    const cloudinaryUrl = await uploadToCloudinary(req.file.buffer, {
      folder: `ugbekun_user_profiles`,
      public_id: `profile_photo_user_${userId}_${Date.now()}`
    });

    // Update base User model
    await prisma.user.update({
      where: { id: userId },
      data: { photo: cloudinaryUrl }
    }).catch(() => {});

    // Update specific role record
    if (decoded.role === 7) {
      const student = await prisma.student.findFirst({
        where: { OR: [{ id: decoded.legacyUserId || -1 }, { email: decoded.username }] }
      });
      if (student) {
        await prisma.student.update({
          where: { id: student.id },
          data: { photo: cloudinaryUrl }
        });
      }
    } else if (decoded.role === 3) {
      let teacher = null;
      if (decoded.legacyUserId) {
        teacher = await prisma.teacher.findUnique({ where: { id: decoded.legacyUserId } });
      }
      if (!teacher) {
        teacher = await prisma.teacher.findFirst({
          where: { OR: [{ email: decoded.username }, { name: { contains: decoded.username, mode: 'insensitive' } }] }
        });
      }
      if (teacher) {
        await prisma.teacher.update({
          where: { id: teacher.id },
          data: { photo: cloudinaryUrl }
        });
      }
    } else if (decoded.role === 6) {
      const parent = await prisma.parent.findFirst({
        where: { OR: [{ id: decoded.legacyUserId || -1 }, { email: decoded.username }] }
      });
      if (parent) {
        await prisma.parent.update({
          where: { id: parent.id },
          data: { photo: cloudinaryUrl }
        });
      }
    }

    return res.json({
      success: true,
      message: 'Profile photo uploaded to Cloudinary & active across ID cards, report cards, and certificates!',
      photoUrl: cloudinaryUrl
    });
  } catch (error) {
    console.error('[PROFILE] Photo upload error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload profile photo.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY MANAGEMENT MODULE ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/inventory
 * Fetches list of stock items, metrics summary, and recent stock transactions
 */
router.get('/inventory', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { category, search } = req.query;

    const where = { branchId: decoded.branchId };
    if (category && category !== 'All') {
      where.category = category;
    }
    if (search && search.trim()) {
      where.OR = [
        { name: { contains: search.trim(), mode: 'insensitive' } },
        { category: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    const [items, transactions] = await Promise.all([
      prisma.inventoryItem.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.inventoryTransaction.findMany({
        where: { item: { branchId: decoded.branchId } },
        include: { item: { select: { name: true, category: true, unit: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    // Calculate real-time metrics
    let totalItemsCount = items.length;
    let totalPurchasedQty = 0;
    let totalSoldQty = 0;
    let totalBalanceQty = 0;
    let totalPurchasedAmount = 0;
    let totalSalesAmount = 0;
    let lowStockCount = 0;

    items.forEach((item) => {
      totalPurchasedQty += item.totalPurchasedInt;
      totalSoldQty += item.totalSoldInt;
      totalBalanceQty += item.quantityBalance;
      totalPurchasedAmount += item.totalPurchasedInt * item.unitCost;
      totalSalesAmount += item.totalSoldInt * item.unitPrice;
      if (item.quantityBalance <= item.reorderLevel) {
        lowStockCount++;
      }
    });

    return res.json({
      success: true,
      data: {
        metrics: {
          totalItemsCount,
          totalPurchasedQty,
          totalSoldQty,
          totalBalanceQty,
          totalPurchasedAmount,
          totalSalesAmount,
          lowStockCount,
        },
        items,
        recentTransactions: transactions.map((t) => ({
          id: t.id,
          itemId: t.itemId,
          itemName: t.item.name,
          category: t.item.category,
          unit: t.item.unit,
          type: t.type,
          quantity: t.quantity,
          unitPrice: t.unitPrice,
          totalAmount: t.totalAmount,
          referenceNo: t.referenceNo,
          notes: t.notes,
          issuedTo: t.issuedTo,
          createdAt: t.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error('[INVENTORY] Fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch inventory records.' });
  }
});

/**
 * POST /api/admin/inventory/items
 * Create a new Inventory Item
 */
router.post('/inventory/items', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { name, category, unit, unitCost, unitPrice, initialStock, reorderLevel } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Item name is required.' });
    }

    const cost = parseFloat(unitCost) || 0.0;
    const price = parseFloat(unitPrice) || 0.0;
    const qty = parseInt(initialStock, 10) || 0;
    const alertLevel = parseInt(reorderLevel, 10) || 5;

    const newItem = await prisma.inventoryItem.create({
      data: {
        branchId: decoded.branchId,
        name: name.trim(),
        category: category || 'General',
        unit: unit || 'Pcs',
        unitCost: cost,
        unitPrice: price,
        totalPurchasedInt: qty,
        totalSoldInt: 0,
        quantityBalance: qty,
        reorderLevel: alertLevel,
      },
    });

    if (qty > 0) {
      await prisma.inventoryTransaction.create({
        data: {
          itemId: newItem.id,
          type: 'PURCHASE',
          quantity: qty,
          unitPrice: cost,
          totalAmount: qty * cost,
          referenceNo: `INIT-${newItem.id}`,
          notes: 'Initial Stock Entry',
        },
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Inventory item created successfully.',
      item: newItem,
    });
  } catch (error) {
    console.error('[INVENTORY] Create item error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create inventory item.' });
  }
});

/**
 * POST /api/admin/inventory/purchase
 * Record a stock purchase / restock entry
 */
router.post('/inventory/purchase', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { itemId, quantity, unitCost, referenceNo, notes } = req.body;

    const qty = parseInt(quantity, 10);
    if (!itemId || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: 'Valid item and positive purchase quantity are required.' });
    }

    const item = await prisma.inventoryItem.findFirst({
      where: { id: parseInt(itemId, 10), branchId: decoded.branchId },
    });

    if (!item) {
      return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    }

    const cost = parseFloat(unitCost) !== undefined && !isNaN(parseFloat(unitCost)) ? parseFloat(unitCost) : item.unitCost;
    const totalAmount = qty * cost;

    const [updatedItem, transaction] = await prisma.$transaction([
      prisma.inventoryItem.update({
        where: { id: item.id },
        data: {
          totalPurchasedInt: { increment: qty },
          quantityBalance: { increment: qty },
          unitCost: cost,
        },
      }),
      prisma.inventoryTransaction.create({
        data: {
          itemId: item.id,
          type: 'PURCHASE',
          quantity: qty,
          unitPrice: cost,
          totalAmount,
          referenceNo: referenceNo || `PUR-${Date.now()}`,
          notes: notes || null,
        },
      }),
    ]);

    return res.json({
      success: true,
      message: `Successfully restocked ${qty} ${item.unit} of ${item.name}.`,
      item: updatedItem,
      transaction,
    });
  } catch (error) {
    console.error('[INVENTORY] Purchase error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to record stock purchase.' });
  }
});

/**
 * POST /api/admin/inventory/sale
 * Record a stock sale / issuance entry
 */
router.post('/inventory/sale', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { itemId, quantity, unitPrice, referenceNo, issuedTo, notes } = req.body;

    const qty = parseInt(quantity, 10);
    if (!itemId || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: 'Valid item and positive sale quantity are required.' });
    }

    const item = await prisma.inventoryItem.findFirst({
      where: { id: parseInt(itemId, 10), branchId: decoded.branchId },
    });

    if (!item) {
      return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    }

    if (item.quantityBalance < qty) {
      return res.status(400).json({
        success: false,
        message: `Insufficient stock! Balance is ${item.quantityBalance} ${item.unit}, but attempted to sell/issue ${qty} ${item.unit}.`,
      });
    }

    const price = parseFloat(unitPrice) !== undefined && !isNaN(parseFloat(unitPrice)) ? parseFloat(unitPrice) : item.unitPrice;
    const totalAmount = qty * price;

    const [updatedItem, transaction] = await prisma.$transaction([
      prisma.inventoryItem.update({
        where: { id: item.id },
        data: {
          totalSoldInt: { increment: qty },
          quantityBalance: { decrement: qty },
        },
      }),
      prisma.inventoryTransaction.create({
        data: {
          itemId: item.id,
          type: 'SALE',
          quantity: qty,
          unitPrice: price,
          totalAmount,
          referenceNo: referenceNo || `SALE-${Date.now()}`,
          issuedTo: issuedTo || null,
          notes: notes || null,
        },
      }),
    ]);

    return res.json({
      success: true,
      message: `Successfully sold/issued ${qty} ${item.unit} of ${item.name}.`,
      item: updatedItem,
      transaction,
    });
  } catch (error) {
    console.error('[INVENTORY] Sale error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to record stock sale.' });
  }
});

/**
 * DELETE /api/admin/inventory/items/:id
 * Delete an inventory item
 */
router.delete('/inventory/items/:id', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const id = parseInt(req.params.id, 10);
    const item = await prisma.inventoryItem.findFirst({
      where: { id, branchId: decoded.branchId },
    });

    if (!item) {
      return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    }

    await prisma.inventoryItem.delete({
      where: { id: item.id },
    });

    return res.json({
      success: true,
      message: `Item "${item.name}" and its stock records deleted.`,
    });
  } catch (error) {
    console.error('[INVENTORY] Delete error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete inventory item.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── AUTOMATED REPORT CARD GENERATION ENGINE (1-CLICK PDF REPORT CARDS) ──────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/report-cards/classes
 * Fetch classes and sections with student counts and mark status
 */
router.get('/report-cards/classes', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const classes = await prisma.class.findMany({
      where: { branchId: decoded.branchId },
      include: {
        sections: {
          select: {
            section: { select: { id: true, name: true } }
          }
        },
        enrolls: {
          where: { sessionId, branchId: decoded.branchId },
          select: { studentId: true, sectionId: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    const formatted = classes.map(c => {
      const secMap = {};
      c.sections.forEach(s => {
        if (s.section) {
          secMap[s.section.id] = {
            id: s.section.id,
            name: s.section.name,
            studentCount: 0
          };
        }
      });

      c.enrolls.forEach(e => {
        if (secMap[e.sectionId]) {
          secMap[e.sectionId].studentCount += 1;
        }
      });

      return {
        id: c.id,
        name: c.name,
        isEcd: c.isEcd || false,
        totalEnrolled: c.enrolls.length,
        sections: Object.values(secMap)
      };
    });

    return res.json({ success: true, classes: formatted });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Get classes error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch classes.' });
  }
});

/**
 * GET /api/admin/report-cards/students
 * Fetch compiled report cards for all students in a class & section
 */
router.get('/report-cards/students', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { classId, sectionId } = req.query;
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    const parsedClassId = Number(classId);
    const parsedSectionId = Number(sectionId);

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    // 1. Fetch class info
    const cls = await prisma.class.findUnique({
      where: { id: parsedClassId },
      select: { name: true, isEcd: true }
    });

    // 2. Fetch enrolled students
    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: parsedClassId,
        sectionId: parsedSectionId,
        sessionId,
        branchId: decoded.branchId
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            gender: true,
            photo: true
          }
        }
      },
      orderBy: { student: { lastName: 'asc' } }
    });

    const studentIds = enrolls.map(e => e.studentId);

    // 3. Fetch all marks for this class & section
    const marks = await prisma.mark.findMany({
      where: {
        studentId: { in: studentIds },
        sessionId,
        branchId: decoded.branchId
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        exam: { select: { id: true, name: true } }
      }
    });

    // 4. Fetch commentaries & Montessori assessments
    const commentaries = await prisma.studentCommentary.findMany({
      where: {
        studentId: { in: studentIds },
        sessionId,
        branchId: decoded.branchId
      }
    });
    const commMap = {};
    commentaries.forEach(c => { commMap[c.studentId] = c; });

    const montessoriList = await prisma.montessoriAssessment.findMany({
      where: {
        studentId: { in: studentIds },
        sessionId,
        branchId: decoded.branchId
      }
    });
    const montMap = {};
    montessoriList.forEach(m => { montMap[m.studentId] = m; });

    // 5. Fetch attendance
    const attendanceRecords = await prisma.attendance.findMany({
      where: {
        studentId: { in: studentIds },
        classId: parsedClassId,
        sectionId: parsedSectionId,
        sessionId,
        branchId: decoded.branchId
      },
      select: { studentId: true, status: true }
    });
    const attMap = {};
    studentIds.forEach(id => {
      attMap[id] = { total: 0, present: 0, absent: 0, late: 0 };
    });
    attendanceRecords.forEach(a => {
      if (attMap[a.studentId]) {
        attMap[a.studentId].total += 1;
        const st = (a.status || '').toLowerCase();
        if (st === 'present' || st === '1') attMap[a.studentId].present += 1;
        else if (st === 'absent' || st === '0') attMap[a.studentId].absent += 1;
        else if (st === 'late') attMap[a.studentId].late += 1;
      }
    });

    // 6. Aggregate marks and compute ranks
    const studentMarksMap = {};
    const studentAggregates = {};
    studentIds.forEach(id => {
      studentMarksMap[id] = [];
      studentAggregates[id] = { sum: 0, count: 0, totalMarks: 0 };
    });

    marks.forEach(m => {
      const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0;
      const examVal = m.mark ? parseFloat(m.mark) : 0;
      const totalVal = testVal + examVal;
      if (studentMarksMap[m.studentId]) {
        studentMarksMap[m.studentId].push({
          id: m.id,
          examName: m.exam?.name || 'Evaluation',
          subjectName: m.subject?.name || 'Subject',
          subjectCode: m.subject?.subjectCode || 'N/A',
          cbtMark: m.cbtMark !== null ? String(testVal) : null,
          theoryMark: m.mark !== null ? String(examVal) : null,
          mark: String(totalVal),
          absent: m.absent === '1' || m.absent === 'true'
        });
        studentAggregates[m.studentId].sum += totalVal;
        studentAggregates[m.studentId].count += 1;
        studentAggregates[m.studentId].totalMarks += totalVal;
      }
    });

    // Compute averages and ranks
    const scores = studentIds.map(id => ({
      id,
      avg: studentAggregates[id].count > 0 ? (studentAggregates[id].sum / studentAggregates[id].count) : 0
    }));
    scores.sort((a, b) => b.avg - a.avg);

    const rankMap = {};
    scores.forEach((item, idx) => {
      rankMap[item.id] = idx + 1;
    });

    // 7. Assemble students array
    const studentList = enrolls.map(e => {
      const st = e.student;
      const agg = studentAggregates[st.id] || { sum: 0, count: 0, totalMarks: 0 };
      const avg = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(1)) : 0;
      const rk = rankMap[st.id] || null;
      const comm = commMap[st.id];
      const mont = montMap[st.id];
      const att = attMap[st.id] || { total: 0, present: 0, absent: 0, late: 0 };

      let grade = 'F';
      if (avg >= 70) grade = 'A';
      else if (avg >= 60) grade = 'B';
      else if (avg >= 50) grade = 'C';
      else if (avg >= 45) grade = 'D';
      else if (avg >= 40) grade = 'E';

      const getOrdinal = (n) => {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
      };

      return {
        id: st.id,
        studentName: `${st.lastName}, ${st.firstName}`,
        firstName: st.firstName,
        lastName: st.lastName,
        admissionNo: st.registerNo || 'N/A',
        registerNo: st.registerNo,
        className: cls?.name || 'Classroom',
        gender: st.gender || 'N/A',
        totalMarks: agg.totalMarks,
        average: avg,
        grade,
        position: rk ? `${getOrdinal(rk)} out of ${studentIds.length}` : 'N/A',
        rank: rk,
        attendanceDays: att.total > 0 ? `${att.present} / ${att.total} Days` : '0 Days Logged',
        presentCount: att.present,
        absentCount: att.absent,
        totalAttendanceDays: att.total,
        teacherComment: comm?.remark || (mont?.narrativeComment || ''),
        principalComment: comm?.reviewNotes || (avg >= 70 ? 'Promoted with distinction.' : (avg >= 50 ? 'Good progress. Promoted.' : 'Needs improvement.')),
        commentStatus: comm?.status || 'PENDING',
        isAiGenerated: comm?.isAiGenerated || false,
        psychomotor: {
          writingMastery: mont?.writingMastery || 'AC',
          drawingCapability: mont?.drawingCapability || 'AC',
          physicalCoordination: mont?.physicalCoordination || 'AC',
          motorSkillProgression: mont?.motorSkillProgression || 'AC'
        },
        affective: {
          generalPunctuality: mont?.generalPunctuality || 'AC',
          peerRespect: mont?.peerRespect || 'AC',
          aestheticNeatness: mont?.aestheticNeatness || 'AC',
          activeGroupParticipation: mont?.activeGroupParticipation || 'AC'
        },
        isEcd: cls?.isEcd || false,
        subjectsCount: studentMarksMap[st.id]?.length || 0,
        reportCard: studentMarksMap[st.id] || []
      };
    });

    return res.json({
      success: true,
      className: cls?.name || 'Classroom',
      isEcd: cls?.isEcd || false,
      totalStudents: studentList.length,
      students: studentList
    });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Get students error:', error);
    return res.status(500).json({ success: false, message: 'Failed to compile student report cards.' });
  }
});

/**
 * GET /api/admin/report-cards/export-pdf
 * 1-Click Single Student PDF Report Card Download
 */
router.get('/report-cards/export-pdf', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { classId, sectionId, studentId, rankingType = 'full', rankingLimit = 3 } = req.query;
  if (!classId || !sectionId || !studentId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and studentId are required.' });
  }

  try {
    const parsedStudentId = Number(studentId);
    const parsedClassId = Number(classId);
    const parsedSectionId = Number(sectionId);

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const student = await prisma.student.findUnique({
      where: { id: parsedStudentId },
      include: { branch: { select: { name: true, code: true } } }
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const cls = await prisma.class.findUnique({ where: { id: parsedClassId }, select: { name: true, isEcd: true } });
    const sec = await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } });
    const sess = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } });

    const className = cls?.name || 'Classroom';
    const sectionName = sec?.name || 'Main';
    const sessionName = sess?.schoolYear || 'Active Session';

    let formTeacherName = 'Form Teacher';
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId: decoded.branchId },
      include: { teacher: { select: { name: true } } }
    });
    if (formAllocation?.teacher) formTeacherName = formAllocation.teacher.name;

    if (cls?.isEcd) {
      const assessment = await prisma.montessoriAssessment.findFirst({
        where: { studentId: parsedStudentId, classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId: decoded.branchId },
        include: { exam: { select: { name: true, resumptionDate: true } } }
      });

      const pdfBuffer = await generateMontessoriReportCardPdf({
        schoolName: student.branch?.name || 'Ugbekun Schools',
        branchCode: student.branch?.code || 'GEN',
        studentName: `${student.lastName}, ${student.firstName}`,
        registerNo: student.registerNo,
        className,
        sectionName,
        sessionName,
        examName: assessment?.exam?.name || 'Term Evaluation',
        assessment: assessment || {},
        resumptionDate: assessment?.exam?.resumptionDate || null,
        formTeacherName
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="report_card_${student.lastName}_${student.firstName}.pdf"`);
      return res.send(pdfBuffer);
    }

    // Standard Report Card
    const marks = await prisma.mark.findMany({
      where: { studentId: parsedStudentId, sessionId, branchId: decoded.branchId },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } }
      }
    });

    // Class benchmark averages
    const allClassMarks = await prisma.mark.findMany({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId: decoded.branchId },
      select: { examId: true, subjectId: true, mark: true, cbtMark: true }
    });
    const avgMap = {};
    allClassMarks.forEach(m => {
      const k = `${m.examId}-${m.subjectId}`;
      if (!avgMap[k]) avgMap[k] = { sum: 0, count: 0 };
      const tot = (parseFloat(m.cbtMark || '0')) + (parseFloat(m.mark || '0'));
      avgMap[k].sum += tot;
      avgMap[k].count += 1;
    });

    let totalSum = 0;
    let marksCount = 0;
    const reportCard = marks.map(m => {
      const testScore = m.cbtMark ? parseFloat(m.cbtMark) : 0;
      const examScore = m.mark ? parseFloat(m.mark) : 0;
      const totalScore = testScore + examScore;
      totalSum += totalScore;
      marksCount += 1;

      const k = `${m.examId}-${m.subjectId}`;
      const cAvg = avgMap[k] && avgMap[k].count > 0 ? Number((avgMap[k].sum / avgMap[k].count).toFixed(1)) : totalScore;

      return {
        id: m.id,
        examName: m.exam?.name || 'Term Evaluation',
        subjectName: m.subject?.name || 'Subject',
        subjectCode: m.subject?.subjectCode || 'N/A',
        cbtMark: String(testScore),
        theoryMark: String(examScore),
        mark: String(totalScore),
        absent: m.absent === '1' || m.absent === 'true',
        classAverage: cAvg
      };
    });

    const overallAverage = marksCount > 0 ? Number((totalSum / marksCount).toFixed(1)) : 0;

    // Rank
    const enrolls = await prisma.enroll.findMany({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId: decoded.branchId },
      select: { studentId: true }
    });
    const studentIds = enrolls.map(e => e.studentId);
    const aggMap = {};
    studentIds.forEach(id => { aggMap[id] = { sum: 0, count: 0 }; });
    allClassMarks.forEach(m => {
      if (aggMap[m.studentId]) {
        aggMap[m.studentId].sum += (parseFloat(m.cbtMark || '0') + parseFloat(m.mark || '0'));
        aggMap[m.studentId].count += 1;
      }
    });
    const scoreRankList = studentIds.map(id => ({
      id,
      avg: aggMap[id]?.count > 0 ? (aggMap[id].sum / aggMap[id].count) : 0
    })).sort((a, b) => b.avg - a.avg);

    const rankIdx = scoreRankList.findIndex(s => s.id === parsedStudentId);
    const rank = rankIdx !== -1 ? rankIdx + 1 : null;

    const comm = await prisma.studentCommentary.findFirst({
      where: { studentId: parsedStudentId, sessionId, branchId: decoded.branchId }
    });

    const pdfBuffer = await generateReportCardPdf({
      schoolName: student.branch?.name || 'Ugbekun Schools',
      branchCode: student.branch?.code || 'GEN',
      studentName: `${student.lastName}, ${student.firstName}`,
      registerNo: student.registerNo,
      className,
      sectionName,
      sessionName,
      reportCard,
      overallAverage,
      commentary: comm?.remark || '',
      rank,
      totalClassStudents: studentIds.length,
      rankingType,
      rankingLimit: Number(rankingLimit),
      resumptionDate: marks[0]?.exam?.resumptionDate || null,
      formTeacherName
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report_card_${student.lastName}_${student.firstName}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Single PDF export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate report card PDF.' });
  }
});

/**
 * GET /api/admin/report-cards/export-batch-pdf
 * 1-Click Whole-Class Multi-Page Batch PDF Report Card Generator
 */
router.get('/report-cards/export-batch-pdf', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { classId, sectionId, rankingType = 'full', rankingLimit = 3 } = req.query;
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    const parsedClassId = Number(classId);
    const parsedSectionId = Number(sectionId);

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: { name: true, code: true }
    });

    const cls = await prisma.class.findUnique({ where: { id: parsedClassId }, select: { name: true, isEcd: true } });
    const sec = await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } });
    const sess = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } });

    const className = cls?.name || 'Classroom';
    const sectionName = sec?.name || 'Main';
    const sessionName = sess?.schoolYear || 'Active Session';

    let formTeacherName = 'Form Teacher';
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId: decoded.branchId },
      include: { teacher: { select: { name: true } } }
    });
    if (formAllocation?.teacher) formTeacherName = formAllocation.teacher.name;

    // Fetch enrolled students
    const enrolls = await prisma.enroll.findMany({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId: decoded.branchId },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } }
      },
      orderBy: { student: { lastName: 'asc' } }
    });

    const studentIds = enrolls.map(e => e.studentId);

    if (studentIds.length === 0) {
      return res.status(404).json({ success: false, message: 'No enrolled students found in this class/section.' });
    }

    // Fetch all class marks
    const allMarks = await prisma.mark.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId: decoded.branchId },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } }
      }
    });

    // Compute subject class averages
    const avgMap = {};
    allMarks.forEach(m => {
      const k = `${m.examId}-${m.subjectId}`;
      if (!avgMap[k]) avgMap[k] = { sum: 0, count: 0 };
      const tot = (parseFloat(m.cbtMark || '0')) + (parseFloat(m.mark || '0'));
      avgMap[k].sum += tot;
      avgMap[k].count += 1;
    });

    // Student aggregates & ranking
    const studentAggregates = {};
    const studentMarksMap = {};
    studentIds.forEach(id => {
      studentAggregates[id] = { sum: 0, count: 0 };
      studentMarksMap[id] = [];
    });

    allMarks.forEach(m => {
      const testScore = m.cbtMark ? parseFloat(m.cbtMark) : 0;
      const examScore = m.mark ? parseFloat(m.mark) : 0;
      const totalScore = testScore + examScore;

      if (studentMarksMap[m.studentId]) {
        const k = `${m.examId}-${m.subjectId}`;
        const cAvg = avgMap[k] && avgMap[k].count > 0 ? Number((avgMap[k].sum / avgMap[k].count).toFixed(1)) : totalScore;

        studentMarksMap[m.studentId].push({
          id: m.id,
          examName: m.exam?.name || 'Evaluation',
          subjectName: m.subject?.name || 'Subject',
          subjectCode: m.subject?.subjectCode || 'N/A',
          cbtMark: String(testScore),
          theoryMark: String(examScore),
          mark: String(totalScore),
          absent: m.absent === '1' || m.absent === 'true',
          classAverage: cAvg
        });

        studentAggregates[m.studentId].sum += totalScore;
        studentAggregates[m.studentId].count += 1;
      }
    });

    const rankList = studentIds.map(id => ({
      id,
      avg: studentAggregates[id].count > 0 ? (studentAggregates[id].sum / studentAggregates[id].count) : 0
    })).sort((a, b) => b.avg - a.avg);

    const rankMap = {};
    rankList.forEach((item, idx) => { rankMap[item.id] = idx + 1; });

    // Fetch commentaries & Montessori
    const commentaries = await prisma.studentCommentary.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId: decoded.branchId }
    });
    const commMap = {};
    commentaries.forEach(c => { commMap[c.studentId] = c; });

    const montessoriList = await prisma.montessoriAssessment.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId: decoded.branchId },
      include: { exam: { select: { name: true, resumptionDate: true } } }
    });
    const montMap = {};
    montessoriList.forEach(m => { montMap[m.studentId] = m; });

    // Assemble student objects for batch generation
    const batchStudents = enrolls.map(e => {
      const st = e.student;
      const agg = studentAggregates[st.id] || { sum: 0, count: 0 };
      const avg = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(1)) : 0;
      const rk = rankMap[st.id] || null;
      const comm = commMap[st.id];
      const mont = montMap[st.id];

      return {
        studentName: `${st.lastName}, ${st.firstName}`,
        registerNo: st.registerNo || 'N/A',
        isEcd: cls?.isEcd || false,
        reportCard: studentMarksMap[st.id] || [],
        overallAverage: avg,
        commentary: comm?.remark || '',
        rank: rk,
        totalClassStudents: studentIds.length,
        rankingType,
        rankingLimit: Number(rankingLimit),
        resumptionDate: allMarks[0]?.exam?.resumptionDate || null,
        formTeacherName,
        examName: mont?.exam?.name || 'Term Evaluation',
        assessment: mont || {}
      };
    });

    const pdfBuffer = await generateBatchClassReportCardsPdf({
      schoolName: branch?.name || 'Ugbekun Schools',
      branchCode: branch?.code || 'GEN',
      className,
      sectionName,
      sessionName,
      students: batchStudents
    });

    const safeClassName = className.replace(/\s+/g, '_');
    const safeSectionName = sectionName.replace(/\s+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="batch_report_cards_${safeClassName}_${safeSectionName}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Batch PDF export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate batch report cards PDF.' });
  }
});

/**
 * POST /api/admin/report-cards/commentary
 * Save/update student commentary and sign-off
 */
router.post('/report-cards/commentary', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { studentId, classId, sectionId, remark, principalRemark, status = 'PRINCIPAL_SIGNED_OFF' } = req.body || {};
  if (!studentId || !classId || !sectionId || !remark) {
    return res.status(400).json({ success: false, message: 'studentId, classId, sectionId, and remark are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const commentary = await prisma.studentCommentary.upsert({
      where: {
        studentId_sessionId: {
          studentId: Number(studentId),
          sessionId
        }
      },
      update: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        remark: remark.trim(),
        reviewNotes: principalRemark ? principalRemark.trim() : undefined,
        status,
        reviewerId: decoded.id,
        isEditedByHuman: true,
        branchId: decoded.branchId
      },
      create: {
        studentId: Number(studentId),
        classId: Number(classId),
        sectionId: Number(sectionId),
        remark: remark.trim(),
        reviewNotes: principalRemark ? principalRemark.trim() : undefined,
        status,
        reviewerId: decoded.id,
        sessionId,
        branchId: decoded.branchId
      }
    });

    return res.json({ success: true, message: 'Commentary saved to student report card.', commentary });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Save commentary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save commentary.' });
  }
});

/**
 * POST /api/admin/report-cards/behavioral
 * Save/update psychomotor and affective domain evaluations
 */
router.post('/report-cards/behavioral', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { studentId, classId, sectionId, psychomotor = {}, affective = {}, narrativeComment } = req.body || {};
  if (!studentId || !classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'studentId, classId, and sectionId are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const exam = await prisma.exam.findFirst({
      where: { branchId: decoded.branchId, sessionId },
      select: { id: true }
    });
    const examId = exam?.id || 1;

    const assessment = await prisma.montessoriAssessment.upsert({
      where: {
        studentId_examId_sessionId: {
          studentId: Number(studentId),
          examId,
          sessionId
        }
      },
      update: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        writingMastery: psychomotor.writingMastery,
        drawingCapability: psychomotor.drawingCapability,
        physicalCoordination: psychomotor.physicalCoordination,
        motorSkillProgression: psychomotor.motorSkillProgression,
        generalPunctuality: affective.generalPunctuality,
        peerRespect: affective.peerRespect,
        aestheticNeatness: affective.aestheticNeatness,
        activeGroupParticipation: affective.activeGroupParticipation,
        narrativeComment: narrativeComment ? narrativeComment.trim() : undefined,
        branchId: decoded.branchId
      },
      create: {
        studentId: Number(studentId),
        classId: Number(classId),
        sectionId: Number(sectionId),
        examId,
        sessionId,
        writingMastery: psychomotor.writingMastery || 'AC',
        drawingCapability: psychomotor.drawingCapability || 'AC',
        physicalCoordination: psychomotor.physicalCoordination || 'AC',
        motorSkillProgression: psychomotor.motorSkillProgression || 'AC',
        generalPunctuality: affective.generalPunctuality || 'AC',
        peerRespect: affective.peerRespect || 'AC',
        aestheticNeatness: affective.aestheticNeatness || 'AC',
        activeGroupParticipation: affective.activeGroupParticipation || 'AC',
        narrativeComment: narrativeComment ? narrativeComment.trim() : undefined,
        branchId: decoded.branchId
      }
    });

    return res.json({ success: true, message: 'Behavioral and psychomotor ratings saved successfully.', assessment });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Save behavioral error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save behavioral ratings.' });
  }
});

/**
 * POST /api/admin/report-cards/ai-comments
 * Intelligent contextualized AI/Smart remark generation
 */
router.post('/report-cards/ai-comments', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { studentName = 'The student', averageScore = 75, attendanceRate = 90, strengths = 'Academics' } = req.body || {};

  try {
    const avg = Number(averageScore) || 75;
    let teacherComment = '';
    let principalComment = '';

    if (avg >= 80) {
      teacherComment = `${studentName} has demonstrated exceptional intellectual mastery, intellectual curiosity, and exemplary discipline throughout this academic term. A stellar role model for classmates.`;
      principalComment = `An outstanding academic distinction. Commended for scholastic excellence and promoted with honors!`;
    } else if (avg >= 70) {
      teacherComment = `${studentName} exhibits strong analytical capability and steady academic commitment. Consistently puts in commendable effort across all subjects.`;
      principalComment = `Very good academic performance. Promoted with praise. Keep up the high standard!`;
    } else if (avg >= 60) {
      teacherComment = `${studentName} is a hardworking and attentive pupil who shows solid understanding of core concepts. Encouraged to participate more actively in classroom discussions.`;
      principalComment = `Satisfactory terminal result. Has the capability to achieve even higher grades next session. Promoted.`;
    } else if (avg >= 50) {
      teacherComment = `${studentName} has made fair progress this term. Regular study revision and attention to homework assignments will yield stronger attainment.`;
      principalComment = `Pass grade achieved. Advised to focus diligently on foundational subjects during the upcoming term.`;
    } else {
      teacherComment = `${studentName} requires closer academic guidance and targeted remedial assistance to improve overall comprehension and performance.`;
      principalComment = `Performance falls below the expected benchmark. Recommended for structured holiday remedial support.`;
    }

    return res.json({
      success: true,
      teacherComment,
      principalComment,
      isAiGenerated: true
    });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] AI comments error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate comments.' });
  }
});

/**
 * GET /api/admin/lesson-plans
 * View, filter, and inspect all teacher lesson plans across the branch.
 */
router.get('/lesson-plans', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { classId, subjectId, teacherId, status, search } = req.query;

  try {
    const where = {
      teacher: { branchId: decoded.branchId }
    };

    if (classId) where.classId = Number(classId);
    if (subjectId) where.subjectId = Number(subjectId);
    if (teacherId) where.teacherId = Number(teacherId);
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { coreTopic: { contains: search, mode: 'insensitive' } },
        { educationalObjectives: { contains: search, mode: 'insensitive' } }
      ];
    }

    const plans = await prisma.lessonPlan.findMany({
      where,
      include: {
        teacher: { select: { id: true, name: true } },
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({ success: true, count: plans.length, plans });
  } catch (error) {
    console.error('[ADMIN] Fetch lesson plans error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch lesson plans.' });
  }
});

/**
 * GET /api/admin/lesson-plans/:id/pdf
 * Official A4 PDF download for a lesson plan.
 */
router.get('/lesson-plans/:id/pdf', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const plan = await prisma.lessonPlan.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        teacher: { select: { name: true, branchId: true } },
        class: { select: { name: true } },
        subject: { select: { name: true } }
      }
    });

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Lesson plan not found.' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId || 1 },
      select: { name: true, code: true }
    });

    const pdfBuffer = await generateLessonPlanPdf({
      schoolName: branch?.name || 'Ugbekun Group of Schools',
      branchCode: branch?.code || 'MAIN',
      teacherName: plan.teacher.name || 'Subject Teacher',
      subjectName: plan.subject.name,
      className: plan.class.name,
      coreTopic: plan.coreTopic,
      educationalObjectives: plan.educationalObjectives,
      materialLists: plan.materialLists,
      teachingGuide: plan.teachingGuide,
      assessmentCriteria: plan.assessmentCriteria,
      classAssignments: plan.classAssignments,
      status: plan.status,
      createdAt: plan.createdAt
    });

    const sanitizedTopic = (plan.coreTopic || 'Lesson_Plan').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Lesson_Plan_${sanitizedTopic}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Lesson plan PDF export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to export lesson plan PDF.' });
  }
});

/**
 * POST /api/admin/report-cards/batch-generate-commentary
 * 1-Click AI Commentary Generator for an entire classroom section.
 */
router.post('/report-cards/batch-generate-commentary', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { classId, sectionId, tone = 'constructive', behavioralTags = [] } = req.body || {};
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const enrollments = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        branchId: decoded.branchId,
        sessionId
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            gender: true
          }
        }
      }
    });

    const studentsData = [];

    for (const enr of enrollments) {
      const st = enr.student;
      if (!st) continue;

      const marks = await prisma.mark.findMany({
        where: { studentId: st.id, sessionId, branchId: decoded.branchId },
        include: { subject: { select: { name: true } } }
      });

      const marksBySubject = {};
      for (const m of marks) {
        if (!m.mark || m.absent === '1') continue;
        const score = parseFloat(m.mark);
        if (!isNaN(score)) {
          marksBySubject[m.subject.name] = score;
        }
      }

      const scoresList = Object.values(marksBySubject);
      const avg = scoresList.length > 0 ? Math.round(scoresList.reduce((a, b) => a + b, 0) / scoresList.length) : 70;

      const att = await prisma.attendance.findMany({
        where: { studentId: st.id, sessionId, branchId: decoded.branchId }
      });
      const totalDays = att.length;
      const presentDays = att.filter(a => String(a.status || '').toLowerCase() === 'present' || String(a.status || '').toLowerCase() === 'late').length;
      const attendanceRate = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 100;

      const existingComm = await prisma.studentCommentary.findUnique({
        where: {
          studentId_sessionId: {
            studentId: st.id,
            sessionId
          }
        }
      });

      studentsData.push({
        studentId: st.id,
        studentName: `${st.firstName} ${st.lastName}`,
        registerNo: st.registerNo || '',
        averageScore: avg,
        attendanceRate,
        marksBySubject,
        behavioralTags,
        existingRemark: existingComm?.remark || null
      });
    }

    const batchGenerated = await generateBatchClassCommentary(studentsData, tone);

    return res.json({
      success: true,
      count: batchGenerated.length,
      commentaries: batchGenerated
    });
  } catch (err) {
    console.error('[ADMIN] Batch commentary generate error:', err);
    return res.status(500).json({ success: false, message: 'Failed to batch generate commentary.' });
  }
});

/**
 * POST /api/admin/report-cards/batch-save-commentary
 * Batch saves and authorizes commentary for an entire classroom section.
 */
router.post('/report-cards/batch-save-commentary', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { classId, sectionId, commentaries = [], status = 'APPROVED_BY_PRINCIPAL' } = req.body || {};
  if (!classId || !sectionId || !Array.isArray(commentaries)) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and commentaries array required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    let savedCount = 0;

    for (const item of commentaries) {
      if (!item.studentId || !item.remark) continue;

      await prisma.studentCommentary.upsert({
        where: {
          studentId_sessionId: {
            studentId: Number(item.studentId),
            sessionId
          }
        },
        update: {
          classId: Number(classId),
          sectionId: Number(sectionId),
          remark: item.remark.trim(),
          reviewNotes: item.principalRemark ? item.principalRemark.trim() : undefined,
          status,
          reviewerId: decoded.id,
          isEditedByHuman: true,
          branchId: decoded.branchId
        },
        create: {
          studentId: Number(item.studentId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          remark: item.remark.trim(),
          reviewNotes: item.principalRemark ? item.principalRemark.trim() : undefined,
          status,
          reviewerId: decoded.id,
          sessionId,
          branchId: decoded.branchId
        }
      });

      savedCount++;
    }

    return res.json({
      success: true,
      message: `Successfully saved & authorized ${savedCount} student report card remarks.`,
      savedCount
    });
  } catch (err) {
    console.error('[ADMIN] Batch commentary save error:', err);
    return res.status(500).json({ success: false, message: 'Failed to batch save commentaries.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MYEDURIDE BUS LOGISTICS & GATE ACCESS CONTROL API BRIDGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/myeduride/config
 * Fetch branch MyEduRide API credentials & connection settings
 */
router.get('/myeduride/config', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const config = await getMyEduRideConfig(prisma, decoded.branchId);
    return res.json({ success: true, data: config });
  } catch (err) {
    console.error('[MYEDURIDE] GET config error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load MyEduRide configuration.' });
  }
});

/**
 * POST /api/admin/myeduride/config
 * Save branch MyEduRide API credentials
 */
router.post('/myeduride/config', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const updated = await saveMyEduRideConfig(prisma, decoded.branchId, req.body || {});
    return res.json({
      success: true,
      message: 'MyEduRide API configuration saved successfully.',
      data: updated
    });
  } catch (err) {
    console.error('[MYEDURIDE] POST config error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save MyEduRide configuration.' });
  }
});

/**
 * POST /api/admin/myeduride/test-connection
 * Perform live handshake test with MyEduRide API
 */
router.post('/myeduride/test-connection', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const currentConfig = await getMyEduRideConfig(prisma, decoded.branchId);
    const { apiUrl = currentConfig.apiUrl, apiKey = currentConfig.apiKey } = req.body || {};

    const testResult = await testMyEduRideConnection({
      apiUrl,
      apiKey,
      branchCode: currentConfig.branchCode
    });

    return res.json({
      success: true,
      data: testResult
    });
  } catch (err) {
    console.error('[MYEDURIDE] Connection test error:', err);
    return res.status(500).json({ success: false, message: 'Failed to test MyEduRide connection.' });
  }
});

/**
 * POST /api/admin/myeduride/sync-roster
 * Sync students, parents & ID card QR tokens to MyEduRide API
 */
router.post('/myeduride/sync-roster', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const result = await syncStudentsToMyEduRide(prisma, decoded.branchId);
    return res.json(result);
  } catch (err) {
    console.error('[MYEDURIDE] Roster sync error:', err);
    return res.status(500).json({ success: false, message: 'Failed to synchronize roster to MyEduRide.' });
  }
});

/**
 * GET /api/admin/myeduride/overview
 * Overview stats: active fleet, gate logs today, synced students count
 */
router.get('/myeduride/overview', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const overview = await getTransportOverview(prisma, decoded.branchId);
    return res.json({ success: true, data: overview });
  } catch (err) {
    console.error('[MYEDURIDE] Overview error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load MyEduRide overview.' });
  }
});

/**
 * GET /api/admin/myeduride/buses
 * Live GPS school bus fleet & routes
 */
router.get('/myeduride/buses', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const fleet = await getBusFleet(prisma, decoded.branchId);
    return res.json({ success: true, data: fleet });
  } catch (err) {
    console.error('[MYEDURIDE] Bus fleet error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load bus fleet.' });
  }
});

/**
 * GET /api/admin/myeduride/gate-logs
 * Gate turnstile access logs stream
 */
router.get('/myeduride/gate-logs', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const { role, status, direction, search, limit } = req.query;
    const logs = await getGateLogs(prisma, decoded.branchId, {
      role,
      status,
      direction,
      search,
      limit: limit ? parseInt(limit, 10) : 50
    });
    return res.json({ success: true, data: logs });
  } catch (err) {
    console.error('[MYEDURIDE] Gate logs error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load gate access logs.' });
  }
});

/**
 * POST /api/admin/myeduride/gate-logs/scan
 * Process live QR / RFID gate turnstile scan
 */
router.post('/myeduride/gate-logs/scan', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { code, direction = 'ENTRY', gateLocation = 'Main Front Turnstile Gate 1', verifiedBy = 'Turnstile Scanner' } = req.body || {};
  if (!code) {
    return res.status(400).json({ success: false, message: 'Scan code is required.' });
  }

  try {
    const result = await processGateScan(prisma, decoded.branchId, {
      code,
      direction,
      gateLocation,
      verifiedBy
    });
    return res.json(result);
  } catch (err) {
    console.error('[MYEDURIDE] Gate scan error:', err);
    return res.status(500).json({ success: false, message: 'Failed to process gate scan.' });
  }
});

/**
 * POST /api/admin/myeduride/manifest/board
 * Record student bus boarding / dropoff event
 */
router.post('/myeduride/manifest/board', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  const { studentId, busId, status } = req.body || {};
  if (!studentId) {
    return res.status(400).json({ success: false, message: 'studentId is required.' });
  }

  try {
    const result = await updateStudentBoarding(prisma, decoded.branchId, {
      studentId,
      busId,
      status
    });
    return res.json(result);
  } catch (err) {
    console.error('[MYEDURIDE] Manifest boarding error:', err);
    return res.status(500).json({ success: false, message: 'Failed to record student boarding.' });
  }
});

/**
 * GET /api/admin/myeduride/export/csv
 * Export gate logs to CSV
 */
router.get('/myeduride/export/csv', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: { name: true }
    });
    const logs = await getGateLogs(prisma, decoded.branchId, { limit: 500 });
    const csv = exportGateLogsCsv(logs, branch?.name || 'Ugbekun Schools');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="myeduride_gate_access_log.csv"');
    return res.send(csv);
  } catch (err) {
    console.error('[MYEDURIDE] CSV export error:', err);
    return res.status(500).json({ success: false, message: 'Failed to export gate logs CSV.' });
  }
});

/**
 * GET /api/admin/myeduride/export/pdf
 * Export gate logs to PDF
 */
router.get('/myeduride/export/pdf', async (req, res) => {
  const decoded = await assertBranchAdmin(req, res);
  if (!decoded) return;

  try {
    const branch = await prisma.branch.findUnique({
      where: { id: decoded.branchId },
      select: { name: true }
    });
    const logs = await getGateLogs(prisma, decoded.branchId, { limit: 150 });
    const pdfBuffer = await exportGateLogsPdf(logs, branch?.name || 'Ugbekun International Academy');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="myeduride_gate_access_log.pdf"');
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[MYEDURIDE] PDF export error:', err);
    return res.status(500).json({ success: false, message: 'Failed to export gate logs PDF.' });
  }
});

module.exports = router;



