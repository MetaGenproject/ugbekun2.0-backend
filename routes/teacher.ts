import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import {
  isSubjectTeacher as originalIsSubjectTeacher,
  isFormTeacher as originalIsFormTeacher,
  hasClassAccess as originalHasClassAccess,
} from '../lib/teacherAccess';
import { staffMatchesBranch } from '../lib/branchStats';
import { generatePedagogicalLessonPlan } from '../lib/lessonPlanService';
import { generateStudentAiCommentary, generateBatchClassCommentary } from '../lib/commentaryService';
import {
  generateLessonPlanPdf,
  generateReportCardPdf,
  generateMontessoriReportCardPdf,
  generateBatchClassReportCardsPdf,
} from '../lib/pdfService';
import { uploadBase64Image } from '../lib/cloudinary';
import gamificationService from '../lib/gamificationService';

async function savePhoto(photoBase64?: string | null, folder: string = 'ugbekun2/staff/photos'): Promise<string | null> {
  if (!photoBase64) return null;
  try {
    const uploadedUrl = await uploadBase64Image(photoBase64, folder);
    if (uploadedUrl) return uploadedUrl;
  } catch (err) {
    console.warn(`[PHOTO UPLOAD] Cloudinary upload unavailable for ${folder}, using fallback:`, (err as any)?.message);
  }
  if (photoBase64.startsWith('data:image/') || photoBase64.startsWith('http://') || photoBase64.startsWith('https://')) {
    return photoBase64;
  }
  return null;
}

// Wrapper bypasses verification if request has been marked as admin-authorized (req.isAdmin)
async function isSubjectTeacher(prisma, teacherId, classId, sectionId, subjectId, req) {
  if (req && req.isAdmin) return true
  return originalIsSubjectTeacher(prisma, teacherId, classId, sectionId, subjectId)
}

async function isFormTeacher(prisma, teacherId, classId, sectionId, req) {
  if (req && req.isAdmin) return true
  return originalIsFormTeacher(prisma, teacherId, classId, sectionId)
}

async function hasClassAccess(prisma, teacherId, classId, sectionId, req) {
  if (req && req.isAdmin) return true
  return originalHasClassAccess(prisma, teacherId, classId, sectionId)
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
    return matched.id
  }

  return null
}



let Tesseract
try {
  Tesseract = require('tesseract.js')
} catch (err) {
  console.warn('[TEACHER] Tesseract.js could not be loaded; OCR image parsing is disabled.')
}

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } })

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'dummy-key',
  baseURL: 'https://api.deepseek.com'
})

const router = express.Router()
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma: any = new PrismaClient({ adapter })

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod'

// Helper to extract bearer token
function getBearerToken(req: any) {
  const authHeader = req.headers?.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  return authHeader.slice('Bearer '.length)
}

// Authentication guard specifically for Teachers (and Branch Admins acting as teachers)
async function assertTeacher(req: any, res: any, next?: any) {
  const token = getBearerToken(req)
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided.' })
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET)
    if (!decoded || (decoded.role !== 3 && decoded.role !== 2)) {
      return res.status(403).json({ success: false, message: 'Access denied: Requires Teacher or Admin role.' })
    }

    if (decoded.role === 2) {
      const branchId = await resolveBranchForAdmin(decoded)
      if (!branchId) {
        return res.status(403).json({ success: false, message: 'Branch admin account is not linked to a school branch.' })
      }
      req.branchId = branchId
      req.isAdmin = true

      const teacherId = Number(req.headers['x-admin-teacher-id'] || req.query.teacherId || req.body.teacherId || 0)
      if (teacherId) {
        const tProfile = await prisma.teacher.findFirst({
          where: { id: teacherId, branchId }
        })
        if (!tProfile) {
          return res.status(403).json({ success: false, message: 'Access denied: Selected teacher does not belong to your branch.' })
        }
        req.teacherId = teacherId
      } else {
        const tProfile = await prisma.teacher.findFirst({
          where: { branchId }
        })
        if (tProfile) {
          req.teacherId = tProfile.id
        } else {
          return res.status(403).json({ success: false, message: 'No teachers found in your branch to impersonate.' })
        }
      }
      if (typeof next === 'function') {
        return next()
      }
      return decoded
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
    if (typeof next === 'function') {
      return next()
    }
    return decoded
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Token is invalid or expired.' })
  }
}

// Apply authentication guard to all teacher routes
router.use(assertTeacher)

/**
 * GET /api/teacher/dashboard-overview
 * Aggregated dashboard data for the new Teacher Portal design mockup.
 * Returns profile, KPI stats, attendance donut, class performance, teaching summary,
 * subject cards, my classes, reminders, and recent activities timeline.
 */
router.get('/dashboard-overview', async (req, res) => {
  try {
    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]

    // 1. Fetch Teacher Info & Branch
    const teacher = await prisma.teacher.findUnique({
      where: { id: req.teacherId },
      include: { branch: { select: { id: true, name: true } } }
    })
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher profile not found.' })
    }

    // 2. Fetch Form Allocations & Subject Assignments
    const [formAllocations, subjectAssignments] = await Promise.all([
      prisma.teacherAllocation.findMany({
        where: { teacherId: req.teacherId },
        include: {
          class: { select: { id: true, name: true, isEcd: true } },
          section: { select: { id: true, name: true } }
        }
      }),
      prisma.subjectAssign.findMany({
        where: { teacherId: req.teacherId },
        include: {
          class: { select: { id: true, name: true, isEcd: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true } }
        }
      })
    ])

    const primaryForm = formAllocations[0] 
      ? `${formAllocations[0].class?.name || ''} ${formAllocations[0].section?.name || ''}`.trim() 
      : (subjectAssignments[0] ? `${subjectAssignments[0].class?.name || ''} ${subjectAssignments[0].section?.name || ''}`.trim() : 'No Class Allocated')

    // Compute unique subjects
    const uniqueSubjectsMap = new Map()
    subjectAssignments.forEach(sa => {
      if (sa.subject && !uniqueSubjectsMap.has(sa.subject.id)) {
        uniqueSubjectsMap.set(sa.subject.id, sa.subject.name)
      }
    })
    const subjectsCount = uniqueSubjectsMap.size

    // Compute total unique students under teacher's classes
    const classSectionPairs = [
      ...formAllocations.map(fa => ({ classId: fa.classId, sectionId: fa.sectionId })),
      ...subjectAssignments.map(sa => ({ classId: sa.classId, sectionId: sa.sectionId }))
    ]
    
    let totalStudentsCount = 0
    if (classSectionPairs.length > 0) {
      totalStudentsCount = await prisma.enroll.count({
        where: {
          OR: classSectionPairs.map(p => ({ classId: p.classId, sectionId: p.sectionId }))
        }
      })
    }

    // 3. Today's Attendance Overview
    let attendancePct = 0, presentCount = 0, lateCount = 0, absentCount = 0
    if (formAllocations[0]) {
      const todayLogs = await prisma.attendance.findMany({
        where: {
          classId: formAllocations[0].classId,
          sectionId: formAllocations[0].sectionId,
          attendanceDate: { gte: new Date(todayStr) }
        }
      })
      if (todayLogs.length > 0) {
        presentCount = todayLogs.filter(l => l.status === 'Present').length
        lateCount = todayLogs.filter(l => l.status === 'Late').length
        absentCount = todayLogs.filter(l => l.status === 'Absent').length
        const total = todayLogs.length
        attendancePct = Math.round(((presentCount + lateCount) / total) * 100)
      }
    }

    // 4. Assignments & CBT Counts
    const [assignmentsCount, pendingReviewCount, testsCount, lessonNotesCount] = await Promise.all([
      prisma.homework.count({ where: { teacherId: req.teacherId } }),
      prisma.homeworkSubmission.count({ where: { homework: { teacherId: req.teacherId }, score: null } }),
      prisma.onlineExam.count({ where: { teacherId: req.teacherId } }),
      prisma.lessonPlan.count({ where: { teacherId: req.teacherId } })
    ])

    // 5. Compute Real Subject Performance Overview from Mark Table
    const subjectPerformance = []
    for (const [subId, subName] of Array.from(uniqueSubjectsMap.entries())) {
      const marks = await prisma.mark.findMany({
        where: { subjectId: subId },
        select: { mark: true, cbtMark: true }
      })
      let totalScore = 0, validCount = 0
      marks.forEach(m => {
        const val = Number(m.mark || m.cbtMark || 0)
        if (val > 0) {
          totalScore += val
          validCount++
        }
      })
      const avgScore = validCount > 0 ? Math.round(totalScore / validCount) : 0
      subjectPerformance.push({ name: subName, score: avgScore })
    }

    // 6. My Classes List
    const myClasses = formAllocations.map(fa => ({
      name: `${fa.class?.name || ''} ${fa.section?.name || ''}`.trim(),
      role: 'Class Teacher',
      studentsCount: totalStudentsCount
    }))
    subjectAssignments.forEach(sa => {
      const className = `${sa.class?.name || ''} ${sa.section?.name || ''}`.trim()
      if (!myClasses.find(c => c.name === className)) {
        myClasses.push({
          name: className,
          role: 'Subject Teacher',
          studentsCount: totalStudentsCount
        })
      }
    })

    // 7. Recent Activities Stream (Fetched from DB)
    const dbActivities = await prisma.teacherActivity.findMany({
      where: { teacherId: req.teacherId },
      orderBy: { createdAt: 'desc' },
      take: 5
    })
    const recentActivities = dbActivities.map(a => ({
      id: a.id,
      text: a.activity,
      timestamp: new Date(a.createdAt).toLocaleDateString(),
      icon: a.type.toLowerCase()
    }))

    // 8. Reminders List (Fetched from DB)
    const dbReminders = await prisma.teacherReminder.findMany({
      where: { teacherId: req.teacherId },
      orderBy: { createdAt: 'desc' }
    })
    const reminders = dbReminders.map(r => ({
      id: r.id,
      text: r.text,
      subtext: r.subtext || undefined,
      done: r.done
    }))

    // Compute Overall Class Average
    let classAverage = 0
    if (subjectPerformance.length > 0) {
      const validScores = subjectPerformance.filter(s => s.score > 0)
      if (validScores.length > 0) {
        classAverage = Math.round(validScores.reduce((acc, curr) => acc + curr.score, 0) / validScores.length)
      }
    }

    res.json({
      success: true,
      profile: {
        teacherId: teacher.id,
        name: teacher.name || 'Staff Member',
        email: teacher.email,
        phone: teacher.phone,
        photo: teacher.photo,
        branchName: teacher.branch?.name || 'School Campus',
        primaryForm: primaryForm
      },
      kpi: {
        studentsCount: totalStudentsCount,
        presentTodayCount: presentCount,
        subjectsCount: subjectsCount,
        assignmentsCount: assignmentsCount,
        pendingReviewCount: pendingReviewCount,
        testsCount: testsCount,
        ongoingTestsCount: testsCount,
        classAverage: classAverage
      },
      attendance: {
        overallPercentage: attendancePct,
        presentCount,
        lateCount,
        absentCount,
        presentPct: totalStudentsCount > 0 ? Math.round((presentCount / totalStudentsCount) * 100) : 0,
        latePct: totalStudentsCount > 0 ? Math.round((lateCount / totalStudentsCount) * 100) : 0,
        absentPct: totalStudentsCount > 0 ? Math.round((absentCount / totalStudentsCount) * 100) : 0
      },
      subjectPerformance,
      teachingSummary: {
        lessonNotesCount,
        assignmentsGivenCount: assignmentsCount,
        testsCreatedCount: testsCount,
        scoresEnteredPct: classAverage > 0 ? 100 : 0
      },
      subjects: Array.from(uniqueSubjectsMap.entries()).map(([id, name], idx) => ({
        id,
        name,
        studentsCount: totalStudentsCount,
        score: subjectPerformance.find(sp => sp.name === name)?.score || 0,
        nextLesson: 'Scheduled on Timetable'
      })),
      myClasses,
      reminders,
      recentActivities
    })
  } catch (error) {
    console.error('[TEACHER] Dashboard overview error:', error)
    res.status(500).json({ success: false, message: 'Failed to load teacher dashboard overview.' })
  }
})

/**
 * GET /api/teacher/roster
 * Fetch student roster for teacher's form and subject classes with parent contact info.
 */
router.get('/roster', assertTeacher, async (req, res) => {
  try {
    const [formAllocations, subjectAssignments] = await Promise.all([
      prisma.teacherAllocation.findMany({
        where: { teacherId: req.teacherId }
      }),
      prisma.subjectAssign.findMany({
        where: { teacherId: req.teacherId }
      })
    ])

    const classSectionPairs = [
      ...formAllocations.map(fa => ({ classId: fa.classId, sectionId: fa.sectionId })),
      ...subjectAssignments.map(sa => ({ classId: sa.classId, sectionId: sa.sectionId }))
    ]

    if (classSectionPairs.length === 0) {
      return res.json({ success: true, students: [] })
    }

    const enrolls = await prisma.enroll.findMany({
      where: {
        OR: classSectionPairs.map(p => ({ classId: p.classId, sectionId: p.sectionId }))
      },
      include: {
        student: {
          include: {
            parent: true
          }
        },
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } }
      },
      orderBy: { roll: 'asc' }
    })

    const students = enrolls.map(e => ({
      id: e.student.id,
      registerNo: e.student.registerNo,
      rollNo: e.roll,
      firstName: e.student.firstName,
      lastName: e.student.lastName,
      gender: e.student.gender,
      photo: e.student.photo,
      className: e.class?.name || 'N/A',
      sectionName: e.section?.name || 'N/A',
      parent: e.student.parent ? {
        id: e.student.parent.id,
        name: e.student.parent.name,
        fatherName: e.student.parent.fatherName,
        motherName: e.student.parent.motherName,
        mobileno: e.student.parent.mobileno,
        email: e.student.parent.email,
        address: e.student.parent.address
      } : null
    }))

    res.json({ success: true, students })
  } catch (error) {
    console.error('[TEACHER] Roster error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch student roster.' })
  }
})

/**
 * GET /api/teacher/reminders
 */
router.get('/reminders', assertTeacher, async (req, res) => {
  try {
    const reminders = await prisma.teacherReminder.findMany({
      where: { teacherId: req.teacherId },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, reminders })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch reminders.' })
  }
})

/**
 * POST /api/teacher/reminders
 */
router.post('/reminders', assertTeacher, async (req, res) => {
  try {
    const { text, subtext } = req.body
    if (!text) return res.status(400).json({ success: false, message: 'Reminder text is required.' })

    const reminder = await prisma.teacherReminder.create({
      data: {
        teacherId: req.teacherId,
        text,
        subtext: subtext || null
      }
    })
    res.json({ success: true, reminder })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to create reminder.' })
  }
})

/**
 * PUT /api/teacher/reminders/:id/toggle
 */
router.put('/reminders/:id/toggle', assertTeacher, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const reminder = await prisma.teacherReminder.findUnique({ where: { id } })
    if (!reminder || reminder.teacherId !== req.teacherId) {
      return res.status(404).json({ success: false, message: 'Reminder not found.' })
    }

    const updated = await prisma.teacherReminder.update({
      where: { id },
      data: { done: !reminder.done }
    })
    res.json({ success: true, reminder: updated })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle reminder.' })
  }
})

/**
 * DELETE /api/teacher/reminders/:id
 */
router.delete('/reminders/:id', assertTeacher, async (req, res) => {
  try {
    const id = Number(req.params.id)
    await prisma.teacherReminder.deleteMany({
      where: { id, teacherId: req.teacherId }
    })
    res.json({ success: true, message: 'Reminder deleted.' })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete reminder.' })
  }
})

/**
 * GET /api/teacher/messages
 */
router.get('/messages', assertTeacher, async (req, res) => {
  try {
    const messages = await prisma.parentMessage.findMany({
      where: {
        branchId: req.branchId,
        OR: [
          { recipientRole: 'TEACHER' },
          { recipientId: req.teacherId }
        ]
      },
      include: {
        parent: { select: { name: true, mobileno: true } },
        student: { select: { firstName: true, lastName: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, messages })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch messages.' })
  }
})

/**
 * POST /api/teacher/messages
 */
router.post('/messages', assertTeacher, async (req, res) => {
  try {
    const { parentId, studentId, subject, message } = req.body
    if (!parentId || !message) {
      return res.status(400).json({ success: false, message: 'Parent ID and message body are required.' })
    }

    const newMessage = await prisma.parentMessage.create({
      data: {
        branchId: req.branchId,
        parentId: Number(parentId),
        studentId: studentId ? Number(studentId) : null,
        recipientRole: 'PARENT',
        senderType: 'TEACHER',
        subject: subject || 'Teacher Notice',
        message
      }
    })

    res.json({ success: true, message: 'Message sent to parent successfully.', newMessage })
  } catch (error) {
    console.error('[TEACHER] Send message error:', error)
    res.status(500).json({ success: false, message: 'Failed to send message to parent.' })
  }
})

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

    const teacherRecord = await prisma.teacher.findUnique({
      where: { id: req.teacherId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        photo: true,
        department: true,
        qualifications: true,
      }
    })

    res.json({
      success: true,
      teacherId: req.teacherId,
      name: teacherRecord?.name || 'Teacher Account',
      email: teacherRecord?.email || null,
      phone: teacherRecord?.phone || null,
      photo: teacherRecord?.photo || null,
      department: teacherRecord?.department || null,
      qualifications: teacherRecord?.qualifications || null,
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
 * POST /api/teacher/profile/upload-photo
 * Upload or update authenticated teacher's photograph.
 */
router.post('/profile/upload-photo', async (req: any, res: any) => {
  try {
    const { photoBase64, photo } = req.body || {}
    const inputPhoto = photoBase64 || photo
    if (!inputPhoto) {
      return res.status(400).json({ success: false, message: 'Photograph data is required.' })
    }

    const teacher = await prisma.teacher.findUnique({
      where: { id: req.teacherId },
      select: { id: true, userId: true, name: true }
    })

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher profile not found.' })
    }

    const photoUrl = await savePhoto(inputPhoto, 'ugbekun2/staff/photos')

    const updated = await prisma.teacher.update({
      where: { id: req.teacherId },
      data: { photo: photoUrl },
      select: { id: true, name: true, photo: true }
    })

    if (teacher.userId) {
      await prisma.user.update({
        where: { id: teacher.userId },
        data: { photo: photoUrl }
      }).catch((e: any) => console.warn('[TEACHER] User photo sync warning:', e.message))
    }

    return res.json({
      success: true,
      message: 'Profile photograph updated successfully.',
      photo: updated.photo,
      profile: updated,
    })
  } catch (error: any) {
    console.error('[TEACHER] Profile photo upload error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update profile photo.' })
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

  const hasAccess = await hasClassAccess(prisma, req.teacherId, classId, sectionId, req)
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
              select: {
                remark: true,
                originalAiRemark: true,
                isAiGenerated: true,
                isEditedByHuman: true,
                status: true,
                reviewNotes: true
              }
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

    const students = enrolls.map(e => {
      const comm = e.student.commentaries[0]
      return {
        id: e.student.id,
        firstName: e.student.firstName,
        lastName: e.student.lastName,
        registerNo: e.student.registerNo,
        gender: e.student.gender,
        remark: comm?.remark || '',
        originalAiRemark: comm?.originalAiRemark || null,
        isAiGenerated: comm?.isAiGenerated || false,
        isEditedByHuman: comm?.isEditedByHuman || false,
        status: comm?.status || 'DRAFT',
        reviewNotes: comm?.reviewNotes || null
      }
    })

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

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId, req)
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

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId, req)
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

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req)
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

    // Log teacher audit activity
    await prisma.teacherActivity.create({
      data: {
        branchId: req.branchId,
        teacherId: req.teacherId,
        activity: 'You marked class roll call attendance',
        type: 'ATTENDANCE'
      }
    }).catch(() => null)

    // Trigger gamification check asynchronously
    gamificationService.checkAttendanceTimeliness(prisma, req.teacherId, classId, sectionId, targetDate, req.branchId)
      .catch(err => console.error('[Gamification] Error in attendance trigger:', err.message))

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

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req)
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
    const parsedDate = new Date(attendanceDate as string)
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
  const { classId, sectionId, studentId, remark, originalAiRemark, isAiGenerated } = req.body
  if (!classId || !sectionId || !studentId || remark === undefined) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' })
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can write card remarks for students in this class.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5
    const isEditedByHuman = isAiGenerated ? (remark !== originalAiRemark) : false

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
        data: {
          remark,
          originalAiRemark: originalAiRemark || null,
          isAiGenerated: !!isAiGenerated,
          isEditedByHuman,
          status: 'TEACHER_APPROVED'
        }
      })
    } else {
      await prisma.studentCommentary.create({
        data: {
          studentId: Number(studentId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          remark,
          originalAiRemark: originalAiRemark || null,
          isAiGenerated: !!isAiGenerated,
          isEditedByHuman,
          status: 'TEACHER_APPROVED',
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
 * POST /api/teacher/commentary/generate-ai
 * Generates an AI-driven qualitative remark using Deepseek AI based on term performance.
 */
router.post('/commentary/generate-ai', async (req, res) => {
  const { classId, sectionId, studentId, behavioralTags = [] } = req.body
  if (!classId || !sectionId || !studentId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and studentId are required.' })
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the designated Form Teacher can generate card remarks.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // 1. Fetch Student details
    const student = await prisma.student.findUnique({
      where: { id: Number(studentId) },
      select: { firstName: true, lastName: true }
    })
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' })
    }

    // 2. Fetch all marks in this session
    const marks = await prisma.mark.findMany({
      where: {
        studentId: Number(studentId),
        sessionId,
      },
      include: {
        subject: { select: { name: true } }
      }
    })

    const grades = {}
    const subjectScores = {}
    for (const m of marks) {
      if (!m.mark || m.absent === '1') continue
      const score = parseFloat(m.mark)
      if (isNaN(score)) continue
      const subjName = m.subject.name
      if (!subjectScores[subjName]) {
        subjectScores[subjName] = []
      }
      subjectScores[subjName].push(score)
    }

    for (const [subj, list] of Object.entries(subjectScores)) {
      const avg = (list as number[]).reduce((a: number, b: number) => a + b, 0) / (list as number[]).length
      grades[subj] = Math.round(avg * 10) / 10
    }

    // 3. Fetch online submissions
    const onlineSubmissions = await prisma.onlineExamSubmission.findMany({
      where: {
        studentId: Number(studentId),
        onlineExam: {
          sessionId,
        }
      },
      include: {
        onlineExam: {
          include: {
            subject: { select: { name: true } }
          }
        }
      }
    })

    const onlineScoresBySubject = {}
    for (const sub of onlineSubmissions) {
      if (sub.totalMark === null || sub.totalMark === undefined) continue
      const subjName = sub.onlineExam.subject.name
      if (!onlineScoresBySubject[subjName]) {
        onlineScoresBySubject[subjName] = []
      }
      onlineScoresBySubject[subjName].push(sub.totalMark)
    }

    // Merge manual and online marks
    const mergedGrades = {}
    const allSubjects = new Set([...Object.keys(grades), ...Object.keys(onlineScoresBySubject)])
    for (const subj of allSubjects) {
      const list = [
        ...(grades[subj] !== undefined ? [grades[subj]] : []),
        ...(onlineScoresBySubject[subj] || []),
      ]
      if (list.length > 0) {
        const avg = list.reduce((a, b) => a + b, 0) / list.length
        mergedGrades[subj] = Math.round(avg * 10) / 10
      }
    }

    // 4. Fetch current term attendance logs
    const attendanceRecords = await prisma.attendance.findMany({
      where: {
        studentId: Number(studentId),
        sessionId,
      }
    })
    const totalDays = attendanceRecords.length
    const presentDays = attendanceRecords.filter(a => {
      const statusLower = String(a.status || '').toLowerCase()
      return statusLower === 'present' || statusLower === 'late'
    }).length
    const attendanceRate = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 100

    // 5. Fetch historical term performance averages
    const historicalMarks = await prisma.mark.findMany({
      where: {
        studentId: Number(studentId),
        sessionId: { not: sessionId }
      }
    })
    const historicalBySession = {}
    for (const m of historicalMarks) {
      if (!m.mark || m.absent === '1') continue
      const score = parseFloat(m.mark)
      if (isNaN(score)) continue
      if (!historicalBySession[m.sessionId]) {
        historicalBySession[m.sessionId] = []
      }
      historicalBySession[m.sessionId].push(score)
    }
    const historicalAverages = Object.entries(historicalBySession).map(([sessId, list]) => {
      const avg = (list as number[]).reduce((a: number, b: number) => a + b, 0) / (list as number[]).length
      return `Session ${sessId}: ${Math.round(avg * 10) / 10}%`
    }).join(', ')

    // 6. Generate AI Qualitative Commentary
    const scoresList: number[] = Object.values(mergedGrades) as any
    const averageScore = scoresList.length > 0 ? Math.round(scoresList.reduce((a: number, b: number) => a + b, 0) / scoresList.length) : 75

    const commentaryDraft = await generateStudentAiCommentary({
      studentName: `${student.firstName} ${student.lastName}`,
      averageScore,
      attendanceRate,
      marksBySubject: mergedGrades,
      historicalAverages,
      behavioralTags,
      tone: 'constructive'
    })

    res.json({
      success: true,
      draft: commentaryDraft
    })
  } catch (error) {
    console.error('[TEACHER] AI Commentary Generation Error:', error)
    res.status(500).json({ success: false, message: 'AI failed to generate narrative commentary.' })
  }
})

/**
 * POST /api/teacher/commentary/batch-generate-ai
 * Generates personalized qualitative commentary for an entire classroom roster.
 */
router.post('/commentary/batch-generate-ai', async (req, res) => {
  const { classId, sectionId, tone = 'constructive', behavioralTags = [] } = req.body
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' })
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can generate class report commentary.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Fetch enrolled students
    const enrollments = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
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
    })

    const studentsData = []

    for (const enr of enrollments) {
      const st = enr.student
      if (!st) continue

      // Fetch marks
      const marks = await prisma.mark.findMany({
        where: { studentId: st.id, sessionId },
        include: { subject: { select: { name: true } } }
      })

      const marksBySubject = {}
      for (const m of marks) {
        if (!m.mark || m.absent === '1') continue
        const score = parseFloat(m.mark)
        if (!isNaN(score)) {
          marksBySubject[m.subject.name] = score
        }
      }

      const scoresList: number[] = Object.values(marksBySubject) as any
      const avg = scoresList.length > 0 ? Math.round(scoresList.reduce((a: number, b: number) => a + b, 0) / scoresList.length) : 70

      // Fetch attendance
      const att = await prisma.attendance.findMany({
        where: { studentId: st.id, sessionId }
      })
      const totalDays = att.length
      const presentDays = att.filter(a => String(a.status || '').toLowerCase() === 'present' || String(a.status || '').toLowerCase() === 'late').length
      const attendanceRate = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 100

      // Fetch existing commentary
      const existingComm = await prisma.studentCommentary.findUnique({
        where: {
          studentId_sessionId: {
            studentId: st.id,
            sessionId
          }
        }
      })

      studentsData.push({
        studentId: st.id,
        studentName: `${st.firstName} ${st.lastName}`,
        registerNo: st.registerNo || '',
        averageScore: avg,
        attendanceRate,
        marksBySubject,
        behavioralTags,
        existingRemark: existingComm?.remark || null
      })
    }

    const batchGenerated = await generateBatchClassCommentary(studentsData, tone)

    res.json({
      success: true,
      count: batchGenerated.length,
      commentaries: batchGenerated
    })
  } catch (err) {
    console.error('[TEACHER] Batch commentary generate error:', err)
    res.status(500).json({ success: false, message: 'Failed to batch generate commentary.' })
  }
})

/**
 * POST /api/teacher/commentary/batch-save
 * Batch saves approved student remarks to student_commentary table.
 */
router.post('/commentary/batch-save', async (req, res) => {
  const { classId, sectionId, commentaries = [] } = req.body
  if (!classId || !sectionId || !Array.isArray(commentaries)) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and commentaries array required.' })
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can save card remarks.'
    })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    let savedCount = 0

    for (const item of commentaries) {
      if (!item.studentId || !item.remark) continue

      const existing = await prisma.studentCommentary.findUnique({
        where: {
          studentId_sessionId: {
            studentId: Number(item.studentId),
            sessionId
          }
        }
      })

      if (existing) {
        await prisma.studentCommentary.update({
          where: { id: existing.id },
          data: {
            remark: item.remark,
            originalAiRemark: item.originalAiRemark || null,
            isAiGenerated: !!item.isAiGenerated,
            isEditedByHuman: !!item.isEditedByHuman,
            status: item.status || 'TEACHER_APPROVED'
          }
        })
      } else {
        await prisma.studentCommentary.create({
          data: {
            studentId: Number(item.studentId),
            classId: Number(classId),
            sectionId: Number(sectionId),
            remark: item.remark,
            originalAiRemark: item.originalAiRemark || null,
            isAiGenerated: !!item.isAiGenerated,
            isEditedByHuman: !!item.isEditedByHuman,
            status: item.status || 'TEACHER_APPROVED',
            sessionId,
            branchId: req.branchId || 1
          }
        })
      }
      savedCount++
    }

    res.json({
      success: true,
      message: `Successfully saved ${savedCount} student report remarks.`,
      savedCount
    })
  } catch (err) {
    console.error('[TEACHER] Batch commentary save error:', err)
    res.status(500).json({ success: false, message: 'Failed to batch save commentaries.' })
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

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req)
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

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId, req)
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
        cbtMark: true,
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
      const markRec = markMap.get(student.id) as any
      const objectiveScore = onlineSubMap.get(student.id) || 0
      const theoryMark = markRec?.mark ? Number(markRec.mark) : null
      const savedCbtMark = markRec?.cbtMark ? Number(markRec.cbtMark) : null
      const absent = markRec?.absent === '1'

      return {
        studentId: student.id,
        registerNo: student.registerNo,
        firstName: student.firstName,
        lastName: student.lastName,
        gender: student.gender,
        theoryMark: absent ? null : theoryMark,
        objectiveMark: savedCbtMark !== null ? savedCbtMark : objectiveScore,
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
  const { classId, sectionId, subjectId, examId, studentId, theoryMark, objectiveMark, absent } = req.body
  if (!classId || !sectionId || !subjectId || !examId || !studentId) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' })
  }

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId, req)
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
      select: { id: true, cbtMark: true }
    })

    const markValue = theoryMark !== undefined && theoryMark !== null && theoryMark !== '' ? String(theoryMark) : null
    const absentValue = absent ? '1' : null
    const passedCbtMark = objectiveMark !== undefined && objectiveMark !== null && objectiveMark !== '' ? String(objectiveMark) : null

    if (existing) {
      const updateData: any = {
        mark: markValue,
        absent: absentValue
      }
      if (req.isAdmin) {
        updateData.cbtMark = passedCbtMark
      }
      await prisma.mark.update({
        where: { id: existing.id },
        data: updateData
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
          cbtMark: passedCbtMark,
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

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId, req)
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

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can compile and export class report cards.'
    })
  }

  try {
    const limit = parseInt(rankingLimit as string, 10) || 3
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

      const myIndex = rankedList.findIndex(x => x.studentId === parsedStudentId)
      if (myIndex !== -1) {
        rank = myIndex + 1
      }
    }

    // 6. Fetch commentary
    const commentaryRecord = await prisma.studentCommentary.findFirst({
      where: {
        studentId: parsedStudentId,
        sessionId,
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
    console.error('[TEACHER] Export PDF error:', error)
    res.status(500).json({ success: false, message: 'Failed to generate PDF report card.' })
  }
})

/**
 * GET /api/teacher/report-cards/export-batch-pdf
 * Generates an A4 multi-page Batch PDF for all students in a classroom (Form Teacher only).
 */
router.get('/report-cards/export-batch-pdf', async (req, res) => {
  const { classId, sectionId, rankingType = 'full', rankingLimit = 3 } = req.query
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' })
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req)
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can export batch report cards for this class.'
    })
  }

  try {
    const limit = parseInt(rankingLimit as string, 10) || 3
    const parsedClassId = Number(classId)
    const parsedSectionId = Number(sectionId)

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const branch = await prisma.branch.findUnique({
      where: { id: req.branchId },
      select: { name: true, code: true }
    })

    const cls = await prisma.class.findUnique({ where: { id: parsedClassId }, select: { name: true, isEcd: true } })
    const sec = await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } })
    const sess = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } })

    const className = cls?.name || 'Classroom'
    const sectionName = sec?.name || 'Main'
    const sessionName = sess?.schoolYear || 'Active Session'

    let formTeacherName = 'Form Teacher'
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId: req.branchId },
      include: { teacher: { select: { name: true } } }
    })
    if (formAllocation?.teacher) formTeacherName = formAllocation.teacher.name

    const enrolls = await prisma.enroll.findMany({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId: req.branchId },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } }
      },
      orderBy: { student: { lastName: 'asc' } }
    })

    const studentIds = enrolls.map(e => e.studentId)
    if (studentIds.length === 0) {
      return res.status(404).json({ success: false, message: 'No enrolled students found.' })
    }

    const allMarks = await prisma.mark.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId: req.branchId },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } }
      }
    })

    const avgMap = {}
    allMarks.forEach(m => {
      const k = `${m.examId}-${m.subjectId}`
      if (!avgMap[k]) avgMap[k] = { sum: 0, count: 0 }
      const tot = (parseFloat(m.cbtMark || '0')) + (parseFloat(m.mark || '0'))
      avgMap[k].sum += tot
      avgMap[k].count += 1
    })

    const studentAggregates = {}
    const studentMarksMap = {}
    studentIds.forEach(id => {
      studentAggregates[id] = { sum: 0, count: 0 }
      studentMarksMap[id] = []
    })

    allMarks.forEach(m => {
      const testScore = m.cbtMark ? parseFloat(m.cbtMark) : 0
      const examScore = m.mark ? parseFloat(m.mark) : 0
      const totalScore = testScore + examScore

      if (studentMarksMap[m.studentId]) {
        const k = `${m.examId}-${m.subjectId}`
        const cAvg = avgMap[k] && avgMap[k].count > 0 ? Number((avgMap[k].sum / avgMap[k].count).toFixed(1)) : totalScore

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
        })

        studentAggregates[m.studentId].sum += totalScore
        studentAggregates[m.studentId].count += 1
      }
    })

    const rankList = studentIds.map(id => ({
      id,
      avg: studentAggregates[id].count > 0 ? (studentAggregates[id].sum / studentAggregates[id].count) : 0
    })).sort((a, b) => b.avg - a.avg)

    const rankMap = {}
    rankList.forEach((item, idx) => { rankMap[item.id] = idx + 1 })

    const commentaries = await prisma.studentCommentary.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId: req.branchId }
    })
    const commMap = {}
    commentaries.forEach(c => { commMap[c.studentId] = c })

    const montessoriList = await prisma.montessoriAssessment.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId: req.branchId },
      include: { exam: { select: { name: true, resumptionDate: true } } }
    })
    const montMap = {}
    montessoriList.forEach(m => { montMap[m.studentId] = m })

    const batchStudents = enrolls.map(e => {
      const st = e.student
      const agg = studentAggregates[st.id] || { sum: 0, count: 0 }
      const avg = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(1)) : 0
      const rk = rankMap[st.id] || null
      const comm = commMap[st.id]
      const mont = montMap[st.id]

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
        rankingLimit: limit,
        resumptionDate: allMarks[0]?.exam?.resumptionDate || null,
        formTeacherName,
        examName: mont?.exam?.name || 'Term Evaluation',
        assessment: mont || {}
      }
    })

    const pdfBuffer = await generateBatchClassReportCardsPdf({
      schoolName: branch?.name || 'Ugbekun Schools',
      branchCode: branch?.code || 'GEN',
      className,
      sectionName,
      sessionName,
      students: batchStudents
    })

    const safeClassName = className.replace(/\s+/g, '_')
    const safeSectionName = sectionName.replace(/\s+/g, '_')

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="batch_report_cards_${safeClassName}_${safeSectionName}.pdf"`)
    return res.send(pdfBuffer)
  } catch (error) {
    console.error('[TEACHER] Batch export PDF error:', error)
    return res.status(500).json({ success: false, message: 'Failed to generate batch report cards PDF.' })
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

    const access = await hasClassAccess(prisma, req.teacherId, cid, sid, req)
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
      const evalRec: any = assessmentMap.get(student.id) || {}

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

    const access = await hasClassAccess(prisma, req.teacherId, cid, sid, req)
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

    // Log teacher audit activity
    await prisma.teacherActivity.create({
      data: {
        branchId: req.branchId,
        teacherId: req.teacherId,
        activity: `You assigned a new homework: ${title}`,
        type: 'HOMEWORK'
      }
    }).catch(() => null)

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
    // Trigger gamification check asynchronously
    gamificationService.checkHomeworkGradingTimeliness(prisma, req.teacherId, submission.homeworkId, req.branchId)
      .catch(err => console.error('[Gamification] Error in homework grading trigger:', err.message))

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
  const { title, classId, subjectId, passingMark, questions, duration, examDate } = req.body
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
        examDate: examDate ? new Date(examDate) : null,
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

// GET /api/teacher/question-bank
router.get('/question-bank', async (req, res) => {
  const { subjectId, classId } = req.query
  try {
    const whereClause: any = {
      branchId: req.branchId
    }
    if (subjectId) {
      whereClause.subjectId = Number(subjectId)
    }
    if (classId) {
      whereClause.classId = Number(classId)
    }

    const items = await prisma.questionBank.findMany({
      where: whereClause,
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, items })
  } catch (error) {
    console.error('[TEACHER] Get question-bank error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve Question Bank items.' })
  }
})

// POST /api/teacher/question-bank
router.post('/question-bank', async (req, res) => {
  const { questionText, questionType, options, correctOption, marks, subjectId, classId } = req.body
  if (!questionText || !subjectId) {
    return res.status(400).json({ success: false, message: 'Question text and Subject are required.' })
  }
  try {
    const item = await prisma.questionBank.create({
      data: {
        questionText,
        questionType: questionType || 'mcq',
        options: options || null,
        correctOption: correctOption || null,
        marks: marks !== undefined ? Number(marks) : 1.0,
        subjectId: Number(subjectId),
        classId: classId ? Number(classId) : null,
        branchId: req.branchId
      }
    })
    res.json({ success: true, item, message: 'Question saved to Question Bank successfully.' })
  } catch (error) {
    console.error('[TEACHER] Create question-bank item error:', error)
    res.status(500).json({ success: false, message: 'Failed to save question to bank.' })
  }
})

// PUT /api/teacher/question-bank/:id
router.put('/question-bank/:id', async (req, res) => {
  const { id } = req.params
  const { questionText, questionType, options, correctOption, marks, subjectId, classId } = req.body
  try {
    const item = await prisma.questionBank.update({
      where: { id: Number(id) },
      data: {
        questionText,
        questionType,
        options,
        correctOption,
        marks: marks !== undefined ? Number(marks) : undefined,
        subjectId: subjectId ? Number(subjectId) : undefined,
        classId: classId ? Number(classId) : null,
      }
    })
    res.json({ success: true, item, message: 'Question updated successfully.' })
  } catch (error) {
    console.error('[TEACHER] Update question-bank item error:', error)
    res.status(500).json({ success: false, message: 'Failed to update question.' })
  }
})

// DELETE /api/teacher/question-bank/:id
router.delete('/question-bank/:id', async (req, res) => {
  const { id } = req.params
  try {
    await prisma.questionBank.delete({
      where: { id: Number(id) }
    })
    res.json({ success: true, message: 'Question removed from bank.' })
  } catch (error) {
    console.error('[TEACHER] Delete question-bank item error:', error)
    res.status(500).json({ success: false, message: 'Failed to delete question.' })
  }
})

// POST /api/teacher/online-exams/distribute
router.post('/online-exams/distribute', async (req, res) => {
  const { examId, title, subjectId, passingMark, duration, questions, classIds, examDate } = req.body
  if (!classIds || !Array.isArray(classIds) || classIds.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one target class is required.' })
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    let finalTitle = title
    let finalSubjectId = Number(subjectId)
    let finalPassingMark = passingMark !== undefined ? Number(passingMark) : 0
    let finalDuration = duration !== undefined ? Number(duration) : 0
    let finalQuestions = questions || []
    let finalExamDate = examDate ? new Date(examDate) : null

    if (examId) {
      const existingExam = await prisma.onlineExam.findUnique({
        where: { id: Number(examId) }
      })
      if (!existingExam) {
        return res.status(404).json({ success: false, message: 'Source exam not found.' })
      }
      finalTitle = existingExam.title
      finalSubjectId = existingExam.subjectId
      finalPassingMark = existingExam.passingMark
      finalDuration = existingExam.duration
      finalQuestions = existingExam.questions
      finalExamDate = examDate ? new Date(examDate) : existingExam.examDate
    }

    if (!finalTitle || !finalSubjectId) {
      return res.status(400).json({ success: false, message: 'Exam title and Subject are required.' })
    }

    // Create online exam for each class
    const createdExams = []
    for (const cid of classIds) {
      const created = await prisma.onlineExam.create({
        data: {
          title: finalTitle,
          classId: Number(cid),
          subjectId: finalSubjectId,
          passingMark: finalPassingMark,
          duration: finalDuration,
          questions: finalQuestions,
          examDate: finalExamDate,
          branchId: req.branchId,
          sessionId
        }
      })
      createdExams.push(created)
    }

    res.json({
      success: true,
      message: `Exam successfully distributed to ${classIds.length} classes.`,
      examsCount: createdExams.length
    })
  } catch (error) {
    console.error('[TEACHER] Distribute exam error:', error)
    res.status(500).json({ success: false, message: 'Failed to distribute exam.' })
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

// PUT /api/teacher/online-exams/:id
router.put('/online-exams/:id', async (req, res) => {
  const { id } = req.params
  const { title, passingMark, duration, examDate } = req.body
  try {
    const exam = await prisma.onlineExam.update({
      where: { id: Number(id) },
      data: {
        title,
        passingMark: passingMark !== undefined ? Number(passingMark) : undefined,
        duration: duration !== undefined ? Number(duration) : undefined,
        examDate: examDate ? new Date(examDate) : null
      }
    })
    res.json({ success: true, exam, message: 'Online exam updated successfully.' })
  } catch (error) {
    console.error('[TEACHER] Update online exam error:', error)
    res.status(500).json({ success: false, message: 'Failed to update online exam.' })
  }
})

// DELETE /api/teacher/online-exams/:id
router.delete('/online-exams/:id', async (req, res) => {
  const { id } = req.params
  try {
    await prisma.onlineExamSubmission.deleteMany({
      where: { onlineExamId: Number(id) }
    })
    await prisma.onlineExam.delete({
      where: { id: Number(id) }
    })
    res.json({ success: true, message: 'Online exam deleted successfully.' })
  } catch (error) {
    console.error('[TEACHER] Delete online exam error:', error)
    res.status(500).json({ success: false, message: 'Failed to delete online exam.' })
  }
})

// Levenshtein & matching helpers
function levenshteinDistance(s1, s2) {
  s1 = s1.toLowerCase().trim();
  s2 = s2.toLowerCase().trim();
  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  const matrix = [];
  for (let i = 0; i <= s2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= s1.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= s2.length; i++) {
    for (let j = 1; j <= s1.length; j++) {
      if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[s2.length][s1.length];
}

function computeSimilarity(s1, s2) {
  const distance = levenshteinDistance(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  if (maxLength === 0) return 1.0;
  return 1.0 - distance / maxLength;
}

// POST /api/teacher/grades/scan
router.post('/grades/scan', upload.single('file'), async (req, res) => {
  const decoded = await assertTeacher(req, res)
  if (!decoded) return

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image file uploaded.' })
  }

  const { classId, sectionId, examId, subjectId } = req.body
  if (!classId || !sectionId || !examId || !subjectId) {
    return res.status(400).json({ success: false, message: 'Missing required parameters (classId, sectionId, examId, subjectId).' })
  }

  const parsedClassId = parseInt(classId, 10)
  const parsedSectionId = parseInt(sectionId, 10)
  const parsedExamId = parseInt(examId, 10)
  const parsedSubjectId = parseInt(subjectId, 10)

  try {
    // 1. OCR processing using Tesseract.js
    if (!Tesseract) {
      return res.status(400).json({
        success: false,
        message: 'OCR Engine is not initialized. Please try again later.'
      })
    }
    const ocrResult = await Tesseract.recognize(req.file.buffer, 'eng')
    const rawText = ocrResult.data.text

    if (!rawText || rawText.trim().length < 5) {
      return res.status(400).json({
        success: false,
        message: 'No text could be extracted from the image. Please verify image clarity.'
      })
    }

    // 2. Upload image to Cloudinary
    const fileBase64 = req.file.buffer.toString('base64')
    const fileUrl = await uploadBase64Image({
      base64: fileBase64,
      mime: req.file.mimetype,
      folder: 'score_sheets'
    })

    // 3. Request JSON parsing from Deepseek
    const prompt = `
      You are a high-precision data entry engine for school gradebooks.
      Analyze the provided raw text parsed from a student score sheet. The text contains names or admission numbers alongside numeric scores.

      Extract all rows into a JSON array matching the structure:
      {
        "extractedRows": [
          {
            "identifier": "Admission/Registration number or name string written on the row",
            "rawName": "Name string written on the row (or null if only ID is present)",
            "score": number or null (if unmarked/absent/unreadable)
          }
        ]
      }

      Raw OCR Text:
      """
      ${rawText}
      """

      Rules:
      1. Strictly extract only what is written in the text. Do not invent any numbers.
      2. If a score is unreadable or empty, set it to null.
      3. Output ONLY valid, parsable JSON. No conversational markdown block, no introductory text.
    `

    const completion = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You extract scores from OCR text and output pure JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    })

    const responseText = completion.choices[0].message.content
    let extractedRows = []
    try {
      const cleaned = responseText.replace(/```json/g, '').replace(/```/g, '').trim()
      const data = JSON.parse(cleaned)
      extractedRows = data.extractedRows || []
    } catch (e) {
      console.error('Deepseek JSON Parse Error:', e, responseText)
      return res.status(500).json({ success: false, message: 'Failed to structure the OCR output. Please retry.' })
    }

    // 4. Fetch Active Registry and align names
    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: parsedClassId,
        sectionId: parsedSectionId,
        sessionId,
        branchId: decoded.branchId || null
      },
      include: {
        student: true
      }
    })

    // Prepare parsed list
    const alignedRows = []
    let rowId = 1

    for (const row of extractedRows) {
      const identifierStr = String(row.identifier || '').trim()
      const rawNameStr = String(row.rawName || '').trim()
      
      let matchedStudent = null
      let bestScore = 0

      // Exact match on RegNo
      if (identifierStr) {
        matchedStudent = enrolls.find(e => e.student.registerNo.toLowerCase() === identifierStr.toLowerCase())?.student || null
      }

      // Fuzzy match on names if not matched
      if (!matchedStudent) {
        for (const enroll of enrolls) {
          const student = enroll.student
          const studentFullName = `${student.firstName} ${student.lastName}`
          const studentFullNameRev = `${student.lastName} ${student.firstName}`
          
          let score1 = computeSimilarity(rawNameStr, studentFullName)
          let score2 = computeSimilarity(rawNameStr, studentFullNameRev)
          let score3 = identifierStr ? computeSimilarity(identifierStr, studentFullName) : 0
          let score4 = identifierStr ? computeSimilarity(identifierStr, studentFullNameRev) : 0

          const maxScore = Math.max(score1, score2, score3, score4)
          if (maxScore > bestScore) {
            bestScore = maxScore
            matchedStudent = student
          }
        }
      } else {
        bestScore = 1.0 // Exact match
      }

      // If matched student similarity is too low, reject match
      if (bestScore < 0.65) {
        matchedStudent = null
        bestScore = 0
      }

      // Determine anomalies
      let hasAnomaly = false
      let anomalyReason = null

      if (!matchedStudent) {
        hasAnomaly = true
        anomalyReason = 'Student not found in registry.'
      }

      const scoreNum = row.score !== null ? parseFloat(row.score) : NaN
      if (row.score !== null && (isNaN(scoreNum) || scoreNum < 0 || scoreNum > 100)) {
        hasAnomaly = true
        anomalyReason = anomalyReason ? anomalyReason + ' Score out of bounds (0-100).' : 'Score out of bounds (0-100).'
      }

      // Low confidence matches
      const lowConfidence = matchedStudent && bestScore < 0.85

      alignedRows.push({
        rowId: rowId++,
        inputIdentifier: identifierStr,
        inputName: rawNameStr || identifierStr,
        matchedStudentId: matchedStudent ? matchedStudent.id : null,
        matchedStudentName: matchedStudent ? `${matchedStudent.lastName}, ${matchedStudent.firstName}` : 'Unmatched',
        matchedRegNo: matchedStudent ? matchedStudent.registerNo : 'N/A',
        matchConfidence: Number(bestScore.toFixed(2)),
        extractedMark: isNaN(scoreNum) ? null : scoreNum,
        hasAnomaly: !!hasAnomaly,
        anomalyReason,
        lowConfidence: !!lowConfidence
      })
    }

    // Check for duplicate student mappings
    const studentCount = {}
    alignedRows.forEach(r => {
      if (r.matchedStudentId) {
        studentCount[r.matchedStudentId] = (studentCount[r.matchedStudentId] || 0) + 1
      }
    })
    alignedRows.forEach(r => {
      if (r.matchedStudentId && studentCount[r.matchedStudentId] > 1) {
        r.hasAnomaly = true
        r.anomalyReason = r.anomalyReason ? r.anomalyReason + ' Duplicate student mapping.' : 'Duplicate student mapping.'
      }
    })

    // Save scan staging record
    const stagingRecord = await prisma.scoreSheetScan.create({
      data: {
        fileName: req.file.originalname,
        fileUrl,
        classId: parsedClassId,
        sectionId: parsedSectionId,
        examId: parsedExamId,
        subjectId: parsedSubjectId,
        parsedData: alignedRows,
        status: 'PENDING_VALIDATION',
        teacherId: decoded.sub,
        branchId: decoded.branchId || 0
      }
    })

    res.json({
      success: true,
      scanId: stagingRecord.id,
      fileUrl,
      parsedData: alignedRows,
      message: 'Score sheet parsed successfully.'
    })
  } catch (error) {
    console.error('[TEACHER] Score sheet scan error:', error)
    res.status(500).json({ success: false, message: 'Internal server error while processing scan.' })
  }
})

// GET /api/teacher/grades/scan/:id
router.get('/grades/scan/:id', async (req, res) => {
  const decoded = await assertTeacher(req, res)
  if (!decoded) return

  const { id } = req.params

  try {
    const scan = await prisma.scoreSheetScan.findFirst({
      where: {
        id: Number(id),
        teacherId: decoded.sub
      }
    })

    if (!scan) {
      return res.status(404).json({ success: false, message: 'Scanned sheet record not found.' })
    }

    res.json({ success: true, scan })
  } catch (error) {
    console.error('[TEACHER] Get scan record error:', error)
    res.status(500).json({ success: false, message: 'Failed to retrieve scan record.' })
  }
})

// POST /api/teacher/grades/scan/:id/commit
router.post('/grades/scan/:id/commit', async (req, res) => {
  const decoded = await assertTeacher(req, res)
  if (!decoded) return

  const { id } = req.params
  const { verifiedData } = req.body

  if (!verifiedData || !Array.isArray(verifiedData)) {
    return res.status(400).json({ success: false, message: 'Invalid or missing verifiedData grid.' })
  }

  try {
    const scan = await prisma.scoreSheetScan.findFirst({
      where: {
        id: Number(id),
        teacherId: decoded.sub,
        status: 'PENDING_VALIDATION'
      }
    })

    if (!scan) {
      return res.status(404).json({ success: false, message: 'Staged scan record not found or already committed.' })
    }

    const globalSetting = await prisma.globalSettings.findFirst()
    const sessionId = globalSetting?.sessionId || 5

    // Run transaction
    await prisma.$transaction(async (tx) => {
      for (const row of verifiedData) {
        if (!row.matchedStudentId) continue

        const scoreVal = row.extractedMark !== null && row.extractedMark !== undefined ? String(row.extractedMark) : null

        const existingMark = await tx.mark.findFirst({
          where: {
            studentId: Number(row.matchedStudentId),
            subjectId: scan.subjectId,
            classId: scan.classId,
            sectionId: scan.sectionId,
            examId: scan.examId,
            sessionId
          }
        })

        if (existingMark) {
          await tx.mark.update({
            where: { id: existingMark.id },
            data: {
              mark: scoreVal,
              absent: scoreVal === null ? 'true' : 'false'
            }
          })
        } else {
          await tx.mark.create({
            data: {
              studentId: Number(row.matchedStudentId),
              subjectId: scan.subjectId,
              classId: scan.classId,
              sectionId: scan.sectionId,
              examId: scan.examId,
              mark: scoreVal,
              absent: scoreVal === null ? 'true' : 'false',
              sessionId,
              branchId: scan.branchId
            }
          })
        }
      }

      // Update staging status
      await tx.scoreSheetScan.update({
        where: { id: scan.id },
        data: {
          status: 'COMMITTED',
          parsedData: verifiedData
        }
      })
    })

    res.json({ success: true, message: 'Scores successfully committed to the production gradebook.' })
  } catch (error) {
    console.error('[TEACHER] Commit scan error:', error)
    res.status(500).json({ success: false, message: 'Transaction failed: Could not commit marks.' })
  }
})

// =============================================================================
// AI LESSON PLANNER, MANAGED MEDIA LIBRARY, & VIRTUAL CLASSROOMS
// =============================================================================

// Helper to save file locally
async function saveMediaFile(file) {
  const uploadDir = path.join(__dirname, '../uploads')
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true })
  }
  const filename = Date.now() + '_' + file.originalname.replace(/\s+/g, '_')
  const filepath = path.join(uploadDir, filename)
  fs.writeFileSync(filepath, file.buffer)
  return `/uploads/${filename}`
}

// Helper to generate Jitsi room token
function generateJitsiToken({ roomName, user, isModerator }) {
  const appId = process.env.JITSI_APP_ID || 'vpaas-magic-cookie-ugbekun';
  const appSecret = process.env.JITSI_APP_SECRET || 'jitsi_dummy_secret_key';
  
  const payload = {
    aud: 'jitsi',
    iss: appId,
    sub: appId,
    room: roomName,
    moderator: isModerator,
    context: {
      user: {
        id: String(user.id),
        name: user.name || user.username || 'Ugbekun User',
        email: user.email || '',
        avatar: user.photo || ''
      },
      features: {
        recording: true,
        livestreaming: true,
        'screen-sharing': true
      }
    }
  }
  return jwt.sign(payload, appSecret, { algorithm: 'HS256', expiresIn: '2h' })
}

// --- 1. Managed Media Library ---

// GET /api/teacher/media
router.get('/media', assertTeacher, async (req, res) => {
  try {
    const { classTier, topic } = req.query as any
    const where: any = {}
    if (classTier) where.classTier = classTier
    if (topic) where.topic = topic

    const items = await prisma.mediaItem.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, items })
  } catch (error) {
    console.error('[TEACHER] Fetch media error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch media library items.' })
  }
})

// POST /api/teacher/media
router.post('/media', assertTeacher, upload.single('file'), async (req, res) => {
  const { title, description, classTier, topic, accessType, price } = req.body
  if (!title || !classTier || !topic || !req.file) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' })
  }

  try {
    const fileUrl = await saveMediaFile(req.file)
    const mediaItem = await prisma.mediaItem.create({
      data: {
        title,
        description: description || null,
        fileUrl,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        classTier,
        topic,
        accessType: accessType === 'PREMIUM' ? 'PREMIUM' : 'FREE',
        price: accessType === 'PREMIUM' && price ? parseFloat(price) : null,
        uploadedBy: req.teacherId
      }
    })
    res.json({ success: true, message: 'Media item uploaded successfully.', item: mediaItem })
  } catch (error) {
    console.error('[TEACHER] Media upload error:', error)
    res.status(500).json({ success: false, message: 'Failed to upload media item.' })
  }
})

// DELETE /api/teacher/media/:id
router.delete('/media/:id', assertTeacher, async (req, res) => {
  try {
    const item = await prisma.mediaItem.findUnique({
      where: { id: Number(req.params.id) }
    })
    if (!item) {
      return res.status(404).json({ success: false, message: 'Media item not found.' })
    }
    await prisma.mediaItem.delete({
      where: { id: item.id }
    })
    const filepath = path.join(__dirname, '..', item.fileUrl)
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath)
      } catch (e) {
        console.warn('Could not delete physical file:', filepath)
      }
    }
    res.json({ success: true, message: 'Media item deleted successfully.' })
  } catch (error) {
    console.error('[TEACHER] Delete media error:', error)
    res.status(500).json({ success: false, message: 'Failed to delete media item.' })
  }
})

// --- 2. AI Lesson Planner ---

// POST /api/teacher/lesson-plan/generate
router.post('/lesson-plan/generate', assertTeacher, async (req, res) => {
  const { classId, subjectId, coreTopic } = req.body
  if (!classId || !subjectId || !coreTopic) {
    return res.status(400).json({ success: false, message: 'classId, subjectId, and coreTopic are required.' })
  }

  try {
    const classObj = await prisma.class.findUnique({
      where: { id: Number(classId) },
      select: { name: true }
    })
    const subjectObj = await prisma.subject.findUnique({
      where: { id: Number(subjectId) },
      select: { name: true }
    })

    if (!classObj || !subjectObj) {
      return res.status(404).json({ success: false, message: 'Class or Subject not found.' })
    }

    const result = await generatePedagogicalLessonPlan({
      subjectName: subjectObj.name,
      className: classObj.name,
      topic: coreTopic,
      subTopic: req.body.subTopic || '',
      duration: req.body.duration || '45 Minutes',
      weekNo: req.body.weekNo || 'Week 3'
    })

    res.json({
      success: true,
      draft: {
        objectives: result.educationalObjectives,
        materials: result.materialLists,
        teachingGuide: result.teachingGuide,
        assessments: result.assessmentCriteria,
        assignments: result.classAssignments,
        coreTopic: result.coreTopic
      }
    })
  } catch (error) {
    console.error('[TEACHER] AI Lesson Plan Generation Error:', error)
    res.status(500).json({ success: false, message: 'Failed to generate AI lesson plan draft.' })
  }
})

// GET /api/teacher/lesson-plan
router.get('/lesson-plan', assertTeacher, async (req, res) => {
  try {
    const plans = await prisma.lessonPlan.findMany({
      where: { teacherId: req.teacherId },
      include: {
        class: { select: { name: true } },
        subject: { select: { name: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, plans })
  } catch (error) {
    console.error('[TEACHER] Fetch lesson plans error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch lesson plans.' })
  }
})

// POST /api/teacher/lesson-plan
router.post('/lesson-plan', assertTeacher, async (req, res) => {
  const { classId, subjectId, coreTopic, objectives, materials, teachingGuide, assessments, assignments, status } = req.body
  if (!classId || !subjectId || !coreTopic) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' })
  }

  try {
    const plan = await prisma.lessonPlan.create({
      data: {
        teacherId: req.teacherId,
        classId: Number(classId),
        subjectId: Number(subjectId),
        coreTopic,
        educationalObjectives: objectives || null,
        materialLists: materials || null,
        teachingGuide: teachingGuide || null,
        assessmentCriteria: assessments || null,
        classAssignments: assignments || null,
        status: status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT'
      }
    })

    if (plan.status === 'PUBLISHED') {
      gamificationService.checkLessonPlanEarly(prisma, req.teacherId, plan.id, req.branchId)
        .catch(err => console.error('[Gamification] Error in lesson plan trigger:', err.message))
    }

    res.json({ success: true, message: 'Lesson plan saved successfully.', plan })
  } catch (error) {
    console.error('[TEACHER] Save lesson plan error:', error)
    res.status(500).json({ success: false, message: 'Failed to save lesson plan.' })
  }
})

// PUT /api/teacher/lesson-plan/:id
router.put('/lesson-plan/:id', assertTeacher, async (req, res) => {
  const { objectives, materials, teachingGuide, assessments, assignments, status, coreTopic } = req.body
  try {
    const plan = await prisma.lessonPlan.findUnique({
      where: { id: Number(req.params.id) }
    })
    if (!plan || plan.teacherId !== req.teacherId) {
      return res.status(404).json({ success: false, message: 'Lesson plan not found or access denied.' })
    }

    const updated = await prisma.lessonPlan.update({
      where: { id: plan.id },
      data: {
        coreTopic: coreTopic !== undefined ? coreTopic : plan.coreTopic,
        educationalObjectives: objectives !== undefined ? objectives : plan.educationalObjectives,
        materialLists: materials !== undefined ? materials : plan.materialLists,
        teachingGuide: teachingGuide !== undefined ? teachingGuide : plan.teachingGuide,
        assessmentCriteria: assessments !== undefined ? assessments : plan.assessmentCriteria,
        classAssignments: assignments !== undefined ? assignments : plan.classAssignments,
        status: status === 'PUBLISHED' ? 'PUBLISHED' : (status === 'DRAFT' ? 'DRAFT' : plan.status)
      }
    })

    if (updated.status === 'PUBLISHED') {
      gamificationService.checkLessonPlanEarly(prisma, req.teacherId, updated.id, req.branchId)
        .catch(err => console.error('[Gamification] Error in lesson plan trigger:', err.message))
    }

    res.json({ success: true, message: 'Lesson plan updated successfully.', plan: updated })
  } catch (error) {
    console.error('[TEACHER] Update lesson plan error:', error)
    res.status(500).json({ success: false, message: 'Failed to update lesson plan.' })
  }
})

// GET /api/teacher/lesson-plan/:id/pdf
router.get('/lesson-plan/:id/pdf', assertTeacher, async (req, res) => {
  try {
    const plan = await prisma.lessonPlan.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        teacher: { select: { name: true, branchId: true } },
        class: { select: { name: true } },
        subject: { select: { name: true } }
      }
    })

    if (!plan || plan.teacherId !== req.teacherId) {
      return res.status(404).json({ success: false, message: 'Lesson plan not found or access denied.' })
    }

    const branch = await prisma.branch.findUnique({
      where: { id: req.branchId || plan.teacher.branchId || 1 },
      select: { name: true, code: true }
    })

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
    })

    const sanitizedTopic = (plan.coreTopic || 'Lesson_Plan').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Lesson_Plan_${sanitizedTopic}.pdf"`)
    res.send(pdfBuffer)
  } catch (error) {
    console.error('[TEACHER] Lesson plan PDF export error:', error)
    res.status(500).json({ success: false, message: 'Failed to export lesson plan PDF.' })
  }
})

// --- 3. Communication Hub (Jitsi / WebRTC Live Rooms) ---

// POST /api/teacher/live-rooms
router.post('/live-rooms', assertTeacher, async (req, res) => {
  const { title, roomName, type, classId, sectionId, scheduledAt, durationMins } = req.body
  if (!title || !roomName || !type || !scheduledAt) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' })
  }

  try {
    const liveRoom = await prisma.liveRoom.create({
      data: {
        title,
        roomName: roomName.trim().toLowerCase().replace(/\s+/g, '-'),
        type: type === 'STAFF_ALIGNMENT' ? 'STAFF_ALIGNMENT' : 'STUDENT_CLASSROOM',
        hostId: req.teacherId,
        classId: classId ? Number(classId) : null,
        sectionId: sectionId ? Number(sectionId) : null,
        scheduledAt: new Date(scheduledAt),
        durationMins: durationMins ? Number(durationMins) : 45,
        isLive: false
      }
    })
    res.json({ success: true, message: 'Live room created successfully.', room: liveRoom })
  } catch (error) {
    console.error('[TEACHER] Create live room error:', error)
    res.status(500).json({ success: false, message: 'Failed to create live room.' })
  }
})

// GET /api/teacher/live-rooms
router.get('/live-rooms', assertTeacher, async (req, res) => {
  try {
    const rooms = await prisma.liveRoom.findMany({
      where: {
        OR: [
          { hostId: req.teacherId },
          { type: 'STAFF_ALIGNMENT' }
        ]
      },
      orderBy: { scheduledAt: 'desc' }
    })
    res.json({ success: true, rooms })
  } catch (error) {
    console.error('[TEACHER] Fetch live rooms error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch live rooms.' })
  }
})

// GET /api/teacher/live-rooms/:roomName/token
router.get('/live-rooms/:roomName/token', assertTeacher, async (req, res) => {
  const { roomName } = req.params
  try {
    const room = await prisma.liveRoom.findUnique({
      where: { roomName }
    })
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' })
    }

    const teacher = await prisma.teacher.findUnique({
      where: { id: req.teacherId }
    })

    const token = generateJitsiToken({
      roomName,
      user: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
        photo: teacher.photo
      },
      isModerator: room.hostId === req.teacherId
    })

    if (room.hostId === req.teacherId && !room.isLive) {
      await prisma.liveRoom.update({
        where: { id: room.id },
        data: { isLive: true }
      })
    }

    res.json({ success: true, token, roomName })
  } catch (error) {
    console.error('[TEACHER] Live token error:', error)
    res.status(500).json({ success: false, message: 'Failed to generate live room token.' })
  }
})

// GET /api/teacher/gamification/profile
router.get('/gamification/profile', assertTeacher, async (req, res) => {
  try {
    const teacher = await prisma.teacher.findUnique({
      where: { id: req.teacherId },
      select: { points: true, name: true }
    });

    const recentLedger = await prisma.gamificationLedger.findMany({
      where: { actorType: 'TEACHER', actorId: req.teacherId },
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
          entityType: 'TEACHER',
          entityId: req.teacherId,
          period: weeklyPeriodKey,
          branchId: req.branchId
        }
      }
    });

    // Get all time rank
    const alltimeCache = await prisma.leaderboardCache.findUnique({
      where: {
        entityType_entityId_period_branchId: {
          entityType: 'TEACHER',
          entityId: req.teacherId,
          period: alltimePeriodKey,
          branchId: req.branchId
        }
      }
    });

    res.json({
      success: true,
      points: teacher?.points || 0,
      recentLedger,
      weeklyRank: weeklyCache?.rank || '-',
      alltimeRank: alltimeCache?.rank || '-'
    });
  } catch (error) {
    console.error('[TEACHER] Get gamification profile error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve gamification profile.' });
  }
});

// GET /api/teacher/gamification/leaderboard
router.get('/gamification/leaderboard', assertTeacher, async (req, res) => {
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
        entityType: 'TEACHER',
        period: periodKey,
        branchId: req.branchId
      },
      orderBy: { points: 'desc' },
      take: 10
    });

    const teacherIds = cacheEntries.map(e => e.entityId);
    const teachers = await prisma.teacher.findMany({
      where: { id: { in: teacherIds } },
      select: { id: true, name: true }
    });

    const teacherMap = {};
    teachers.forEach(t => {
      teacherMap[t.id] = t.name;
    });

    const leaderboard = cacheEntries.map((entry, index) => ({
      rank: entry.rank,
      points: entry.points,
      name: teacherMap[entry.entityId] || `Teacher #${entry.entityId}`
    }));

    res.json({
      success: true,
      leaderboard
    });
  } catch (error) {
    console.error('[TEACHER] Get gamification leaderboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve gamification leaderboard.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PREDICTIVE ATTRITION RADAR & INTERVENTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/teacher/attrition/dashboard
 * Fetch students in the Form Teacher's classroom flagged with high/medium attrition risk.
 */
router.get('/attrition/dashboard', async (req, res) => {
  try {
    const allocations = await prisma.teacherAllocation.findMany({
      where: { teacherId: req.teacherId },
      select: { classId: true, sectionId: true }
    });

    if (allocations.length === 0) {
      return res.json({ success: true, alerts: [] });
    }

    // Map allocations into list of conditions
    const orConditions = allocations.map(a => ({
      classId: a.classId,
      sectionId: a.sectionId
    }));

    const enrolledStudents = await prisma.enroll.findMany({
      where: {
        OR: orConditions,
        isAlumni: 0
      },
      select: { studentId: true }
    });

    const studentIds = enrolledStudents.map(e => e.studentId);

    const alerts = await prisma.interventionAlert.findMany({
      where: {
        teacherId: req.teacherId,
        risk: {
          studentId: { in: studentIds }
        }
      },
      include: {
        risk: {
          include: {
            student: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                registerNo: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, alerts });
  } catch (error) {
    console.error('[TEACHER] Attrition dashboard fetch error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch attrition alerts.' });
  }
});

/**
 * GET /api/teacher/attrition/detail/:studentId
 * Fetch the detailed component metrics and pre-drafted parent plan.
 */
router.get('/attrition/detail/:studentId', async (req, res) => {
  try {
    const studentId = Number(req.params.studentId);

    // Verify enrollment
    const enroll = await prisma.enroll.findFirst({
      where: { studentId, isAlumni: 0 },
      select: { classId: true, sectionId: true }
    });

    if (!enroll) {
      return res.status(404).json({ success: false, message: 'Student enrollment not found.' });
    }

    // Verify Form Teacher allocation
    const isAllocated = await prisma.teacherAllocation.findFirst({
      where: {
        teacherId: req.teacherId,
        classId: enroll.classId,
        sectionId: enroll.sectionId
      }
    });

    if (!isAllocated) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not the Form Teacher for this student.' });
    }

    const risk = await prisma.studentAttritionRisk.findUnique({
      where: { studentId },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true
          }
        },
        alerts: {
          where: { teacherId: req.teacherId },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!risk) {
      return res.status(404).json({ success: false, message: 'No attrition risk profile generated for this student yet.' });
    }

    res.json({ success: true, risk });
  } catch (error) {
    console.error('[TEACHER] Attrition detail fetch error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch attrition detail.' });
  }
});

/**
 * POST /api/teacher/attrition/action/:alertId
 * Form Teacher updates status of the intervention alert.
 */
router.post('/attrition/action/:alertId', async (req, res) => {
  try {
    const alertId = Number(req.params.alertId);
    const { status } = req.body;

    if (!['PENDING', 'ACTIVE', 'RESOLVED', 'DISMISSED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid intervention alert status.' });
    }

    const alert = await prisma.interventionAlert.findUnique({
      where: { id: alertId }
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Intervention alert not found.' });
    }

    if (alert.teacherId !== req.teacherId) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not authorized to update this alert.' });
    }

    const updatedAlert = await prisma.interventionAlert.update({
      where: { id: alertId },
      data: { status }
    });

    // Release isolation if status is set to RESOLVED
    if (status === 'RESOLVED') {
      await prisma.studentAttritionRisk.update({
        where: { id: alert.riskId },
        data: { isIsolated: false }
      });
    }

    res.json({ success: true, alert: updatedAlert });
  } catch (error) {
    console.error('[TEACHER] Attrition alert action update error:', error);
    res.status(500).json({ success: false, message: 'Failed to update attrition alert status.' });
  }
})

/**
 * GET /api/teacher/events
 * Fetch all events for the current branch and session.
 */
router.get('/events', assertTeacher, async (req, res) => {
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
    console.error('[TEACHER] Get events error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch events.' })
  }
})

export default router;

