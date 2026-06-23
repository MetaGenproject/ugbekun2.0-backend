const express = require('express')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { getBranchStats, listStaffForBranch, staffMatchesBranch } = require('../lib/branchStats')
const { generateRegistrationNumber, bindEvaluationMatrix, wipeEvaluationMatrix, generateSecurePassword } = require('../lib/studentService')
const { sendOnboardingCredentials, sendTeacherOnboardingCredentials } = require('../lib/emailService')
const { generateCredentialSlipPdf } = require('../lib/pdfService')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')

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
    const where = { branchId: decoded.branchId, active: true }
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const [students, parents] = await Promise.all([
      prisma.student.findMany({
        where,
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
        where,
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          relation: true,
          email: true,
          mobileno: true,
          city: true,
          state: true,
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
        where: { branchId: decoded.branchId, active: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
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

    const { firstName, lastName, gender, birthday, classId, sectionId } = student
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
    const { name, email, phone } = req.body
    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Name and email are required.' })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' })
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
      const baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '.')
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

      const maxTeacher = await tx.teacher.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      const nextTeacherId = maxTeacher ? maxTeacher.id + 1 : 1

      const user = await tx.user.create({
        data: {
          id: nextUserId,
          username: uniqueUsername,
          password: hashedPassword,
          role: 3, // Teacher
          legacyUserId: nextTeacherId,
          active: true,
        },
      })

      // 3. Create Teacher Profile
      const teacher = await tx.teacher.create({
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
      console.error('[ADMIN] Teacher onboarding email dispatch error (non-blocking):', err.message)
      emailError = err.message
    }

    // ── Post-Transaction: Generate PDF Credential Slip ──────────────────
    let pdfBase64 = null
    try {
      const pdfBuffer = await generateCredentialSlipPdf({
        schoolName: branch?.name || 'Ugbekun School',
        branchCode: branch?.code || '',
        studentName: name, // For teacher slip, we put their name in the studentName slot
        registerNo: 'TEACHER',
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
      console.error('[ADMIN] Failed to generate teacher credential PDF slip:', pdfErr)
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
    console.error('[ADMIN] Teacher onboarding error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to onboard teacher.' })
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

module.exports = router
