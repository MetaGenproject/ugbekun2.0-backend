import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { isFormTeacher } from './teacherDashboardController';
import { notifyParentsOfSubmittedAbsences } from '../../lib/attendanceAbsenceNotifier';
import { parseSchoolDateKey, schoolDateUtcMidnight } from '../../lib/schoolDate';
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
    message: 'Access denied: Only the designated Form Teacher can manage whole-class attendance registers.',
  });
  return false;
}

async function activeSessionId(): Promise<number> {
  const globalSetting = await prisma.globalSettings.findFirst();
  return globalSetting?.sessionId || 5;
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
    const sessionId = await activeSessionId();
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
    const sessionId = await activeSessionId();
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
    const sessionId = await activeSessionId();
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
    const sessionId = await activeSessionId();
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
    const sessionId = await activeSessionId();
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
    const sessionId = await activeSessionId();
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
