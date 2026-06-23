const express = require('express')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { generateReportCardPdf, generateMontessoriReportCardPdf } = require('../lib/pdfService')

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

// Authentication guard specifically for Parents (Role 6)
async function assertParent(req, res, next) {
  const token = getBearerToken(req)
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided.' })
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (!decoded || decoded.role !== 6) {
      return res.status(403).json({ success: false, message: 'Access denied: Requires Parent role.' })
    }

    const parent = await prisma.parent.findFirst({
      where: {
        OR: [
          { userId: decoded.sub },
          { id: decoded.sub }
        ]
      }
    })

    if (!parent) {
      return res.status(403).json({ success: false, message: 'Parent profile not found.' })
    }

    req.parentId = parent.id
    req.branchId = parent.branchId
    next()
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Token is invalid or expired.' })
  }
}

// Security guard to check if requested student is linked to the parent
async function assertChildLinked(req, res, next) {
  const studentId = parseInt(req.params.studentId || req.query.studentId, 10)
  if (isNaN(studentId)) {
    return res.status(400).json({ success: false, message: 'Invalid Student ID provided.' })
  }

  try {
    const student = await prisma.student.findFirst({
      where: {
        id: studentId,
        parentId: req.parentId
      },
      include: {
        enrolls: {
          orderBy: { id: 'desc' },
          take: 1
        }
      }
    })

    if (!student) {
      return res.status(403).json({ success: false, message: 'Access denied: Student is not linked to this parent.' })
    }

    req.studentId = student.id
    req.studentBranchId = student.branchId
    
    const activeEnroll = student.enrolls[0]
    if (activeEnroll) {
      req.childClassId = activeEnroll.classId
      req.childSectionId = activeEnroll.sectionId
      req.childSessionId = activeEnroll.sessionId
    } else {
      const globalSetting = await prisma.globalSettings.findFirst()
      req.childSessionId = globalSetting?.sessionId || 5
    }

    next()
  } catch (error) {
    console.error('[PARENT] assertChildLinked error:', error)
    return res.status(500).json({ success: false, message: 'Internal validation error.' })
  }
}

router.use(assertParent)

/**
 * GET /api/parent/children
 * Returns the list of children associated with the parent.
 */
router.get('/children', async (req, res) => {
  try {
    const children = await prisma.student.findMany({
      where: {
        parentId: req.parentId,
        active: true
      },
      include: {
        enrolls: {
          include: {
            class: { select: { name: true } },
            section: { select: { name: true } }
          },
          orderBy: { id: 'desc' },
          take: 1
        }
      }
    })

    const formatted = children.map(child => {
      const enroll = child.enrolls[0] || null
      return {
        id: child.id,
        registerNo: child.registerNo,
        firstName: child.firstName,
        lastName: child.lastName,
        photo: child.photo,
        className: enroll?.class?.name || 'Not Enrolled',
        sectionName: enroll?.section?.name || 'N/A'
      }
    })

    res.json({ success: true, children: formatted })
  } catch (error) {
    console.error('[PARENT] Fetch children error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve children records.' })
  }
})

/**
 * GET /api/parent/child/:studentId/profile
 * Returns profile details for a specific child.
 */
router.get('/child/:studentId/profile', assertChildLinked, async (req, res) => {
  try {
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: {
        branch: { select: { name: true, code: true } }
      }
    })

    let classInfo = null
    let sectionInfo = null
    let fellowStudentsCount = 0
    let formTeacher = null
    let subjects = []

    if (req.childClassId && req.childSectionId) {
      classInfo = await prisma.class.findUnique({ where: { id: req.childClassId }, select: { name: true } })
      sectionInfo = await prisma.section.findUnique({ where: { id: req.childSectionId }, select: { name: true } })

      fellowStudentsCount = await prisma.enroll.count({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId
        }
      })

      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId
        },
        include: {
          teacher: { select: { name: true, email: true, phone: true } }
        }
      })
      formTeacher = formAllocation?.teacher || null

      const subjectAssigns = await prisma.subjectAssign.findMany({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId
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
      classId: req.childClassId || null,
      className: classInfo?.name || null,
      sectionId: req.childSectionId || null,
      sectionName: sectionInfo?.name || null,
      sessionId: req.childSessionId,
      fellowStudentsCount,
      formTeacher,
      subjects
    })
  } catch (error) {
    console.error('[PARENT] Child profile error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve child profile details.' })
  }
})

/**
 * GET /api/parent/child/:studentId/attendance
 * Returns child's daily logs and percentage score.
 */
router.get('/child/:studentId/attendance', assertChildLinked, async (req, res) => {
  try {
    const logs = await prisma.attendance.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId
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
    console.error('[PARENT] Child attendance error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve child attendance logs.' })
  }
})

/**
 * GET /api/parent/child/:studentId/tasks
 * Returns teacher notes and online exam assignments for the child.
 */
router.get('/child/:studentId/tasks', assertChildLinked, async (req, res) => {
  if (!req.childClassId) {
    return res.json({ success: true, notes: [], onlineExams: [] })
  }

  try {
    const allNotes = await prisma.teacherNote.findMany({
      where: { branchId: req.studentBranchId },
      include: {
        teacher: { select: { name: true } }
      }
    })

    const notes = allNotes
      .filter(n => n.classId.split(',').map(s => s.trim()).includes(String(req.childClassId)))
      .map(n => ({
        id: n.id,
        title: n.title,
        description: n.description,
        fileName: n.fileName,
        encName: n.encName,
        teacherName: n.teacher?.name || 'Staff',
        createdAt: n.createdAt
      }))

    const onlineExams = await prisma.onlineExam.findMany({
      where: {
        classId: req.childClassId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId
      },
      include: {
        subject: { select: { name: true } },
        submissions: {
          where: { studentId: req.studentId },
          select: { totalMark: true, createdAt: true }
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
          submitted: !!submission,
          score: submission ? submission.totalMark : null,
          submittedAt: submission ? submission.createdAt : null,
          createdAt: ex.createdAt
        }
      })
    })
  } catch (error) {
    console.error('[PARENT] Child tasks error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve child tasks.' })
  }
})

/**
 * GET /api/parent/child/:studentId/grades
 * Returns subject marks, class averages, and ranking for the child.
 */
router.get('/child/:studentId/grades', assertChildLinked, async (req, res) => {
  try {
    // Check if class is ECD
    let isEcdClass = false
    let clsInfo = null
    if (req.childClassId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: req.childClassId },
        select: { name: true, isEcd: true }
      })
      isEcdClass = !!clsInfo?.isEcd
    }

    if (isEcdClass) {
      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: req.studentId,
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId
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

    const studentMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        exam: { select: { id: true, name: true } }
      }
    })

    if (studentMarks.length === 0) {
      return res.json({ success: true, reportCard: [], overallAverage: 0, commentary: null })
    }

    const subjectIds = Array.from(new Set(studentMarks.map(m => m.subjectId)))
    const classMarks = await prisma.mark.findMany({
      where: {
        classId: req.childClassId,
        sectionId: req.childSectionId,
        sessionId: req.childSessionId,
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

    const commentary = await prisma.studentCommentary.findFirst({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId
      },
      select: { remark: true }
    })

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

    let rank = null
    let totalClassStudents = 0

    if (req.childClassId && req.childSectionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId
        },
        select: { studentId: true }
      })
      const studentIds = enrolls.map(e => e.studentId)
      totalClassStudents = studentIds.length

      if (studentIds.length > 0) {
        const allMarks = await prisma.mark.findMany({
          where: {
            studentId: { in: studentIds },
            sessionId: req.childSessionId,
            branchId: req.studentBranchId
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
    console.error('[PARENT] Child grades error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve child grade card.' })
  }
})

/**
 * GET /api/parent/child/:studentId/export-pdf
 * Generates child's report card PDF with custom rankings.
 */
router.get('/child/:studentId/export-pdf', assertChildLinked, async (req, res) => {
  try {
    const { rankingType = 'full', rankingLimit = 3 } = req.query
    const limit = parseInt(rankingLimit, 10) || 3

    // Check if class is ECD
    let isEcdClass = false
    let clsInfo = null
    if (req.childClassId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: req.childClassId },
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

      if (req.childSectionId) {
        const sec = await prisma.section.findUnique({ where: { id: req.childSectionId }, select: { name: true } })
        sectionName = sec?.name || 'N/A'
        const sess = await prisma.schoolYear.findUnique({ where: { id: req.childSessionId }, select: { schoolYear: true } })
        sessionName = sess?.schoolYear || 'N/A'

        const formAllocation = await prisma.teacherAllocation.findFirst({
          where: {
            classId: req.childClassId,
            sectionId: req.childSectionId,
            sessionId: req.childSessionId,
            branchId: req.studentBranchId
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
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
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

    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: {
        branch: { select: { name: true, code: true } }
      }
    })

    let className = 'N/A'
    let sectionName = 'N/A'
    let sessionName = 'N/A'
    let formTeacherName = 'Form Teacher'

    if (req.childClassId && req.childSectionId) {
      const cls = await prisma.class.findUnique({ where: { id: req.childClassId }, select: { name: true } })
      className = cls?.name || 'N/A'
      const sec = await prisma.section.findUnique({ where: { id: req.childSectionId }, select: { name: true } })
      sectionName = sec?.name || 'N/A'
      const sess = await prisma.schoolYear.findUnique({ where: { id: req.childSessionId }, select: { schoolYear: true } })
      sessionName = sess?.schoolYear || 'N/A'

      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId
        },
        include: {
          teacher: { select: { name: true } }
        }
      })
      if (formAllocation?.teacher) {
        formTeacherName = formAllocation.teacher.name
      }
    }

    const studentMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId
      },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } }
      }
    })

    if (studentMarks.length === 0) {
      return res.status(400).json({ success: false, message: 'No grade records found to export.' })
    }

    const subjectIds = Array.from(new Set(studentMarks.map(m => m.subjectId)))
    const classMarks = await prisma.mark.findMany({
      where: {
        classId: req.childClassId,
        sectionId: req.childSectionId,
        sessionId: req.childSessionId,
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

    let rank = null
    let totalClassStudents = 0

    if (req.childClassId && req.childSectionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId
        },
        select: { studentId: true }
      })
      const studentIds = enrolls.map(e => e.studentId)
      totalClassStudents = studentIds.length

      if (studentIds.length > 0) {
        const allMarks = await prisma.mark.findMany({
          where: {
            studentId: { in: studentIds },
            sessionId: req.childSessionId,
            branchId: req.studentBranchId
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

    const commentaryRecord = await prisma.studentCommentary.findFirst({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId
      },
      select: { remark: true }
    })

    const resumptionDate = studentMarks[0]?.exam.resumptionDate || null

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
    console.error('[PARENT] Export PDF error:', error)
    res.status(500).json({ success: false, message: 'Failed to generate PDF report card.' })
  }
})

module.exports = router
