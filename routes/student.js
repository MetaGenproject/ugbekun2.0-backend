const express = require('express')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { generateReportCardPdf, generateMontessoriReportCardPdf } = require('../lib/pdfService')
const { autoGradeCbtSubmission } = require('../lib/cbtService')
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
 * GET /api/student/dashboard-overview
 * Aggregated dashboard data for the new Student Portal design.
 * Returns profile, KPI stats, timetable, assignments, exams, attendance, fees, activities, events.
 */
router.get('/dashboard-overview', async (req, res) => {
  try {
    const today = new Date()
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    const todayDayName = dayNames[today.getDay()]

    // ── 1. Student Profile ──────────────────────────────────────────────
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: { branch: { select: { name: true } } }
    })
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' })
    }

    let classInfo = null, sectionInfo = null, fellowStudentsCount = 0
    let formTeacher = null, subjects = []
    if (req.classId && req.sectionId) {
      ;[classInfo, sectionInfo, fellowStudentsCount] = await Promise.all([
        prisma.class.findUnique({ where: { id: req.classId }, select: { name: true } }),
        prisma.section.findUnique({ where: { id: req.sectionId }, select: { name: true } }),
        prisma.enroll.count({ where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId } })
      ])
      const formAlloc = await prisma.teacherAllocation.findFirst({
        where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId },
        include: { teacher: { select: { name: true, email: true, phone: true } } }
      })
      formTeacher = formAlloc?.teacher || null

      const subjectAssigns = await prisma.subjectAssign.findMany({
        where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId },
        include: { subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } } }
      })
      subjects = subjectAssigns.map(sa => ({
        id: sa.subject.id,
        name: sa.subject.name,
        code: sa.subject.subjectCode,
        type: sa.subject.subjectType
      }))
    }

    const profile = {
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
    }

    // ── 2. Attendance KPI ─────────────────────────────────────────────────
    const attendanceLogs = await prisma.attendance.findMany({
      where: { studentId: req.studentId, sessionId: req.sessionId, branchId: req.branchId },
      orderBy: { attendanceDate: 'desc' }
    })
    const totalDays = attendanceLogs.length
    const presentCount = attendanceLogs.filter(l => l.status === 'Present').length
    const absentCount = attendanceLogs.filter(l => l.status === 'Absent').length
    const lateCount = attendanceLogs.filter(l => l.status === 'Late').length
    const attendancePct = totalDays > 0 ? Number(((presentCount + lateCount) / totalDays * 100).toFixed(1)) : 100

    const attendance = {
      percentage: attendancePct,
      totalDays,
      presentCount,
      absentCount,
      lateCount,
      logs: attendanceLogs.slice(0, 30).map(l => ({
        id: l.id,
        attendanceDate: l.attendanceDate,
        status: l.status,
        remark: l.remark
      }))
    }

    // ── 3. Grades / Average / Rank ──────────────────────────────────────
    let overallAverage = 0, rank = null, totalClassStudents = fellowStudentsCount
    let subjectPerformance = [] // [{name, score}]

    const studentMarks = await prisma.mark.findMany({
      where: { studentId: req.studentId, sessionId: req.sessionId, branchId: req.branchId },
      include: { subject: { select: { name: true } } }
    })

    if (studentMarks.length > 0) {
      let totalScoreSum = 0, marksCount = 0
      const subjectMap = {}

      studentMarks.forEach(m => {
        const testScore = m.cbtMark !== null ? parseFloat(m.cbtMark) : 0
        const examScore = m.mark !== null ? parseFloat(m.mark) : 0
        const total = testScore + examScore
        if (m.cbtMark !== null || m.mark !== null) {
          totalScoreSum += total
          marksCount++
          const sName = m.subject?.name || 'Unknown'
          if (!subjectMap[sName]) subjectMap[sName] = { sum: 0, count: 0 }
          subjectMap[sName].sum += total
          subjectMap[sName].count++
        }
      })

      overallAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0
      subjectPerformance = Object.entries(subjectMap).map(([name, d]) => ({
        name,
        score: Number((d.sum / d.count).toFixed(1))
      }))

      // Compute rank within class
      if (req.classId && req.sectionId) {
        const enrolls = await prisma.enroll.findMany({
          where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId },
          select: { studentId: true }
        })
        const studentIds = enrolls.map(e => e.studentId)
        totalClassStudents = studentIds.length

        if (studentIds.length > 0) {
          const allMarks = await prisma.mark.findMany({
            where: { studentId: { in: studentIds }, sessionId: req.sessionId, branchId: req.branchId },
            select: { studentId: true, mark: true, cbtMark: true }
          })
          const agg = {}
          studentIds.forEach(id => { agg[id] = { sum: 0, count: 0 } })
          allMarks.forEach(m => {
            const v = (parseFloat(m.cbtMark || '0') || 0) + (parseFloat(m.mark || '0') || 0)
            if (m.mark || m.cbtMark) { agg[m.studentId].sum += v; agg[m.studentId].count++ }
          })
          const ranked = studentIds
            .map(id => ({ id, avg: agg[id].count > 0 ? agg[id].sum / agg[id].count : 0 }))
            .sort((a, b) => b.avg - a.avg)
          const idx = ranked.findIndex(x => x.id === req.studentId)
          if (idx !== -1) rank = idx + 1
        }
      }
    }

    // ── 4. Today's Timetable ──────────────────────────────────────────────
    let todayTimetable = []
    if (req.classId && req.sectionId) {
      const slots = await prisma.timetableSlot.findMany({
        where: { classId: req.classId, sectionId: req.sectionId, branchId: req.branchId, dayOfWeek: todayDayName },
        include: {
          subject: { select: { name: true } },
          teacher: { select: { name: true } },
          section: { select: { name: true } }
        },
        orderBy: { startTime: 'asc' }
      })
      todayTimetable = slots.map(s => ({
        id: s.id,
        startTime: s.startTime,
        endTime: s.endTime,
        type: s.type,
        title: s.title || s.subject?.name || 'Period',
        teacherName: s.teacher?.name || null,
        roomLabel: s.section?.name || null
      }))
    }

    // ── 5. Upcoming Assignments (Homeworks) ──────────────────────────────
    let upcomingHomeworks = []
    if (req.classId) {
      const homeworks = await prisma.homework.findMany({
        where: { classId: req.classId, branchId: req.branchId },
        include: { subject: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
        take: 6
      })
      const submittedHwIds = new Set(
        (await prisma.homeworkSubmission.findMany({
          where: { studentId: req.studentId, homeworkId: { in: homeworks.map(h => h.id) } },
          select: { homeworkId: true }
        })).map(s => s.homeworkId)
      )
      upcomingHomeworks = homeworks.map(hw => {
        const dueDate = new Date(hw.dueDate)
        const diffDays = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        let deadlineBadge = 'Upcoming'
        if (diffDays < 0) deadlineBadge = 'Overdue'
        else if (diffDays === 0) deadlineBadge = 'Due Today'
        else if (diffDays === 1) deadlineBadge = 'Due Tomorrow'
        else deadlineBadge = `${diffDays} Days Left`
        return {
          id: hw.id,
          title: hw.title,
          subjectName: hw.subject?.name || 'General',
          dueDate: hw.dueDate,
          deadlineBadge,
          diffDays,
          submitted: submittedHwIds.has(hw.id)
        }
      })
    }

    // ── 6. Upcoming CBT / Exams ─────────────────────────────────────────
    let upcomingExams = []
    if (req.classId) {
      const onlineExams = await prisma.onlineExam.findMany({
        where: { classId: req.classId, branchId: req.branchId },
        include: { subject: { select: { name: true } } },
        orderBy: { examDate: 'asc' },
        take: 6
      })
      const submittedExIds = new Set(
        (await prisma.onlineExamSubmission.findMany({
          where: { studentId: req.studentId, onlineExamId: { in: onlineExams.map(e => e.id) } },
          select: { onlineExamId: true }
        })).map(s => s.onlineExamId)
      )
      upcomingExams = onlineExams.map(ex => {
        const examDate = ex.examDate ? new Date(ex.examDate) : null
        const diffDays = examDate ? Math.ceil((examDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null
        let deadlineBadge = 'Available'
        if (diffDays === null) deadlineBadge = 'Available'
        else if (diffDays < 0) deadlineBadge = 'Past'
        else if (diffDays === 0) deadlineBadge = 'Today'
        else deadlineBadge = `${diffDays} Days Left`
        return {
          id: ex.id,
          title: ex.title,
          subjectName: ex.subject?.name || 'General',
          examDate: ex.examDate,
          deadlineBadge,
          diffDays,
          submitted: submittedExIds.has(ex.id)
        }
      })
    }

    // ── 7. Homework Progress Stats ────────────────────────────────────────
    let homeworkProgress = { completed: 0, pending: 0, overdue: 0, percentage: 0 }
    if (req.classId) {
      const allHomeworks = await prisma.homework.findMany({
        where: { classId: req.classId, branchId: req.branchId },
        select: { id: true, dueDate: true }
      })
      const submittedHwSet = new Set(
        (await prisma.homeworkSubmission.findMany({
          where: { studentId: req.studentId },
          select: { homeworkId: true }
        })).map(s => s.homeworkId)
      )
      const completed = allHomeworks.filter(h => submittedHwSet.has(h.id)).length
      const overdue = allHomeworks.filter(h => !submittedHwSet.has(h.id) && new Date(h.dueDate) < today).length
      const pending = allHomeworks.length - completed - overdue
      homeworkProgress = {
        completed,
        pending: Math.max(0, pending),
        overdue,
        percentage: allHomeworks.length > 0 ? Math.round((completed / allHomeworks.length) * 100) : 0
      }
    }

    // ── 8. School Fee Status ──────────────────────────────────────────────
    let feeStatus = { status: 'Unknown', totalBilled: 0, totalPaid: 0, outstanding: 0, nextTermDate: null }
    const invoice = await prisma.invoice.findFirst({
      where: { studentId: req.studentId, sessionId: req.sessionId, branchId: req.branchId },
      include: { payments: { select: { amount: true } } },
      orderBy: { createdAt: 'desc' }
    })
    if (invoice) {
      const totalBilled = parseFloat(invoice.totalAmount || '0')
      const totalPaid = invoice.payments.reduce((s, p) => s + parseFloat(p.amount || '0'), 0)
      const outstanding = Math.max(0, totalBilled - totalPaid)
      let status = 'Unpaid'
      if (outstanding === 0) status = 'Paid'
      else if (totalPaid > 0) status = 'Partial'
      feeStatus = { status, totalBilled, totalPaid, outstanding, nextTermDate: null }
    }

    // ── 9. Events / Announcements ─────────────────────────────────────────
    const events = await prisma.event.findMany({
      where: { branchId: req.branchId, sessionId: req.sessionId, startDate: { gte: new Date(today.getFullYear(), today.getMonth() - 1, 1) } },
      orderBy: { startDate: 'asc' },
      take: 5
    })
    const announcements = events.map(ev => ({
      id: ev.id,
      title: ev.title,
      description: ev.description || '',
      startDate: ev.startDate
    }))

    // ── 10. Recent Activities ─────────────────────────────────────────────
    const recentActivities = []

    const recentHwSubs = await prisma.homeworkSubmission.findMany({
      where: { studentId: req.studentId },
      include: { homework: { include: { subject: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 3
    })
    recentHwSubs.forEach(s => {
      recentActivities.push({
        type: 'homework_submitted',
        text: `You submitted ${s.homework?.subject?.name || 'a'} homework`,
        timestamp: s.createdAt
      })
    })

    const recentExamSubs = await prisma.onlineExamSubmission.findMany({
      where: { studentId: req.studentId },
      include: { onlineExam: { include: { subject: { select: { name: true } } } } },
      orderBy: { submittedAt: 'desc' },
      take: 3
    })
    recentExamSubs.forEach(s => {
      const scoreText = s.totalMark !== null && s.totalMark !== undefined ? ` (Score: ${s.totalMark})` : ''
      recentActivities.push({
        type: 'exam_submitted',
        text: `You completed ${s.onlineExam?.subject?.name || ''} exam${scoreText}`,
        timestamp: s.submittedAt
      })
    })

    attendanceLogs.slice(0, 3).forEach(l => {
      recentActivities.push({
        type: 'attendance',
        text: `Attendance marked: ${l.status}`,
        timestamp: l.attendanceDate
      })
    })

    recentActivities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    res.json({
      success: true,
      profile,
      kpi: {
        averageScore: overallAverage,
        classRank: rank,
        totalClassStudents,
        attendancePercentage: attendancePct,
        behaviourRating: attendancePct >= 90 ? 'Excellent' : attendancePct >= 75 ? 'Good' : 'Fair'
      },
      attendance,
      todayTimetable,
      upcomingHomeworks,
      upcomingExams,
      homeworkProgress,
      feeStatus,
      subjectPerformance,
      announcements,
      recentActivities: recentActivities.slice(0, 8)
    })
  } catch (error) {
    console.error('[STUDENT] Dashboard overview error:', error)
    res.status(500).json({ success: false, message: error.message || 'Failed to load dashboard overview.' })
  }
})

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

// ── CBT ONLINE EXAM ROUTES FOR STUDENTS ──────────────────────────────

// GET /api/student/cbt/active-exams
// Lists all published CBT examinations for student's enrolled classroom
router.get('/cbt/active-exams', async (req, res) => {
  try {
    const classId = req.classId
    if (!classId) {
      return res.json({ success: true, exams: [] })
    }

    // 1. Fetch OnlineExam models
    const onlineExams = await prisma.onlineExam.findMany({
      where: { classId, branchId: req.branchId },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } }
      },
      orderBy: { createdAt: 'desc' }
    })

    // 2. Fetch CbtDistribution models
    const distributions = await prisma.cbtDistribution.findMany({
      where: {
        classId,
        branchId: req.branchId,
        isPublished: true,
        ...(req.sectionId ? { OR: [{ sectionId: req.sectionId }, { sectionId: null }] } : {})
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        group: { select: { id: true, title: true, questionIds: true } }
      },
      orderBy: { createdAt: 'desc' }
    })

    // Find student's existing submissions
    const allExamIds = [...onlineExams.map(e => e.id), ...distributions.map(d => d.id)]
    const submissions = await prisma.onlineExamSubmission.findMany({
      where: {
        studentId: req.studentId,
        onlineExamId: { in: allExamIds }
      }
    })
    const subMap = {}
    submissions.forEach(s => {
      subMap[s.onlineExamId] = s
    })

    const formattedList = [
      ...distributions.map(dist => {
        const sub = subMap[dist.id]
        const qCount = Array.isArray(dist.group?.questionIds) ? dist.group.questionIds.length : 10
        return {
          id: dist.id,
          sourceType: 'distribution',
          title: dist.title,
          subjectName: dist.subject?.name || 'General Subject',
          subjectCode: dist.subject?.subjectCode || 'CBT',
          duration: dist.duration || 30,
          passingMark: dist.passingMark || 50,
          showResults: dist.showResults,
          questionCount: qCount,
          instructions: dist.instructions || 'Answer all questions within the allocated time limit.',
          isSubmitted: Boolean(sub && sub.submittedAt),
          totalMark: sub?.totalMark !== null && sub?.totalMark !== undefined ? sub.totalMark : null,
          startedAt: sub?.startedAt || null,
          submittedAt: sub?.submittedAt || null
        }
      }),
      ...onlineExams.map(ex => {
        const sub = subMap[ex.id]
        const questions = Array.isArray(ex.questions) ? ex.questions : []
        return {
          id: ex.id,
          sourceType: 'online_exam',
          title: ex.title,
          subjectName: ex.subject?.name || 'General Subject',
          subjectCode: ex.subject?.subjectCode || 'CBT',
          duration: ex.duration || 30,
          passingMark: ex.passingMark || 50,
          showResults: true,
          questionCount: questions.length,
          instructions: 'Standard CBT online examination.',
          isSubmitted: Boolean(sub && sub.submittedAt),
          totalMark: sub?.totalMark !== null && sub?.totalMark !== undefined ? sub.totalMark : null,
          startedAt: sub?.startedAt || null,
          submittedAt: sub?.submittedAt || null
        }
      })
    ]

    return res.json({
      success: true,
      exams: formattedList
    })
  } catch (error) {
    console.error('[STUDENT] Active CBT exams error:', error)
    return res.status(500).json({ success: false, message: 'Failed to load active CBT exams.' })
  }
})

// GET /api/student/cbt/exams/:id/take
// Initializes examination attempt and returns sanitized questions (without leaking correct answers)
router.get('/cbt/exams/:id/take', async (req, res) => {
  const { id } = req.params
  const examId = Number(id)

  try {
    let examTitle = 'CBT Examination'
    let duration = 30
    let passingMark = 50
    let instructions = ''
    let shuffleQuestions = true
    let showResults = true
    let rawQuestions = []
    let targetOnlineExamId = examId

    // Check CbtDistribution first
    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: examId },
      include: {
        subject: { select: { name: true } },
        group: true
      }
    })

    if (dist) {
      examTitle = dist.title
      duration = dist.duration || 30
      passingMark = dist.passingMark || 50
      instructions = dist.instructions || ''
      shuffleQuestions = dist.shuffleQuestions
      showResults = dist.showResults

      if (dist.group && Array.isArray(dist.group.questionIds) && dist.group.questionIds.length > 0) {
        rawQuestions = await prisma.questionBank.findMany({
          where: { id: { in: dist.group.questionIds.map(Number) } }
        })
      } else {
        rawQuestions = await prisma.questionBank.findMany({
          where: { branchId: req.branchId, subjectId: dist.subjectId },
          take: 20
        })
      }

      // Ensure matching onlineExam exists for foreign key
      let onlineEx = await prisma.onlineExam.findFirst({
        where: {
          title: dist.title,
          classId: dist.classId,
          subjectId: dist.subjectId,
          branchId: req.branchId
        }
      })
      if (!onlineEx) {
        onlineEx = await prisma.onlineExam.create({
          data: {
            title: dist.title,
            classId: dist.classId,
            subjectId: dist.subjectId,
            duration: dist.duration,
            passingMark: dist.passingMark,
            questions: rawQuestions,
            branchId: req.branchId,
            sessionId: req.sessionId || 5,
            examDate: dist.startDate || new Date()
          }
        })
      }
      targetOnlineExamId = onlineEx.id
    } else {
      const onlineExam = await prisma.onlineExam.findUnique({
        where: { id: examId },
        include: { subject: { select: { name: true } } }
      })

      if (!onlineExam) {
        return res.status(404).json({ success: false, message: 'CBT examination not found.' })
      }

      examTitle = onlineExam.title
      duration = onlineExam.duration || 30
      passingMark = onlineExam.passingMark || 50
      rawQuestions = Array.isArray(onlineExam.questions) ? onlineExam.questions : []
      targetOnlineExamId = onlineExam.id
    }

    // Check for existing attempt
    let submission = await prisma.onlineExamSubmission.findFirst({
      where: { onlineExamId: targetOnlineExamId, studentId: req.studentId }
    })

    if (submission && (submission.submittedAt || submission.totalMark !== null)) {
      return res.status(400).json({
        success: false,
        message: 'You have already completed and submitted this examination.'
      })
    }

    if (!submission) {
      submission = await prisma.onlineExamSubmission.create({
        data: {
          onlineExamId: targetOnlineExamId,
          studentId: req.studentId,
          startedAt: new Date(),
          totalMark: null
        }
      })
    }

    // Shuffle questions if enabled
    let orderedQuestions = [...rawQuestions]
    if (shuffleQuestions) {
      for (let i = orderedQuestions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [orderedQuestions[i], orderedQuestions[j]] = [orderedQuestions[j], orderedQuestions[i]]
      }
    }

    // Sanitize questions: strip correctOption / correctAnswer so client cannot inspect answers!
    const sanitizedQuestions = orderedQuestions.map((q, idx) => ({
      id: q.id !== undefined ? q.id : idx,
      questionText: q.questionText || q.question || `Question ${idx + 1}`,
      questionType: q.questionType || q.type || 'mcq',
      options: Array.isArray(q.options) ? q.options : ['A', 'B', 'C', 'D'],
      marks: Number(q.marks || q.points || 1.0)
    }))

    return res.json({
      success: true,
      exam: {
        id: examId,
        onlineExamId: targetOnlineExamId,
        title: examTitle,
        duration,
        passingMark,
        instructions,
        showResults,
        startedAt: submission.startedAt,
        questions: sanitizedQuestions
      }
    })
  } catch (error) {
    console.error('[STUDENT] Take CBT exam error:', error)
    return res.status(500).json({ success: false, message: 'Failed to launch CBT examination.' })
  }
})

// POST /api/student/cbt/exams/:id/submit
// Auto-grades submission, persists score, and returns performance summary
router.post('/cbt/exams/:id/submit', async (req, res) => {
  const { id } = req.params
  const examId = Number(id)
  const { answers = [] } = req.body

  try {
    // 1. Resolve questions and answers from database
    let rawQuestions = []
    let passingMark = 50
    let showResults = true
    let targetOnlineExamId = examId

    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: examId },
      include: { group: true }
    })

    if (dist) {
      passingMark = dist.passingMark || 50
      showResults = dist.showResults
      if (dist.group && Array.isArray(dist.group.questionIds) && dist.group.questionIds.length > 0) {
        rawQuestions = await prisma.questionBank.findMany({
          where: { id: { in: dist.group.questionIds.map(Number) } }
        })
      } else {
        rawQuestions = await prisma.questionBank.findMany({
          where: { branchId: req.branchId, subjectId: dist.subjectId },
          take: 20
        })
      }

      const onlineEx = await prisma.onlineExam.findFirst({
        where: {
          title: dist.title,
          classId: dist.classId,
          subjectId: dist.subjectId,
          branchId: req.branchId
        }
      })
      if (onlineEx) {
        targetOnlineExamId = onlineEx.id
      }
    } else {
      const onlineExam = await prisma.onlineExam.findUnique({
        where: { id: examId }
      })
      if (!onlineExam) {
        return res.status(404).json({ success: false, message: 'CBT examination not found.' })
      }
      passingMark = onlineExam.passingMark || 50
      rawQuestions = Array.isArray(onlineExam.questions) ? onlineExam.questions : []
      targetOnlineExamId = onlineExam.id
    }

    // 2. Resolve active submission
    const existing = await prisma.onlineExamSubmission.findFirst({
      where: {
        studentId: req.studentId,
        OR: [
          { onlineExamId: targetOnlineExamId },
          { onlineExamId: examId }
        ]
      }
    })

    if (!existing) {
      return res.status(400).json({ success: false, message: 'No active attempt found for this examination.' })
    }

    if (existing.submittedAt !== null && existing.totalMark !== null) {
      return res.status(400).json({ success: false, message: 'You have already submitted this exam.' })
    }

    // 3. Auto-grade submission using autoGradeCbtSubmission
    const grading = autoGradeCbtSubmission({
      questions: rawQuestions,
      studentAnswers: answers,
      passingPercentage: passingMark
    })

    // 4. Update submission in database
    const updated = await prisma.onlineExamSubmission.update({
      where: { id: existing.id },
      data: {
        answers,
        totalMark: grading.percentage,
        submittedAt: new Date()
      }
    })

    // 5. Trigger gamification check
    gamificationService.checkOnlineExamPerformance(prisma, req.studentId, updated.id, req.branchId)
      .catch(err => console.error('[Gamification] Error in CBT performance reward:', err.message))

    return res.json({
      success: true,
      message: 'CBT examination submitted and auto-graded successfully!',
      result: {
        totalScore: grading.totalScore,
        totalPossible: grading.totalPossible,
        percentage: grading.percentage,
        grade: grading.grade,
        isPassed: grading.isPassed,
        correctCount: grading.correctCount,
        wrongCount: grading.wrongCount,
        unansweredCount: grading.unansweredCount,
        showResults,
        breakdown: showResults ? grading.breakdown : []
      }
    })
  } catch (error) {
    console.error('[STUDENT] CBT Exam submission error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to submit CBT exam.' })
  }
})

// Legacy endpoints for backwards compatibility
router.post('/online-exams/:id/start', async (req, res) => {
  req.url = `/cbt/exams/${req.params.id}/take`
  return router.handle(req, res)
})

router.post('/online-exams/:id/submit', async (req, res) => {
  req.url = `/cbt/exams/${req.params.id}/submit`
  return router.handle(req, res)
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
    const globalSetting = await prisma.globalSettings.findFirst()
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

/**
 * GET /api/student/teachers
 * Fetch Form Teacher & Subject Teachers for the student's enrolled class.
 */
router.get('/teachers', assertStudent, async (req, res) => {
  try {
    if (!req.classId || !req.sectionId) {
      return res.json({ success: true, formTeacher: null, subjectTeachers: [] })
    }

    const [formAlloc, subjectAssigns] = await Promise.all([
      prisma.teacherAllocation.findFirst({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          branchId: req.branchId
        },
        include: {
          teacher: {
            select: { id: true, name: true, email: true, phone: true, photo: true, department: true }
          }
        }
      }),
      prisma.subjectAssign.findMany({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          branchId: req.branchId
        },
        include: {
          teacher: {
            select: { id: true, name: true, email: true, phone: true, photo: true, department: true }
          },
          subject: {
            select: { id: true, name: true, subjectCode: true }
          }
        }
      })
    ])

    const formTeacher = formAlloc?.teacher ? {
      id: formAlloc.teacher.id,
      name: formAlloc.teacher.name,
      email: formAlloc.teacher.email,
      phone: formAlloc.teacher.phone,
      photo: formAlloc.teacher.photo,
      department: formAlloc.teacher.department,
      role: 'Form Teacher'
    } : null

    const teacherMap = new Map()
    subjectAssigns.forEach(sa => {
      if (sa.teacher) {
        if (!teacherMap.has(sa.teacher.id)) {
          teacherMap.set(sa.teacher.id, {
            id: sa.teacher.id,
            name: sa.teacher.name,
            email: sa.teacher.email,
            phone: sa.teacher.phone,
            photo: sa.teacher.photo,
            department: sa.teacher.department,
            subjects: []
          })
        }
        if (sa.subject) {
          teacherMap.get(sa.teacher.id).subjects.push({
            id: sa.subject.id,
            name: sa.subject.name,
            code: sa.subject.subjectCode
          })
        }
      }
    })

    res.json({
      success: true,
      formTeacher,
      subjectTeachers: Array.from(teacherMap.values())
    })
  } catch (error) {
    console.error('[STUDENT] Teachers fetch error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch teachers.' })
  }
})

/**
 * GET /api/student/invoices
 * Fetch fee invoices, itemized breakdown, paid/balance due, and official school bank account.
 */
router.get('/invoices', assertStudent, async (req, res) => {
  try {
    const [invoices, schoolBank] = await Promise.all([
      prisma.invoice.findMany({
        where: { studentId: req.studentId, branchId: req.branchId },
        include: {
          items: true,
          payments: true
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.schoolBank.findUnique({
        where: { branchId: req.branchId }
      })
    ])

    let totalFeeAmount = 0
    let totalPaidAmount = 0

    const formattedInvoices = invoices.map(inv => {
      const amount = Number(inv.totalAmount || inv.amount || 0)
      const paid = inv.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0)
      const balance = Math.max(0, amount - paid)

      totalFeeAmount += amount
      totalPaidAmount += paid

      let status = 'UNPAID'
      if (balance === 0 && amount > 0) status = 'PAID'
      else if (paid > 0) status = 'PARTIAL'

      return {
        id: inv.id,
        invoiceNo: inv.invoiceNo || `INV-${inv.id}`,
        title: inv.title || 'Term School Fee Invoice',
        amount,
        discount: Number(inv.discount || 0),
        fine: Number(inv.fine || 0),
        paidAmount: paid,
        balance,
        status,
        dueDate: inv.dueDate,
        createdAt: inv.createdAt,
        items: inv.items.map(it => ({ id: it.id, name: it.name, amount: Number(it.amount || 0) })),
        payments: inv.payments.map(p => ({
          id: p.id,
          amount: Number(p.amount || 0),
          paymentMethod: p.paymentMethod || 'Bank Transfer',
          paidAt: p.createdAt
        }))
      }
    })

    const totalBalance = Math.max(0, totalFeeAmount - totalPaidAmount)

    res.json({
      success: true,
      invoices: formattedInvoices,
      schoolBank: schoolBank ? {
        bankName: schoolBank.bankName,
        accountName: schoolBank.accountName,
        accountNumber: schoolBank.accountNumber,
        branchName: schoolBank.branchName,
        sortCode: schoolBank.sortCode
      } : null,
      totalFeeAmount,
      totalPaidAmount,
      totalBalance
    })
  } catch (error) {
    console.error('[STUDENT] Invoices fetch error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch invoices.' })
  }
})

/**
 * GET /api/student/timetable
 * Fetch weekly class period slots & exam schedule slots.
 */
router.get('/timetable', assertStudent, async (req, res) => {
  try {
    if (!req.classId || !req.sectionId) {
      return res.json({ success: true, timetableSlots: [], examScheduleSlots: [] })
    }

    const [timetableSlots, examSlots] = await Promise.all([
      prisma.timetableSlot.findMany({
        where: { classId: req.classId, sectionId: req.sectionId, branchId: req.branchId },
        include: {
          subject: { select: { name: true, subjectCode: true } },
          teacher: { select: { name: true } }
        },
        orderBy: { startTime: 'asc' }
      }),
      prisma.examScheduleSlot.findMany({
        where: { classId: req.classId, sectionId: req.sectionId, branchId: req.branchId },
        include: {
          subject: { select: { name: true, subjectCode: true } },
          hall: { select: { name: true } },
          invigilator: { select: { name: true } }
        },
        orderBy: { examDate: 'asc' }
      })
    ])

    res.json({
      success: true,
      timetableSlots: timetableSlots.map(s => ({
        id: s.id,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        type: s.type,
        title: s.title || s.subject?.name || 'Period',
        subjectName: s.subject?.name || null,
        subjectCode: s.subject?.subjectCode || null,
        teacherName: s.teacher?.name || null
      })),
      examScheduleSlots: examSlots.map(es => ({
        id: es.id,
        examDate: es.examDate,
        startTime: es.startTime,
        endTime: es.endTime,
        instructions: es.instructions,
        subjectName: es.subject?.name || 'Subject',
        subjectCode: es.subject?.subjectCode || 'SUB',
        hallName: es.hall?.name || 'Examination Hall',
        invigilatorName: es.invigilator?.name || 'Invigilator'
      }))
    })
  } catch (error) {
    console.error('[STUDENT] Timetable fetch error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch timetable.' })
  }
})

/**
 * GET /api/student/reminders
 */
router.get('/reminders', assertStudent, async (req, res) => {
  try {
    const reminders = await prisma.studentReminder.findMany({
      where: { studentId: req.studentId },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, reminders })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch study reminders.' })
  }
})

/**
 * POST /api/student/reminders
 */
router.post('/reminders', assertStudent, async (req, res) => {
  try {
    const { text, subtext } = req.body
    if (!text) return res.status(400).json({ success: false, message: 'Reminder text is required.' })

    const reminder = await prisma.studentReminder.create({
      data: {
        studentId: req.studentId,
        text,
        subtext: subtext || null
      }
    })
    res.json({ success: true, reminder })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to create study reminder.' })
  }
})

/**
 * PUT /api/student/reminders/:id/toggle
 */
router.put('/reminders/:id/toggle', assertStudent, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const reminder = await prisma.studentReminder.findUnique({ where: { id } })
    if (!reminder || reminder.studentId !== req.studentId) {
      return res.status(404).json({ success: false, message: 'Reminder not found.' })
    }

    const updated = await prisma.studentReminder.update({
      where: { id },
      data: { done: !reminder.done }
    })
    res.json({ success: true, reminder: updated })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle reminder.' })
  }
})

/**
 * DELETE /api/student/reminders/:id
 */
router.delete('/reminders/:id', assertStudent, async (req, res) => {
  try {
    const id = Number(req.params.id)
    await prisma.studentReminder.deleteMany({
      where: { id, studentId: req.studentId }
    })
    res.json({ success: true, message: 'Reminder deleted.' })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete reminder.' })
  }
})

/**
 * GET /api/student/messages
 */
router.get('/messages', assertStudent, async (req, res) => {
  try {
    const messages = await prisma.studentMessage.findMany({
      where: { studentId: req.studentId },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, messages })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch student messages.' })
  }
})

/**
 * POST /api/student/messages
 */
router.post('/messages', assertStudent, async (req, res) => {
  try {
    const { recipientRole, recipientId, subject, message } = req.body
    if (!message) return res.status(400).json({ success: false, message: 'Message content is required.' })

    const newMessage = await prisma.studentMessage.create({
      data: {
        branchId: req.branchId,
        studentId: req.studentId,
        recipientId: recipientId ? Number(recipientId) : null,
        recipientRole: recipientRole || 'TEACHER',
        subject: subject || 'Student Inquiry',
        message
      }
    })

    res.json({ success: true, message: 'Message sent successfully.', newMessage })
  } catch (error) {
    console.error('[STUDENT] Send message error:', error)
    res.status(500).json({ success: false, message: 'Failed to send message.' })
  }
})

/**
 * PUT /api/student/change-password
 */
router.put('/change-password', assertStudent, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new passwords are required.' })
    }

    const bcrypt = require('bcryptjs')
    const user = await prisma.user.findUnique({ where: { id: req.userId } })
    if (!user) return res.status(404).json({ success: false, message: 'User record not found.' })

    const isMatch = await bcrypt.compare(currentPassword, user.password)
    if (!isMatch) return res.status(400).json({ success: false, message: 'Current password is incorrect.' })

    const hashedPassword = await bcrypt.hash(newPassword, 10)
    await prisma.user.update({
      where: { id: req.userId },
      data: { password: hashedPassword }
    })

    res.json({ success: true, message: 'Password updated successfully.' })
  } catch (error) {
    console.error('[STUDENT] Change password error:', error)
    res.status(500).json({ success: false, message: 'Failed to update password.' })
  }
})

module.exports = router
