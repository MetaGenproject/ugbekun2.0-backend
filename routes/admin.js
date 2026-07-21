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
              class: { select: { name: true } },
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
    if (![3, 4, 8, 9, 12, 13].includes(selectedRole)) {
      return res.status(400).json({ success: false, message: 'Invalid staff role.' })
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
    const { name, email, phone } = req.body
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
      const t = await tx.teacher.update({
        where: { id: teacherId },
        data: {
          name,
          email,
          phone: phone || null,
          updatedAt: new Date(),
        },
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
    const globalSetting = await prisma.globalSetting.findFirst({
      where: { branchId: decoded.branchId }
    })
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
    const globalSetting = await prisma.globalSetting.findFirst({
      where: { branchId: decoded.branchId }
    })
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

