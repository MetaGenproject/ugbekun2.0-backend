import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { generateReportCardPdf, generateMontessoriReportCardPdf } from '../lib/pdfService';
import { uploadBase64Image } from '../lib/cloudinary';

async function savePhoto(photoBase64?: string | null, folder: string = 'ugbekun2/parents/photos'): Promise<string | null> {
  if (!photoBase64) return null;
  try {
    const uploadedUrl = await uploadBase64Image(photoBase64, folder);
    if (uploadedUrl) return uploadedUrl;
  } catch (err) {
    console.warn(`[PARENT PHOTO UPLOAD] Cloudinary upload unavailable for ${folder}, using fallback:`, (err as any)?.message);
  }
  if (photoBase64.startsWith('data:image/') || photoBase64.startsWith('http://') || photoBase64.startsWith('https://')) {
    return photoBase64;
  }
  return null;
}

const router = express.Router()
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma: any = new PrismaClient({ adapter })

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod'

function getBearerToken(req: any) {
  const authHeader = req.headers?.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  return authHeader.slice('Bearer '.length)
}

// Authentication guard specifically for Parents (Role 6)
async function assertParent(req: any, res: any, next: any) {
  const token = getBearerToken(req)
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided.' })
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET)
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
async function assertChildLinked(req: any, res: any, next: any) {
  const studentId = parseInt(String(req.params?.studentId || req.query?.studentId || ''), 10)
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
      const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0
      const examVal = m.mark ? parseFloat(m.mark) : 0
      const totalVal = testVal + examVal
      if (m.cbtMark !== null || m.mark !== null) {
        classAverageMap[key].sum += totalVal
        classAverageMap[key].count += 1
      }
    })

    const commentary = await prisma.studentCommentary.findFirst({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId,
        status: 'PRINCIPAL_SIGNED_OFF'
      },
      select: { remark: true }
    })

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
    const { rankingType = 'full', rankingLimit = 3 } = req.query as any
    const limit = parseInt(rankingLimit as string, 10) || 3

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
      const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0
      const examVal = m.mark ? parseFloat(m.mark) : 0
      const totalVal = testVal + examVal
      if (m.cbtMark !== null || m.mark !== null) {
        classAverageMap[key].sum += totalVal
        classAverageMap[key].count += 1
      }
    })

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

    const commentaryRecord = await prisma.studentCommentary.findFirst({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId,
        status: 'PRINCIPAL_SIGNED_OFF'
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

/**
 * GET /api/parent/classes-sections
 * Retrieve classes and sections for sibling enrollment form.
 */
router.get('/classes-sections', async (req, res) => {
  try {
    const classes = await prisma.class.findMany({
      where: { branchId: req.branchId },
      include: {
        sections: {
          include: {
            section: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })

    return res.json({ success: true, classes })
  } catch (error) {
    console.error('[PARENT] Get classes-sections error:', error)
    return res.status(500).json({ success: false, message: 'Failed to load classes and sections.' })
  }
})

/**
 * GET /api/parent/sibling-requests
 * Retrieve list of sibling requests submitted by this parent.
 */
router.get('/sibling-requests', async (req, res) => {
  try {
    const requests = await prisma.parentSiblingRequest.findMany({
      where: { parentId: req.parentId, branchId: req.branchId },
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    const formatted = requests.map(r => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      gender: r.gender,
      birthday: r.birthday,
      status: r.status,
      rejectionReason: r.rejectionReason,
      className: r.class?.name || 'Class',
      sectionName: r.section?.name || 'General',
      createdAt: r.createdAt,
    }))

    return res.json({ success: true, siblingRequests: formatted })
  } catch (error) {
    console.error('[PARENT] Get sibling requests error:', error)
    return res.status(500).json({ success: false, message: 'Failed to load sibling requests.' })
  }
})

/**
 * POST /api/parent/sibling-requests
 * Submit a new sibling request for approval.
 */
router.post('/sibling-requests', async (req, res) => {
  try {
    const { firstName, lastName, gender, birthday, classId, sectionId } = req.body || {}

    if (!firstName || !lastName || !gender || !classId || !sectionId) {
      return res.status(400).json({ success: false, message: 'First name, last name, gender, class, and section are required.' })
    }

    const cls = await prisma.class.findFirst({
      where: { id: Number(classId), branchId: req.branchId },
    })
    const sec = await prisma.section.findFirst({
      where: { id: Number(sectionId), branchId: req.branchId },
    })

    if (!cls || !sec) {
      return res.status(400).json({ success: false, message: 'Invalid class or section selected.' })
    }

    const duplicate = await prisma.parentSiblingRequest.findFirst({
      where: {
        parentId: req.parentId,
        branchId: req.branchId,
        firstName: { equals: firstName.trim(), mode: 'insensitive' },
        lastName: { equals: lastName.trim(), mode: 'insensitive' },
        status: { in: ['pending', 'approved'] },
      },
    })

    if (duplicate) {
      return res.status(400).json({ success: false, message: 'A request for this child has already been submitted.' })
    }

    const siblingRequest = await prisma.parentSiblingRequest.create({
      data: {
        parentId: req.parentId,
        branchId: req.branchId,
        classId: Number(classId),
        sectionId: Number(sectionId),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        gender,
        birthday: birthday ? new Date(birthday) : null,
        status: 'pending',
      },
    })

    return res.status(201).json({ success: true, message: 'Sibling request submitted successfully.', siblingRequest })
  } catch (error) {
    console.error('[PARENT] Create sibling request error:', error)
    return res.status(500).json({ success: false, message: 'Failed to submit sibling request.' })
  }
})

/**
 * GET /api/parent/events
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
    console.error('[PARENT] Get events error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch events.' })
  }
})

/**
 * GET /api/parent/child/:studentId/invoices
 * Fetch fee invoices, itemized breakdown, payment receipts, and school bank details for a child.
 */
router.get('/child/:studentId/invoices', assertChildLinked, async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        studentId: req.studentId,
        branchId: req.studentBranchId,
      },
      include: {
        items: true,
        payments: {
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    const schoolBank = await prisma.schoolBank.findFirst({
      where: {
        branchId: req.studentBranchId,
        isActive: true,
      },
    })

    let totalFeeAmount = 0
    let totalPaidAmount = 0

    const formattedInvoices = invoices.map(inv => {
      const amount = Number(inv.amount || 0)
      const paid = Number(inv.paidAmount || 0)
      const balance = Number(inv.balance || 0)
      totalFeeAmount += amount
      totalPaidAmount += paid

      return {
        id: inv.id,
        invoiceNo: inv.invoiceNo || `INV-${inv.id}`,
        title: inv.title || 'Term Fee Invoice',
        amount,
        discount: Number(inv.discount || 0),
        fine: Number(inv.fine || 0),
        paidAmount: paid,
        balance,
        status: inv.status || (balance <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID'),
        dueDate: inv.dueDate,
        createdAt: inv.createdAt,
        items: inv.items.map(item => ({
          id: item.id,
          name: item.name,
          amount: Number(item.amount || 0),
        })),
        payments: inv.payments.map(p => ({
          id: p.id,
          amount: Number(p.amount || 0),
          paymentMethod: p.paymentMethod,
          transactionRef: p.transactionRef,
          paidAt: p.createdAt,
        })),
      }
    })

    const totalBalance = Math.max(0, totalFeeAmount - totalPaidAmount)

    return res.json({
      success: true,
      invoices: formattedInvoices,
      schoolBank: schoolBank ? {
        bankName: schoolBank.bankName,
        accountName: schoolBank.accountName,
        accountNumber: schoolBank.accountNumber,
        branchName: schoolBank.branchName,
        sortCode: schoolBank.sortCode,
      } : null,
      totalFeeAmount,
      totalPaidAmount,
      totalBalance,
    })
  } catch (error) {
    console.error('[PARENT] Get child invoices error:', error)
    return res.status(500).json({ success: false, message: 'Failed to retrieve fee invoices.' })
  }
})

/**
 * GET /api/parent/child/:studentId/timetable
 * Fetch timetable slots and exam schedule slots for a child.
 */
router.get('/child/:studentId/timetable', assertChildLinked, async (req, res) => {
  if (!req.childClassId) {
    return res.json({ success: true, timetableSlots: [], examScheduleSlots: [] })
  }

  try {
    const timetableSlots = await prisma.timetableSlot.findMany({
      where: {
        classId: req.childClassId,
        branchId: req.studentBranchId,
        ...(req.childSectionId ? { sectionId: req.childSectionId } : {}),
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        teacher: { select: { id: true, name: true } },
      },
      orderBy: [
        { dayOfWeek: 'asc' },
        { startTime: 'asc' },
      ],
    })

    const examScheduleSlots = await prisma.examScheduleSlot.findMany({
      where: {
        classId: req.childClassId,
        branchId: req.studentBranchId,
        isPublished: true,
        ...(req.childSectionId ? { sectionId: req.childSectionId } : {}),
      },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        hall: { select: { name: true, location: true } },
        invigilator: { select: { name: true } },
      },
      orderBy: { examDate: 'asc' },
    })

    return res.json({
      success: true,
      timetableSlots: timetableSlots.map(slot => ({
        id: slot.id,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        type: slot.type,
        title: slot.title || slot.subject?.name || 'Class Period',
        subjectName: slot.subject?.name || null,
        subjectCode: slot.subject?.subjectCode || null,
        teacherName: slot.teacher?.name || null,
      })),
      examScheduleSlots: examScheduleSlots.map(slot => ({
        id: slot.id,
        examDate: slot.examDate,
        startTime: slot.startTime,
        endTime: slot.endTime,
        instructions: slot.instructions,
        subjectName: slot.subject.name,
        subjectCode: slot.subject.subjectCode,
        hallName: slot.hall?.name || 'Main Exam Hall',
        invigilatorName: slot.invigilator?.name || 'Invigilator',
      })),
    })
  } catch (error) {
    console.error('[PARENT] Get child timetable error:', error)
    return res.status(500).json({ success: false, message: 'Failed to retrieve timetable slots.' })
  }
})

/**
 * GET /api/parent/child/:studentId/teachers
 * Fetch form teacher and subject teachers for a child.
 */
router.get('/child/:studentId/teachers', assertChildLinked, async (req, res) => {
  if (!req.childClassId) {
    return res.json({ success: true, formTeacher: null, subjectTeachers: [] })
  }

  try {
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: {
        classId: req.childClassId,
        sectionId: req.childSectionId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
      },
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            photo: true,
            department: true,
            qualifications: true,
          },
        },
      },
    })

    const subjectAssigns = await prisma.subjectAssign.findMany({
      where: {
        classId: req.childClassId,
        sectionId: req.childSectionId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
      },
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            photo: true,
            department: true,
          },
        },
        subject: { select: { id: true, name: true, subjectCode: true } },
      },
    })

    const teacherMap = new Map()
    subjectAssigns.forEach(sa => {
      if (!sa.teacher) return
      const tid = sa.teacher.id
      if (!teacherMap.has(tid)) {
        teacherMap.set(tid, {
          id: sa.teacher.id,
          name: sa.teacher.name,
          email: sa.teacher.email,
          phone: sa.teacher.phone,
          photo: sa.teacher.photo,
          department: sa.teacher.department,
          subjects: [],
        })
      }
      teacherMap.get(tid).subjects.push({
        id: sa.subject.id,
        name: sa.subject.name,
        code: sa.subject.subjectCode,
      })
    })

    return res.json({
      success: true,
      formTeacher: formAllocation?.teacher || null,
      subjectTeachers: Array.from(teacherMap.values()),
    })
  } catch (error) {
    console.error('[PARENT] Get child teachers error:', error)
    return res.status(500).json({ success: false, message: 'Failed to retrieve teachers directory.' })
  }
})

/**
 * GET /api/parent/messages
 * Fetch messages exchanged between parent and teachers/admin.
 */
router.get('/messages', async (req, res) => {
  try {
    const messages = await prisma.parentMessage.findMany({
      where: {
        parentId: req.parentId,
        branchId: req.branchId,
      },
      include: {
        student: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return res.json({
      success: true,
      messages: messages.map(m => ({
        id: m.id,
        senderType: m.senderType,
        recipientRole: m.recipientRole,
        subject: m.subject,
        message: m.message,
        isRead: m.isRead,
        childName: m.student ? `${m.student.firstName} ${m.student.lastName}` : null,
        createdAt: m.createdAt,
      })),
    })
  } catch (error) {
    console.error('[PARENT] Get messages error:', error)
    return res.status(500).json({ success: false, message: 'Failed to fetch messages.' })
  }
})

/**
 * POST /api/parent/messages
 * Send a message to form teacher or school admin.
 */
router.post('/messages', async (req, res) => {
  try {
    const { studentId, recipientRole = 'TEACHER', recipientId, subject, message } = req.body || {}

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message content is required.' })
    }

    const newMessage = await prisma.parentMessage.create({
      data: {
        parentId: req.parentId,
        branchId: req.branchId,
        studentId: studentId ? Number(studentId) : null,
        recipientId: recipientId ? Number(recipientId) : null,
        recipientRole,
        senderType: 'PARENT',
        subject: subject ? subject.trim() : 'Parent Inquiry',
        message: message.trim(),
      },
    })

    return res.status(201).json({
      success: true,
      message: 'Message sent successfully.',
      data: newMessage,
    })
  } catch (error) {
    console.error('[PARENT] Post message error:', error)
    return res.status(500).json({ success: false, message: 'Failed to send message.' })
  }
})

/**
 * GET /api/parent/profile
 * Get parent profile details.
 */
router.get('/profile', async (req, res) => {
  try {
    const parent = await prisma.parent.findUnique({
      where: { id: req.parentId },
      include: {
        user: { select: { username: true } },
        branch: { select: { name: true, code: true } },
      },
    })

    if (!parent) {
      return res.status(404).json({ success: false, message: 'Parent profile not found.' })
    }

    return res.json({
      success: true,
      parent: {
        id: parent.id,
        username: parent.user?.username || '',
        name: parent.name,
        relation: parent.relation,
        fatherName: parent.fatherName,
        motherName: parent.motherName,
        occupation: parent.occupation,
        education: parent.education,
        income: parent.income,
        email: parent.email,
        mobileno: parent.mobileno,
        address: parent.address,
        city: parent.city,
        state: parent.state,
        photo: parent.photo,
        branchName: parent.branch?.name || null,
      },
    })
  } catch (error) {
    console.error('[PARENT] Get profile error:', error)
    return res.status(500).json({ success: false, message: 'Failed to retrieve profile.' })
  }
})

/**
 * PUT /api/parent/profile
 * Update parent profile information.
 */
router.put('/profile', async (req, res) => {
  try {
    const { name, email, mobileno, address, city, state, occupation, education, fatherName, motherName } = req.body || {}

    const updated = await prisma.parent.update({
      where: { id: req.parentId },
      data: {
        ...(name ? { name: name.trim() } : {}),
        ...(email ? { email: email.trim() } : {}),
        ...(mobileno ? { mobileno: mobileno.trim() } : {}),
        ...(address ? { address: address.trim() } : {}),
        ...(city ? { city: city.trim() } : {}),
        ...(state ? { state: state.trim() } : {}),
        ...(occupation ? { occupation: occupation.trim() } : {}),
        ...(education ? { education: education.trim() } : {}),
        ...(fatherName ? { fatherName: fatherName.trim() } : {}),
        ...(motherName ? { motherName: motherName.trim() } : {}),
        updatedAt: new Date(),
      },
    })

    return res.json({ success: true, message: 'Profile updated successfully.', parent: updated })
  } catch (error) {
    console.error('[PARENT] Update profile error:', error)
    return res.status(500).json({ success: false, message: 'Failed to update profile.' })
  }
})

/**
 * POST /api/parent/profile/upload-photo
 * Parent uploads/updates their own photograph.
 */
router.post('/profile/upload-photo', async (req, res) => {
  try {
    const { photoBase64, photo } = req.body || {}
    const inputPhoto = photoBase64 || photo
    if (!inputPhoto) {
      return res.status(400).json({ success: false, message: 'Photograph data is required.' })
    }

    const photoUrl = await savePhoto(inputPhoto, 'ugbekun2/parents/photos')

    const updated = await prisma.parent.update({
      where: { id: req.parentId },
      data: { photo: photoUrl },
      select: { id: true, name: true, photo: true },
    })

    if (req.user?.id) {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { photo: photoUrl },
      }).catch(() => null)
    }

    return res.json({
      success: true,
      message: 'Profile photograph updated successfully.',
      photo: updated.photo,
      parent: updated,
    })
  } catch (error: any) {
    console.error('[PARENT] Profile photo upload error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update photo.' })
  }
})

/**
 * POST /api/parent/child/:studentId/upload-photo
 * Parent uploads/updates their child's photograph.
 */
router.post('/child/:studentId/upload-photo', async (req, res) => {
  try {
    const studentId = Number(req.params.studentId)
    const { photoBase64, photo } = req.body || {}
    const inputPhoto = photoBase64 || photo
    if (!inputPhoto) {
      return res.status(400).json({ success: false, message: 'Photograph data is required.' })
    }

    const student = await prisma.student.findFirst({
      where: { id: studentId, parentId: req.parentId },
      select: { id: true, userId: true, firstName: true, lastName: true },
    })

    if (!student) {
      return res.status(404).json({ success: false, message: 'Child record not found under your account.' })
    }

    const photoUrl = await savePhoto(inputPhoto, 'ugbekun2/students/photos')

    const updated = await prisma.student.update({
      where: { id: studentId },
      data: { photo: photoUrl },
      select: { id: true, firstName: true, lastName: true, photo: true },
    })

    if (student.userId) {
      await prisma.user.update({
        where: { id: student.userId },
        data: { photo: photoUrl },
      }).catch(() => null)
    }

    return res.json({
      success: true,
      message: `${student.firstName}'s photograph updated successfully.`,
      photo: updated.photo,
      student: updated,
    })
  } catch (error: any) {
    console.error('[PARENT] Child photo upload error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update child photo.' })
  }
})

/**
 * PUT /api/parent/change-password
 * Change parent login password.
 */
router.put('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {}
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new passwords are required.' })
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters long.' })
    }

    const parent = await prisma.parent.findUnique({
      where: { id: req.parentId },
      select: { userId: true },
    })

    if (!parent || !parent.userId) {
      return res.status(400).json({ success: false, message: 'User credential not linked to parent profile.' })
    }

    const user = await prisma.user.findUnique({
      where: { id: parent.userId },
    })

    if (!user) {
      return res.status(404).json({ success: false, message: 'User record not found.' })
    }

    const isValid = bcrypt.compareSync(currentPassword, user.password)
    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Current password provided is incorrect.' })
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10)
    await prisma.user.update({
      where: { id: parent.userId },
      data: {
        password: hashedPassword,
        updatedAt: new Date(),
      },
    })

    return res.json({ success: true, message: 'Password updated successfully.' })
  } catch (error) {
    console.error('[PARENT] Change password error:', error)
    return res.status(500).json({ success: false, message: 'Failed to change password.' })
  }
})

export default router;

