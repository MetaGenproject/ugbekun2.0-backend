import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { parseSchoolDateKey } from '../../lib/schoolDate';
import {
  AttendanceRegisterError,
  getRegisterWithEntries,
  listRegisterAudits,
  unlockRegister,
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

/**
 * Resolve the active session ID for a branch/class.
 * Priority: explicit param > global_settings > most recent enrolled session for the branch/class.
 */
async function activeSessionId(branchId?: number, classId?: number): Promise<number> {
  const globalSetting = await prisma.globalSettings.findFirst();
  const globalSession = globalSetting?.sessionId || 4;

  if (!branchId) return globalSession;

  // Verify this session actually has enrollment data for this branch+class
  const where: any = { branchId, sessionId: globalSession };
  if (classId) where.classId = classId;
  const sessionCheck = await prisma.enroll.count({ where });
  if (sessionCheck > 0) return globalSession;

  // Smart fallback: find the most recent session with enrollment data for this branch+class
  const fallbackWhere: any = { branchId };
  if (classId) fallbackWhere.classId = classId;
  const latest = await prisma.enroll.findFirst({
    where: fallbackWhere,
    orderBy: { sessionId: 'desc' },
    select: { sessionId: true },
  });
  return latest?.sessionId ?? globalSession;
}

/**
 * GET /api/admin/attendance/register
 */
export async function getAdminAttendanceRegister(req: Request, res: Response): Promise<Response | void> {
  const classId = Number(req.query.classId);
  const sectionId = Number(req.query.sectionId);
  const dateKey = parseSchoolDateKey(req.query.date);
  if (!classId || !sectionId || !dateKey) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and date (YYYY-MM-DD) are required.' });
  }

  try {
    const sessionId = req.query.sessionId
      ? Number(req.query.sessionId)
      : await activeSessionId(req.branchId, classId);

    const snapshot = await getRegisterWithEntries(prisma, {
      branchId: req.branchId,
      sessionId,
      classId,
      sectionId,
      dateKey,
    });
    const audits = snapshot.register
      ? await listRegisterAudits(prisma, { branchId: req.branchId, registerId: snapshot.register.id })
      : [];
    return res.json({ success: true, ...snapshot, audits, activeSessionId: sessionId });
  } catch (error) {
    const handled = registerErrorResponse(res, error);
    if (handled) return handled;
    console.error('[ADMIN] Attendance register fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch attendance register.' });
  }
}

/**
 * POST /api/admin/attendance/register/unlock
 */
export async function unlockAdminAttendanceRegister(req: Request, res: Response): Promise<Response | void> {
  const { registerId, classId, sectionId, date, reason } = req.body || {};
  const dateKey = date ? parseSchoolDateKey(date) : null;

  try {
    const sessionId = req.body.sessionId
      ? Number(req.body.sessionId)
      : await activeSessionId(req.branchId, classId ? Number(classId) : undefined);

    const updated = await prisma.$transaction(async (tx) => {
      return unlockRegister(tx, {
        branchId: req.branchId,
        registerId: registerId ? Number(registerId) : undefined,
        sessionId,
        classId: classId ? Number(classId) : undefined,
        sectionId: sectionId ? Number(sectionId) : undefined,
        dateKey: dateKey || undefined,
        reason,
        actorUserId: req.userId ? Number(req.userId) : null,
      });
    });

    return res.json({
      success: true,
      message: 'Register unlocked. Form teacher can edit until they submit again.',
      register: {
        id: updated.id,
        status: updated.status,
        version: updated.version,
        unlockedReason: updated.unlockedReason,
      },
    });
  } catch (error) {
    const handled = registerErrorResponse(res, error);
    if (handled) return handled;
    console.error('[ADMIN] Attendance register unlock error:', error);
    return res.status(500).json({ success: false, message: 'Failed to unlock attendance register.' });
  }
}
