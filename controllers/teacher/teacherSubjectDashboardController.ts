import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { schoolWeekDateKeys, todaySchoolDateKey } from '../../lib/schoolDate';

type AssignRow = {
  classId: number;
  sectionId: number;
  subjectId: number;
  className: string;
  sectionName: string;
  subjectName: string;
};

function emptyDashboard(profile: Record<string, unknown> | null) {
  return {
    success: true,
    profile,
    session: { academicSession: null, currentTerm: null },
    kpi: {
      classesCount: 0,
      studentsCount: 0,
      activeAssignmentsCount: 0,
      assessmentsToGradeCount: 0,
      pendingExamQuestionsCount: 0,
    },
    scoreOverview: {
      average: 0,
      scoredCount: 0,
      bands: [
        { id: '80-100', label: '80 - 100', count: 0, percent: 0 },
        { id: '60-79', label: '60 - 79', count: 0, percent: 0 },
        { id: '40-59', label: '40 - 59', count: 0, percent: 0 },
        { id: 'below-40', label: 'Below 40', count: 0, percent: 0 },
      ],
    },
    classes: [],
    students: [],
    recentAssignments: [],
    assessmentsToGrade: [],
    exams: [],
    schedule: [],
    staffMessages: [],
    unreadStaffCount: 0,
  };
}

function teacherFirstName(name: string | null | undefined) {
  const cleaned = String(name || '')
    .replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, '')
    .trim();
  return cleaned.split(/\s+/)[0] || cleaned || 'Teacher';
}

function classLabel(className?: string | null, sectionName?: string | null) {
  return `${className || ''} ${sectionName || ''}`.trim() || 'Unassigned class';
}

function countQuestions(questions: unknown) {
  if (!questions) return 0;
  if (Array.isArray(questions)) return questions.length;
  if (typeof questions === 'string') {
    try {
      const parsed = JSON.parse(questions);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function parseEnteredScore(mark?: string | null, cbtMark?: string | null) {
  const raw = String(mark ?? '').trim() !== '' ? mark : cbtMark;
  if (raw == null || String(raw).trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function formatClock(time: string | null | undefined) {
  if (!time) return '';
  const [hourRaw, minuteRaw] = String(time).split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour)) return String(time);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour + 11) % 12) + 1;
  return `${String(hour12).padStart(2, '0')}:${String(Number.isFinite(minute) ? minute : 0).padStart(2, '0')} ${suffix}`;
}

function relativeActivity(value: Date | null) {
  if (!value) return 'No portal activity';
  const diffMs = Date.now() - value.getTime();
  if (diffMs < 0) return 'No portal activity';
  if (diffMs < 24 * 60 * 60 * 1000) return 'Active';
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  return value.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function examStatus(questionCount: number, examDate: Date | null, submissionCount: number) {
  if (questionCount === 0) return 'Draft';
  if (submissionCount > 0) return 'In progress';
  if (examDate) return 'Scheduled';
  return 'Ready';
}

async function loadStaffInbox(branchId: number, userId: number | null | undefined) {
  if (!branchId || !userId) return { messages: [] as any[], unreadCount: 0 };
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        id: number;
        senderId: number | null;
        senderType: string | null;
        subject: string | null;
        message: string;
        isMemo: boolean;
        createdAt: Date;
      }>
    >(
      `SELECT id, sender_id AS "senderId", sender_type AS "senderType", subject, message, is_memo AS "isMemo", created_at AS "createdAt"
       FROM staff_messages
       WHERE branch_id = $1 AND (recipient_id = $2 OR recipient_id IS NULL OR is_memo = true)
       ORDER BY created_at DESC
       LIMIT 8`,
      branchId,
      Number(userId)
    );

    const senderIds = Array.from(new Set(rows.map((row) => Number(row.senderId)).filter((id) => Number.isFinite(id) && id > 0)));
    const [users, teachers] = await Promise.all([
      senderIds.length
        ? prisma.user.findMany({
            where: { id: { in: senderIds } },
            select: { id: true, username: true, photo: true, role: true },
          })
        : Promise.resolve([]),
      senderIds.length
        ? prisma.teacher.findMany({
            where: { OR: [{ id: { in: senderIds } }, { userId: { in: senderIds } }] },
            select: { id: true, userId: true, name: true, photo: true, department: true },
          })
        : Promise.resolve([]),
    ]);

    const userMap = new Map(users.map((user) => [user.id, user]));
    const teacherByUserId = new Map(teachers.filter((t) => t.userId).map((t) => [t.userId as number, t]));
    const teacherById = new Map(teachers.map((t) => [t.id, t]));

    const messages = rows.map((row) => {
      const senderId = Number(row.senderId) || 0;
      const teacher = teacherByUserId.get(senderId) || teacherById.get(senderId);
      const user = userMap.get(senderId);
      return {
        id: row.id,
        senderName: teacher?.name || user?.username || 'School Admin',
        senderRole: teacher?.department || row.senderType || 'Staff',
        photo: teacher?.photo || user?.photo || null,
        subject: row.subject,
        preview: String(row.message || '').replace(/\s+/g, ' ').slice(0, 90),
        createdAt: row.createdAt,
        isMemo: Boolean(row.isMemo),
      };
    });

    return { messages, unreadCount: messages.length };
  } catch (error) {
    console.warn('[TEACHER] Staff inbox unavailable:', (error as Error)?.message);
    return { messages: [], unreadCount: 0 };
  }
}

/**
 * GET /api/teacher/subject-dashboard
 * Subject-teacher workspace sourced only from assigned classes, enrollments, homework, exams, marks, and timetable.
 */
export async function getSubjectTeacherDashboard(req: Request, res: Response): Promise<Response | void> {
  try {
    const teacherId = Number(req.teacherId);
    if (!teacherId) {
      return res.status(400).json({ success: false, message: 'Teacher profile required.' });
    }

    const [teacher, globalSetting] = await Promise.all([
      prisma.teacher.findUnique({
        where: { id: teacherId },
        include: {
          branch: {
            select: {
              id: true,
              name: true,
              systemSetting: {
                select: {
                  schoolName: true,
                  academicSession: true,
                  currentTerm: true,
                },
              },
            },
          },
        },
      }),
      prisma.globalSettings.findFirst(),
    ]);

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher profile not found.' });
    }

    const sessionId = Number((req as any).sessionId) || globalSetting?.sessionId || undefined;
    const branchId = req.branchId || teacher.branchId || undefined;
    const profile = {
      teacherId: teacher.id,
      name: teacher.name || 'Staff Member',
      firstName: teacherFirstName(teacher.name),
      email: teacher.email,
      phone: teacher.phone,
      photo: teacher.photo,
      department: teacher.department,
      branchName: teacher.branch?.systemSetting?.schoolName || teacher.branch?.name || 'School Campus',
    };

    let subjectAssignments = await prisma.subjectAssign.findMany({
      where: {
        teacherId,
        ...(branchId ? { branchId } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
      },
    });
    if (subjectAssignments.length === 0 && sessionId) {
      subjectAssignments = await prisma.subjectAssign.findMany({
        where: {
          teacherId,
          ...(branchId ? { branchId } : {}),
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
        },
      });
    }

    const assignments: AssignRow[] = subjectAssignments.map((row) => ({
      classId: row.classId,
      sectionId: row.sectionId,
      subjectId: row.subjectId,
      className: row.class?.name || 'Class',
      sectionName: row.section?.name || '',
      subjectName: row.subject?.name || 'Subject',
    }));

    if (assignments.length === 0) {
      return res.json({
        ...emptyDashboard(profile),
        session: {
          academicSession: teacher.branch?.systemSetting?.academicSession || null,
          currentTerm: teacher.branch?.systemSetting?.currentTerm || null,
        },
      });
    }

    const classSectionPairs = Array.from(
      new Map(assignments.map((row) => [`${row.classId}:${row.sectionId}`, { classId: row.classId, sectionId: row.sectionId }])).values()
    );
    const classIds = Array.from(new Set(assignments.map((row) => row.classId)));
    const subjectIds = Array.from(new Set(assignments.map((row) => row.subjectId)));
    const assignOr = assignments.map((row) => ({
      classId: row.classId,
      sectionId: row.sectionId,
      subjectId: row.subjectId,
    }));

    const startOfToday = new Date(`${todaySchoolDateKey()}T00:00:00.000Z`);
    const weekKeys = schoolWeekDateKeys(todaySchoolDateKey());
    const dayDates: Record<string, string> = {
      MONDAY: weekKeys[0],
      TUESDAY: weekKeys[1],
      WEDNESDAY: weekKeys[2],
      THURSDAY: weekKeys[3],
      FRIDAY: weekKeys[4],
    };

    const [enrolls, homeworks, onlineExams, marks, timetableSlots, questionBankCount, staffInbox] = await Promise.all([
      prisma.enroll.findMany({
        where: {
          isAlumni: 0,
          ...(branchId ? { branchId } : {}),
          OR: classSectionPairs,
        },
        include: {
          student: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              photo: true,
              registerNo: true,
              user: { select: { lastLogin: true } },
            },
          },
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
        },
        orderBy: [{ classId: 'asc' }, { roll: 'asc' }],
      }),
      prisma.homework.findMany({
        where: {
          ...(branchId ? { branchId } : {}),
          subjectId: { in: subjectIds },
          classId: { in: classIds },
        },
        include: {
          class: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
          submissions: { select: { id: true, score: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      prisma.onlineExam.findMany({
        where: {
          ...(branchId ? { branchId } : {}),
          subjectId: { in: subjectIds },
          classId: { in: classIds },
        },
        include: {
          class: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
          submissions: { select: { id: true, totalMark: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      prisma.mark.findMany({
        where: {
          ...(branchId ? { branchId } : {}),
          OR: assignOr,
        },
        select: { mark: true, cbtMark: true },
      }),
      prisma.timetableSlot.findMany({
        where: {
          teacherId,
          ...(branchId ? { branchId } : {}),
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
        },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      }),
      prisma.questionBank.count({
        where: {
          ...(branchId ? { branchId } : {}),
          subjectId: { in: subjectIds },
        },
      }),
      loadStaffInbox(Number(branchId) || 0, Number(req.userId) || teacher.userId || teacher.id),
    ]);

    const teacherHomeworks = homeworks.filter((hw) =>
      assignments.some((row) => row.classId === hw.classId && row.subjectId === hw.subjectId)
    );
    const teacherExams = onlineExams.filter((exam) =>
      assignments.some((row) => row.classId === exam.classId && row.subjectId === exam.subjectId)
    );

    const uniqueStudentIds = new Set<number>();
    const studentsByPair = new Map<string, typeof enrolls>();
    for (const enroll of enrolls) {
      if (!enroll.student) continue;
      uniqueStudentIds.add(enroll.student.id);
      const key = `${enroll.classId}:${enroll.sectionId}`;
      const list = studentsByPair.get(key) || [];
      list.push(enroll);
      studentsByPair.set(key, list);
    }

    const studentIds = Array.from(uniqueStudentIds);
    const recentSubmissions =
      studentIds.length > 0
        ? await prisma.homeworkSubmission.findMany({
            where: {
              studentId: { in: studentIds },
              homework: { subjectId: { in: subjectIds } },
            },
            orderBy: { createdAt: 'desc' },
            take: 300,
            select: { studentId: true, createdAt: true },
          })
        : [];

    const lastSubmissionAt = new Map<number, Date>();
    for (const row of recentSubmissions) {
      if (!lastSubmissionAt.has(row.studentId)) {
        lastSubmissionAt.set(row.studentId, row.createdAt);
      }
    }

    const students = assignments.flatMap((assign) => {
      const roster = studentsByPair.get(`${assign.classId}:${assign.sectionId}`) || [];
      return roster.map((enroll) => {
        const lastLogin = enroll.student.user?.lastLogin || null;
        const lastWork = lastSubmissionAt.get(enroll.student.id) || null;
        const latest =
          lastLogin && lastWork ? (lastLogin > lastWork ? lastLogin : lastWork) : lastLogin || lastWork;
        return {
          id: enroll.student.id,
          assignKey: `${enroll.student.id}:${assign.classId}:${assign.sectionId}:${assign.subjectId}`,
          firstName: enroll.student.firstName || '',
          lastName: enroll.student.lastName || '',
          photo: enroll.student.photo,
          registerNo: enroll.student.registerNo,
          classId: assign.classId,
          sectionId: assign.sectionId,
          subjectId: assign.subjectId,
          className: classLabel(assign.className, assign.sectionName),
          subjectName: assign.subjectName,
          lastActivityAt: latest,
          lastActivity: relativeActivity(latest),
        };
      });
    });

    const classCounts = new Map<string, { classId: number; sectionId: number; name: string; studentCount: number }>();
    for (const assign of assignments) {
      const key = `${assign.classId}:${assign.sectionId}`;
      if (!classCounts.has(key)) {
        classCounts.set(key, {
          classId: assign.classId,
          sectionId: assign.sectionId,
          name: classLabel(assign.className, assign.sectionName),
          studentCount: (studentsByPair.get(key) || []).length,
        });
      }
    }

    const enteredScores = marks
      .map((row) => parseEnteredScore(row.mark, row.cbtMark))
      .filter((value): value is number => value !== null);
    const bands = [
      { id: '80-100', label: '80 - 100', count: enteredScores.filter((score) => score >= 80).length, percent: 0 },
      { id: '60-79', label: '60 - 79', count: enteredScores.filter((score) => score >= 60 && score < 80).length, percent: 0 },
      { id: '40-59', label: '40 - 59', count: enteredScores.filter((score) => score >= 40 && score < 60).length, percent: 0 },
      { id: 'below-40', label: 'Below 40', count: enteredScores.filter((score) => score < 40).length, percent: 0 },
    ].map((band) => ({
      ...band,
      percent: enteredScores.length > 0 ? Number(((band.count / enteredScores.length) * 100).toFixed(1)) : 0,
    }));
    const average =
      enteredScores.length > 0
        ? Number((enteredScores.reduce((sum, score) => sum + score, 0) / enteredScores.length).toFixed(1))
        : 0;

    const activeAssignments = teacherHomeworks.filter((hw) => new Date(hw.dueDate).getTime() >= startOfToday.getTime());
    const assessmentsToGrade = [
      ...teacherHomeworks
        .map((hw) => {
          const pending = hw.submissions.filter((sub) => sub.score === null).length;
          return {
            id: `homework-${hw.id}`,
            kind: 'assignment' as const,
            title: hw.title,
            className: hw.class?.name || 'Class',
            subjectName: hw.subject?.name || 'Subject',
            scriptsCount: pending,
            status: 'Pending',
          };
        })
        .filter((row) => row.scriptsCount > 0),
      ...teacherExams
        .map((exam) => {
          const pending = exam.submissions.filter((sub) => sub.totalMark === null).length;
          return {
            id: `exam-${exam.id}`,
            kind: 'cbt' as const,
            title: exam.title,
            className: exam.class?.name || 'Class',
            subjectName: exam.subject?.name || 'Subject',
            scriptsCount: pending,
            status: 'Pending',
          };
        })
        .filter((row) => row.scriptsCount > 0),
    ];

    const pendingExamQuestions = teacherExams.filter((exam) => countQuestions(exam.questions) === 0).length;

    const recentAssignments = teacherHomeworks.slice(0, 5).map((hw) => {
      const due = new Date(hw.dueDate);
      const isActive = due.getTime() >= startOfToday.getTime();
      return {
        id: hw.id,
        title: hw.title,
        className: hw.class?.name || 'Class',
        subjectName: hw.subject?.name || 'Subject',
        dueDate: hw.dueDate,
        status: isActive ? 'Active' : 'Closed',
      };
    });

    const exams = teacherExams.slice(0, 5).map((exam) => {
      const questionCount = countQuestions(exam.questions);
      return {
        id: exam.id,
        title: exam.title,
        className: exam.class?.name || 'Class',
        subjectName: exam.subject?.name || 'Subject',
        type: 'CBT',
        questionCount,
        status: examStatus(questionCount, exam.examDate, exam.submissions.length),
      };
    });

    const dayOrder = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
    const schedule = [...timetableSlots]
      .sort((a, b) => {
        const dayDiff = dayOrder.indexOf(a.dayOfWeek) - dayOrder.indexOf(b.dayOfWeek);
        if (dayDiff !== 0) return dayDiff;
        return String(a.startTime).localeCompare(String(b.startTime));
      })
      .slice(0, 8)
      .map((slot) => {
        const dateKey = dayDates[slot.dayOfWeek];
        const dayDate = dateKey ? new Date(`${dateKey}T00:00:00.000Z`) : null;
        return {
          id: slot.id,
          dayOfWeek: slot.dayOfWeek,
          dateLabel: dayDate
            ? dayDate.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', timeZone: 'UTC' })
            : slot.dayOfWeek.slice(0, 3),
          className: classLabel(slot.class?.name, slot.section?.name),
          subjectName: slot.subject?.name || slot.title || 'Period',
          startTime: formatClock(slot.startTime),
          endTime: formatClock(slot.endTime),
          status: slot.isPublished ? 'Approved' : 'Pending Approval',
        };
      });

    return res.json({
      success: true,
      profile,
      session: {
        academicSession: teacher.branch?.systemSetting?.academicSession || null,
        currentTerm: teacher.branch?.systemSetting?.currentTerm || null,
      },
      kpi: {
        classesCount: classCounts.size,
        studentsCount: uniqueStudentIds.size,
        activeAssignmentsCount: activeAssignments.length,
        assessmentsToGradeCount: assessmentsToGrade.reduce((sum, row) => sum + row.scriptsCount, 0),
        pendingExamQuestionsCount: pendingExamQuestions,
        questionBankCount,
      },
      scoreOverview: {
        average,
        scoredCount: enteredScores.length,
        bands,
      },
      classes: Array.from(classCounts.values()),
      students: students.slice(0, 80),
      studentsTotal: students.length,
      recentAssignments,
      assessmentsToGrade: assessmentsToGrade.slice(0, 6),
      exams,
      schedule,
      staffMessages: staffInbox.messages,
      unreadStaffCount: staffInbox.unreadCount,
    });
  } catch (error) {
    console.error('[TEACHER] Subject dashboard error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load subject teacher dashboard.' });
  }
}
