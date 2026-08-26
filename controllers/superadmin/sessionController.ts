import { Request, Response } from 'express';
import prisma from '../../lib/prisma';

/**
 * GET /api/superadmin/sessions
 */
export async function getSessions(req: Request, res: Response): Promise<Response | void> {
  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSessionId = globalSetting?.sessionId || 1;
    const sessions = await prisma.schoolYear.findMany({
      orderBy: { id: 'desc' },
    });

    return res.json({
      success: true,
      data: sessions.map((s) => ({
        id: s.id,
        name: s.schoolYear,
        isCurrent: s.id === activeSessionId,
        createdAt: s.createdAt,
      })),
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] List sessions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load sessions.' });
  }
}

/**
 * POST /api/superadmin/sessions
 */
export async function createSession(req: Request, res: Response): Promise<Response | void> {
  try {
    const { name, isCurrent } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Session name is required.' });
    }

    const sessionName = name.trim();

    const session = await prisma.schoolYear.create({
      data: {
        schoolYear: sessionName,
        createdBy: 1,
      },
    });

    if (isCurrent) {
      await prisma.globalSettings.updateMany({
        data: { sessionId: session.id },
      });
    }

    return res.status(201).json({ success: true, message: 'Session created successfully.', data: session });
  } catch (error: any) {
    console.error('[SUPERADMIN] Create session error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create session.' });
  }
}

/**
 * PUT /api/superadmin/sessions/active
 */
export async function setActiveSession(req: Request, res: Response): Promise<Response | void> {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required.' });
    }

    await prisma.globalSettings.updateMany({
      data: { sessionId: Number(sessionId) },
    });

    return res.json({ success: true, message: 'Active session updated.' });
  } catch (error: any) {
    console.error('[SUPERADMIN] Set active session error:', error);
    return res.status(500).json({ success: false, message: 'Failed to set active session.' });
  }
}
