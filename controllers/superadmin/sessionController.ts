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

    const sessionList = sessions.map((s) => ({
      id: s.id,
      name: s.schoolYear,
      schoolYear: s.schoolYear,
      isCurrent: s.id === activeSessionId,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
    }));

    return res.json({
      success: true,
      data: {
        sessions: sessionList,
        activeSessionId,
      },
      sessions: sessionList,
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
    const rawName = req.body?.schoolYear || req.body?.name;
    const isCurrent = Boolean(req.body?.isCurrent);
    if (!rawName || !String(rawName).trim()) {
      return res.status(400).json({ success: false, message: 'Session name is required.' });
    }

    const sessionName = String(rawName).trim();

    // Check for duplicate schoolYear
    const existing = await prisma.schoolYear.findFirst({
      where: {
        schoolYear: { equals: sessionName, mode: 'insensitive' },
      },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: `Academic session "${sessionName}" already exists.`,
      });
    }

    const session = await prisma.schoolYear.create({
      data: {
        schoolYear: sessionName,
        createdBy: Number((req as any).userId || 1),
      },
    });

    if (isCurrent) {
      const gsCount = await prisma.globalSettings.count();
      if (gsCount === 0) {
        await prisma.globalSettings.create({
          data: {
            instituteName: 'Ugbekun SaaS Platform',
            sessionId: session.id,
          },
        });
      } else {
        await prisma.globalSettings.updateMany({
          data: { sessionId: session.id },
        });
      }
    }

    const formatted = {
      id: session.id,
      name: session.schoolYear,
      schoolYear: session.schoolYear,
      isCurrent,
      createdBy: session.createdBy,
      createdAt: session.createdAt,
    };

    return res.status(201).json({
      success: true,
      message: 'Session created successfully.',
      data: formatted,
      session: formatted,
    });
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

    const targetId = Number(sessionId);
    const existing = await prisma.schoolYear.findUnique({ where: { id: targetId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Academic session not found.' });
    }

    const gsCount = await prisma.globalSettings.count();
    if (gsCount === 0) {
      await prisma.globalSettings.create({
        data: {
          instituteName: 'Ugbekun SaaS Platform',
          sessionId: targetId,
        },
      });
    } else {
      await prisma.globalSettings.updateMany({
        data: { sessionId: targetId },
      });
    }

    return res.json({ success: true, message: 'Active session updated.' });
  } catch (error: any) {
    console.error('[SUPERADMIN] Set active session error:', error);
    return res.status(500).json({ success: false, message: 'Failed to set active session.' });
  }
}
