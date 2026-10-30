import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma';
import {
  isSubjectTeacher as originalIsSubjectTeacher,
  isFormTeacher as originalIsFormTeacher,
  hasClassAccess as originalHasClassAccess,
  canTeacherAccessSubject,
  getTeacherAcademicRoles,
} from '../../lib/teacherAccess';
import { uploadBase64Image } from '../../lib/cloudinary';
import { getRegisterWithEntries, REGISTER_STATUS } from '../../lib/attendanceRegisterService';
import { todaySchoolDateKey } from '../../lib/schoolDate';

export const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

export async function savePhoto(photoBase64?: string | null, folder: string = 'ugbekun2/staff/photos'): Promise<string | null> {
  if (!photoBase64) return null;
  try {
    const uploadedUrl = await uploadBase64Image(photoBase64, folder);
    if (uploadedUrl) return uploadedUrl;
  } catch (err: any) {
    console.warn(`[PHOTO UPLOAD] Cloudinary upload unavailable for ${folder}, using fallback:`, err?.message);
  }
  if (photoBase64.startsWith('data:image/') || photoBase64.startsWith('http://') || photoBase64.startsWith('https://')) {
    return photoBase64;
  }
  return null;
}

export async function isSubjectTeacher(db: any, teacherId: any, classId: any, sectionId: any, subjectId: any, req: any) {
  if (req && (req.isAdmin || req.userRole === 1 || req.userRole === 2)) return true;
  return canTeacherAccessSubject(db, teacherId, classId, sectionId, subjectId, req?.sessionId, req);
}

export async function isFormTeacher(db: any, teacherId: any, classId: any, sectionId: any, req: any) {
  if (req && (req.isAdmin || req.userRole === 1 || req.userRole === 2)) return true;
  return originalIsFormTeacher(db, teacherId, classId, sectionId);
}

export async function hasClassAccess(db: any, teacherId: any, classId: any, sectionId: any, req: any) {
  if (req && (req.isAdmin || req.userRole === 1 || req.userRole === 2)) return true;
  return originalHasClassAccess(db, teacherId, classId, sectionId, req);
}

export async function saveMediaFile(file: any) {
  const uploadDir = path.join(__dirname, '../../uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const filename = Date.now() + '_' + file.originalname.replace(/\s+/g, '_');
  const filepath = path.join(uploadDir, filename);
  fs.writeFileSync(filepath, file.buffer);
  return `/uploads/${filename}`;
}

async function resolveTeacherSession(branchId?: number, reqSessionId?: number): Promise<number> {
  if (reqSessionId) return Number(reqSessionId);
  const globalSetting = await prisma.globalSettings.findFirst();
  if (globalSetting?.sessionId) return globalSetting.sessionId;
  if (branchId) {
    const latestEnroll = await prisma.enroll.findFirst({
      where: { branchId },
      orderBy: { sessionId: 'desc' },
      select: { sessionId: true },
    });
    if (latestEnroll?.sessionId) return latestEnroll.sessionId;
  }
  return 5;
}

export function generateJitsiToken({ roomName, user, isModerator }: { roomName: string; user: any; isModerator: boolean }) {
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
        avatar: user.photo || '',
      },
      features: {
        recording: true,
        livestreaming: true,
        'screen-sharing': true,
      },
    },
  };
  return jwt.sign(payload, appSecret, { algorithm: 'HS256', expiresIn: '2h' });
}

/**
 * GET /api/teacher/dashboard-overview
 */
export async function getDashboardOverview(req: Request, res: Response): Promise<Response | void> {
  try {
    const todayKey = todaySchoolDateKey();

    // Batch 1: profile, allocations and active session are independent — fetch together.
    const [teacher, activeSessionId, formAllocations, subjectAssignments] = await Promise.all([
      prisma.teacher.findUnique({
        where: { id: req.teacherId },
        include: { branch: { select: { id: true, name: true } } },
      }),
      // req.sessionId is not set by requireTeacher, so resolve the active session here
      // (previously attendance fell back to sessionId = 1).
      resolveTeacherSession(req.branchId, req.sessionId ? Number(req.sessionId) : undefined),
      prisma.teacherAllocation.findMany({
        where: { teacherId: req.teacherId },
        include: {
          class: { select: { id: true, name: true, isEcd: true } },
          section: { select: { id: true, name: true } },
        },
      }),
      prisma.subjectAssign.findMany({
        where: { teacherId: req.teacherId },
        include: {
          class: { select: { id: true, name: true, isEcd: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true } },
        },
      }),
    ]);
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher profile not found.' });
    }

    const primaryForm = formAllocations[0]
      ? `${formAllocations[0].class?.name || ''} ${formAllocations[0].section?.name || ''}`.trim()
      : subjectAssignments[0]
      ? `${subjectAssignments[0].class?.name || ''} ${subjectAssignments[0].section?.name || ''}`.trim()
      : 'No Class Allocated';

    const uniqueSubjectsMap = new Map();
    subjectAssignments.forEach((sa) => {
      if (sa.subject && !uniqueSubjectsMap.has(sa.subject.id)) {
        uniqueSubjectsMap.set(sa.subject.id, sa.subject.name);
      }
    });
    const subjectsCount = uniqueSubjectsMap.size;

    // De-duplicated (classId, sectionId) pairs the teacher covers.
    const pairKeys = new Set<string>();
    const classSectionPairs: Array<{ classId: number; sectionId: number }> = [];
    [...formAllocations, ...subjectAssignments].forEach((a) => {
      const key = `${a.classId}-${a.sectionId}`;
      if (!pairKeys.has(key)) {
        pairKeys.add(key);
        classSectionPairs.push({ classId: a.classId, sectionId: a.sectionId });
      }
    });

    // (subjectId, classId, sectionId) triples — used to scope marks to the teacher's own classes.
    const markScopes = subjectAssignments.map((sa) => ({
      subjectId: sa.subjectId,
      classId: sa.classId,
      sectionId: sa.sectionId,
    }));

    const teacherSubjectIds = Array.from(uniqueSubjectsMap.keys());

    // Batch 2: everything below only depends on batch 1 — run concurrently.
    const [
      totalStudentsCount,
      snapshot,
      assignmentsCount,
      pendingReviewCount,
      testsCount,
      lessonNotesCount,
      scopedMarks,
      dbActivities,
      dbReminders,
      academicRoles,
    ] = await Promise.all([
      classSectionPairs.length > 0
        ? prisma.enroll.count({
            where: {
              sessionId: activeSessionId,
              ...(req.branchId ? { branchId: req.branchId } : {}),
              OR: classSectionPairs,
            },
          })
        : Promise.resolve(0),
      formAllocations[0]
        ? getRegisterWithEntries(prisma, {
            branchId: req.branchId,
            sessionId: activeSessionId,
            classId: formAllocations[0].classId,
            sectionId: formAllocations[0].sectionId,
            dateKey: todayKey,
          })
        : Promise.resolve(null),
      teacherSubjectIds.length > 0
        ? prisma.homework.count({ where: { subjectId: { in: teacherSubjectIds }, branchId: req.branchId } })
        : Promise.resolve(0),
      teacherSubjectIds.length > 0
        ? prisma.homeworkSubmission.count({
            where: { score: null, homework: { subjectId: { in: teacherSubjectIds }, branchId: req.branchId } },
          })
        : Promise.resolve(0),
      teacherSubjectIds.length > 0
        ? prisma.onlineExam.count({ where: { subjectId: { in: teacherSubjectIds }, branchId: req.branchId } })
        : Promise.resolve(0),
      prisma.lessonPlan.count({ where: { teacherId: req.teacherId } }),
      // One scoped query replaces the old per-subject loop, which loaded every mark for
      // each subject across ALL schools and sessions (full table scan per subject).
      markScopes.length > 0
        ? prisma.mark.findMany({
            where: { sessionId: activeSessionId, OR: markScopes },
            select: { subjectId: true, mark: true, cbtMark: true },
          })
        : Promise.resolve([] as Array<{ subjectId: number; mark: string | null; cbtMark: string | null }>),
      prisma.teacherActivity.findMany({
        where: { teacherId: req.teacherId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      prisma.teacherReminder.findMany({
        where: { teacherId: req.teacherId },
        orderBy: { createdAt: 'desc' },
      }),
      getTeacherAcademicRoles(prisma, req.teacherId, req.branchId, req.sessionId ? Number(req.sessionId) : null),
    ]);

    let attendancePct = 0,
      presentCount = 0,
      lateCount = 0,
      absentCount = 0;
    if (snapshot) {
      const published =
        snapshot.register?.status === REGISTER_STATUS.SUBMITTED ||
        snapshot.register?.status === REGISTER_STATUS.LOCKED;
      if (published) {
        presentCount = snapshot.summary.present;
        lateCount = snapshot.summary.late;
        absentCount = snapshot.summary.absent;
        const coded = snapshot.summary.total - snapshot.summary.unmarked;
        attendancePct = coded > 0 ? Math.round(((presentCount + lateCount) / coded) * 100) : 0;
      }
    }

    // Aggregate marks per subject in memory (same scoring rule as before).
    const markAgg = new Map<number, { total: number; count: number }>();
    scopedMarks.forEach((m) => {
      const val = Number(m.mark || m.cbtMark || 0);
      if (val > 0) {
        const agg = markAgg.get(m.subjectId) || { total: 0, count: 0 };
        agg.total += val;
        agg.count++;
        markAgg.set(m.subjectId, agg);
      }
    });
    const subjectPerformance: any[] = Array.from(uniqueSubjectsMap.entries()).map(([subId, subName]) => {
      const agg = markAgg.get(subId);
      return { name: subName, score: agg && agg.count > 0 ? Math.round(agg.total / agg.count) : 0 };
    });

    const myClasses = formAllocations.map((fa) => ({
      name: `${fa.class?.name || ''} ${fa.section?.name || ''}`.trim(),
      role: 'Class Teacher',
      studentsCount: totalStudentsCount,
    }));
    subjectAssignments.forEach((sa) => {
      const className = `${sa.class?.name || ''} ${sa.section?.name || ''}`.trim();
      if (!myClasses.find((c) => c.name === className)) {
        myClasses.push({
          name: className,
          role: 'Subject Teacher',
          studentsCount: totalStudentsCount,
        });
      }
    });

    const recentActivities = dbActivities.map((a) => ({
      id: a.id,
      text: a.activity,
      timestamp: new Date(a.createdAt).toLocaleDateString(),
      icon: a.type.toLowerCase(),
    }));

    const reminders = dbReminders.map((r) => ({
      id: r.id,
      text: r.text,
      subtext: r.subtext || undefined,
      done: r.done,
    }));

    let classAverage = 0;
    if (subjectPerformance.length > 0) {
      const validScores = subjectPerformance.filter((s) => s.score > 0);
      if (validScores.length > 0) {
        classAverage = Math.round(validScores.reduce((acc, curr) => acc + curr.score, 0) / validScores.length);
      }
    }

    return res.json({
      success: true,
      profile: {
        teacherId: teacher.id,
        name: teacher.name || 'Staff Member',
        email: teacher.email,
        phone: teacher.phone,
        photo: teacher.photo,
        branchName: teacher.branch?.name || 'School Campus',
        primaryForm,
      },
      kpi: {
        studentsCount: totalStudentsCount,
        presentTodayCount: presentCount,
        subjectsCount,
        assignmentsCount,
        pendingReviewCount,
        testsCount,
        ongoingTestsCount: testsCount,
        classAverage,
      },
      attendance: {
        overallPercentage: attendancePct,
        presentCount,
        lateCount,
        absentCount,
        presentPct: totalStudentsCount > 0 ? Math.round((presentCount / totalStudentsCount) * 100) : 0,
        latePct: totalStudentsCount > 0 ? Math.round((lateCount / totalStudentsCount) * 100) : 0,
        absentPct: totalStudentsCount > 0 ? Math.round((absentCount / totalStudentsCount) * 100) : 0,
      },
      subjectPerformance,
      teachingSummary: {
        lessonNotesCount,
        assignmentsGivenCount: assignmentsCount,
        testsCreatedCount: testsCount,
        scoresEnteredPct: classAverage > 0 ? 100 : 0,
      },
      subjects: Array.from(uniqueSubjectsMap.entries()).map(([id, name]) => ({
        id,
        name,
        studentsCount: totalStudentsCount,
        score: subjectPerformance.find((sp) => sp.name === name)?.score || 0,
        nextLesson: 'Scheduled on Timetable',
      })),
      myClasses,
      academicRoles,
      reminders,
      recentActivities,
    });
  } catch (error) {
    console.error('[TEACHER] Dashboard overview error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load teacher dashboard overview.' });
  }
}

/**
 * GET /api/teacher/roster
 */
export async function getRoster(req: Request, res: Response): Promise<Response | void> {
  try {
    const { classId: reqClassId, sectionId: reqSectionId, search } = req.query;
    const activeSessionId = await resolveTeacherSession(req.branchId, req.query.sessionId ? Number(req.query.sessionId) : undefined);

    let [formAllocations, subjectAssignments] = await Promise.all([
      prisma.teacherAllocation.findMany({
        where: { teacherId: req.teacherId, sessionId: activeSessionId },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
        },
      }),
      prisma.subjectAssign.findMany({
        where: { teacherId: req.teacherId, sessionId: activeSessionId },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
        },
      }),
    ]);

    if (formAllocations.length === 0 && subjectAssignments.length === 0) {
      [formAllocations, subjectAssignments] = await Promise.all([
        prisma.teacherAllocation.findMany({
          where: { teacherId: req.teacherId },
          include: {
            class: { select: { id: true, name: true } },
            section: { select: { id: true, name: true } },
          },
        }),
        prisma.subjectAssign.findMany({
          where: { teacherId: req.teacherId },
          include: {
            class: { select: { id: true, name: true } },
            section: { select: { id: true, name: true } },
          },
        }),
      ]);
    }

    // Build unique assigned classes with their sections
    const assignedClassesMap = new Map<number, { id: number; name: string; sections: Array<{ id: number; name: string }> }>();

    for (const alloc of [...formAllocations, ...subjectAssignments]) {
      if (!alloc.classId) continue;
      if (!assignedClassesMap.has(alloc.classId)) {
        assignedClassesMap.set(alloc.classId, {
          id: alloc.classId,
          name: alloc.class?.name || `Class #${alloc.classId}`,
          sections: [],
        });
      }
      const cls = assignedClassesMap.get(alloc.classId)!;
      if (alloc.sectionId && !cls.sections.some((s) => s.id === alloc.sectionId)) {
        cls.sections.push({
          id: alloc.sectionId,
          name: alloc.section?.name || 'Main',
        });
      }
    }

    const assignedClasses = Array.from(assignedClassesMap.values());

    if (assignedClasses.length === 0) {
      return res.json({ success: true, students: [], assignedClasses: [] });
    }

    // Backend Permission Rule Enforcement: If classId specified, verify teacher has access
    let filterClassId: number | null = null;
    let filterSectionId: number | null = null;

    if (reqClassId) {
      const targetCId = Number(reqClassId);
      if (!assignedClassesMap.has(targetCId)) {
        return res.status(403).json({
          success: false,
          message: 'Access Denied: You are not authorized to view students in this class.',
        });
      }
      filterClassId = targetCId;
      if (reqSectionId) {
        filterSectionId = Number(reqSectionId);
      }
    }

    // Build enroll query where condition
    const whereCondition: any = {
      isAlumni: 0,
      sessionId: activeSessionId,
      ...(req.branchId ? { branchId: req.branchId } : {}),
    };

    if (filterClassId) {
      whereCondition.classId = filterClassId;
      if (filterSectionId) {
        whereCondition.sectionId = filterSectionId;
      }
    } else {
      // Default: students across all authorized classes and sections
      const classSectionPairs: Array<{ classId: number; sectionId?: number }> = [];
      assignedClasses.forEach((ac) => {
        if (ac.sections.length > 0) {
          ac.sections.forEach((sec) => classSectionPairs.push({ classId: ac.id, sectionId: sec.id }));
        } else {
          classSectionPairs.push({ classId: ac.id });
        }
      });
      whereCondition.OR = classSectionPairs;
    }

    if (search && String(search).trim() !== '') {
      const q = String(search).trim();
      whereCondition.student = {
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { registerNo: { contains: q, mode: 'insensitive' } },
          ...(Number.isInteger(Number(q)) ? [{ id: Number(q) }] : []),
        ],
      };
    }

    const enrolls = await prisma.enroll.findMany({
      where: whereCondition,
      include: {
        student: {
          include: {
            parent: true,
          },
        },
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
      },
      orderBy: [{ class: { name: 'asc' } }, { roll: 'asc' }, { student: { lastName: 'asc' } }],
    });

    const students = enrolls.map((e) => ({
      id: e.student.id,
      registerNo: e.student.registerNo,
      rollNo: e.roll,
      firstName: e.student.firstName,
      lastName: e.student.lastName,
      gender: e.student.gender,
      photo: e.student.photo,
      classId: e.classId,
      className: e.class?.name || 'N/A',
      sectionId: e.sectionId,
      sectionName: e.section?.name || 'N/A',
      parent: e.student.parent
        ? {
            id: e.student.parent.id,
            name: e.student.parent.name,
            fatherName: e.student.parent.fatherName,
            motherName: e.student.parent.motherName,
            mobileno: e.student.parent.mobileno,
            email: e.student.parent.email,
            address: e.student.parent.address,
          }
        : null,
    }));

    return res.json({ success: true, students, assignedClasses });
  } catch (error) {
    console.error('[TEACHER] Roster error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch student roster.' });
  }
}

/**
 * GET /api/teacher/reminders
 */
export async function getReminders(req: Request, res: Response): Promise<Response | void> {
  try {
    const reminders = await prisma.teacherReminder.findMany({
      where: { teacherId: req.teacherId },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, reminders });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch reminders.' });
  }
}

/**
 * POST /api/teacher/reminders
 */
export async function createReminder(req: Request, res: Response): Promise<Response | void> {
  try {
    const { text, subtext } = req.body;
    if (!text) return res.status(400).json({ success: false, message: 'Reminder text is required.' });

    const reminder = await prisma.teacherReminder.create({
      data: {
        teacherId: req.teacherId,
        text,
        subtext: subtext || null,
      },
    });
    return res.json({ success: true, reminder });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to create reminder.' });
  }
}

/**
 * PUT /api/teacher/reminders/:id/toggle
 */
export async function toggleReminder(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const reminder = await prisma.teacherReminder.findUnique({ where: { id } });
    if (!reminder || reminder.teacherId !== req.teacherId) {
      return res.status(404).json({ success: false, message: 'Reminder not found.' });
    }

    const updated = await prisma.teacherReminder.update({
      where: { id },
      data: { done: !reminder.done },
    });
    return res.json({ success: true, reminder: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to toggle reminder.' });
  }
}

/**
 * DELETE /api/teacher/reminders/:id
 */
export async function deleteReminder(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    await prisma.teacherReminder.deleteMany({
      where: { id, teacherId: req.teacherId },
    });
    return res.json({ success: true, message: 'Reminder deleted.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to delete reminder.' });
  }
}

/**
 * GET /api/teacher/messages
 */
export async function getMessages(req: Request, res: Response): Promise<Response | void> {
  try {
    const messages = await prisma.parentMessage.findMany({
      where: {
        branchId: req.branchId,
        OR: [{ recipientRole: 'TEACHER' }, { recipientId: req.teacherId }],
      },
      include: {
        parent: { select: { name: true, mobileno: true } },
        student: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, messages });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch messages.' });
  }
}

/**
 * POST /api/teacher/messages
 */
export async function sendMessage(req: Request, res: Response): Promise<Response | void> {
  try {
    const { parentId, studentId, subject, message } = req.body;
    if (!parentId || !message) {
      return res.status(400).json({ success: false, message: 'Parent ID and message body are required.' });
    }

    const newMessage = await prisma.parentMessage.create({
      data: {
        branchId: req.branchId,
        parentId: Number(parentId),
        studentId: studentId ? Number(studentId) : null,
        recipientRole: 'PARENT',
        senderType: 'TEACHER',
        subject: subject || 'Teacher Notice',
        message,
      },
    });

    return res.json({ success: true, message: 'Message sent to parent successfully.', newMessage });
  } catch (error) {
    console.error('[TEACHER] Send message error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send message to parent.' });
  }
}

/**
 * GET /api/teacher/profile
 */
export async function getProfile(req: Request, res: Response): Promise<Response | void> {
  try {
    const activeSessionId = await resolveTeacherSession(req.branchId);

    let formAllocations = await prisma.teacherAllocation.findMany({
      where: { teacherId: req.teacherId, sessionId: activeSessionId },
      include: {
        class: { select: { name: true, isEcd: true } },
        section: { select: { name: true } },
      },
    });

    if (formAllocations.length === 0) {
      const fallbackAllocs = await prisma.teacherAllocation.findMany({
        where: { teacherId: req.teacherId },
        orderBy: { sessionId: 'desc' },
        include: {
          class: { select: { name: true, isEcd: true } },
          section: { select: { name: true } },
        },
      });
      const seen = new Set<string>();
      formAllocations = fallbackAllocs.filter((a) => {
        const k = `${a.classId}-${a.sectionId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    let subjectAssignments = await prisma.subjectAssign.findMany({
      where: { teacherId: req.teacherId, sessionId: activeSessionId },
      include: {
        class: { select: { name: true, isEcd: true } },
        section: { select: { name: true } },
        subject: { select: { name: true } },
      },
      orderBy: { id: 'desc' },
    });

    if (subjectAssignments.length === 0) {
      const fallbackAssigns = await prisma.subjectAssign.findMany({
        where: { teacherId: req.teacherId },
        orderBy: [{ sessionId: 'desc' }, { id: 'desc' }],
        include: {
          class: { select: { name: true, isEcd: true } },
          section: { select: { name: true } },
          subject: { select: { name: true } },
        },
      });
      const seen = new Set<string>();
      subjectAssignments = fallbackAssigns.filter((s) => {
        const k = `${s.classId}-${s.sectionId}-${s.subjectId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    const teacherRecord = await prisma.teacher.findFirst({
      where: {
        OR: [
          { id: req.teacherId },
          ...(req.userId ? [{ userId: req.userId }, { id: req.userId }] : []),
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        photo: true,
        department: true,
        qualifications: true,
        houseAddress: true,
        bankName: true,
        accountNumber: true,
        accountName: true,
        userId: true,
        user: {
          select: {
            username: true,
            email: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
            code: true,
            systemSetting: {
              select: {
                schoolName: true,
                logoUrl: true,
                tagline: true,
              },
            },
          },
        },
      },
    });

    const branchName = teacherRecord?.branch?.systemSetting?.schoolName || teacherRecord?.branch?.name || 'School Campus';

    return res.json({
      success: true,
      teacherId: teacherRecord?.id || req.teacherId,
      name: teacherRecord?.name || 'Teacher Account',
      username: teacherRecord?.user?.username || null,
      email: teacherRecord?.email || teacherRecord?.user?.email || null,
      phone: teacherRecord?.phone || null,
      photo: teacherRecord?.photo || null,
      department: teacherRecord?.department || null,
      qualifications: teacherRecord?.qualifications || null,
      houseAddress: teacherRecord?.houseAddress || null,
      bankName: teacherRecord?.bankName || null,
      accountNumber: teacherRecord?.accountNumber || null,
      accountName: teacherRecord?.accountName || null,
      branchName,
      branch: teacherRecord?.branch || null,
      isFormTeacher: formAllocations.length > 0,
      isClassTeacher: formAllocations.length > 0,
      isSubjectTeacher: subjectAssignments.length > 0,
      formAllocations: formAllocations.map((a) => ({
        classId: a.classId,
        className: a.class.name,
        sectionId: a.sectionId,
        sectionName: a.section.name,
        isEcd: a.class.isEcd,
        sessionId: a.sessionId,
      })),
      subjectAssignments: subjectAssignments.map((s) => ({
        classId: s.classId,
        className: s.class.name,
        sectionId: s.sectionId,
        sectionName: s.section.name,
        subjectId: s.subjectId,
        subjectName: s.subject.name,
        isEcd: s.class.isEcd,
        sessionId: s.sessionId,
      })),
    });
  } catch (error) {
    console.error('[TEACHER] Profile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve teacher profile.' });
  }
}

/**
 * PUT /api/teacher/profile
 */
export async function updateProfile(req: Request, res: Response): Promise<Response | void> {
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
    } = req.body || {};

    const teacher = await prisma.teacher.findFirst({
      where: {
        OR: [
          { id: req.teacherId },
          ...(req.userId ? [{ userId: req.userId }, { id: req.userId }] : []),
        ],
      },
      select: { id: true, userId: true },
    });

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher profile not found.' });
    }

    const updated = await prisma.teacher.update({
      where: { id: teacher.id },
      data: {
        ...(name ? { name: name.trim() } : {}),
        ...(email !== undefined ? { email: email ? email.trim() : null } : {}),
        ...(phone !== undefined ? { phone: phone ? phone.trim() : null } : {}),
        ...(qualifications !== undefined ? { qualifications: qualifications ? qualifications.trim() : null } : {}),
        ...(houseAddress !== undefined ? { houseAddress: houseAddress ? houseAddress.trim() : null } : {}),
        ...(department !== undefined ? { department: department ? department.trim() : null } : {}),
        ...(bankName !== undefined ? { bankName: bankName ? bankName.trim() : null } : {}),
        ...(accountNumber !== undefined ? { accountNumber: accountNumber ? accountNumber.trim() : null } : {}),
        ...(accountName !== undefined ? { accountName: accountName ? accountName.trim() : null } : {}),
        updatedAt: new Date(),
      },
    });

    if (teacher.userId) {
      await prisma.user
        .update({
          where: { id: teacher.userId },
          data: {
            ...(name ? { name: name.trim() } : {}),
            ...(email ? { email: email.trim() } : {}),
            updatedAt: new Date(),
          },
        })
        .catch((e: any) => console.warn('[TEACHER] User sync warning on profile update:', e.message));
    }

    return res.json({
      success: true,
      message: 'Teacher profile updated successfully.',
      profile: updated,
    });
  } catch (error: any) {
    console.error('[TEACHER] Update profile error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update profile.' });
  }
}

/**
 * PUT /api/teacher/change-password
 */
export async function changePassword(req: Request, res: Response): Promise<Response | void> {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new passwords are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const teacher = await prisma.teacher.findFirst({
      where: {
        OR: [
          { id: req.teacherId },
          ...(req.userId ? [{ userId: req.userId }, { id: req.userId }] : []),
        ],
      },
      select: { id: true, userId: true },
    });

    const targetUserId = teacher?.userId || req.userId;
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'User account not linked to teacher.' });
    }

    const user = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User record not found.' });
    }

    const isBcrypt = user.password.startsWith('$2');
    const isValid = isBcrypt
      ? bcrypt.compareSync(currentPassword, user.password)
      : currentPassword === user.password;

    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword, updatedAt: new Date() },
    });

    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (error: any) {
    console.error('[TEACHER] Change password error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to change password.' });
  }
}

/**
 * PUT /api/teacher/change-username
 */
export async function changeUsername(req: Request, res: Response): Promise<Response | void> {
  try {
    const { newUsername } = req.body;
    const clean = typeof newUsername === 'string' ? newUsername.trim() : '';
    if (!clean || clean.length < 3) {
      return res.status(400).json({ success: false, message: 'Username must be at least 3 characters long.' });
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(clean)) {
      return res.status(400).json({
        success: false,
        message: 'Username may only contain letters, numbers, dots, hyphens, and underscores.',
      });
    }

    const teacher = await prisma.teacher.findFirst({
      where: {
        OR: [
          { id: req.teacherId },
          ...(req.userId ? [{ userId: req.userId }, { id: req.userId }] : []),
        ],
      },
      select: { id: true, userId: true },
    });

    const targetUserId = teacher?.userId || req.userId;
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'User account not linked to teacher.' });
    }

    const existing = await prisma.user.findFirst({
      where: {
        username: { equals: clean, mode: 'insensitive' },
        id: { not: targetUserId },
      },
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Username is already taken by another account.' });
    }

    await prisma.user.update({
      where: { id: targetUserId },
      data: { username: clean, updatedAt: new Date() },
    });

    return res.json({
      success: true,
      message: 'Username updated successfully.',
      username: clean,
    });
  } catch (error: any) {
    console.error('[TEACHER] Change username error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to change username.' });
  }
}

/**
 * POST /api/teacher/profile/upload-photo
 */
export async function uploadProfilePhoto(req: Request, res: Response): Promise<Response | void> {
  try {
    let inputPhoto = req.body?.photoBase64 || req.body?.photo;
    if (!inputPhoto && req.file) {
      inputPhoto = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }
    if (!inputPhoto) {
      return res.status(400).json({ success: false, message: 'Photograph data is required.' });
    }

    const teacher = await prisma.teacher.findFirst({
      where: {
        OR: [
          { id: req.teacherId },
          ...(req.userId ? [{ userId: req.userId }, { id: req.userId }] : []),
        ],
      },
      select: { id: true, userId: true, name: true },
    });

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher profile not found.' });
    }

    const photoUrl = await savePhoto(inputPhoto, 'ugbekun2/staff/photos');

    const updated = await prisma.teacher.update({
      where: { id: teacher.id },
      data: { photo: photoUrl },
      select: { id: true, name: true, photo: true },
    });

    if (teacher.userId) {
      await prisma.user
        .update({
          where: { id: teacher.userId },
          data: { photo: photoUrl },
        })
        .catch((e: any) => console.warn('[TEACHER] User photo sync warning:', e.message));
    }

    return res.json({
      success: true,
      message: 'Profile photograph updated successfully.',
      photo: updated.photo,
      profile: updated,
    });
  } catch (error: any) {
    console.error('[TEACHER] Profile photo upload error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update profile photo.' });
  }
}

/**
 * GET /api/teacher/events
 */
export async function getEvents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const events = await prisma.event.findMany({
      where: {
        branchId,
        sessionId,
      },
      orderBy: {
        startDate: 'asc',
      },
    });

    return res.json({ success: true, events });
  } catch (error: any) {
    console.error('[TEACHER] Get events error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch events.' });
  }
}
