const express = require('express')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { generateReportCardPdf, generateMontessoriReportCardPdf } = require('../lib/pdfService')
const gamificationService = require('../lib/gamificationService')
const companionService = require('../lib/companionService')
const walletService = require('../lib/walletService')

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

// Authentication guard specifically for Students (Role 7)
async function assertStudent(req, res, next) {
  const token = getBearerToken(req)
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided.' })
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (!decoded || decoded.role !== 7) {
      return res.status(403).json({ success: false, message: 'Access denied: Requires Student role.' })
    }

    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { userId: decoded.sub },
          { id: decoded.sub }
        ]
      },
      include: {
        enrolls: {
          orderBy: { id: 'desc' },
          take: 1
        }
      }
    })

    if (!student) {
      return res.status(403).json({ success: false, message: 'Student profile not found.' })
    }

    req.studentId = student.id
    req.branchId = student.branchId
    
    // Inject active enrollment info if present
    const activeEnroll = student.enrolls[0]
    if (activeEnroll) {
      req.classId = activeEnroll.classId
      req.sectionId = activeEnroll.sectionId
      req.sessionId = activeEnroll.sessionId
    } else {
      // Fallback to active global settings session if not enrolled
      const globalSetting = await prisma.globalSettings.findFirst()
      req.sessionId = globalSetting?.sessionId || 5
    }

    next()
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Token is invalid or expired.' })
  }
}

// Apply authentication guard to all student routes
router.use(assertStudent)

/**
 * GET /api/student/profile
 * Returns compound student profile and class details.
 */
router.get('/profile', async (req, res) => {
  try {
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: {
        branch: { select: { name: true, code: true } }
      }
    })

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student profile not found.' })
    }

    let classInfo = null
    let sectionInfo = null
    let fellowStudentsCount = 0
    let formTeacher = null
    let subjects = []

    if (req.classId && req.sectionId) {
      // Fetch Class & Section names
      classInfo = await prisma.class.findUnique({ where: { id: req.classId }, select: { name: true } })
      sectionInfo = await prisma.section.findUnique({ where: { id: req.sectionId }, select: { name: true } })

      // Count fellow students in same room and session
      fellowStudentsCount = await prisma.enroll.count({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId
        }
      })

      // Fetch Form Teacher details
      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId
        },
        include: {
          teacher: { select: { name: true, email: true, phone: true } }
        }
      })
      formTeacher = formAllocation?.teacher || null

      // Fetch Subject details assigned to this class
      const subjectAssigns = await prisma.subjectAssign.findMany({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId
        },
        include: {
          subject: { select: { name: true, subjectCode: true, subjectType: true } }
        }
      })
      subjects = subjectAssigns.map(sa => ({
        id: sa.subject.id,
        name: sa.subject.name,
        code: sa.subject.subjectCode,
        type: sa.subject.subjectType
      }))
    }

    res.json({
      success: true,
      studentId: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      registerNo: student.registerNo,
      gender: student.gender,
      photo: student.photo,
      branchName: student.branch?.name || null,
      classId: req.classId || null,
      className: classInfo?.name || null,
      sectionId: req.sectionId || null,
      sectionName: sectionInfo?.name || null,
      sessionId: req.sessionId,
      fellowStudentsCount,
      formTeacher,
      subjects
    })
  } catch (error) {
    console.error('[STUDENT] Profile error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve profile details.' })
  }
})

/**
 * GET /api/student/attendance
 * Returns daily logs and summary calculation.
 */
router.get('/attendance', async (req, res) => {
  try {
    const logs = await prisma.attendance.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.sessionId,
        branchId: req.branchId
      },
      orderBy: { attendanceDate: 'desc' }
    })

    const totalDays = logs.length
    const presentCount = logs.filter(l => l.status === 'Present').length
    const absentCount = logs.filter(l => l.status === 'Absent').length
    const lateCount = logs.filter(l => l.status === 'Late').length
    const percentage = totalDays > 0 ? ((presentCount + lateCount) / totalDays) * 100 : 100

    res.json({
      success: true,
      percentage: Number(percentage.toFixed(1)),
      totalDays,
      presentCount,
      absentCount,
      lateCount,
      logs: logs.map(l => ({
        id: l.id,
        attendanceDate: l.attendanceDate,
        status: l.status,
        remark: l.remark
      }))
    })
  } catch (error) {
    console.error('[STUDENT] Attendance error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve attendance logs.' })
  }
})

/**
 * GET /api/student/tasks
 * Returns teacher notes and online exam assignments.
 */
router.get('/tasks', async (req, res) => {
  if (!req.classId) {
    return res.json({ success: true, notes: [], onlineExams: [], homeworks: [] })
  }

  try {
    // 1. Fetch teacher notes/study guides
    const allNotes = await prisma.teacherNote.findMany({
      where: { branchId: req.branchId },
      include: {
        teacher: { select: { name: true } }
      }
    })

    // Filter in JS since teacherNote.classId is stored as a string or comma-separated list
    const notes = allNotes
      .filter(n => n.classId.split(',').map(s => s.trim()).includes(String(req.classId)))
      .map(n => ({
        id: n.id,
        title: n.title,
        description: n.description,
        fileName: n.fileName,
        encName: n.encName,
        teacherName: n.teacher?.name || 'Staff',
        createdAt: n.createdAt
      }))

    // 2. Fetch online assessments allocated to this class
    const onlineExams = await prisma.onlineExam.findMany({
      where: {
        classId: req.classId,
        sessionId: req.sessionId,
        branchId: req.branchId
      },
      include: {
        subject: { select: { name: true } },
        submissions: {
          where: { studentId: req.studentId },
          select: { totalMark: true, answers: true, startedAt: true, submittedAt: true, createdAt: true }
        }
      }
    })

    // 3. Fetch homework allocated to this class
    const homeworks = await prisma.homework.findMany({
      where: {
        classId: req.classId,
        sessionId: req.sessionId,
        branchId: req.branchId
      },
      include: {
        subject: { select: { name: true } },
        submissions: {
          where: { studentId: req.studentId },
          select: { score: true, answers: true, feedback: true, createdAt: true }
        }
      }
    })

    res.json({
      success: true,
      notes,
      onlineExams: onlineExams.map(ex => {
        const submission = ex.submissions[0] || null
        return {
          id: ex.id,
          title: ex.title,
          subjectName: ex.subject.name,
          passingMark: ex.passingMark,
          duration: ex.duration || 0,
          questions: ex.questions || [],
          submitted: submission ? (submission.totalMark !== null) : false,
          started: submission ? (submission.startedAt !== null) : false,
          score: submission ? submission.totalMark : null,
          answers: submission ? submission.answers : null,
          startedAt: submission ? submission.startedAt : null,
          submittedAt: submission ? submission.submittedAt : null,
          examDate: ex.examDate,
          createdAt: ex.createdAt
        }
      }),
      homeworks: homeworks.map(hw => {
        const submission = hw.submissions[0] || null
        return {
          id: hw.id,
          title: hw.title,
          description: hw.description,
          subjectName: hw.subject.name,
          dueDate: hw.dueDate,
          questions: hw.questions || [],
          submitted: !!submission,
          score: submission ? submission.score : null,
          feedback: submission ? submission.feedback : null,
          answers: submission ? submission.answers : null,
          submittedAt: submission ? submission.createdAt : null,
          createdAt: hw.createdAt
        }
      })
    })
  } catch (error) {
    console.error('[STUDENT] Tasks error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve tasks.' })
  }
})

/**
 * GET /api/student/grades
 * Returns subject marks, class averages, and term report cards.
 */
router.get('/grades', async (req, res) => {
  try {
    // Check if class is ECD
    let isEcdClass = false
    let clsInfo = null
    if (req.classId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: req.classId },
        select: { name: true, isEcd: true }
      })
      isEcdClass = !!clsInfo?.isEcd
    }

    if (isEcdClass) {
      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: req.studentId,
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId
        },
        include: {
          exam: { select: { name: true } }
        }
      })
      return res.json({
        success: true,
        isEcd: true,
        assessment: assessment || {
          writingMastery: '',
          drawingCapability: '',
          physicalCoordination: '',
          motorSkillProgression: '',
          generalPunctuality: '',
          peerRespect: '',
          aestheticNeatness: '',
          activeGroupParticipation: '',
          narrativeComment: ''
        }
      })
    }

    // 1. Retrieve all marks for this student in the current session
    const studentMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.sessionId,
        branchId: req.branchId
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        exam: { select: { id: true, name: true } }
      }
    })

    if (studentMarks.length === 0) {
      return res.json({ success: true, reportCard: [], overallAverage: 0, commentary: null })
    }

    // 2. Calculate class averages for the subjects the student is taking
    const subjectIds = Array.from(new Set(studentMarks.map(m => m.subjectId)))
    const classMarks = await prisma.mark.findMany({
      where: {
        classId: req.classId,
        sectionId: req.sectionId,
        sessionId: req.sessionId,
        subjectId: { in: subjectIds }
      }
    })

    // Calculate averages helper map
    const classAverageMap = {}
    classMarks.forEach(m => {
      const key = `${m.examId}-${m.subjectId}`
      if (!classAverageMap[key]) {
        classAverageMap[key] = { sum: 0, count: 0 }
      }
      const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0
      const examVal = m.mark ? parseFloat(m.mark) : 0
      const totalVal = testVal + examVal
      if (m.cbtMark !== null || m.mark !== null) {
        classAverageMap[key].sum += totalVal
        classAverageMap[key].count += 1
      }
    })

    // 3. Fetch Form Teacher commentary
    const commentary = await prisma.studentCommentary.findFirst({
      where: {
        studentId: req.studentId,
        sessionId: req.sessionId,
        status: 'PRINCIPAL_SIGNED_OFF'
      },
      select: { remark: true }
    })

    // 4. Map report card lines
    let totalScoreSum = 0
    let marksCount = 0

    const reportCard = studentMarks.map(m => {
      const testScore = m.cbtMark !== null ? parseFloat(m.cbtMark) : 0
      const examScore = m.mark !== null ? parseFloat(m.mark) : 0
      const totalScore = testScore + examScore

      let markValue = null
      let studentScore = NaN
      if (m.cbtMark !== null || m.mark !== null) {
        studentScore = totalScore
        markValue = String(totalScore)
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
        cbtMark: m.cbtMark !== null ? String(testScore) : null,
        theoryMark: m.mark !== null ? String(examScore) : null,
        mark: markValue,
        absent: m.absent === '1' || m.absent === 'true',
        classAverage
      }
    })

    const overallAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0

    // 5. Calculate class rankings
    let rank = null
    let totalClassStudents = 0

    if (req.classId && req.sectionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
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
            sessionId: req.sessionId,
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

        const myIndex = rankedList.findIndex(x => x.studentId === req.studentId)
        if (myIndex !== -1) {
          rank = myIndex + 1
        }
      }
    }

    res.json({
      success: true,
      reportCard,
      overallAverage,
      commentary: commentary?.remark || null,
      rank,
      totalClassStudents
    })
  } catch (error) {
    console.error('[STUDENT] Grades error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve grade card.' })
  }
})

/**
 * GET /api/student/grades/export-pdf
 * Generates a unified A4 report card PDF.
 */
router.get('/grades/export-pdf', async (req, res) => {
  try {
    const { rankingType = 'full', rankingLimit = 3 } = req.query
    const limit = parseInt(rankingLimit, 10) || 3

    // Check if class is ECD
    let isEcdClass = false
    let clsInfo = null
    if (req.classId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: req.classId },
        select: { name: true, isEcd: true }
      })
      isEcdClass = !!clsInfo?.isEcd
    }

    if (isEcdClass) {
      const student = await prisma.student.findUnique({
        where: { id: req.studentId },
        include: {
          branch: { select: { name: true, code: true } }
        }
      })
      if (!student) {
        return res.status(404).json({ success: false, message: 'Student not found.' })
      }

      let sectionName = 'N/A'
      let sessionName = 'N/A'
      let formTeacherName = 'Form Teacher'

      if (req.sectionId) {
        const sec = await prisma.section.findUnique({ where: { id: req.sectionId }, select: { name: true } })
        sectionName = sec?.name || 'N/A'
        const sess = await prisma.schoolYear.findUnique({ where: { id: req.sessionId }, select: { schoolYear: true } })
        sessionName = sess?.schoolYear || 'N/A'

        const formAllocation = await prisma.teacherAllocation.findFirst({
          where: {
            classId: req.classId,
            sectionId: req.sectionId,
            sessionId: req.sessionId,
            branchId: req.branchId
          },
          include: {
            teacher: { select: { name: true } }
          }
        })
        if (formAllocation?.teacher) {
          formTeacherName = formAllocation.teacher.name
        }
      }

      const examIdVal = req.query.examId ? Number(req.query.examId) : undefined

      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: req.studentId,
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
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
        className: clsInfo.name,
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

    // 1. Fetch student info
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: {
        branch: { select: { name: true, code: true } }
      }
    })

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' })
    }

    // 2. Fetch Class, Section, and Session info
    let className = 'N/A'
    let sectionName = 'N/A'
    let sessionName = 'N/A'
    let formTeacherName = 'Form Teacher'

    if (req.classId && req.sectionId) {
      const cls = await prisma.class.findUnique({ where: { id: req.classId }, select: { name: true } })
      className = cls?.name || 'N/A'
      const sec = await prisma.section.findUnique({ where: { id: req.sectionId }, select: { name: true } })
      sectionName = sec?.name || 'N/A'
      const sess = await prisma.schoolYear.findUnique({ where: { id: req.sessionId }, select: { schoolYear: true } })
      sessionName = sess?.schoolYear || 'N/A'

      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId
        },
        include: {
          teacher: { select: { name: true } }
        }
      })
      if (formAllocation?.teacher) {
        formTeacherName = formAllocation.teacher.name
      }
    }

    // 3. Fetch marks
    const studentMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.sessionId,
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
        classId: req.classId,
        sectionId: req.sectionId,
        sessionId: req.sessionId,
        subjectId: { in: subjectIds }
      }
    })

    // Calculate averages helper map
    const classAverageMap = {}
    classMarks.forEach(m => {
      const key = `${m.examId}-${m.subjectId}`
      if (!classAverageMap[key]) {
        classAverageMap[key] = { sum: 0, count: 0 }
      }
      const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0
      const examVal = m.mark ? parseFloat(m.mark) : 0
      const totalVal = testVal + examVal
      if (m.cbtMark !== null || m.mark !== null) {
        classAverageMap[key].sum += totalVal
        classAverageMap[key].count += 1
      }
    })

    // 4. Map report card lines
    let totalScoreSum = 0
    let marksCount = 0

    const reportCard = studentMarks.map(m => {
      const testScore = m.cbtMark !== null ? parseFloat(m.cbtMark) : 0
      const examScore = m.mark !== null ? parseFloat(m.mark) : 0
      const totalScore = testScore + examScore

      let markValue = null
      let studentScore = NaN
      if (m.cbtMark !== null || m.mark !== null) {
        studentScore = totalScore
        markValue = String(totalScore)
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
        cbtMark: m.cbtMark !== null ? String(testScore) : null,
        theoryMark: m.mark !== null ? String(examScore) : null,
        mark: markValue,
        absent: m.absent === '1' || m.absent === 'true',
        classAverage
      }
    })

    const overallAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0

    // 5. Calculate class rankings
    let rank = null
    let totalClassStudents = 0

    if (req.classId && req.sectionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
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
            sessionId: req.sessionId,
            branchId: req.branchId
          },
          select: { studentId: true, mark: true, cbtMark: true }
        })

        const studentAggregates = {}
        studentIds.forEach(id => {
          studentAggregates[id] = { sum: 0, count: 0 }
        })

        allMarks.forEach(m => {
          const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0
          const examVal = m.mark ? parseFloat(m.mark) : 0
          const totalVal = testVal + examVal
          if (m.cbtMark !== null || m.mark !== null) {
            studentAggregates[m.studentId].sum += totalVal
            studentAggregates[m.studentId].count += 1
          }
        })

        const rankedList = studentIds.map(id => {
          const agg = studentAggregates[id]
          const average = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(2)) : 0
          return { studentId: id, average }
        })

        rankedList.sort((a, b) => b.average - a.average)

        const myIndex = rankedList.findIndex(x => x.studentId === req.studentId)
        if (myIndex !== -1) {
          rank = myIndex + 1
        }
      }
    }

    // 6. Fetch commentary
    const commentaryRecord = await prisma.studentCommentary.findFirst({
      where: {
        studentId: req.studentId,
        sessionId: req.sessionId,
        status: 'PRINCIPAL_SIGNED_OFF'
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
    console.error('[STUDENT] Export PDF error:', error)
    res.status(500).json({ success: false, message: 'Failed to generate PDF report card.' })
  }
})

// Submit Homework
router.post('/homeworks/:id/submit', async (req, res) => {
  const { id } = req.params
  const { answers } = req.body // Array of { questionId, answerText, fileUrl, audioUrl }
  if (!answers || !Array.isArray(answers)) {
    return res.status(400).json({ success: false, message: 'Answers array is required.' })
  }
  try {
    const homework = await prisma.homework.findUnique({
      where: { id: Number(id) }
    })
    if (!homework) {
      return res.status(404).json({ success: false, message: 'Homework assignment not found.' })
    }

    // Check if already submitted
    const existing = await prisma.homeworkSubmission.findFirst({
      where: {
        homeworkId: homework.id,
        studentId: req.studentId
      }
    })
    if (existing) {
      return res.status(400).json({ success: false, message: 'You have already submitted this homework.' })
    }

    // Hybrid auto-grading logic
    const questions = (homework.questions || [])
    let totalScore = 0
    let hasManual = false

    for (const q of questions) {
      const studentAns = answers.find(a => a.questionId === q.id)
      if (q.type === 'MCQ' || q.type === 'TF') {
        if (studentAns && String(studentAns.answerText).trim().toLowerCase() === String(q.correctAnswer).trim().toLowerCase()) {
          totalScore += Number(q.points || 1)
        }
      } else if (q.type === 'DOCUMENT' || q.type === 'AUDIO') {
        hasManual = true
      }
    }

    const submission = await prisma.homeworkSubmission.create({
      data: {
        homeworkId: homework.id,
        studentId: req.studentId,
        answers,
        score: totalScore,
        feedback: hasManual ? 'Pending manual grading for documents/audios.' : 'Auto-graded.'
      }
    })

    // Trigger gamification early homework submission check
    gamificationService.checkHomeworkSubmissionEarly(prisma, req.studentId, submission.id, req.branchId)
      .catch(err => console.error('[Gamification] Error in early homework submission check:', err.message))

    res.json({ success: true, submission, message: 'Homework submitted successfully.' })
  } catch (error) {
    console.error('[STUDENT] Homework submission error:', error)
    res.status(500).json({ success: false, message: 'Failed to submit homework.' })
  }
})

// Start Online Exam
router.post('/online-exams/:id/start', async (req, res) => {
  const { id } = req.params
  try {
    const exam = await prisma.onlineExam.findUnique({
      where: { id: Number(id) }
    })
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Online exam not found.' })
    }

    if (exam.examDate && new Date(exam.examDate).getTime() > Date.now()) {
      return res.status(400).json({ success: false, message: 'This scheduled CBT exam has not started yet.' })
    }

    // Check for existing attempt/submission
    const existing = await prisma.onlineExamSubmission.findFirst({
      where: {
        onlineExamId: exam.id,
        studentId: req.studentId
      }
    })

    if (existing) {
      // If they have already completed/submitted, deny starting again
      if (existing.submittedAt !== null || existing.totalMark !== null) {
        return res.status(400).json({ success: false, message: 'You have already attempted and submitted this exam. It cannot be reattempted.' })
      }

      // If they started but haven't submitted yet, check if time limit has passed
      if (exam.duration && exam.duration > 0 && existing.startedAt) {
        const elapsedMinutes = (Date.now() - new Date(existing.startedAt).getTime()) / 60000
        if (elapsedMinutes > exam.duration + 1) { // 1 minute grace period
          // Auto-submit as 0/expired
          await prisma.onlineExamSubmission.update({
            where: { id: existing.id },
            data: {
              totalMark: 0,
              submittedAt: new Date()
            }
          })
          return res.status(400).json({ success: false, message: 'Time limit for this exam has expired. It cannot be reattempted.' })
        }
      }

      // Within duration, allow them to resume/continue
      return res.json({
        success: true,
        message: 'Resuming online exam attempt.',
        startedAt: existing.startedAt,
        duration: exam.duration
      })
    }

    // No existing attempt, create a new one
    const submission = await prisma.onlineExamSubmission.create({
      data: {
        onlineExamId: exam.id,
        studentId: req.studentId,
        totalMark: null,
        startedAt: new Date()
      }
    })

    res.json({
      success: true,
      message: 'Online exam started successfully.',
      startedAt: submission.startedAt,
      duration: exam.duration
    })
  } catch (error) {
    console.error('[STUDENT] Start online exam error:', error)
    res.status(500).json({ success: false, message: 'Failed to start online exam.' })
  }
})

// Submit Online Exam
router.post('/online-exams/:id/submit', async (req, res) => {
  const { id } = req.params
  const { answers } = req.body // Array of { questionId, answerText, fileUrl, audioUrl }
  if (!answers || !Array.isArray(answers)) {
    return res.status(400).json({ success: false, message: 'Answers array is required.' })
  }
  try {
    const exam = await prisma.onlineExam.findUnique({
      where: { id: Number(id) }
    })
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Online exam not found.' })
    }

    // Find the student's active attempt
    const existing = await prisma.onlineExamSubmission.findFirst({
      where: {
        onlineExamId: exam.id,
        studentId: req.studentId
      }
    })

    if (!existing) {
      return res.status(400).json({ success: false, message: 'No active attempt found. You must start the exam first.' })
    }

    if (existing.submittedAt !== null || existing.totalMark !== null) {
      return res.status(400).json({ success: false, message: 'You have already submitted this exam.' })
    }

    // Verify time limit if exam is timed
    if (exam.duration && exam.duration > 0 && existing.startedAt) {
      const elapsedMinutes = (Date.now() - new Date(existing.startedAt).getTime()) / 60000
      if (elapsedMinutes > exam.duration + 1) { // 1 minute buffer
        // Mark as submitted with 0 score (time-bound restriction)
        await prisma.onlineExamSubmission.update({
          where: { id: existing.id },
          data: {
            totalMark: 0,
            submittedAt: new Date()
          }
        })
        return res.status(400).json({ success: false, message: 'Time limit exceeded. Your attempt could not be submitted and is marked as invalid.' })
      }
    }

    // Hybrid auto-grading logic
    const questions = (exam.questions || [])
    let totalScore = 0

    for (const q of questions) {
      const studentAns = answers.find(a => a.questionId === q.id)
      if (q.type === 'MCQ' || q.type === 'TF') {
        if (studentAns && String(studentAns.answerText).trim().toLowerCase() === String(q.correctAnswer).trim().toLowerCase()) {
          totalScore += Number(q.points || 1)
        }
      }
    }

    const submission = await prisma.onlineExamSubmission.update({
      where: { id: existing.id },
      data: {
        answers,
        totalMark: totalScore,
        submittedAt: new Date()
      }
    })

    // Trigger gamification online exam check
    gamificationService.checkOnlineExamPerformance(prisma, req.studentId, submission.id, req.branchId)
      .catch(err => console.error('[Gamification] Error in exam performance check:', err.message))

    res.json({ success: true, submission, message: 'Online exam submitted successfully.' })
  } catch (error) {
    console.error('[STUDENT] Online exam submission error:', error)
    res.status(500).json({ success: false, message: 'Failed to submit online exam.' })
  }
})

// =============================================================================
// MANAGED MEDIA LIBRARY & VIRTUAL CLASSROOMS FOR STUDENTS
// =============================================================================

// Helper to generate Jitsi room token for student
function generateStudentJitsiToken({ roomName, student }) {
  const appId = process.env.JITSI_APP_ID || 'vpaas-magic-cookie-ugbekun';
  const appSecret = process.env.JITSI_APP_SECRET || 'jitsi_dummy_secret_key';
  
  const payload = {
    aud: 'jitsi',
    iss: appId,
    sub: appId,
    room: roomName,
    moderator: false,
    context: {
      user: {
        id: `student_${student.id}`,
        name: `${student.firstName} ${student.lastName}`,
        email: student.email || '',
        avatar: student.photo || ''
      },
      features: {
        recording: false,
        livestreaming: false,
        'screen-sharing': true
      }
    }
  }
  return jwt.sign(payload, appSecret, { algorithm: 'HS256', expiresIn: '2h' })
}

// GET /api/student/media
router.get('/media', async (req, res) => {
  try {
    if (!req.classId) {
      return res.json({ success: true, items: [] })
    }

    const classObj = await prisma.class.findUnique({
      where: { id: req.classId },
      select: { nameNumeric: true }
    })

    let tier = 'Primary'
    if (classObj) {
      const num = parseInt(classObj.nameNumeric)
      if (isNaN(num) || num < 1) {
        tier = 'Preschool'
      } else if (num >= 7) {
        tier = 'Secondary'
      }
    }

    const items = await prisma.mediaItem.findMany({
      where: { classTier: tier },
      orderBy: { createdAt: 'desc' }
    })

    res.json({ success: true, items })
  } catch (error) {
    console.error('[STUDENT] Fetch media error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch media library.' })
  }
})

// GET /api/student/live-rooms
router.get('/live-rooms', async (req, res) => {
  try {
    if (!req.classId) {
      return res.json({ success: true, rooms: [] })
    }

    const rooms = await prisma.liveRoom.findMany({
      where: {
        type: 'STUDENT_CLASSROOM',
        classId: req.classId,
        sectionId: req.sectionId || undefined
      },
      orderBy: { scheduledAt: 'desc' }
    })

    res.json({ success: true, rooms })
  } catch (error) {
    console.error('[STUDENT] Fetch live rooms error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch live classrooms.' })
  }
})

// GET /api/student/live-rooms/:roomName/token
router.get('/live-rooms/:roomName/token', async (req, res) => {
  const { roomName } = req.params
  try {
    const room = await prisma.liveRoom.findUnique({
      where: { roomName }
    })
    if (!room) {
      return res.status(404).json({ success: false, message: 'Classroom room not found.' })
    }

    if (room.type === 'STUDENT_CLASSROOM' && room.classId !== req.classId) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not enrolled in this class.' })
    }

    const student = await prisma.student.findUnique({
      where: { id: req.studentId }
    })

    const token = generateStudentJitsiToken({
      roomName,
      student
    })

    res.json({ success: true, token, roomName })
  } catch (error) {
    console.error('[STUDENT] Live token error:', error)
    res.status(500).json({ success: false, message: 'Failed to generate live classroom token.' })
  }
})

// =============================================================================
// INTERNAL TRIVIA STREAM ENGINE
// =============================================================================

// GET /api/student/trivia/active
router.get('/trivia/active', assertStudent, async (req, res) => {
  try {
    // Fetch all active questions (global pool — no branch filter on TriviaQuestion)
    const questions = await prisma.triviaQuestion.findMany({
      where: { active: true },
      orderBy: { id: 'desc' }
    });

    // Fetch student's own submissions
    const submissions = await prisma.triviaSubmission.findMany({
      where: { studentId: req.studentId }
    });

    const answeredMap = {};
    submissions.forEach(s => {
      answeredMap[s.triviaQuestionId] = {
        isCorrect: s.isCorrect,
        selectedOption: s.selectedOption
      };
    });

    const mappedQuestions = questions.map(q => {
      const submission = answeredMap[q.id];
      return {
        id: q.id,
        questionText: q.questionText,
        options: q.options,
        timeLimitSeconds: q.timeLimitSeconds,
        points: q.points,
        difficulty: q.difficulty,
        answered: !!submission,
        isCorrect: submission ? submission.isCorrect : null,
        selectedOption: submission ? submission.selectedOption : null
      };
    });

    const streakRecord = await prisma.studentTriviaStreak.findFirst({
      where: { studentId: req.studentId }
    });

    res.json({
      success: true,
      questions: mappedQuestions,
      streak: streakRecord ? {
        currentStreak: streakRecord.currentStreak,
        highestStreak: streakRecord.highestStreak
      } : { currentStreak: 0, highestStreak: 0 }
    });
  } catch (error) {
    console.error('[STUDENT] Active trivia error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve active trivia.' });
  }
});

// POST /api/student/trivia/submit
router.post('/trivia/submit', assertStudent, async (req, res) => {
  const { triviaQuestionId, selectedOption, timeTakenMs } = req.body;
  if (triviaQuestionId === undefined || selectedOption === undefined || timeTakenMs === undefined) {
    return res.status(400).json({ success: false, message: 'triviaQuestionId, selectedOption, and timeTakenMs are required.' });
  }

  try {
    const question = await prisma.triviaQuestion.findUnique({
      where: { id: Number(triviaQuestionId) }
    });

    if (!question) {
      return res.status(404).json({ success: false, message: 'Trivia question not found.' });
    }

    // Check if already answered
    const existing = await prisma.triviaSubmission.findFirst({
      where: {
        triviaQuestionId: question.id,
        studentId: req.studentId
      }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'You have already answered this question.' });
    }

    // Anti-cheat checks
    if (timeTakenMs < 500) {
      return res.status(400).json({ success: false, message: 'Submission rejected: Answered suspiciously fast.' });
    }

    const timeLimitMs = (question.timeLimitSeconds + 3) * 1000; // 3-second buffer for network latency
    if (timeTakenMs > timeLimitMs) {
      return res.status(400).json({ success: false, message: 'Submission rejected: Time limit exceeded.' });
    }

    const isCorrect = (Number(selectedOption) === question.correctOption);

    // Save submission
    await prisma.triviaSubmission.create({
      data: {
        studentId: req.studentId,
        triviaQuestionId: question.id,
        selectedOption: Number(selectedOption),
        isCorrect,
        timeTakenMs
      }
    });

    let currentStreak = 0;
    let streakBonus = 0;
    let pointsAwarded = 0;

    if (isCorrect) {
      // Manage streak
      const streakRecord = await prisma.studentTriviaStreak.findFirst({
        where: { studentId: req.studentId }
      });

      const now = new Date();
      if (!streakRecord) {
        currentStreak = 1;
        await prisma.studentTriviaStreak.create({
          data: {
            studentId: req.studentId,
            currentStreak: 1,
            highestStreak: 1,
            lastActiveDate: now
          }
        });
      } else {
        const lastDate = new Date(streakRecord.lastActiveDate);
        // Compare dates ignoring time
        const todayZero = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const lastZero = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate());
        const diffTime = Math.abs(todayZero - lastZero);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays === 1) {
          currentStreak = streakRecord.currentStreak + 1;
          await prisma.studentTriviaStreak.update({
            where: { id: streakRecord.id },
            data: {
              currentStreak,
              highestStreak: Math.max(streakRecord.highestStreak, currentStreak),
              lastActiveDate: now
            }
          });
        } else if (diffDays === 0) {
          currentStreak = streakRecord.currentStreak;
          await prisma.studentTriviaStreak.update({
            where: { id: streakRecord.id },
            data: { lastActiveDate: now }
          });
        } else {
          // Streak broken, start fresh
          currentStreak = 1;
          await prisma.studentTriviaStreak.update({
            where: { id: streakRecord.id },
            data: {
              currentStreak: 1,
              lastActiveDate: now
            }
          });
        }
      }

      // Streak bonus: 5 XP per streak count (capped at 50 XP bonus)
      streakBonus = Math.min(currentStreak * 5, 50);
      pointsAwarded = question.points + streakBonus;

      // Award Points
      await gamificationService.awardPoints(prisma, {
        actorType: 'STUDENT',
        actorId: req.studentId,
        points: pointsAwarded,
        actionType: 'TRIVIA_CORRECT',
        referenceEntity: 'TriviaQuestion',
        referenceId: question.id,
        branchId: req.branchId,
        metadata: { selectedOption, streakBonus, currentStreak }
      });
    } else {
      // Incorrect answer: reset streak to 0
      const streakRecord = await prisma.studentTriviaStreak.findFirst({
        where: { studentId: req.studentId }
      });
      if (streakRecord) {
        await prisma.studentTriviaStreak.update({
          where: { id: streakRecord.id },
          data: {
            currentStreak: 0,
            lastActiveDate: new Date()
          }
        });
      }
    }

    res.json({
      success: true,
      isCorrect,
      correctOption: question.correctOption,
      pointsAwarded,
      currentStreak
    });
  } catch (error) {
    console.error('[STUDENT] Trivia submission error:', error);
    res.status(500).json({ success: false, message: 'Failed to process trivia submission.' });
  }
});

// GET /api/student/gamification/profile
router.get('/gamification/profile', assertStudent, async (req, res) => {
  try {
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      select: { xp: true, firstName: true, lastName: true }
    });

    const streak = await prisma.studentTriviaStreak.findFirst({
      where: { studentId: req.studentId }
    });

    const badges = await prisma.studentBadge.findMany({
      where: { studentId: req.studentId },
      include: { badge: true }
    });

    const recentLedger = await prisma.gamificationLedger.findMany({
      where: { actorType: 'STUDENT', actorId: req.studentId },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    // Get rank info from LeaderboardCache
    const periods = await gamificationService.getPeriodKeys(prisma);
    const weeklyPeriodKey = `WEEKLY_${periods.WEEKLY}`;
    const alltimePeriodKey = `ALL_TIME_${periods.ALL_TIME}`;

    // Get weekly rank
    const weeklyCache = await prisma.leaderboardCache.findUnique({
      where: {
        entityType_entityId_period_branchId: {
          entityType: 'STUDENT',
          entityId: req.studentId,
          period: weeklyPeriodKey,
          branchId: req.branchId
        }
      }
    });

    // Get all time rank
    const alltimeCache = await prisma.leaderboardCache.findUnique({
      where: {
        entityType_entityId_period_branchId: {
          entityType: 'STUDENT',
          entityId: req.studentId,
          period: alltimePeriodKey,
          branchId: req.branchId
        }
      }
    });

    res.json({
      success: true,
      xp: student?.xp || 0,
      streak: streak ? { currentStreak: streak.currentStreak, highestStreak: streak.highestStreak } : { currentStreak: 0, highestStreak: 0 },
      badges: badges.map(sb => sb.badge),
      recentLedger,
      weeklyRank: weeklyCache?.rank || '-',
      alltimeRank: alltimeCache?.rank || '-'
    });
  } catch (error) {
    console.error('[STUDENT] Get gamification profile error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve gamification profile.' });
  }
});

// GET /api/student/gamification/leaderboard
router.get('/gamification/leaderboard', assertStudent, async (req, res) => {
  const { periodType = 'WEEKLY' } = req.query;
  try {
    const periods = await gamificationService.getPeriodKeys(prisma);
    let periodKey = '';
    if (periodType === 'WEEKLY') {
      periodKey = `WEEKLY_${periods.WEEKLY}`;
    } else {
      periodKey = `ALL_TIME_${periods.ALL_TIME}`;
    }

    const cacheEntries = await prisma.leaderboardCache.findMany({
      where: {
        entityType: 'STUDENT',
        period: periodKey,
        branchId: req.branchId
      },
      orderBy: { points: 'desc' },
      take: 10
    });

    const studentIds = cacheEntries.map(e => e.entityId);
    const students = await prisma.student.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, firstName: true, lastName: true }
    });

    const studentMap = {};
    students.forEach(s => {
      studentMap[s.id] = `${s.firstName} ${s.lastName}`;
    });

    const leaderboard = cacheEntries.map((entry, index) => ({
      rank: index + 1,
      studentId: entry.entityId,
      studentName: studentMap[entry.entityId] || `Student #${entry.entityId}`,
      points: entry.points
    }));

    res.json({
      success: true,
      leaderboard
    });
  } catch (error) {
    console.error('[STUDENT] Get leaderboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve leaderboard.' });
  }
});

/**
 * GET /api/student/events
 * Fetch all events for the current branch.
 */
router.get('/events', async (req, res) => {
  const branchId = req.branchId

  try {
    const globalSetting = await prisma.globalSetting.findFirst({
      where: { branchId }
    })
    const sessionId = globalSetting?.sessionId || 5

    const events = await prisma.event.findMany({
      where: {
        branchId,
        sessionId
      },
      orderBy: {
        startDate: 'asc'
      }
    })

    return res.json({ success: true, events })
  } catch (error) {
    console.error('[STUDENT] Get events error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch events.' })
  }
})

module.exports = router
