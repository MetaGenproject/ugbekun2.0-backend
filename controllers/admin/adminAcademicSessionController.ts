import { Request, Response } from 'express';
import prisma from '../../lib/prisma';

const DEFAULT_TERMS = ['First Term', 'Second Term', 'Third Term'];

function normalizeSessionName(value: unknown) {
  return String(value || '').trim();
}

function normalizeTerm(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return 'First Term';
  const compact = raw.toLowerCase().replace(/\s+/g, '');
  if (compact === '1stterm' || compact === 'firstterm') return 'First Term';
  if (compact === '2ndterm' || compact === 'secondterm') return 'Second Term';
  if (compact === '3rdterm' || compact === 'thirdterm') return 'Third Term';
  return DEFAULT_TERMS.includes(raw) ? raw : raw;
}

async function getActiveSessionId() {
  const globalSetting = await prisma.globalSettings.findFirst();
  return globalSetting?.sessionId || null;
}

async function applyCurrentSession(branchId: number, session: { id: number; schoolYear: string }, term?: string) {
  const currentTerm = term ? normalizeTerm(term) : undefined;

  const globalSetting = await prisma.globalSettings.findFirst();
  if (globalSetting) {
    await prisma.globalSettings.update({
      where: { id: globalSetting.id },
      data: { sessionId: session.id },
    });
  } else {
    await prisma.globalSettings.create({
      data: {
        instituteName: 'Ugbekun',
        sessionId: session.id,
      },
    });
  }

  await prisma.systemSetting.upsert({
    where: { branchId },
    create: {
      branchId,
      academicSession: session.schoolYear,
      currentTerm: currentTerm || 'First Term',
    },
    update: {
      academicSession: session.schoolYear,
      ...(currentTerm ? { currentTerm } : {}),
    },
  });
}

/**
 * GET /api/admin/sessions
 */
export async function getAcademicSessions(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const [sessions, activeSessionId, settings] = await Promise.all([
      prisma.schoolYear.findMany({ orderBy: { id: 'desc' } }),
      getActiveSessionId(),
      branchId
        ? prisma.systemSetting.findUnique({
            where: { branchId },
            select: { academicSession: true, currentTerm: true },
          })
        : Promise.resolve(null),
    ]);

    return res.json({
      success: true,
      currentTerm: settings?.currentTerm || 'First Term',
      terms: DEFAULT_TERMS,
      sessions: sessions.map((session) => ({
        id: session.id,
        name: session.schoolYear,
        isCurrent: session.id === activeSessionId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })),
    });
  } catch (error: any) {
    console.error('[ADMIN] List academic sessions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load academic sessions.' });
  }
}

/**
 * POST /api/admin/sessions
 */
export async function createAcademicSession(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const name = normalizeSessionName(req.body?.name || req.body?.schoolYear);
  const isCurrent = Boolean(req.body?.isCurrent);
  const currentTerm = req.body?.currentTerm;

  if (!name) {
    return res.status(400).json({ success: false, message: 'Session name is required.' });
  }

  try {
    const duplicate = await prisma.schoolYear.findFirst({
      where: { schoolYear: { equals: name, mode: 'insensitive' } },
    });
    if (duplicate) {
      return res.status(400).json({ success: false, message: 'An academic session with this name already exists.' });
    }

    const session = await prisma.schoolYear.create({
      data: {
        schoolYear: name,
        createdBy: Number(req.userId || 1),
      },
    });

    if (isCurrent && branchId) {
      await applyCurrentSession(branchId, session, currentTerm);
    }

    return res.status(201).json({
      success: true,
      message: 'Academic session created.',
      session: {
        id: session.id,
        name: session.schoolYear,
        isCurrent,
        createdAt: session.createdAt,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Create academic session error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create academic session.' });
  }
}

/**
 * PUT /api/admin/sessions/:id
 */
export async function updateAcademicSession(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const sessionId = Number(req.params.id);
  const name = normalizeSessionName(req.body?.name || req.body?.schoolYear);
  const isCurrent = req.body?.isCurrent === true;
  const currentTerm = req.body?.currentTerm;

  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid session id.' });
  }

  try {
    const existing = await prisma.schoolYear.findUnique({ where: { id: sessionId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Academic session not found.' });
    }

    let schoolYear = existing.schoolYear;
    if (name && name.toLowerCase() !== existing.schoolYear.toLowerCase()) {
      const duplicate = await prisma.schoolYear.findFirst({
        where: {
          id: { not: sessionId },
          schoolYear: { equals: name, mode: 'insensitive' },
        },
      });
      if (duplicate) {
        return res.status(400).json({ success: false, message: 'An academic session with this name already exists.' });
      }
      schoolYear = name;
    }

    const session = await prisma.schoolYear.update({
      where: { id: sessionId },
      data: { schoolYear },
    });

    if ((isCurrent || currentTerm) && branchId) {
      await applyCurrentSession(branchId, session, currentTerm);
    }

    return res.json({
      success: true,
      message: 'Academic session updated.',
      session: {
        id: session.id,
        name: session.schoolYear,
        isCurrent: isCurrent || (await getActiveSessionId()) === session.id,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Update academic session error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update academic session.' });
  }
}

/**
 * DELETE /api/admin/sessions/:id
 */
export async function deleteAcademicSession(req: Request, res: Response): Promise<Response | void> {
  const sessionId = Number(req.params.id);

  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid session id.' });
  }

  try {
    const existing = await prisma.schoolYear.findUnique({ where: { id: sessionId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Academic session not found.' });
    }

    const activeSessionId = await getActiveSessionId();
    if (activeSessionId === sessionId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete the current academic session. Set another session as current first.',
      });
    }

    const [eventCount, enrollCount] = await Promise.all([
      prisma.event.count({ where: { sessionId } }),
      prisma.enroll.count({ where: { sessionId } }),
    ]);

    if (eventCount > 0 || enrollCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'This session has calendar events or student enrolments and cannot be deleted.',
      });
    }

    await prisma.schoolYear.delete({ where: { id: sessionId } });
    return res.json({ success: true, message: 'Academic session deleted.' });
  } catch (error: any) {
    console.error('[ADMIN] Delete academic session error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete academic session.' });
  }
}

/**
 * PUT /api/admin/sessions/:id/current
 */
export async function setCurrentAcademicSession(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const sessionId = Number(req.params.id);
  const currentTerm = req.body?.currentTerm;

  if (!branchId) {
    return res.status(400).json({ success: false, message: 'Branch context is required.' });
  }
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid session id.' });
  }

  try {
    const session = await prisma.schoolYear.findUnique({ where: { id: sessionId } });
    if (!session) {
      return res.status(404).json({ success: false, message: 'Academic session not found.' });
    }

    await applyCurrentSession(branchId, session, currentTerm);
    return res.json({
      success: true,
      message: 'Current academic session updated.',
      session: { id: session.id, name: session.schoolYear, isCurrent: true },
      currentTerm: currentTerm ? normalizeTerm(currentTerm) : undefined,
    });
  } catch (error: any) {
    console.error('[ADMIN] Set current academic session error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to set current session.' });
  }
}
