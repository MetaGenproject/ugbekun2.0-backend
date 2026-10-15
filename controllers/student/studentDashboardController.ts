import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import prisma from '../../lib/prisma';
import { listSubmittedAttendance } from '../../lib/attendanceRegisterService';
import { parseMarkScore } from '../../lib/markParser';
import { uploadBase64Image } from '../../lib/cloudinary';

export async function savePhoto(photoBase64?: string | null, folder: string = 'ugbekun2/students/photos'): Promise<string | null> {
  if (!photoBase64) return null;
  try {
    const uploadedUrl = await uploadBase64Image(photoBase64, folder);
    if (uploadedUrl) return uploadedUrl;
  } catch (err: any) {
    console.warn(`[PHOTO UPLOAD] Cloudinary upload unavailable for ${folder}, using fallback:`, err?.message);
  }
  if (photoBase64.startsWith('data:image/')) {
    try {
      const uploadDir = path.join(__dirname, '../../uploads/students');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      const matches = photoBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const ext = matches[1].split('/')[1] || 'png';
        const filename = `student_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
        const filepath = path.join(uploadDir, filename);
        fs.writeFileSync(filepath, Buffer.from(matches[2], 'base64'));
        return `/uploads/students/${filename}`;
      }
    } catch (fsErr: any) {
      console.warn('[PHOTO UPLOAD] Disk fallback error:', fsErr.message);
    }
    return photoBase64;
  }
  if (photoBase64.startsWith('http://') || photoBase64.startsWith('https://') || photoBase64.startsWith('/uploads/')) {
    return photoBase64;
  }
  return null;
}


/**
 * GET /api/student/dashboard-overview
 */
export async function getDashboardOverview(req: Request, res: Response): Promise<Response | void> {
  try {
    const today = new Date();
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const todayDayName = dayNames[today.getDay()];

    // 1. Student Profile lookup
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: {
        branch: { select: { name: true } },
        user: { select: { username: true } },
      },
    });
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    // 2. High-Performance Concurrent Batch Execution
    const [
      classSectionData,
      attendanceRes,
      classPub,
      timetableSlotsRaw,
      homeworkData,
      examData,
      invoice,
      events,
    ] = await Promise.all([
      // A. Class, Section, Student Count, Form Teacher, and Subject Allocations
      (async () => {
        if (!req.classId || !req.sectionId) return null;
        const [classInfo, sectionInfo, fellowStudentsCount, formAlloc, subjectAssigns] = await Promise.all([
          prisma.class.findUnique({ where: { id: req.classId }, select: { name: true } }),
          prisma.section.findUnique({ where: { id: req.sectionId }, select: { name: true } }),
          prisma.enroll.count({
            where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId },
          }),
          prisma.teacherAllocation.findFirst({
            where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId },
            include: { teacher: { select: { name: true, email: true, phone: true, photo: true } } },
          }),
          prisma.subjectAssign.findMany({
            where: {
              classId: req.classId,
              ...(req.sectionId
                ? {
                    OR: [
                      { sectionId: req.sectionId },
                      { sectionId: 0 },
                    ],
                  }
                : {}),
              sessionId: req.sessionId,
              ...(req.branchId ? { branchId: req.branchId } : {}),
            },
            include: {
              subject: { select: { id: true, name: true, subjectCode: true, subjectType: true, subjectAuthor: true } },
              teacher: { select: { id: true, name: true, email: true, phone: true, photo: true, department: true } },
            },
          }),
        ]);
        return {
          classInfo,
          sectionInfo,
          fellowStudentsCount,
          formTeacher: formAlloc?.teacher || null,
          subjectAssigns,
        };
      })(),

      // B. Attendance KPI (Submitted registers)
      listSubmittedAttendance(prisma, {
        studentId: req.studentId,
        sessionId: req.sessionId,
        branchId: req.branchId,
      }),

      // C. Class publication check
      (async () => {
        if (!req.classId || !req.sessionId) return null;
        return prisma.classReportCardPublication.findFirst({
          where: {
            classId: req.classId,
            sessionId: req.sessionId,
            ...(req.branchId ? { OR: [{ branchId: req.branchId }, { branchId: null }] } : {}),
            isPublished: true,
          },
        });
      })(),

      // D. Today's Timetable Slots
      (async () => {
        if (!req.classId) return [];
        let slots = await prisma.timetableSlot.findMany({
          where: {
            classId: req.classId,
            branchId: req.branchId,
            dayOfWeek: todayDayName,
            isPublished: true,
            ...(req.sectionId
              ? {
                  OR: [{ sectionId: req.sectionId }, { sectionId: null }],
                }
              : {}),
          },
          include: {
            subject: { select: { id: true, name: true, subjectCode: true } },
            teacher: { select: { id: true, name: true, phone: true, photo: true } },
            section: { select: { id: true, name: true } },
            class: { select: { id: true, name: true } },
          },
          orderBy: { startTime: 'asc' },
        });

        if (slots.length === 0) {
          slots = await prisma.timetableSlot.findMany({
            where: {
              classId: req.classId,
              branchId: req.branchId,
              dayOfWeek: todayDayName,
            },
            include: {
              subject: { select: { id: true, name: true, subjectCode: true } },
              teacher: { select: { id: true, name: true, phone: true, photo: true } },
              section: { select: { id: true, name: true } },
              class: { select: { id: true, name: true } },
            },
            orderBy: { startTime: 'asc' },
          });
        }
        return slots;
      })(),

      // E. Homeworks and Submissions
      (async () => {
        if (!req.classId) return { homeworks: [], submissions: [] };
        const [homeworks, submissions] = await Promise.all([
          prisma.homework.findMany({
            where: { classId: req.classId, branchId: req.branchId },
            include: { subject: { select: { name: true } } },
            orderBy: { dueDate: 'asc' },
          }),
          prisma.homeworkSubmission.findMany({
            where: { studentId: req.studentId },
            // Only fields the dashboard uses — skips the large `answers` JSON column.
            select: {
              id: true,
              homeworkId: true,
              score: true,
              feedback: true,
              createdAt: true,
              homework: { select: { subject: { select: { name: true } } } },
            },
            orderBy: { createdAt: 'desc' },
          }),
        ]);
        return { homeworks, submissions };
      })(),

      // F. CBT Online Exams and Submissions
      (async () => {
        if (!req.classId) return { onlineExams: [], examSubs: [] };
        const [rawOnlineExams, examSubs, unpublishedDists] = await Promise.all([
          prisma.onlineExam.findMany({
            where: { classId: req.classId, branchId: req.branchId },
            include: { subject: { select: { name: true } } },
            orderBy: { examDate: 'asc' },
            take: 8,
          }),
          prisma.onlineExamSubmission.findMany({
            where: { studentId: req.studentId },
            // Only fields the dashboard uses — skips the exam `questions` JSON.
            select: {
              onlineExamId: true,
              totalMark: true,
              submittedAt: true,
              onlineExam: { select: { subject: { select: { name: true } } } },
            },
            orderBy: { submittedAt: 'desc' },
            take: 8,
          }),
          prisma.cbtDistribution.findMany({
            where: { classId: req.classId, branchId: req.branchId, isPublished: false },
            select: { onlineExamId: true, title: true, subjectId: true },
          }),
        ]);
        const unpublishedIds = new Set(unpublishedDists.map((d) => d.onlineExamId).filter(Boolean));
        const unpublishedTitles = new Set(unpublishedDists.map((d) => `${d.title}::${d.subjectId}`));
        const onlineExams = rawOnlineExams.filter(
          (ex) => !unpublishedIds.has(ex.id) && !unpublishedTitles.has(`${ex.title}::${ex.subjectId}`)
        );
        return { onlineExams, examSubs };
      })(),

      // G. School fee status / Invoices
      prisma.invoice.findFirst({
        where: { studentId: req.studentId, sessionId: req.sessionId, branchId: req.branchId },
        include: { payments: { select: { amount: true } } },
        orderBy: { createdAt: 'desc' },
      }),

      // H. Events / Announcements
      prisma.event.findMany({
        where: {
          branchId: req.branchId,
          sessionId: req.sessionId,
          startDate: { gte: new Date(today.getFullYear(), today.getMonth() - 1, 1) },
        },
        orderBy: { startDate: 'asc' },
        take: 5,
      }),
    ]);

    // Profile processing
    let subjects: any[] = [];
    if (classSectionData?.subjectAssigns) {
      const subjMap = new Map();
      classSectionData.subjectAssigns.forEach((sa) => {
        if (!sa.subject) return;
        if (!subjMap.has(sa.subject.id)) {
          subjMap.set(sa.subject.id, {
            id: sa.subject.id,
            name: sa.subject.name,
            code: sa.subject.subjectCode,
            type: sa.subject.subjectType || 'Core',
            author: sa.subject.subjectAuthor || null,
            teacher: sa.teacher
              ? {
                  id: sa.teacher.id,
                  name: sa.teacher.name,
                  email: sa.teacher.email,
                  phone: sa.teacher.phone,
                  photo: sa.teacher.photo,
                  department: sa.teacher.department,
                }
              : null,
          });
        } else if (sa.teacher && !subjMap.get(sa.subject.id).teacher) {
          subjMap.get(sa.subject.id).teacher = {
            id: sa.teacher.id,
            name: sa.teacher.name,
            email: sa.teacher.email,
            phone: sa.teacher.phone,
            photo: sa.teacher.photo,
            department: sa.teacher.department,
          };
        }
      });
      subjects = Array.from(subjMap.values());
    }

    const profile = {
      studentId: student.id,
      username: student.user?.username || null,
      firstName: student.firstName,
      lastName: student.lastName,
      registerNo: student.registerNo,
      gender: student.gender,
      photo: student.photo,
      branchName: student.branch?.name || null,
      classId: req.classId || null,
      className: classSectionData?.classInfo?.name || null,
      sectionId: req.sectionId || null,
      sectionName: classSectionData?.sectionInfo?.name || null,
      sessionId: req.sessionId,
      fellowStudentsCount: classSectionData?.fellowStudentsCount || 0,
      formTeacher: classSectionData?.formTeacher || null,
      subjects,
    };

    // Attendance KPI processing
    const attendanceLogs = attendanceRes.logs || [];
    const attendanceSummary = attendanceRes.summary || { percentage: 0, totalDays: 0, presentCount: 0, absentCount: 0, lateCount: 0 };
    const attendancePct = attendanceSummary.percentage;
    const attendance = {
      percentage: attendancePct,
      totalDays: attendanceSummary.totalDays,
      presentCount: attendanceSummary.presentCount,
      absentCount: attendanceSummary.absentCount,
      lateCount: attendanceSummary.lateCount,
      logs: attendanceLogs.slice(0, 30).map((l) => ({
        id: l.id,
        attendanceDate: l.attendanceDate,
        status: l.status,
        remark: l.remark,
      })),
    };

    // Grades / Average / Rank
    const isClassPublished = Boolean(classPub);
    let overallAverage = 0;
    let rank = null;
    let totalClassStudents = classSectionData?.fellowStudentsCount || 0;
    let subjectPerformance: any[] = [];
    let studentMarks: any[] = [];

    if (isClassPublished && req.classId && req.sessionId) {
      const [marks, enrolls] = await Promise.all([
        prisma.mark.findMany({
          where: {
            studentId: req.studentId,
            sessionId: req.sessionId,
            branchId: req.branchId,
          },
          include: {
            subject: { select: { name: true } },
            exam: { select: { publishResult: true } },
          },
        }),
        req.sectionId
          ? prisma.enroll.findMany({
              where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId },
              select: { studentId: true },
            })
          : Promise.resolve([]),
      ]);

      studentMarks = marks;
      if (studentMarks.length > 0) {
        let totalScoreSum = 0;
        let marksCount = 0;
        const subjectMap: Record<string, any> = {};

        studentMarks.forEach((m) => {
          const parsed = parseMarkScore(m.mark, m.cbtMark);
          if (parsed.hasValidScore) {
            totalScoreSum += parsed.total;
            marksCount++;
            const sName = m.subject?.name || 'Unknown';
            if (!subjectMap[sName]) subjectMap[sName] = { sum: 0, count: 0 };
            subjectMap[sName].sum += parsed.total;
            subjectMap[sName].count++;
          }
        });

        overallAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;
        subjectPerformance = Object.entries(subjectMap).map(([name, d]) => ({
          name,
          score: Number((d.sum / d.count).toFixed(1)),
        }));

        const studentIds = enrolls.map((e) => e.studentId);
        if (studentIds.length > 0) {
          totalClassStudents = studentIds.length;
          const allMarks = await prisma.mark.findMany({
            where: {
              studentId: { in: studentIds },
              sessionId: req.sessionId,
              branchId: req.branchId,
            },
            select: { studentId: true, mark: true, cbtMark: true },
          });
          const agg: Record<string, any> = {};
          studentIds.forEach((id) => {
            agg[id] = { sum: 0, count: 0 };
          });
          allMarks.forEach((m) => {
            const parsed = parseMarkScore(m.mark, m.cbtMark);
            if (parsed.hasValidScore) {
              agg[m.studentId].sum += parsed.total;
              agg[m.studentId].count++;
            }
          });
          const ranked = studentIds
            .map((id) => ({ id, avg: agg[id].count > 0 ? agg[id].sum / agg[id].count : 0 }))
            .sort((a, b) => b.avg - a.avg);
          const idx = ranked.findIndex((x) => x.id === req.studentId);
          if (idx !== -1) rank = idx + 1;
        }
      }
    }

    // Timetable formatting
    const todayTimetable = timetableSlotsRaw.map((s) => ({
      id: s.id,
      startTime: s.startTime,
      endTime: s.endTime,
      time: `${s.startTime} - ${s.endTime}`,
      type: s.type,
      title:
        s.title ||
        s.subject?.name ||
        (s.type === 'BREAK' ? 'Recess / Break' : s.type === 'ASSEMBLY' ? 'Morning Assembly' : 'Period'),
      subjectName: s.subject?.name || null,
      subjectCode: s.subject?.subjectCode || '',
      teacherName: s.teacher?.name || null,
      teacher: s.teacher?.name || (s.type === 'SUBJECT' ? 'Teacher Unassigned' : null),
      teacherPhone: s.teacher?.phone || null,
      roomLabel: s.section?.name || s.class?.name || null,
      className: s.class?.name || null,
      sectionName: s.section?.name || null,
    }));

    // Homeworks & Progress (Processed from batch)
    const { homeworks: allHomeworks, submissions: allHwSubmissions } = homeworkData;
    const subMap = new Map(allHwSubmissions.map((s) => [s.homeworkId, s]));
    const upcomingHomeworks = allHomeworks.slice(0, 6).map((hw) => {
      const dueDate = new Date(hw.dueDate);
      const diffDays = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      let deadlineBadge = 'Upcoming';
      if (diffDays < 0) deadlineBadge = 'Overdue';
      else if (diffDays === 0) deadlineBadge = 'Due Today';
      else if (diffDays === 1) deadlineBadge = 'Due Tomorrow';
      else deadlineBadge = `${diffDays} Days Left`;
      const sub = subMap.get(hw.id);
      return {
        id: hw.id,
        title: hw.title,
        description: hw.description,
        questions: hw.questions || [],
        subjectName: hw.subject?.name || 'General',
        dueDate: hw.dueDate,
        deadlineBadge,
        diffDays,
        submitted: !!sub,
        score: sub?.score ?? null,
        submissionScore: sub?.score ?? null,
        submissionStatus: sub ? (sub.score !== null ? 'GRADED' : 'SUBMITTED') : 'PENDING',
        feedback: sub?.feedback || null,
      };
    });

    const submittedHwSet = new Set(allHwSubmissions.map((s) => s.homeworkId));
    const completedHw = allHomeworks.filter((h) => submittedHwSet.has(h.id)).length;
    const overdueHw = allHomeworks.filter((h) => !submittedHwSet.has(h.id) && new Date(h.dueDate) < today).length;
    const pendingHw = allHomeworks.length - completedHw - overdueHw;
    const homeworkProgress = {
      completed: completedHw,
      pending: Math.max(0, pendingHw),
      overdue: overdueHw,
      percentage: allHomeworks.length > 0 ? Math.round((completedHw / allHomeworks.length) * 100) : 0,
    };

    // CBT Exams (Processed from batch)
    const { onlineExams, examSubs } = examData;
    const submittedExIds = new Set(examSubs.map((s) => s.onlineExamId));
    const upcomingExams = onlineExams.slice(0, 6).map((ex) => {
      const examDate = ex.examDate ? new Date(ex.examDate) : null;
      const diffDays = examDate ? Math.ceil((examDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;
      let deadlineBadge = 'Available';
      if (diffDays === null) deadlineBadge = 'Available';
      else if (diffDays < 0) deadlineBadge = 'Past';
      else if (diffDays === 0) deadlineBadge = 'Today';
      else deadlineBadge = `${diffDays} Days Left`;
      return {
        id: ex.id,
        title: ex.title,
        subjectName: ex.subject?.name || 'General',
        examDate: ex.examDate,
        deadlineBadge,
        diffDays,
        submitted: submittedExIds.has(ex.id),
      };
    });

    // Fee Status
    let feeStatus = { status: 'Unknown', totalBilled: 0, totalPaid: 0, outstanding: 0, nextTermDate: null };
    if (invoice) {
      const totalBilled = parseFloat(String(invoice.totalAmount || '0'));
      const totalPaid = invoice.payments.reduce((s, p) => s + parseFloat(String(p.amount || '0')), 0);
      const outstanding = Math.max(0, totalBilled - totalPaid);
      let status = 'Unpaid';
      if (outstanding === 0) status = 'Paid';
      else if (totalPaid > 0) status = 'Partial';
      feeStatus = { status, totalBilled, totalPaid, outstanding, nextTermDate: null };
    }

    // Announcements
    const announcements = events.map((ev) => ({
      id: ev.id,
      title: ev.title,
      description: ev.description || '',
      startDate: ev.startDate,
    }));

    // Recent Activities (Aggregated from batch in memory)
    const recentActivities: any[] = [];
    allHwSubmissions.slice(0, 3).forEach((s) => {
      recentActivities.push({
        type: 'homework_submitted',
        text: `You submitted ${s.homework?.subject?.name || 'a'} homework`,
        timestamp: s.createdAt,
      });
    });

    examSubs.slice(0, 3).forEach((s) => {
      const scoreText = s.totalMark !== null && s.totalMark !== undefined ? ` (Score: ${s.totalMark})` : '';
      recentActivities.push({
        type: 'exam_submitted',
        text: `You completed ${s.onlineExam?.subject?.name || ''} exam${scoreText}`,
        timestamp: s.submittedAt,
      });
    });

    attendanceLogs.slice(0, 3).forEach((l) => {
      recentActivities.push({
        type: 'attendance',
        text: `Attendance marked: ${l.status}`,
        timestamp: l.attendanceDate,
      });
    });

    recentActivities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return res.json({
      success: true,
      profile,
      kpi: {
        averageScore: (isClassPublished && studentMarks.length > 0) ? overallAverage : null,
        classRank: (isClassPublished && studentMarks.length > 0) ? rank : null,
        totalClassStudents,
        attendancePercentage: attendancePct,
        behaviourRating: attendancePct >= 90 ? 'Excellent' : attendancePct >= 75 ? 'Good' : 'Fair',
        resultsPublished: isClassPublished && studentMarks.length > 0,
      },
      attendance,
      todayTimetable,
      upcomingHomeworks,
      upcomingExams,
      homeworkProgress,
      feeStatus,
      subjectPerformance,
      announcements,
      recentActivities: recentActivities.slice(0, 8),
    });
  } catch (error: any) {
    console.error('[STUDENT] Dashboard overview error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load dashboard overview.' });
  }
}

/**
 * GET /api/student/profile
 */
export async function getProfile(req: Request, res: Response): Promise<Response | void> {
  try {
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: {
        branch: { select: { name: true, code: true } },
        parent: {
          select: {
            id: true,
            name: true,
            relation: true,
            fatherName: true,
            motherName: true,
            occupation: true,
            income: true,
            education: true,
            email: true,
            mobileno: true,
            address: true,
            city: true,
            state: true,
          },
        },
        user: {
          select: {
            id: true,
            username: true,
            photo: true,
          },
        },
      },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student profile not found.' });
    }

    let classInfo = null;
    let sectionInfo = null;
    let fellowStudentsCount = 0;
    let formTeacher = null;
    let subjects: any[] = [];

    if (req.classId) {
      classInfo = await prisma.class.findUnique({ where: { id: req.classId }, select: { name: true } });
      if (req.sectionId) {
        sectionInfo = await prisma.section.findUnique({ where: { id: req.sectionId }, select: { name: true } });
        fellowStudentsCount = await prisma.enroll.count({
          where: {
            classId: req.classId,
            sectionId: req.sectionId,
            sessionId: req.sessionId,
            branchId: req.branchId,
          },
        });
      }

      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: req.classId,
          ...(req.sectionId ? { sectionId: req.sectionId } : {}),
          sessionId: req.sessionId,
          branchId: req.branchId,
        },
        include: {
          teacher: { select: { id: true, name: true, email: true, phone: true, photo: true } },
        },
      });
      formTeacher = formAllocation?.teacher || null;

      const subjectAssigns = await prisma.subjectAssign.findMany({
        where: {
          classId: req.classId,
          ...(req.sectionId
            ? {
                OR: [
                  { sectionId: req.sectionId },
                  { sectionId: 0 },
                ],
              }
            : {}),
          ...(req.branchId ? { branchId: req.branchId } : {}),
        },
        include: {
          subject: { select: { id: true, name: true, subjectCode: true, subjectType: true, subjectAuthor: true } },
          teacher: { select: { id: true, name: true, email: true, phone: true, photo: true, department: true } },
        },
        orderBy: { id: 'asc' },
      });

      const subjMap = new Map();
      subjectAssigns.forEach((sa) => {
        if (!sa.subject) return;
        if (!subjMap.has(sa.subject.id)) {
          subjMap.set(sa.subject.id, {
            id: sa.subject.id,
            name: sa.subject.name,
            code: sa.subject.subjectCode,
            type: sa.subject.subjectType || 'Core',
            author: sa.subject.subjectAuthor || null,
            teacher: sa.teacher
              ? {
                  id: sa.teacher.id,
                  name: sa.teacher.name,
                  email: sa.teacher.email,
                  phone: sa.teacher.phone,
                  photo: sa.teacher.photo,
                  department: sa.teacher.department,
                }
              : null,
          });
        } else if (sa.teacher && !subjMap.get(sa.subject.id).teacher) {
          subjMap.get(sa.subject.id).teacher = {
            id: sa.teacher.id,
            name: sa.teacher.name,
            email: sa.teacher.email,
            phone: sa.teacher.phone,
            photo: sa.teacher.photo,
            department: sa.teacher.department,
          };
        }
      });
      subjects = Array.from(subjMap.values());
    }

    // Class History & School Years
    const [enrollRecords, schoolYears] = await Promise.all([
      prisma.enroll.findMany({
        where: { studentId: req.studentId },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
        },
        orderBy: { sessionId: 'desc' },
      }),
      prisma.schoolYear.findMany({
        select: { id: true, schoolYear: true },
      }),
    ]);

    const schoolYearMap = new Map<number, string>();
    schoolYears.forEach((sy) => schoolYearMap.set(sy.id, sy.schoolYear));

    const classHistory = enrollRecords.map((en) => ({
      id: en.id,
      sessionId: en.sessionId,
      sessionName: schoolYearMap.get(en.sessionId) || `Session #${en.sessionId}`,
      classId: en.classId,
      className: en.class?.name || 'Class',
      sectionId: en.sectionId,
      sectionName: en.section?.name || 'Section',
      roll: en.roll,
      isAlumni: Boolean(en.isAlumni),
      enrolledAt: en.createdAt,
    }));

    let isEcdClass = false;
    if (req.classId) {
      const cls = await prisma.class.findUnique({ where: { id: req.classId }, select: { isEcd: true } });
      isEcdClass = !!cls?.isEcd;
    }

    const currentSchoolYear = req.sessionId ? schoolYearMap.get(req.sessionId) : null;

    return res.json({
      success: true,
      studentId: student.id,
      userId: student.userId,
      username: student.user?.username || null,
      firstName: student.firstName,
      lastName: student.lastName,
      registerNo: student.registerNo,
      gender: student.gender,
      admissionDate: student.admissionDate,
      birthday: student.birthday,
      religion: student.religion,
      caste: student.caste,
      bloodGroup: student.bloodGroup,
      motherTongue: student.motherTongue,
      currentAddress: student.currentAddress,
      permanentAddress: student.permanentAddress,
      city: student.city,
      state: student.state,
      mobileno: student.mobileno,
      email: student.email || null,
      photo: student.photo || student.user?.photo || null,
      branchName: student.branch?.name || null,
      classId: req.classId || null,
      className: classInfo?.name || null,
      sectionId: req.sectionId || null,
      sectionName: sectionInfo?.name || null,
      sessionId: req.sessionId,
      sessionName: currentSchoolYear || null,
      fellowStudentsCount,
      formTeacher,
      subjects,
      parent: student.parent || null,
      classHistory,
      isEcd: isEcdClass,
    });
  } catch (error) {
    console.error('[STUDENT] Profile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve profile details.' });
  }
}

/**
 * GET /api/student/reminders
 */
export async function getReminders(req: Request, res: Response): Promise<Response | void> {
  try {
    const reminders = await prisma.studentReminder.findMany({
      where: { studentId: req.studentId },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, reminders });
  } catch (error: any) {
    console.error('[STUDENT] Get reminders error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch reminders.' });
  }
}

/**
 * POST /api/student/reminders
 */
export async function createReminder(req: Request, res: Response): Promise<Response | void> {
  try {
    const { text, title, subtext, date, time } = req.body;
    const finalContent = (text || title || '').trim();
    if (!finalContent) {
      return res.status(400).json({ success: false, message: 'Reminder text is required.' });
    }
    const reminder = await prisma.studentReminder.create({
      data: {
        studentId: req.studentId,
        text: finalContent,
        subtext: subtext ? String(subtext).trim() : (date ? `${date} ${time || ''}`.trim() : null),
        done: false,
      },
    });
    return res.status(201).json({ success: true, reminder });
  } catch (error: any) {
    console.error('[STUDENT] Create reminder error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create reminder.' });
  }
}

/**
 * PUT /api/student/reminders/:id/toggle
 */
export async function toggleReminder(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = parseInt(String(req.params.id), 10);
    const reminder = await prisma.studentReminder.findFirst({
      where: { id, studentId: req.studentId },
    });
    if (!reminder) {
      return res.status(404).json({ success: false, message: 'Reminder not found.' });
    }
    const updated = await prisma.studentReminder.update({
      where: { id },
      data: { done: !reminder.done },
    });
    return res.json({ success: true, reminder: updated });
  } catch (error: any) {
    console.error('[STUDENT] Toggle reminder error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update reminder.' });
  }
}

/**
 * DELETE /api/student/reminders/:id
 */
export async function deleteReminder(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = parseInt(String(req.params.id), 10);
    await prisma.studentReminder.deleteMany({
      where: { id, studentId: req.studentId },
    });
    return res.json({ success: true, message: 'Reminder deleted.' });
  } catch (error: any) {
    console.error('[STUDENT] Delete reminder error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete reminder.' });
  }
}

/**
 * GET /api/student/messages
 */
export async function getMessages(req: Request, res: Response): Promise<Response | void> {
  try {
    const messages = await prisma.parentMessage.findMany({
      where: { studentId: req.studentId, branchId: req.branchId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return res.json({ success: true, messages });
  } catch (error: any) {
    console.error('[STUDENT] Get messages error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch messages.' });
  }
}

/**
 * POST /api/student/messages
 */
export async function sendMessage(req: Request, res: Response): Promise<Response | void> {
  try {
    const { recipientRole = 'TEACHER', recipientId, subject, message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message content is required.' });
    }

    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      select: { parentId: true },
    });

    const newMessage = await prisma.parentMessage.create({
      data: {
        parentId: student?.parentId || 1,
        studentId: req.studentId,
        branchId: req.branchId,
        recipientId: recipientId ? Number(recipientId) : null,
        recipientRole,
        senderType: 'STUDENT',
        subject: subject ? subject.trim() : 'Student Inquiry',
        message: message.trim(),
      },
    });
    return res.status(201).json({ success: true, message: 'Message sent.', data: newMessage });
  } catch (error: any) {
    console.error('[STUDENT] Send message error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to send message.' });
  }
}

/**
 * PUT /api/student/change-password
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
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      select: { userId: true },
    });
    if (!student || !student.userId) {
      return res.status(400).json({ success: false, message: 'User account not linked to student.' });
    }
    const user = await prisma.user.findUnique({ where: { id: student.userId } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User record not found.' });
    }
    const isValid = bcrypt.compareSync(currentPassword, user.password);
    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    await prisma.user.update({
      where: { id: student.userId },
      data: { password: hashedPassword, updatedAt: new Date() },
    });
    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (error: any) {
    console.error('[STUDENT] Change password error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to change password.' });
  }
}

/**
 * PUT /api/student/change-username
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

    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      select: { id: true, userId: true },
    });

    if (!student || !student.userId) {
      return res.status(400).json({ success: false, message: 'User account not linked to student.' });
    }

    const existing = await prisma.user.findFirst({
      where: {
        username: { equals: clean, mode: 'insensitive' },
        id: { not: student.userId },
      },
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Username is already taken by another account.' });
    }

    await prisma.user.update({
      where: { id: student.userId },
      data: { username: clean, updatedAt: new Date() },
    });

    return res.json({
      success: true,
      message: 'Username updated successfully.',
      username: clean,
    });
  } catch (error: any) {
    console.error('[STUDENT] Change username error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to change username.' });
  }
}

/**
 * POST /api/student/upload-photo
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

    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      select: { id: true, userId: true },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student profile not found.' });
    }

    const photoUrl = await savePhoto(inputPhoto, 'ugbekun2/students/photos');

    const updated = await prisma.student.update({
      where: { id: req.studentId },
      data: { photo: photoUrl, updatedAt: new Date() },
      select: { id: true, photo: true },
    });

    if (student.userId) {
      await prisma.user
        .update({
          where: { id: student.userId },
          data: { photo: photoUrl },
        })
        .catch((e: any) => console.warn('[STUDENT] User photo sync warning:', e.message));
    }

    return res.json({
      success: true,
      message: 'Profile photo updated successfully.',
      photo: updated.photo,
    });
  } catch (error: any) {
    console.error('[STUDENT] Profile photo upload error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update profile photo.' });
  }
}

