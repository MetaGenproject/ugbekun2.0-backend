import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma';

/**
 * GET /api/student/dashboard-overview
 */
export async function getDashboardOverview(req: Request, res: Response): Promise<Response | void> {
  try {
    const today = new Date();
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const todayDayName = dayNames[today.getDay()];

    // 1. Student Profile
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: { branch: { select: { name: true } } },
    });
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    let classInfo = null;
    let sectionInfo = null;
    let fellowStudentsCount = 0;
    let formTeacher = null;
    let subjects: any[] = [];

    if (req.classId && req.sectionId) {
      [classInfo, sectionInfo, fellowStudentsCount] = await Promise.all([
        prisma.class.findUnique({ where: { id: req.classId }, select: { name: true } }),
        prisma.section.findUnique({ where: { id: req.sectionId }, select: { name: true } }),
        prisma.enroll.count({
          where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId },
        }),
      ]);
      const formAlloc = await prisma.teacherAllocation.findFirst({
        where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId },
        include: { teacher: { select: { name: true, email: true, phone: true } } },
      });
      formTeacher = formAlloc?.teacher || null;

      const subjectAssigns = await prisma.subjectAssign.findMany({
        where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId },
        include: { subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } } },
      });
      subjects = subjectAssigns.map((sa) => ({
        id: sa.subject.id,
        name: sa.subject.name,
        code: sa.subject.subjectCode,
        type: sa.subject.subjectType,
      }));
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
      subjects,
    };

    // 2. Attendance KPI
    const attendanceLogs = await prisma.attendance.findMany({
      where: { studentId: req.studentId, sessionId: req.sessionId, branchId: req.branchId },
      orderBy: { attendanceDate: 'desc' },
    });
    const totalDays = attendanceLogs.length;
    const presentCount = attendanceLogs.filter((l) => l.status === 'Present').length;
    const absentCount = attendanceLogs.filter((l) => l.status === 'Absent').length;
    const lateCount = attendanceLogs.filter((l) => l.status === 'Late').length;
    const attendancePct = totalDays > 0 ? Number((((presentCount + lateCount) / totalDays) * 100).toFixed(1)) : 100;

    const attendance = {
      percentage: attendancePct,
      totalDays,
      presentCount,
      absentCount,
      lateCount,
      logs: attendanceLogs.slice(0, 30).map((l) => ({
        id: l.id,
        attendanceDate: l.attendanceDate,
        status: l.status,
        remark: l.remark,
      })),
    };

    // 3. Grades / Average / Rank
    let overallAverage = 0;
    let rank = null;
    let totalClassStudents = fellowStudentsCount;
    let subjectPerformance: any[] = [];

    const studentMarks = await prisma.mark.findMany({
      where: { studentId: req.studentId, sessionId: req.sessionId, branchId: req.branchId },
      include: { subject: { select: { name: true } } },
    });

    if (studentMarks.length > 0) {
      let totalScoreSum = 0;
      let marksCount = 0;
      const subjectMap: Record<string, any> = {};

      studentMarks.forEach((m) => {
        const testScore = m.cbtMark !== null ? parseFloat(m.cbtMark) : 0;
        const examScore = m.mark !== null ? parseFloat(m.mark) : 0;
        const total = testScore + examScore;
        if (m.cbtMark !== null || m.mark !== null) {
          totalScoreSum += total;
          marksCount++;
          const sName = m.subject?.name || 'Unknown';
          if (!subjectMap[sName]) subjectMap[sName] = { sum: 0, count: 0 };
          subjectMap[sName].sum += total;
          subjectMap[sName].count++;
        }
      });

      overallAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;
      subjectPerformance = Object.entries(subjectMap).map(([name, d]) => ({
        name,
        score: Number((d.sum / d.count).toFixed(1)),
      }));

      // Compute rank within class
      if (req.classId && req.sectionId) {
        const enrolls = await prisma.enroll.findMany({
          where: { classId: req.classId, sectionId: req.sectionId, sessionId: req.sessionId, branchId: req.branchId },
          select: { studentId: true },
        });
        const studentIds = enrolls.map((e) => e.studentId);
        totalClassStudents = studentIds.length;

        if (studentIds.length > 0) {
          const allMarks = await prisma.mark.findMany({
            where: { studentId: { in: studentIds }, sessionId: req.sessionId, branchId: req.branchId },
            select: { studentId: true, mark: true, cbtMark: true },
          });
          const agg: Record<string, any> = {};
          studentIds.forEach((id) => {
            agg[id] = { sum: 0, count: 0 };
          });
          allMarks.forEach((m) => {
            const v = (parseFloat(m.cbtMark || '0') || 0) + (parseFloat(m.mark || '0') || 0);
            if (m.mark || m.cbtMark) {
              agg[m.studentId].sum += v;
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

    // 4. Today's Timetable
    let todayTimetable: any[] = [];
    if (req.classId) {
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
            isPublished: true,
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

      todayTimetable = slots.map((s) => ({
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
    }

    // 5. Upcoming Assignments (Homeworks)
    let upcomingHomeworks: any[] = [];
    if (req.classId) {
      const homeworks = await prisma.homework.findMany({
        where: { classId: req.classId, branchId: req.branchId },
        include: { subject: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
        take: 6,
      });
      const submissions = await prisma.homeworkSubmission.findMany({
        where: { studentId: req.studentId, homeworkId: { in: homeworks.map((h) => h.id) } },
        select: { homeworkId: true, score: true, feedback: true },
      });
      const subMap = new Map(submissions.map((s) => [s.homeworkId, s]));

      upcomingHomeworks = homeworks.map((hw) => {
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
    }

    // 6. Upcoming CBT / Exams
    let upcomingExams: any[] = [];
    if (req.classId) {
      const onlineExams = await prisma.onlineExam.findMany({
        where: { classId: req.classId, branchId: req.branchId },
        include: { subject: { select: { name: true } } },
        orderBy: { examDate: 'asc' },
        take: 6,
      });
      const submittedExIds = new Set(
        (
          await prisma.onlineExamSubmission.findMany({
            where: { studentId: req.studentId, onlineExamId: { in: onlineExams.map((e) => e.id) } },
            select: { onlineExamId: true },
          })
        ).map((s) => s.onlineExamId)
      );
      upcomingExams = onlineExams.map((ex) => {
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
    }

    // 7. Homework Progress Stats
    let homeworkProgress = { completed: 0, pending: 0, overdue: 0, percentage: 0 };
    if (req.classId) {
      const allHomeworks = await prisma.homework.findMany({
        where: { classId: req.classId, branchId: req.branchId },
        select: { id: true, dueDate: true },
      });
      const submittedHwSet = new Set(
        (
          await prisma.homeworkSubmission.findMany({
            where: { studentId: req.studentId },
            select: { homeworkId: true },
          })
        ).map((s) => s.homeworkId)
      );
      const completed = allHomeworks.filter((h) => submittedHwSet.has(h.id)).length;
      const overdue = allHomeworks.filter((h) => !submittedHwSet.has(h.id) && new Date(h.dueDate) < today).length;
      const pending = allHomeworks.length - completed - overdue;
      homeworkProgress = {
        completed,
        pending: Math.max(0, pending),
        overdue,
        percentage: allHomeworks.length > 0 ? Math.round((completed / allHomeworks.length) * 100) : 0,
      };
    }

    // 8. School Fee Status
    let feeStatus = { status: 'Unknown', totalBilled: 0, totalPaid: 0, outstanding: 0, nextTermDate: null };
    const invoice = await prisma.invoice.findFirst({
      where: { studentId: req.studentId, sessionId: req.sessionId, branchId: req.branchId },
      include: { payments: { select: { amount: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (invoice) {
      const totalBilled = parseFloat(String(invoice.totalAmount || '0'));
      const totalPaid = invoice.payments.reduce((s, p) => s + parseFloat(String(p.amount || '0')), 0);
      const outstanding = Math.max(0, totalBilled - totalPaid);
      let status = 'Unpaid';
      if (outstanding === 0) status = 'Paid';
      else if (totalPaid > 0) status = 'Partial';
      feeStatus = { status, totalBilled, totalPaid, outstanding, nextTermDate: null };
    }

    // 9. Events / Announcements
    const events = await prisma.event.findMany({
      where: {
        branchId: req.branchId,
        sessionId: req.sessionId,
        startDate: { gte: new Date(today.getFullYear(), today.getMonth() - 1, 1) },
      },
      orderBy: { startDate: 'asc' },
      take: 5,
    });
    const announcements = events.map((ev) => ({
      id: ev.id,
      title: ev.title,
      description: ev.description || '',
      startDate: ev.startDate,
    }));

    // 10. Recent Activities
    const recentActivities: any[] = [];

    const recentHwSubs = await prisma.homeworkSubmission.findMany({
      where: { studentId: req.studentId },
      include: { homework: { include: { subject: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    recentHwSubs.forEach((s) => {
      recentActivities.push({
        type: 'homework_submitted',
        text: `You submitted ${s.homework?.subject?.name || 'a'} homework`,
        timestamp: s.createdAt,
      });
    });

    const recentExamSubs = await prisma.onlineExamSubmission.findMany({
      where: { studentId: req.studentId },
      include: { onlineExam: { include: { subject: { select: { name: true } } } } },
      orderBy: { submittedAt: 'desc' },
      take: 3,
    });
    recentExamSubs.forEach((s) => {
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
        averageScore: overallAverage,
        classRank: rank,
        totalClassStudents,
        attendancePercentage: attendancePct,
        behaviourRating: attendancePct >= 90 ? 'Excellent' : attendancePct >= 75 ? 'Good' : 'Fair',
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
      include: { branch: { select: { name: true, code: true } } },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student profile not found.' });
    }

    let classInfo = null;
    let sectionInfo = null;
    let fellowStudentsCount = 0;
    let formTeacher = null;
    let subjects: any[] = [];

    if (req.classId && req.sectionId) {
      classInfo = await prisma.class.findUnique({ where: { id: req.classId }, select: { name: true } });
      sectionInfo = await prisma.section.findUnique({ where: { id: req.sectionId }, select: { name: true } });

      fellowStudentsCount = await prisma.enroll.count({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId,
        },
      });

      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId,
        },
        include: {
          teacher: { select: { name: true, email: true, phone: true } },
        },
      });
      formTeacher = formAllocation?.teacher || null;

      const subjectAssigns = await prisma.subjectAssign.findMany({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId,
        },
        include: {
          subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } },
        },
      });
      subjects = subjectAssigns.map((sa) => ({
        id: sa.subject.id,
        name: sa.subject.name,
        code: sa.subject.subjectCode,
        type: sa.subject.subjectType,
      }));
    }

    let isEcdClass = false;
    if (req.classId) {
      const cls = await prisma.class.findUnique({ where: { id: req.classId }, select: { isEcd: true } });
      isEcdClass = !!cls?.isEcd;
    }

    return res.json({
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
      subjects,
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
