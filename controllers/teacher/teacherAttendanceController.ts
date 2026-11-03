import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';
import { isFormTeacher } from './teacherDashboardController';
import { notifyParentsOfSubmittedAbsences } from '../../lib/attendanceAbsenceNotifier';
import {
  parseSchoolDateKey,
  schoolDateUtcMidnight,
  describeSchoolDate,
  schoolDateStoredRange,
  storedAttendanceDateKey,
  todaySchoolDateKey,
  parseSchoolMonthKey,
  todaySchoolMonthKey,
  schoolMonthDateKeys,
  schoolMonthLabel,
  schoolMonthStoredRange,
  isWeekendSchoolDate,
} from '../../lib/schoolDate';
import {
  AttendanceRegisterError,
  getRegisterWithEntries,
  getWeekMatrix,
  openOrGetRegister,
  submitRegister,
  toLegacyAttendancePayload,
  upsertEntries,
} from '../../lib/attendanceRegisterService';

function registerErrorResponse(res: Response, error: unknown) {
  if (error instanceof AttendanceRegisterError) {
    return res.status(error.httpStatus).json({
      success: false,
      message: error.message,
      code: error.code,
      ...error.extra,
    });
  }
  return null;
}

async function forbidUnlessFormTeacher(
  req: Request,
  res: Response,
  classId: unknown,
  sectionId: unknown
): Promise<boolean> {
  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req);
  if (isForm) return true;
  res.status(403).json({
    success: false,
    message: 'Access denied: Only the designated Class Teacher can manage whole-class attendance registers.',
  });
  return false;
}

async function activeSessionId(branchId?: number, classId?: number): Promise<number> {
  const globalSetting = await prisma.globalSettings.findFirst();
  const globalSession = globalSetting?.sessionId || 4;
  if (!branchId) return globalSession;

  const where: any = { branchId, sessionId: globalSession };
  if (classId) where.classId = classId;
  const count = await prisma.enroll.count({ where });
  if (count > 0) return globalSession;

  const fallbackWhere: any = { branchId };
  if (classId) fallbackWhere.classId = classId;
  const latest = await prisma.enroll.findFirst({
    where: fallbackWhere,
    orderBy: { sessionId: 'desc' },
    select: { sessionId: true },
  });
  return latest?.sessionId ?? globalSession;
}

async function fireAbsenceAlerts(
  plannedRows: Array<{ studentId: number; status: string; remark: string | null }>,
  args: { branchId: number; classId: number; sectionId: number; dateKey: string }
) {
  const absences = plannedRows.filter((row) => row.status === 'Absent');
  if (!absences.length) return;
  const [klass, section] = await Promise.all([
    prisma.class.findUnique({ where: { id: args.classId }, select: { name: true } }),
    prisma.section.findUnique({ where: { id: args.sectionId }, select: { name: true } }),
  ]);
  notifyParentsOfSubmittedAbsences({
    branchId: args.branchId,
    className: klass?.name,
    sectionName: section?.name,
    dateKey: args.dateKey,
    absences,
  }).catch((error) => console.error('[ATTENDANCE] Absence notify error:', error?.message || error));
}

function registerWriteTransaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
  return prisma.$transaction(work, { timeout: 20000, maxWait: 10000 });
}

function parseClassSection(classId: unknown, sectionId: unknown) {
  const cId = Number(classId);
  const sId = Number(sectionId);
  if (!cId || !sId) return null;
  return { classId: cId, sectionId: sId };
}

/**
 * POST /api/teacher/attendance
 * Existing Phase 0 submit path. Dual-writes the register header + line items (no deleteMany).
 */
export async function saveAttendance(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, attendanceDate, attendanceData, markRemainingPresent } = req.body;
  const ids = parseClassSection(classId, sectionId);
  if (!ids || !attendanceDate || !Array.isArray(attendanceData)) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' });
  }

  if (!(await forbidUnlessFormTeacher(req, res, ids.classId, ids.sectionId))) return;

  const dateKey = parseSchoolDateKey(attendanceDate);
  if (!dateKey) {
    return res.status(400).json({ success: false, message: 'Invalid attendanceDate format. Use YYYY-MM-DD.' });
  }

  try {
    const sessionId = req.body.sessionId
      ? Number(req.body.sessionId)
      : await activeSessionId(req.branchId, ids.classId);
    const register = await openOrGetRegister(prisma, {
      branchId: req.branchId,
      sessionId,
      classId: ids.classId,
      sectionId: ids.sectionId,
      dateKey,
      teacherId: req.teacherId,
    });
    const result = await registerWriteTransaction(async (tx) => {
      return submitRegister(tx, {
        registerId: register.id,
        branchId: req.branchId,
        sessionId,
        classId: ids.classId,
        sectionId: ids.sectionId,
        dateKey,
        teacherId: req.teacherId,
        actorUserId: req.userId ? Number(req.userId) : null,
        entries: attendanceData,
        markRemainingPresent: markRemainingPresent === true,
        mode: 'legacy-save',
      });
    });

    await prisma.teacherActivity
      .create({
        data: {
          branchId: req.branchId,
          teacherId: req.teacherId,
          activity: 'You marked class roll call attendance',
          type: 'ATTENDANCE',
        },
      })
      .catch(() => null);

    gamificationService
      .checkAttendanceTimeliness(
        prisma,
        req.teacherId,
        ids.classId,
        ids.sectionId,
        schoolDateUtcMidnight(dateKey),
        req.branchId
      )
      .catch((err: any) => console.error('[Gamification] Error in attendance trigger:', err.message));

    fireAbsenceAlerts(result.planned.rows, {
      branchId: req.branchId,
      classId: ids.classId,
      sectionId: ids.sectionId,
      dateKey,
    });

    return res.json({
      success: true,
      message: 'Attendance register submitted successfully.',
      register: {
        id: result.register.id,
        status: result.register.status,
        version: result.register.version,
      },
    });
  } catch (error) {
    const handled = registerErrorResponse(res, error);
    if (handled) return handled;
    console.error('[TEACHER] Attendance save error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save attendance.' });
  }
}

/**
 * GET /api/teacher/attendance
 */
export async function getAttendance(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, attendanceDate } = req.query;
  const ids = parseClassSection(classId, sectionId);
  if (!ids || !attendanceDate) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and attendanceDate are required.' });
  }

  if (!(await forbidUnlessFormTeacher(req, res, ids.classId, ids.sectionId))) return;

  const dateKey = parseSchoolDateKey(attendanceDate);
  if (!dateKey) {
    return res.status(400).json({ success: false, message: 'Invalid attendanceDate format. Use YYYY-MM-DD.' });
  }

  try {
    const sessionId = req.query.sessionId
      ? Number(req.query.sessionId)
      : await activeSessionId(req.branchId, ids.classId);
    const snapshot = await getRegisterWithEntries(prisma, {
      branchId: req.branchId,
      sessionId,
      classId: ids.classId,
      sectionId: ids.sectionId,
      dateKey,
    });

    return res.json({
      success: true,
      attendance: toLegacyAttendancePayload(snapshot.entries),
      register: snapshot.register,
      summary: snapshot.summary,
      calendar: snapshot.calendar,
      canEdit: snapshot.canEdit,
    });
  } catch (error) {
    const handled = registerErrorResponse(res, error);
    if (handled) return handled;
    console.error('[TEACHER] Attendance fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch attendance.' });
  }
}

/**
 * GET /api/teacher/attendance/register
 */
export async function getAttendanceRegister(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, date } = req.query;
  const ids = parseClassSection(classId, sectionId);
  const dateKey = parseSchoolDateKey(date);
  if (!ids || !dateKey) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and date (YYYY-MM-DD) are required.' });
  }

  if (!(await forbidUnlessFormTeacher(req, res, ids.classId, ids.sectionId))) return;

  try {
    const sessionId = req.query.sessionId
      ? Number(req.query.sessionId)
      : await activeSessionId(req.branchId, ids.classId);
    const snapshot = await getRegisterWithEntries(prisma, {
      branchId: req.branchId,
      sessionId,
      classId: ids.classId,
      sectionId: ids.sectionId,
      dateKey,
    });
    return res.json({ success: true, ...snapshot });
  } catch (error) {
    const handled = registerErrorResponse(res, error);
    if (handled) return handled;
    console.error('[TEACHER] Attendance register fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch attendance register.' });
  }
}

/**
 * PATCH /api/teacher/attendance/register/entries
 */
export async function patchAttendanceRegisterEntries(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, date, entries, expectedVersion } = req.body;
  const ids = parseClassSection(classId, sectionId);
  const dateKey = parseSchoolDateKey(date);
  if (!ids || !dateKey || !Array.isArray(entries)) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, date, and entries[] are required.' });
  }

  if (!(await forbidUnlessFormTeacher(req, res, ids.classId, ids.sectionId))) return;

  try {
    const sessionId = req.body.sessionId
      ? Number(req.body.sessionId)
      : await activeSessionId(req.branchId, ids.classId);
    const register = await openOrGetRegister(prisma, {
      branchId: req.branchId,
      sessionId,
      classId: ids.classId,
      sectionId: ids.sectionId,
      dateKey,
      teacherId: req.teacherId,
    });
    const result = await registerWriteTransaction(async (tx) => {
      return upsertEntries(tx, {
        registerId: register.id,
        branchId: req.branchId,
        teacherId: req.teacherId,
        actorUserId: req.userId ? Number(req.userId) : null,
        expectedVersion,
        entries,
        requireComplete: false,
        mode: 'patch',
      });
    });

    return res.json({
      success: true,
      register: {
        id: result.register.id,
        status: result.register.status,
        version: result.register.version,
      },
    });
  } catch (error) {
    const handled = registerErrorResponse(res, error);
    if (handled) return handled;
    console.error('[TEACHER] Attendance register patch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save attendance draft.' });
  }
}

/**
 * POST /api/teacher/attendance/register/submit
 */
export async function submitAttendanceRegister(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, date, entries, markRemainingPresent, expectedVersion, registerId } = req.body;
  const ids = parseClassSection(classId, sectionId);
  const dateKey = parseSchoolDateKey(date);
  if (!ids || !dateKey) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and date (YYYY-MM-DD) are required.' });
  }

  if (!(await forbidUnlessFormTeacher(req, res, ids.classId, ids.sectionId))) return;

  try {
    const sessionId = req.body.sessionId
      ? Number(req.body.sessionId)
      : await activeSessionId(req.branchId, ids.classId);
    const register = registerId
      ? await prisma.attendanceRegister.findFirst({
          where: { id: Number(registerId), branchId: req.branchId },
        })
      : await openOrGetRegister(prisma, {
          branchId: req.branchId,
          sessionId,
          classId: ids.classId,
          sectionId: ids.sectionId,
          dateKey,
          teacherId: req.teacherId,
        });
    if (!register) {
      throw new AttendanceRegisterError('NOT_FOUND', 'Attendance register not found.', 404);
    }
    const result = await registerWriteTransaction(async (tx) => {
      return submitRegister(tx, {
        registerId: register.id,
        branchId: req.branchId,
        sessionId,
        classId: ids.classId,
        sectionId: ids.sectionId,
        dateKey,
        teacherId: req.teacherId,
        actorUserId: req.userId ? Number(req.userId) : null,
        expectedVersion,
        entries: Array.isArray(entries) ? entries : [],
        markRemainingPresent: markRemainingPresent === true,
        mode: 'submit',
      });
    });

    const isUpdate = Boolean(register.submittedAt);

    await prisma.teacherActivity
      .create({
        data: {
          branchId: req.branchId,
          teacherId: req.teacherId,
          activity: isUpdate
            ? 'You updated class roll call attendance'
            : 'You marked class roll call attendance',
          type: 'ATTENDANCE',
        },
      })
      .catch(() => null);

    gamificationService
      .checkAttendanceTimeliness(
        prisma,
        req.teacherId,
        ids.classId,
        ids.sectionId,
        schoolDateUtcMidnight(dateKey),
        req.branchId
      )
      .catch((err: any) => console.error('[Gamification] Error in attendance trigger:', err.message));

    fireAbsenceAlerts(result.planned.rows, {
      branchId: req.branchId,
      classId: ids.classId,
      sectionId: ids.sectionId,
      dateKey,
    });

    return res.json({
      success: true,
      message: isUpdate
        ? 'Attendance register updated successfully.'
        : 'Attendance register submitted successfully.',
      register: {
        id: result.register.id,
        status: result.register.status,
        version: result.register.version,
      },
    });
  } catch (error) {
    const handled = registerErrorResponse(res, error);
    if (handled) return handled;
    console.error('[TEACHER] Attendance register submit error:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit attendance register.' });
  }
}

/**
 * GET /api/teacher/attendance/week
 */
export async function getAttendanceWeek(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, date } = req.query;
  const ids = parseClassSection(classId, sectionId);
  const dateKey = parseSchoolDateKey(date);
  if (!ids || !dateKey) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and date (YYYY-MM-DD) are required.' });
  }

  if (!(await forbidUnlessFormTeacher(req, res, ids.classId, ids.sectionId))) return;

  try {
    const sessionId = req.query.sessionId
      ? Number(req.query.sessionId)
      : await activeSessionId(req.branchId, ids.classId);
    const week = await getWeekMatrix(prisma, {
      branchId: req.branchId,
      sessionId,
      classId: ids.classId,
      sectionId: ids.sectionId,
      dateKey,
    });
    return res.json({ success: true, ...week });
  } catch (error) {
    const handled = registerErrorResponse(res, error);
    if (handled) return handled;
    console.error('[TEACHER] Attendance week fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch attendance week.' });
  }
}

/**
 * GET /api/teacher/attendance/daily-report
 */
export async function getTeacherDailyAttendanceReport(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, date } = req.query;
  const ids = parseClassSection(classId, sectionId);
  if (!ids) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  if (!(await forbidUnlessFormTeacher(req, res, ids.classId, ids.sectionId))) return;

  const dateKey = parseSchoolDateKey(date) || todaySchoolDateKey();
  const described = describeSchoolDate(dateKey);
  const range = schoolDateStoredRange(dateKey);

  try {
    const sessionId = req.query.sessionId
      ? Number(req.query.sessionId)
      : await activeSessionId(req.branchId, ids.classId);

    // 1. Fetch active enrolled students
    const enrolls = await prisma.enroll.findMany({
      where: {
        branchId: req.branchId,
        sessionId,
        classId: ids.classId,
        sectionId: ids.sectionId,
        isAlumni: 0,
        student: { active: true },
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            photo: true,
            gender: true,
          },
        },
      },
      orderBy: [{ roll: 'asc' }, { studentId: 'asc' }],
    });

    // 2. Fetch register metadata (if created)
    const register = await prisma.attendanceRegister.findFirst({
      where: {
        branchId: req.branchId,
        sessionId,
        classId: ids.classId,
        sectionId: ids.sectionId,
        registerDate: schoolDateUtcMidnight(dateKey),
      },
      select: {
        id: true,
        status: true,
        version: true,
        submittedAt: true,
        notes: true,
      },
    });

    // 3. Fetch attendance entries for that date
    const logs = await prisma.attendance.findMany({
      where: {
        branchId: req.branchId,
        sessionId,
        classId: ids.classId,
        sectionId: ids.sectionId,
        attendanceDate: range,
      },
      select: {
        id: true,
        studentId: true,
        status: true,
        remark: true,
        attendanceDate: true,
        updatedAt: true,
      },
    });

    // Filter accurately for this dateKey
    const dayLogs = logs.filter((l) => storedAttendanceDateKey(l.attendanceDate) === dateKey);
    const logMap = new Map<number, (typeof dayLogs)[0]>();
    for (const l of dayLogs) {
      logMap.set(l.studentId, l);
    }

    let presentCount = 0;
    let absentCount = 0;
    let lateCount = 0;
    let excusedCount = 0;
    let sickCount = 0;
    let unmarkedCount = 0;

    const students = enrolls.map((e, index) => {
      const record = logMap.get(e.studentId);
      const rawStatus = record?.status ? String(record.status).trim() : '';
      let status = 'Unmarked';

      if (rawStatus) {
        const upper = rawStatus.toUpperCase();
        if (upper === 'PRESENT') {
          status = 'Present';
          presentCount++;
        } else if (upper === 'ABSENT') {
          status = 'Absent';
          absentCount++;
        } else if (upper === 'LATE') {
          status = 'Late';
          lateCount++;
        } else if (upper === 'EXCUSED') {
          status = 'Excused';
          excusedCount++;
        } else if (upper === 'SICK') {
          status = 'Sick';
          sickCount++;
        } else {
          status = rawStatus;
        }
      } else {
        unmarkedCount++;
      }

      const nameParts = [e.student.lastName, e.student.firstName].map((s) => String(s || '').trim()).filter(Boolean);
      const fullName = nameParts.length ? nameParts.join(', ') : `Student #${e.studentId}`;

      return {
        studentId: e.student.id,
        roll: e.roll || index + 1,
        name: fullName,
        firstName: e.student.firstName,
        lastName: e.student.lastName,
        registerNo: e.student.registerNo,
        photo: e.student.photo,
        gender: e.student.gender,
        status,
        remark: record?.remark || null,
        markedAt: record?.updatedAt || null,
      };
    });

    const totalStudents = enrolls.length;
    const markedStudents = totalStudents - unmarkedCount;
    const inAttendance = presentCount + lateCount;
    const attendanceRate = markedStudents > 0 ? Number(((inAttendance / markedStudents) * 100).toFixed(1)) : 0;

    return res.json({
      success: true,
      date: dateKey,
      weekday: described.weekday,
      isWeekend: described.isWeekend,
      isToday: described.isToday,
      register: register || null,
      summary: {
        total: totalStudents,
        present: presentCount,
        absent: absentCount,
        late: lateCount,
        excused: excusedCount,
        sick: sickCount,
        unmarked: unmarkedCount,
        attendanceRate,
      },
      students,
    });
  } catch (error: any) {
    console.error('[TEACHER] Daily attendance report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate daily attendance report.' });
  }
}

/**
 * GET /api/teacher/attendance/monthly-report
 */
export async function getTeacherMonthlyAttendanceReport(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, month } = req.query;
  const ids = parseClassSection(classId, sectionId);
  if (!ids) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  if (!(await forbidUnlessFormTeacher(req, res, ids.classId, ids.sectionId))) return;

  const monthKey = parseSchoolMonthKey(month) || todaySchoolMonthKey();
  const dateKeys = schoolMonthDateKeys(monthKey);
  if (dateKeys.length === 0) {
    return res.status(400).json({ success: false, message: 'Invalid month format. Use YYYY-MM.' });
  }

  const range = schoolMonthStoredRange(monthKey);
  if (!range) {
    return res.status(400).json({ success: false, message: 'Failed to resolve month range.' });
  }

  try {
    const sessionId = req.query.sessionId
      ? Number(req.query.sessionId)
      : await activeSessionId(req.branchId, ids.classId);

    // 1. Fetch active students
    const enrolls = await prisma.enroll.findMany({
      where: {
        branchId: req.branchId,
        sessionId,
        classId: ids.classId,
        sectionId: ids.sectionId,
        isAlumni: 0,
        student: { active: true },
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            photo: true,
          },
        },
      },
      orderBy: [{ roll: 'asc' }, { studentId: 'asc' }],
    });

    // 2. Fetch all month attendance logs for this class
    const logs = await prisma.attendance.findMany({
      where: {
        branchId: req.branchId,
        sessionId,
        classId: ids.classId,
        sectionId: ids.sectionId,
        attendanceDate: range,
      },
      select: {
        studentId: true,
        status: true,
        attendanceDate: true,
      },
    });

    // Map logs by "studentId::dateKey"
    const logLookup = new Map<string, string>();
    for (const log of logs) {
      const dKey = storedAttendanceDateKey(log.attendanceDate);
      const status = log.status ? String(log.status).trim() : '';
      if (status) {
        logLookup.set(`${log.studentId}::${dKey}`, status);
      }
    }

    // 3. Compute per-day totals across the class
    const daysData = dateKeys.map((dKey, idx) => {
      const dayNum = idx + 1;
      const isWeekend = isWeekendSchoolDate(dKey);
      let dayPresent = 0;
      let dayAbsent = 0;
      let dayLate = 0;

      for (const e of enrolls) {
        const raw = logLookup.get(`${e.studentId}::${dKey}`);
        if (raw) {
          const upper = raw.toUpperCase();
          if (upper === 'PRESENT') dayPresent++;
          else if (upper === 'ABSENT') dayAbsent++;
          else if (upper === 'LATE') dayLate++;
        }
      }

      const totalMarked = dayPresent + dayAbsent + dayLate;
      const isSchoolDayHeld = totalMarked > 0;

      return {
        day: dayNum,
        dateKey: dKey,
        isWeekend,
        isSchoolDayHeld,
        totals: {
          present: dayPresent,
          absent: dayAbsent,
          late: dayLate,
          holiday: isWeekend ? 1 : 0,
        },
      };
    });

    // 4. Build per-student rows
    let grandPresent = 0;
    let grandAbsent = 0;
    let grandLate = 0;

    const students = enrolls.map((e, index) => {
      let pCount = 0;
      let aCount = 0;
      let lCount = 0;
      const dayStatuses: Record<string, string> = {};

      for (const dayItem of daysData) {
        const raw = logLookup.get(`${e.studentId}::${dayItem.dateKey}`);
        if (raw) {
          const upper = raw.toUpperCase();
          if (upper === 'PRESENT') {
            dayStatuses[String(dayItem.day)] = 'P';
            pCount++;
          } else if (upper === 'ABSENT') {
            dayStatuses[String(dayItem.day)] = 'A';
            aCount++;
          } else if (upper === 'LATE') {
            dayStatuses[String(dayItem.day)] = 'L';
            lCount++;
          } else {
            dayStatuses[String(dayItem.day)] = raw.slice(0, 1).toUpperCase();
          }
        } else {
          dayStatuses[String(dayItem.day)] = dayItem.isWeekend ? 'H' : '—';
        }
      }

      grandPresent += pCount;
      grandAbsent += aCount;
      grandLate += lCount;

      const totalStudentDays = pCount + aCount + lCount;
      const studentRate = totalStudentDays > 0 ? Number((((pCount + lCount) / totalStudentDays) * 100).toFixed(1)) : 0;

      const nameParts = [e.student.lastName, e.student.firstName].map((s) => String(s || '').trim()).filter(Boolean);
      const fullName = nameParts.length ? nameParts.join(', ') : `Student #${e.studentId}`;

      return {
        studentId: e.student.id,
        roll: e.roll || index + 1,
        name: fullName,
        firstName: e.student.firstName,
        lastName: e.student.lastName,
        registerNo: e.student.registerNo,
        photo: e.student.photo,
        days: dayStatuses,
        presentCount: pCount,
        absentCount: aCount,
        lateCount: lCount,
        percentage: studentRate,
      };
    });

    const activeSchoolDaysCount = daysData.filter((d) => d.isSchoolDayHeld).length;
    const totalPossibleSessions = activeSchoolDaysCount * enrolls.length;
    const overallRate = totalPossibleSessions > 0
      ? Number((((grandPresent + grandLate) / totalPossibleSessions) * 100).toFixed(1))
      : 0;

    return res.json({
      success: true,
      month: monthKey,
      monthLabel: schoolMonthLabel(monthKey),
      totalEnrolled: enrolls.length,
      schoolDaysCount: activeSchoolDaysCount,
      days: daysData,
      summary: {
        totalPresent: grandPresent,
        totalAbsent: grandAbsent,
        totalLate: grandLate,
        totalHoliday: daysData.filter((d) => d.isWeekend).length,
        averageAttendanceRate: overallRate,
      },
      students,
    });
  } catch (error: any) {
    console.error('[TEACHER] Monthly attendance report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate monthly attendance report.' });
  }
}

/**
 * GET /api/teacher/attendance/termly-report
 */
export async function getTeacherTermlyAttendanceReport(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, termId } = req.query;
  const ids = parseClassSection(classId, sectionId);
  if (!ids) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  if (!(await forbidUnlessFormTeacher(req, res, ids.classId, ids.sectionId))) return;

  try {
    let sessionId = req.query.sessionId ? Number(req.query.sessionId) : 0;
    if (!sessionId || isNaN(sessionId)) {
      sessionId = await activeSessionId(req.branchId, ids.classId);
    }

    const termNum = termId ? Number(termId) : 1;

    // 1. Fetch active students for this session and class section
    let enrolls = await prisma.enroll.findMany({
      where: {
        branchId: req.branchId,
        sessionId,
        classId: ids.classId,
        sectionId: ids.sectionId,
        isAlumni: 0,
        student: { active: true },
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            photo: true,
          },
        },
      },
      orderBy: [{ roll: 'asc' }, { studentId: 'asc' }],
    });

    // Fallback: if no enrollment found with specific sessionId, lookup by class and section
    if (enrolls.length === 0) {
      enrolls = await prisma.enroll.findMany({
        where: {
          classId: ids.classId,
          sectionId: ids.sectionId,
          isAlumni: 0,
          student: { active: true },
        },
        include: {
          student: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              registerNo: true,
              photo: true,
            },
          },
        },
        orderBy: [{ roll: 'asc' }, { studentId: 'asc' }],
      });
    }

    // 2. Fetch all attendance registers & entries for this class/section
    const logs = await prisma.attendance.findMany({
      where: {
        classId: ids.classId,
        sectionId: ids.sectionId,
        ...(req.branchId ? { branchId: req.branchId } : {}),
      },
      select: {
        studentId: true,
        status: true,
        attendanceDate: true,
      },
    });

    // Map academic term months:
    // Term 1: Sept - Dec (months 8, 9, 10, 11)
    // Term 2: Jan - Apr (months 0, 1, 2, 3)
    // Term 3: May - Aug (months 4, 5, 6, 7)
    const termMonthsMap: Record<number, number[]> = {
      1: [8, 9, 10, 11],
      2: [0, 1, 2, 3],
      3: [4, 5, 6, 7],
    };
    const validMonths = termMonthsMap[termNum] || [8, 9, 10, 11];

    const termLogs = logs.filter((log) => {
      const dt = new Date(log.attendanceDate);
      return validMonths.includes(dt.getUTCMonth());
    });

    // If term 1 has no strict month match yet but logs exist, include session logs
    const effectiveLogs = termLogs.length > 0 ? termLogs : (termNum === 1 ? logs : termLogs);

    // Deduplicate distinct dates where attendance was recorded for this class in this term
    const distinctDates = new Set<string>();
    for (const log of effectiveLogs) {
      distinctDates.add(storedAttendanceDateKey(log.attendanceDate));
    }
    const totalSchoolDaysOpened = distinctDates.size;

    // Aggregate by student
    const studentAggregates = new Map<number, { present: number; absent: number; late: number }>();
    for (const log of effectiveLogs) {
      const current = studentAggregates.get(log.studentId) || { present: 0, absent: 0, late: 0 };
      const upper = String(log.status || '').toUpperCase();
      if (upper === 'PRESENT') current.present++;
      else if (upper === 'ABSENT') current.absent++;
      else if (upper === 'LATE') current.late++;
      studentAggregates.set(log.studentId, current);
    }

    let grandPresent = 0;
    let grandAbsent = 0;
    let grandLate = 0;
    let chronicAbsenteeCount = 0;

    const students = enrolls.map((e, index) => {
      const counts = studentAggregates.get(e.studentId) || { present: 0, absent: 0, late: 0 };
      grandPresent += counts.present;
      grandAbsent += counts.absent;
      grandLate += counts.late;

      const attended = counts.present + counts.late;
      const rate = totalSchoolDaysOpened > 0 ? Number(((attended / totalSchoolDaysOpened) * 100).toFixed(1)) : 0;

      let evaluation = 'Pending';
      if (totalSchoolDaysOpened > 0) {
        if (rate >= 95) evaluation = 'Excellent';
        else if (rate >= 85) evaluation = 'Good';
        else if (rate >= 75) evaluation = 'Average';
        else {
          evaluation = 'Critical';
          chronicAbsenteeCount++;
        }
      }

      const nameParts = [e.student.lastName, e.student.firstName].map((s) => String(s || '').trim()).filter(Boolean);
      const fullName = nameParts.length ? nameParts.join(', ') : `Student #${e.studentId}`;

      return {
        studentId: e.student.id,
        roll: e.roll || index + 1,
        name: fullName,
        firstName: e.student.firstName,
        lastName: e.student.lastName,
        registerNo: e.student.registerNo,
        photo: e.student.photo,
        presentDays: counts.present,
        absentDays: counts.absent,
        lateDays: counts.late,
        totalDays: totalSchoolDaysOpened,
        percentage: rate,
        evaluation,
      };
    });

    const totalPossible = totalSchoolDaysOpened * enrolls.length;
    const averageClassRate = totalPossible > 0 ? Number((((grandPresent + grandLate) / totalPossible) * 100).toFixed(1)) : 0;

    return res.json({
      success: true,
      termId: termNum,
      termLabel: termNum === 1 ? '1st Term' : termNum === 2 ? '2nd Term' : '3rd Term',
      totalEnrolled: enrolls.length,
      totalSchoolDays: totalSchoolDaysOpened,
      summary: {
        averageClassRate,
        totalPresent: grandPresent,
        totalAbsent: grandAbsent,
        totalLate: grandLate,
        chronicAbsenteeCount,
      },
      students,
    });
  } catch (error: any) {
    console.error('[TEACHER] Termly attendance report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate termly attendance report.' });
  }
}
