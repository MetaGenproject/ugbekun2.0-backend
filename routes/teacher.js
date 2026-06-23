const express = require('express')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { isSubjectTeacher, isFormTeacher, hasClassAccess } = require('../lib/teacherAccess')
const { generateReportCardPdf, generateMontessoriReportCardPdf } = require('../lib/pdfService')

const router = express.Router()
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod'

// Helper to extract bearer token
function getBearerToken(req) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  return authHeader.slice('Bearer '.length)
}

// Authentication guard specifically for Teachers
async function assertTeacher(req, res, next) {
  const token = getBearerToken(req)
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided.' })
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (!decoded || decoded.role !== 3) {
      return res.status(403).json({ success: false, message: 'Access denied: Requires Teacher role.' })
    }

    const teacher = await prisma.teacher.findFirst({
      where: {
        OR: [
          { userId: decoded.sub },
          { id: decoded.sub }
        ]
      }
    })

    if (!teacher) {
      return res.status(403).json({ success: false, message: 'Teacher profile not found.' })
    }

    req.teacherId = teacher.id
    req.branchId = teacher.branchId
    next()
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Token is invalid or expired.' })
  }
}

// Apply authentication guard to all teacher routes
router.use(assertTeacher)

/**
 * GET /api/teacher/profile
 * Returns compound role assignments: Form class allocations and subject assignments.
 */
router.get('/profile', async (req, res) => {
  try {
    // 1. Fetch Form Teacher Allocations
    const formAllocations = await prisma.teacherAllocation.findMany({
      where: { teacherId: req.teacherId },
      include: {
        class: { select: { name: true, isEcd: true } },
        section: { select: { name: true } }
      }
    })

    // 2. Fetch Subject Teacher Assignments
    const subjectAssignments = await prisma.subjectAssign.findMany({
      where: { teacherId: req.teacherId },
      include: {
        class: { select: { name: true, isEcd: true } },
        section: { select: { name: true } },
        subject: { select: { name: true } }
      }
    })

    res.json({
      success: true,
      teacherId: req.teacherId,
      isFormTeacher: formAllocations.length > 0,
      isSubjectTeacher: subjectAssignments.length > 0,
      formAllocations: formAllocations.map(a => ({
        classId: a.classId,
        className: a.class.name,
        sectionId: a.sectionId,
        sectionName: a.section.name,
        isEcd: a.class.isEcd,
        sessionId: a.sessionId
      })),
      subjectAssignments: subjectAssignments.map(s => ({
        classId: s.classId,
        className: s.class.name,
        sectionId: s.sectionId,
        sectionName: s.section.name,
        subjectId: s.subjectId,
        subjectName: s.subject.name,
        isEcd: s.class.isEcd,
        sessionId: s.sessionId
      }))
    })
  } catch (error) {
    console.error('[TEACHER] Profile error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve teacher profile.' })
  }
})

/**
 * GET /api/teacher/exams
 * Fetch branch exams.
 */
router.get('/exams', async (req, res) => {
  try {
    const exams = await prisma.exam.findMany({
      where: {
        branchId: req.branchId,
        status: 1
      },
      select: {
        id: true,
        name: true
      }
    })
    res.json({ success: true, exams })
  } catch (error) {
    console.error('[TEACHER] Fetch exams error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch exams.' })
  }
})

/**
 * GET /api/teacher/students
 * Retrieve student roster for a class & section (Accessible if Form Teacher OR Subject Teacher).
 */
router.get('/students', async (req, res) => {
  const { classId, sectionId } = req.query
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' })
  }

  const hasAccess = await hasClassAccess(prisma, req.teacherId, classId, sectionId)
  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not allocated to this class.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            gender: true,
            commentaries: {
              where: { sessionId },
              select: { remark: true }
            }
          }
        }
      },
      orderBy: {
        student: {
          lastName: 'asc'
        }
      }
    })

    const students = enrolls.map(e => ({
      id: e.student.id,
      firstName: e.student.firstName,
      lastName: e.student.lastName,
      registerNo: e.student.registerNo,
      gender: e.student.gender,
      remark: e.student.commentaries[0]?.remark || ''
    }))

    res.json({ success: true, students })
  } catch (error) {
    console.error('[TEACHER] Students fetch error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch student roster.' })
  }
})

/**
 * GET /api/teacher/scores
 * Fetch scores for a specific class, section, subject, and exam.
 */
router.get('/scores', async (req, res) => {
  const { classId, sectionId, subjectId, examId } = req.query
  if (!classId || !sectionId || !subjectId || !examId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, subjectId, and examId are required.' })
  }

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId)
  if (!isAssigned) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not assigned to view grades for this subject.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const marks = await prisma.mark.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        subjectId: Number(subjectId),
        examId: Number(examId),
        sessionId,
        branchId: req.branchId
      },
      select: {
        id: true,
        studentId: true,
        mark: true,
        absent: true
      }
    })

    res.json({ success: true, marks })
  } catch (error) {
    console.error('[TEACHER] Scores fetch error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch scores.' })
  }
})

/**
 * POST /api/teacher/scores
 * Enter or modify raw scores for a subject (Confined to assigned Subject Teacher).
 */
router.post('/scores', async (req, res) => {
  const { classId, sectionId, subjectId, examId, scores } = req.body
  if (!classId || !sectionId || !subjectId || !examId || !Array.isArray(scores)) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' })
  }

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId)
  if (!isAssigned) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not assigned to enter grades for this subject.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Save grades transactionally
    const operations = []
    for (const s of scores) {
      // Find existing mark first to perform a clean upsert
      const existing = await prisma.mark.findFirst({
        where: {
          studentId: Number(s.studentId),
          subjectId: Number(subjectId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          examId: Number(examId),
          sessionId,
          branchId: req.branchId
        },
        select: { id: true }
      })

      if (existing) {
        operations.push(
          prisma.mark.update({
            where: { id: existing.id },
            data: {
              mark: s.mark !== undefined ? String(s.mark) : null,
              absent: s.absent ? '1' : null
            }
          })
        )
      } else {
        operations.push(
          prisma.mark.create({
            data: {
              studentId: Number(s.studentId),
              subjectId: Number(subjectId),
              classId: Number(classId),
              sectionId: Number(sectionId),
              examId: Number(examId),
              mark: s.mark !== undefined ? String(s.mark) : null,
              absent: s.absent ? '1' : null,
              sessionId,
              branchId: req.branchId
            }
          })
        )
      }
    }

    if (operations.length > 0) {
      await prisma.$transaction(operations)
    }

    res.json({ success: true, message: 'Scores saved successfully.' })
  } catch (error) {
    console.error('[TEACHER] Scores save error:', error)
    res.status(500).json({ success: false, message: error.message || 'Failed to save scores.' })
  }
})

/**
 * POST /api/teacher/attendance
 * Save class attendance (Confined exclusively to Form / Class Teacher).
 */
router.post('/attendance', async (req, res) => {
  const { classId, sectionId, attendanceDate, attendanceData } = req.body
  if (!classId || !sectionId || !attendanceDate || !Array.isArray(attendanceData)) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' })
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the designated Form Teacher can manage whole-class attendance registers.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5
    
    // Normalize date to UTC midnight
    const parsedDate = new Date(attendanceDate)
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid attendanceDate format.' })
    }
    const targetDate = new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate()))

    // Deduplicate incoming student records by studentId to prevent double-entry within the payload
    const uniqueRecordsMap = new Map()
    for (const item of attendanceData) {
      if (item.studentId) {
        uniqueRecordsMap.set(Number(item.studentId), item)
      }
    }
    const deduplicatedData = Array.from(uniqueRecordsMap.values())

    // Perform atomic transaction
    await prisma.$transaction(async (tx) => {
      // 1. Delete all existing records for this day, class, section, session, branch
      await tx.attendance.deleteMany({
        where: {
          classId: Number(classId),
          sectionId: Number(sectionId),
          attendanceDate: targetDate,
          sessionId,
          branchId: req.branchId
        }
      })

      // 2. Insert new records
      if (deduplicatedData.length > 0) {
        await tx.attendance.createMany({
          data: deduplicatedData.map(a => ({
            studentId: Number(a.studentId),
            classId: Number(classId),
            sectionId: Number(sectionId),
            attendanceDate: targetDate,
            status: a.status,
            remark: a.remark || null,
            sessionId,
            branchId: req.branchId
          }))
        })
      }
    })

    res.json({ success: true, message: 'Attendance register submitted successfully.' })
  } catch (error) {
    console.error('[TEACHER] Attendance save error:', error)
    res.status(500).json({ success: false, message: 'Failed to save attendance.' })
  }
})

/**
 * GET /api/teacher/attendance
 * Retrieve attendance for a class & section on a specific date.
 */
router.get('/attendance', async (req, res) => {
  const { classId, sectionId, attendanceDate } = req.query
  if (!classId || !sectionId || !attendanceDate) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and attendanceDate are required.' })
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can inspect class attendance registers.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5
    
    // Normalize date to UTC midnight
    const parsedDate = new Date(attendanceDate)
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid attendanceDate format.' })
    }
    const targetDate = new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate()))

    const attendanceRecords = await prisma.attendance.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        attendanceDate: targetDate,
        sessionId,
        branchId: req.branchId
      },
      select: {
        studentId: true,
        status: true,
        remark: true
      }
    })

    res.json({ success: true, attendance: attendanceRecords })
  } catch (error) {
    console.error('[TEACHER] Attendance fetch error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch attendance.' })
  }
})

/**
 * POST /api/teacher/commentary
 * Write holistic card comments/remarks (Confined exclusively to Form / Class Teacher).
 */
router.post('/commentary', async (req, res) => {
  const { classId, sectionId, studentId, remark } = req.body
  if (!classId || !sectionId || !studentId || remark === undefined) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' })
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can write card remarks for students in this class.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const existing = await prisma.studentCommentary.findUnique({
      where: {
        studentId_sessionId: {
          studentId: Number(studentId),
          sessionId
        }
      },
      select: { id: true }
    })

    if (existing) {
      await prisma.studentCommentary.update({
        where: { id: existing.id },
        data: { remark }
      })
    } else {
      await prisma.studentCommentary.create({
        data: {
          studentId: Number(studentId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          remark,
          sessionId,
          branchId: req.branchId
        }
      })
    }

    res.json({ success: true, message: 'Holistic remarks saved successfully.' })
  } catch (error) {
    console.error('[TEACHER] Commentary save error:', error)
    res.status(500).json({ success: false, message: 'Failed to save holistic remarks.' })
  }
})

/**
 * GET /api/teacher/report-cards
 * Access cross-subject compiled report card (Confined exclusively to Form / Class Teacher).
 */
router.get('/report-cards', async (req, res) => {
  const { classId, sectionId } = req.query
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' })
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can view compiled class report cards.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // 1. Fetch all marks in this class/section/session
    const marks = await prisma.mark.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId
      },
      include: {
        student: { select: { firstName: true, lastName: true, registerNo: true } },
        subject: { select: { name: true } },
        exam: { select: { name: true } }
      }
    })

    res.json({ success: true, marks })
  } catch (error) {
    console.error('[TEACHER] Report cards compile error:', error)
    res.status(500).json({ success: false, message: 'Failed to compile report card data.' })
  }
})

/**
 * GET /api/teacher/gradebook/sheet
 * Consolidates student rosters, theory marks, and objective exam submissions.
 */
router.get('/gradebook/sheet', async (req, res) => {
  const { classId, sectionId, subjectId, examId } = req.query
  if (!classId || !sectionId || !subjectId || !examId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, subjectId, and examId are required.' })
  }

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId)
  if (!isAssigned) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not assigned to view grades for this subject.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // 1. Fetch all enrolled students
    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId
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
      },
      orderBy: {
        student: {
          lastName: 'asc'
        }
      }
    })

    // 2. Fetch manual marks from the Mark model
    const marks = await prisma.mark.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        subjectId: Number(subjectId),
        examId: Number(examId),
        sessionId,
        branchId: req.branchId
      },
      select: {
        id: true,
        studentId: true,
        mark: true,
        absent: true
      }
    })

    // 3. Fetch automated objective exam submissions
    const onlineExams = await prisma.onlineExam.findMany({
      where: {
        classId: Number(classId),
        subjectId: Number(subjectId),
        sessionId,
        branchId: req.branchId
      },
      select: { id: true }
    })
    const onlineExamIds = onlineExams.map(oe => oe.id)

    const onlineSubmissions = onlineExamIds.length > 0
      ? await prisma.onlineExamSubmission.findMany({
          where: {
            onlineExamId: { in: onlineExamIds }
          },
          select: {
            studentId: true,
            totalMark: true
          }
        })
      : []

    // Map scores by studentId
    const markMap = new Map(marks.map(m => [m.studentId, m]))
    const onlineSubMap = new Map()
    for (const sub of onlineSubmissions) {
      const current = onlineSubMap.get(sub.studentId) || 0
      onlineSubMap.set(sub.studentId, current + sub.totalMark)
    }

    // 4. Combine into rows
    const rows = enrolls.map(e => {
      const student = e.student
      const markRec = markMap.get(student.id)
      const objectiveScore = onlineSubMap.get(student.id) || 0
      const theoryMark = markRec?.mark ? Number(markRec.mark) : null
      const absent = markRec?.absent === '1'

      return {
        studentId: student.id,
        registerNo: student.registerNo,
        firstName: student.firstName,
        lastName: student.lastName,
        gender: student.gender,
        theoryMark: absent ? null : theoryMark,
        objectiveMark: objectiveScore,
        absent
      }
    })

    res.json({ success: true, sheet: rows })
  } catch (error) {
    console.error('[TEACHER] Gradebook sheet compile error:', error)
    res.status(500).json({ success: false, message: 'Failed to compile gradebook sheet.' })
  }
})

/**
 * POST /api/teacher/gradebook/save-single
 * Upserts a single student's manual theory score.
 */
router.post('/gradebook/save-single', async (req, res) => {
  const { classId, sectionId, subjectId, examId, studentId, theoryMark, absent } = req.body
  if (!classId || !sectionId || !subjectId || !examId || !studentId) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' })
  }

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId)
  if (!isAssigned) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not assigned to enter grades for this subject.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const existing = await prisma.mark.findFirst({
      where: {
        studentId: Number(studentId),
        subjectId: Number(subjectId),
        classId: Number(classId),
        sectionId: Number(sectionId),
        examId: Number(examId),
        sessionId,
        branchId: req.branchId
      },
      select: { id: true }
    })

    const markValue = theoryMark !== undefined && theoryMark !== null && theoryMark !== '' ? String(theoryMark) : null
    const absentValue = absent ? '1' : null

    if (existing) {
      await prisma.mark.update({
        where: { id: existing.id },
        data: {
          mark: markValue,
          absent: absentValue
        }
      })
    } else {
      await prisma.mark.create({
        data: {
          studentId: Number(studentId),
          subjectId: Number(subjectId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          examId: Number(examId),
          mark: markValue,
          absent: absentValue,
          sessionId,
          branchId: req.branchId
        }
      })
    }

    res.json({ success: true, message: 'Grade saved successfully.' })
  } catch (error) {
    console.error('[TEACHER] Grade single save error:', error)
    res.status(500).json({ success: false, message: error.message || 'Failed to save grade.' })
  }
})

/**
 * POST /api/teacher/gradebook/csv-upload
 * Bulk uploads theory marks from CSV data.
 */
router.post('/gradebook/csv-upload', async (req, res) => {
  const { classId, sectionId, subjectId, examId, scores } = req.body
  if (!classId || !sectionId || !subjectId || !examId || !Array.isArray(scores)) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' })
  }

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId)
  if (!isAssigned) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not assigned to upload grades for this subject.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Get all students enrolled in this class/section to validate
    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId
      },
      include: {
        student: {
          select: {
            id: true,
            registerNo: true
          }
        }
      }
    })

    const studentMap = new Map(enrolls.map(e => [String(e.student.registerNo).trim().toLowerCase(), e.student.id]))

    const operations = []
    const results = { updated: 0, skipped: 0, errors: [] }

    for (const item of scores) {
      const regNo = String(item.registerNo || '').trim().toLowerCase()
      const studentId = studentMap.get(regNo)

      if (!studentId) {
        results.skipped++
        results.errors.push(`Registration number ${item.registerNo} not found in this class section.`)
        continue
      }

      const theoryMark = item.theoryMark !== undefined && item.theoryMark !== null && item.theoryMark !== '' ? String(item.theoryMark) : null
      const absent = item.absent ? '1' : null

      // Find existing mark first to perform a clean upsert
      const existing = await prisma.mark.findFirst({
        where: {
          studentId,
          subjectId: Number(subjectId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          examId: Number(examId),
          sessionId,
          branchId: req.branchId
        },
        select: { id: true }
      })

      if (existing) {
        operations.push(
          prisma.mark.update({
            where: { id: existing.id },
            data: {
              mark: theoryMark,
              absent
            }
          })
        )
      } else {
        operations.push(
          prisma.mark.create({
            data: {
              studentId,
              subjectId: Number(subjectId),
              classId: Number(classId),
              sectionId: Number(sectionId),
              examId: Number(examId),
              mark: theoryMark,
              absent,
              sessionId,
              branchId: req.branchId
            }
          })
        )
      }
      results.updated++
    }

    if (operations.length > 0) {
      await prisma.$transaction(operations)
    }

    res.json({ success: true, results })
  } catch (error) {
    console.error('[TEACHER] CSV upload save error:', error)
    res.status(500).json({ success: false, message: error.message || 'Failed to bulk import scores.' })
  }
})

/**
 * GET /api/teacher/report-cards/export-pdf
 * Generates an A4 report card PDF for a student (Form Teacher only).
 */
router.get('/report-cards/export-pdf', async (req, res) => {
  const { classId, sectionId, studentId, rankingType = 'full', rankingLimit = 3 } = req.query
  if (!classId || !sectionId || !studentId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and studentId are required.' })
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can compile and export class report cards.'
    })
  }

  try {
    const limit = parseInt(rankingLimit, 10) || 3
    const parsedStudentId = Number(studentId)
    const parsedClassId = Number(classId)
    const parsedSectionId = Number(sectionId)

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Check if class is ECD
    const cls = await prisma.class.findUnique({
      where: { id: parsedClassId },
      select: { name: true, isEcd: true }
    })

    // 1. Fetch student info
    const student = await prisma.student.findUnique({
      where: { id: parsedStudentId },
      include: {
        branch: { select: { name: true, code: true } }
      }
    })

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' })
    }

    if (cls?.isEcd) {
      // Resolve details
      const sec = await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } })
      const sectionName = sec?.name || 'N/A'
      const sess = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } })
      const sessionName = sess?.schoolYear || 'N/A'

      let formTeacherName = 'Form Teacher'
      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: parsedClassId,
          sectionId: parsedSectionId,
          sessionId,
          branchId: req.branchId
        },
        include: {
          teacher: { select: { name: true } }
        }
      })
      if (formAllocation?.teacher) {
        formTeacherName = formAllocation.teacher.name
      }

      const examIdVal = req.query.examId ? Number(req.query.examId) : undefined

      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: parsedStudentId,
          classId: parsedClassId,
          sectionId: parsedSectionId,
          sessionId,
          branchId: req.branchId,
          ...(examIdVal ? { examId: examIdVal } : {})
        },
        include: {
          exam: { select: { name: true, resumptionDate: true } }
        }
      })

      const examName = assessment?.exam?.name || 'Term Evaluation'
      const resumptionDate = assessment?.exam?.resumptionDate || null

      const pdfBuffer = await generateMontessoriReportCardPdf({
        schoolName: student.branch?.name || 'Ugbekun Schools',
        branchCode: student.branch?.code || 'GEN',
        studentName: `${student.lastName}, ${student.firstName}`,
        registerNo: student.registerNo,
        className: cls.name,
        sectionName,
        sessionName,
        examName,
        assessment: assessment || {},
        resumptionDate,
        formTeacherName
      })

      const safeLastName = (student.lastName || 'Student').replace(/\s+/g, '_')
      const safeFirstName = (student.firstName || 'Grades').replace(/\s+/g, '_')

      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="report_card_${safeLastName}_${safeFirstName}.pdf"`)
      return res.send(pdfBuffer)
    }

    // 2. Fetch Class, Section, and Session info
    const className = cls?.name || 'N/A'
    const sec = await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } })
    const sectionName = sec?.name || 'N/A'
    const sess = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } })
    const sessionName = sess?.schoolYear || 'N/A'

    let formTeacherName = 'Form Teacher'
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: {
        classId: parsedClassId,
        sectionId: parsedSectionId,
        sessionId,
        branchId: req.branchId
      },
      include: {
        teacher: { select: { name: true } }
      }
    })
    if (formAllocation?.teacher) {
      formTeacherName = formAllocation.teacher.name
    }

    // 3. Fetch marks
    const studentMarks = await prisma.mark.findMany({
      where: {
        studentId: parsedStudentId,
        sessionId,
        branchId: req.branchId
      },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } }
      }
    })

    if (studentMarks.length === 0) {
      return res.status(400).json({ success: false, message: 'No grade records found to export.' })
    }

    // Class average lookup
    const subjectIds = Array.from(new Set(studentMarks.map(m => m.subjectId)))
    const classMarks = await prisma.mark.findMany({
      where: {
        classId: parsedClassId,
        sectionId: parsedSectionId,
        sessionId,
        subjectId: { in: subjectIds }
      }
    })

    const classAverageMap = {}
    classMarks.forEach(m => {
      const key = `${m.examId}-${m.subjectId}`
      if (!classAverageMap[key]) {
        classAverageMap[key] = { sum: 0, count: 0 }
      }
      if (m.mark && m.mark !== '{}' && m.mark !== '') {
        const val = parseFloat(m.mark)
        if (!isNaN(val)) {
          classAverageMap[key].sum += val
          classAverageMap[key].count += 1
        }
      }
    })

    // 4. Map report card lines
    let totalScoreSum = 0
    let marksCount = 0

    const reportCard = studentMarks.map(m => {
      let markValue = null
      let studentScore = NaN
      if (m.mark && m.mark !== '{}' && m.mark !== '') {
        const parsed = parseFloat(m.mark)
        if (!isNaN(parsed)) {
          studentScore = parsed
          markValue = String(parsed)
        }
      }

      if (!isNaN(studentScore)) {
        totalScoreSum += studentScore
        marksCount++
      }

      const avgKey = `${m.examId}-${m.subjectId}`
      const avgData = classAverageMap[avgKey]
      const classAverage = avgData && avgData.count > 0 
        ? Number((avgData.sum / avgData.count).toFixed(1)) 
        : (isNaN(studentScore) ? 0 : studentScore)

      return {
        id: m.id,
        examName: m.exam.name,
        subjectName: m.subject.name,
        subjectCode: m.subject.subjectCode,
        mark: markValue,
        absent: m.absent === '1' || m.absent === 'true',
        classAverage
      }
    })

    const overallAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0

    // 5. Calculate class rankings
    let rank = null
    let totalClassStudents = 0

    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: parsedClassId,
        sectionId: parsedSectionId,
        sessionId,
        branchId: req.branchId
      },
      select: { studentId: true }
    })
    const studentIds = enrolls.map(e => e.studentId)
    totalClassStudents = studentIds.length

    if (studentIds.length > 0) {
      const allMarks = await prisma.mark.findMany({
        where: {
          studentId: { in: studentIds },
          sessionId,
          branchId: req.branchId
        },
        select: { studentId: true, mark: true }
      })

      const studentAggregates = {}
      studentIds.forEach(id => {
        studentAggregates[id] = { sum: 0, count: 0 }
      })

      allMarks.forEach(m => {
        if (m.mark && m.mark !== '{}' && m.mark !== '') {
          const val = parseFloat(m.mark)
          if (!isNaN(val)) {
            studentAggregates[m.studentId].sum += val
            studentAggregates[m.studentId].count += 1
          }
        }
      })

      const rankedList = studentIds.map(id => {
        const agg = studentAggregates[id]
        const average = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(2)) : 0
        return { studentId: id, average }
      })

      rankedList.sort((a, b) => b.average - a.average)

      const myIndex = rankedList.findIndex(x => x.studentId === parsedStudentId)
      if (myIndex !== -1) {
        rank = myIndex + 1
      }
    }

    // 6. Fetch commentary
    const commentaryRecord = await prisma.studentCommentary.findFirst({
      where: {
        studentId: parsedStudentId,
        sessionId
      },
      select: { remark: true }
    })

    // Resumption Date
    const resumptionDate = studentMarks[0]?.exam.resumptionDate || null

    // Generate PDF buffer
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
      commentary: commentaryRecord?.remark || '',
      rank,
      totalClassStudents,
      rankingType,
      rankingLimit: limit,
      resumptionDate,
      formTeacherName
    })

    const safeLastName = (student.lastName || 'Student').replace(/\s+/g, '_')
    const safeFirstName = (student.firstName || 'Grades').replace(/\s+/g, '_')

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="report_card_${safeLastName}_${safeFirstName}.pdf"`)
    res.send(pdfBuffer)

  } catch (error) {
    console.error('[TEACHER] Export PDF error:', error)
    res.status(500).json({ success: false, message: 'Failed to generate PDF report card.' })
  }
})

/**
 * GET /api/teacher/montessori/sheet
 * Consolidates early childhood students and their Montessori & Narrative assessments.
 */
router.get('/montessori/sheet', async (req, res) => {
  const { classId, sectionId, examId } = req.query
  if (!classId || !sectionId || !examId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and examId are required.' })
  }

  const cid = Number(classId)
  const sid = Number(sectionId)
  const eid = Number(examId)

  try {
    // Verify class is marked as ECD
    const cls = await prisma.class.findUnique({
      where: { id: cid },
      select: { isEcd: true }
    })
    if (!cls || !cls.isEcd) {
      return res.status(400).json({ success: false, message: 'This class is not configured for Montessori evaluations.' })
    }

    const access = await hasClassAccess(prisma, req.teacherId, cid, sid)
    if (!access) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have teaching allocations in this classroom.'
      })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // 1. Fetch enrolled students
    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: cid,
        sectionId: sid,
        sessionId,
        branchId: req.branchId
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
      },
      orderBy: {
        student: {
          lastName: 'asc'
        }
      }
    })

    // 2. Fetch existing Montessori assessments
    const assessments = await prisma.montessoriAssessment.findMany({
      where: {
        classId: cid,
        sectionId: sid,
        examId: eid,
        sessionId,
        branchId: req.branchId
      }
    })

    const assessmentMap = new Map(assessments.map(a => [a.studentId, a]))

    // 3. Map into rows
    const rows = enrolls.map(e => {
      const student = e.student
      const evalRec = assessmentMap.get(student.id) || {}

      return {
        studentId: student.id,
        registerNo: student.registerNo,
        firstName: student.firstName,
        lastName: student.lastName,
        gender: student.gender,
        writingMastery: evalRec.writingMastery || '',
        drawingCapability: evalRec.drawingCapability || '',
        physicalCoordination: evalRec.physicalCoordination || '',
        motorSkillProgression: evalRec.motorSkillProgression || '',
        generalPunctuality: evalRec.generalPunctuality || '',
        peerRespect: evalRec.peerRespect || '',
        aestheticNeatness: evalRec.aestheticNeatness || '',
        activeGroupParticipation: evalRec.activeGroupParticipation || '',
        narrativeComment: evalRec.narrativeComment || ''
      }
    })

    res.json({ success: true, sheet: rows })
  } catch (error) {
    console.error('[TEACHER] Montessori sheet fetch error:', error)
    res.status(500).json({ success: false, message: 'Failed to compile Montessori sheet.' })
  }
})

/**
 * POST /api/teacher/montessori/save-single
 * Saves or updates a single early childhood student's Montessori & Narrative inputs.
 */
router.post('/montessori/save-single', async (req, res) => {
  const {
    classId,
    sectionId,
    examId,
    studentId,
    writingMastery,
    drawingCapability,
    physicalCoordination,
    motorSkillProgression,
    generalPunctuality,
    peerRespect,
    aestheticNeatness,
    activeGroupParticipation,
    narrativeComment
  } = req.body

  if (!classId || !sectionId || !examId || !studentId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, examId, and studentId are required.' })
  }

  const cid = Number(classId)
  const sid = Number(sectionId)
  const eid = Number(examId)
  const studId = Number(studentId)

  try {
    // Verify class is marked as ECD
    const cls = await prisma.class.findUnique({
      where: { id: cid },
      select: { isEcd: true }
    })
    if (!cls || !cls.isEcd) {
      return res.status(400).json({ success: false, message: 'This class is not configured for Montessori evaluations.' })
    }

    const access = await hasClassAccess(prisma, req.teacherId, cid, sid)
    if (!access) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have teaching allocations in this classroom.'
      })
    }

    // Validate rubrics
    const validRubrics = ['EM', 'DV', 'AC', 'MS', null, '']
    const rubricsToCheck = [
      writingMastery, drawingCapability, physicalCoordination, motorSkillProgression,
      generalPunctuality, peerRespect, aestheticNeatness, activeGroupParticipation
    ]

    for (const rubric of rubricsToCheck) {
      if (rubric !== undefined && !validRubrics.includes(rubric)) {
        return res.status(400).json({ success: false, message: `Invalid rubric value: ${rubric}. Must be one of EM, DV, AC, MS.` })
      }
    }

    // Validate comment length
    if (narrativeComment && narrativeComment.length > 500) {
      return res.status(400).json({ success: false, message: 'Narrative comment exceeds the maximum limit of 500 characters.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Check if record exists
    const existing = await prisma.montessoriAssessment.findFirst({
      where: {
        studentId: studId,
        examId: eid,
        sessionId,
        branchId: req.branchId
      },
      select: { id: true }
    })

    const payload = {
      writingMastery: writingMastery || null,
      drawingCapability: drawingCapability || null,
      physicalCoordination: physicalCoordination || null,
      motorSkillProgression: motorSkillProgression || null,
      generalPunctuality: generalPunctuality || null,
      peerRespect: peerRespect || null,
      aestheticNeatness: aestheticNeatness || null,
      activeGroupParticipation: activeGroupParticipation || null,
      narrativeComment: narrativeComment || null
    }

    if (existing) {
      await prisma.montessoriAssessment.update({
        where: { id: existing.id },
        data: payload
      })
    } else {
      await prisma.montessoriAssessment.create({
        data: {
          studentId: studId,
          classId: cid,
          sectionId: sid,
          examId: eid,
          sessionId,
          branchId: req.branchId,
          ...payload
        }
      })
    }

    res.json({ success: true, message: 'Montessori assessment saved successfully.' })
  } catch (error) {
    console.error('[TEACHER] Montessori save error:', error)
    res.status(500).json({ success: false, message: 'Failed to save Montessori assessment.' })
  }
})

// --- DYNAMIC HOMEWORK & ONLINE EXAMS ENDPOINTS ---

// GET /api/teacher/homeworks
router.get('/homeworks', async (req, res) => {
  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const homeworks = await prisma.homework.findMany({
      where: {
        branchId: req.branchId,
        sessionId
      },
      include: {
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, homeworks })
  } catch (error) {
    console.error('[TEACHER] Get homeworks error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve homeworks.' })
  }
})

// POST /api/teacher/homeworks
router.post('/homeworks', async (req, res) => {
  const { title, description, classId, subjectId, dueDate, questions } = req.body
  if (!title || !classId || !subjectId || !dueDate) {
    return res.status(400).json({ success: false, message: 'Title, Class, Subject, and Due Date are required.' })
  }
  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const homework = await prisma.homework.create({
      data: {
        title,
        description,
        classId: Number(classId),
        subjectId: Number(subjectId),
        dueDate: new Date(dueDate),
        questions: questions || [],
        branchId: req.branchId,
        sessionId
      }
    })
    res.json({ success: true, homework, message: 'Homework published successfully.' })
  } catch (error) {
    console.error('[TEACHER] Create homework error:', error)
    res.status(500).json({ success: false, message: 'Failed to publish homework.' })
  }
})

// GET /api/teacher/homeworks/:id/submissions
router.get('/homeworks/:id/submissions', async (req, res) => {
  const { id } = req.params
  try {
    const submissions = await prisma.homeworkSubmission.findMany({
      where: { homeworkId: Number(id) },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, submissions })
  } catch (error) {
    console.error('[TEACHER] Get homework submissions error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve submissions.' })
  }
})

// POST /api/teacher/homeworks/submissions/:id/grade
router.post('/homeworks/submissions/:id/grade', async (req, res) => {
  const { id } = req.params
  const { score, feedback } = req.body
  try {
    const submission = await prisma.homeworkSubmission.update({
      where: { id: Number(id) },
      data: {
        score: score !== undefined ? Number(score) : null,
        feedback: feedback || null
      }
    })
    res.json({ success: true, submission, message: 'Submission graded successfully.' })
  } catch (error) {
    console.error('[TEACHER] Grade homework submission error:', error)
    res.status(500).json({ success: false, message: 'Failed to save grade/feedback.' })
  }
})

// GET /api/teacher/online-exams
router.get('/online-exams', async (req, res) => {
  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const exams = await prisma.onlineExam.findMany({
      where: {
        branchId: req.branchId,
        sessionId
      },
      include: {
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, exams })
  } catch (error) {
    console.error('[TEACHER] Get online-exams error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve online exams.' })
  }
})

// POST /api/teacher/online-exams
router.post('/online-exams', async (req, res) => {
  const { title, classId, subjectId, passingMark, questions, duration } = req.body
  if (!title || !classId || !subjectId) {
    return res.status(400).json({ success: false, message: 'Title, Class, and Subject are required.' })
  }
  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const exam = await prisma.onlineExam.create({
      data: {
        title,
        classId: Number(classId),
        subjectId: Number(subjectId),
        passingMark: passingMark !== undefined ? Number(passingMark) : 0,
        duration: duration !== undefined ? Number(duration) : 0,
        questions: questions || [],
        branchId: req.branchId,
        sessionId
      }
    })
    res.json({ success: true, exam, message: 'Online exam published successfully.' })
  } catch (error) {
    console.error('[TEACHER] Create online exam error:', error)
    res.status(500).json({ success: false, message: 'Failed to publish online exam.' })
  }
})

// GET /api/teacher/online-exams/:id/submissions
router.get('/online-exams/:id/submissions', async (req, res) => {
  const { id } = req.params
  try {
    const submissions = await prisma.onlineExamSubmission.findMany({
      where: { onlineExamId: Number(id) },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, submissions })
  } catch (error) {
    console.error('[TEACHER] Get online-exam submissions error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve submissions.' })
  }
})

// POST /api/teacher/online-exams/submissions/:id/grade
router.post('/online-exams/submissions/:id/grade', async (req, res) => {
  const { id } = req.params
  const { score } = req.body
  try {
    const submission = await prisma.onlineExamSubmission.update({
      where: { id: Number(id) },
      data: {
        totalMark: Number(score)
      }
    })
    res.json({ success: true, submission, message: 'Submission graded successfully.' })
  } catch (error) {
    console.error('[TEACHER] Grade online-exam submission error:', error)
    res.status(500).json({ success: false, message: 'Failed to save grade.' })
  }
})

module.exports = router
