import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';
import { generateJitsiToken, saveMediaFile } from './teacherDashboardController';

/**
 * GET /api/teacher/media
 */
export async function getMedia(req: Request, res: Response): Promise<Response | void> {
  try {
    const { classTier, topic } = req.query as any;
    const where: any = {};
    if (classTier) where.classTier = classTier;
    if (topic) where.topic = topic;

    const items = await prisma.mediaItem.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, items });
  } catch (error) {
    console.error('[TEACHER] Fetch media error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch media library items.' });
  }
}

/**
 * POST /api/teacher/media
 */
export async function uploadMedia(req: Request, res: Response): Promise<Response | void> {
  const { title, description, classTier, topic, accessType, price } = req.body;
  if (!title || !classTier || !topic || !req.file) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' });
  }

  try {
    const fileUrl = await saveMediaFile(req.file);
    const mediaItem = await prisma.mediaItem.create({
      data: {
        title,
        description: description || null,
        fileUrl,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        classTier,
        topic,
        accessType: accessType === 'PREMIUM' ? 'PREMIUM' : 'FREE',
        price: accessType === 'PREMIUM' && price ? parseFloat(price) : null,
        uploadedBy: req.teacherId,
      },
    });
    return res.json({ success: true, message: 'Media item uploaded successfully.', item: mediaItem });
  } catch (error) {
    console.error('[TEACHER] Media upload error:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload media item.' });
  }
}

/**
 * DELETE /api/teacher/media/:id
 */
export async function deleteMedia(req: Request, res: Response): Promise<Response | void> {
  try {
    const item = await prisma.mediaItem.findUnique({
      where: { id: Number(req.params.id) },
    });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Media item not found.' });
    }
    await prisma.mediaItem.delete({
      where: { id: item.id },
    });
    const filepath = path.join(__dirname, '../..', item.fileUrl);
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch (e) {
        console.warn('Could not delete physical file:', filepath);
      }
    }
    return res.json({ success: true, message: 'Media item deleted successfully.' });
  } catch (error) {
    console.error('[TEACHER] Delete media error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete media item.' });
  }
}

/**
 * POST /api/teacher/live-rooms
 */
export async function createLiveRoom(req: Request, res: Response): Promise<Response | void> {
  const { title, roomName, type, classId, sectionId, scheduledAt, durationMins } = req.body;
  if (!title || !roomName || !type || !scheduledAt) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' });
  }

  try {
    const liveRoom = await prisma.liveRoom.create({
      data: {
        title,
        roomName: roomName.trim().toLowerCase().replace(/\s+/g, '-'),
        type: type === 'STAFF_ALIGNMENT' ? 'STAFF_ALIGNMENT' : 'STUDENT_CLASSROOM',
        hostId: req.teacherId,
        classId: classId ? Number(classId) : null,
        sectionId: sectionId ? Number(sectionId) : null,
        scheduledAt: new Date(scheduledAt),
        durationMins: durationMins ? Number(durationMins) : 45,
        isLive: false,
      },
    });
    return res.json({ success: true, message: 'Live room created successfully.', room: liveRoom });
  } catch (error) {
    console.error('[TEACHER] Create live room error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create live room.' });
  }
}

/**
 * GET /api/teacher/live-rooms
 */
export async function getLiveRooms(req: Request, res: Response): Promise<Response | void> {
  try {
    const rooms = await prisma.liveRoom.findMany({
      where: {
        OR: [{ hostId: req.teacherId }, { type: 'STAFF_ALIGNMENT' }],
      },
      orderBy: { scheduledAt: 'desc' },
    });
    return res.json({ success: true, rooms });
  } catch (error) {
    console.error('[TEACHER] Fetch live rooms error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch live rooms.' });
  }
}

/**
 * GET /api/teacher/live-rooms/:roomName/token
 */
export async function getLiveRoomToken(req: Request, res: Response): Promise<Response | void> {
  const roomName = String(req.params.roomName);
  try {
    const room = await prisma.liveRoom.findUnique({
      where: { roomName },
    });
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    const teacher = await prisma.teacher.findUnique({
      where: { id: req.teacherId },
    });

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found.' });
    }

    const token = generateJitsiToken({
      roomName,
      user: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
        photo: teacher.photo,
      },
      isModerator: room.hostId === req.teacherId,
    });

    if (room.hostId === req.teacherId && !room.isLive) {
      await prisma.liveRoom.update({
        where: { id: room.id },
        data: { isLive: true },
      });
    }

    return res.json({ success: true, token, roomName });
  } catch (error) {
    console.error('[TEACHER] Live token error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate live room token.' });
  }
}

/**
 * GET /api/teacher/gamification/profile
 */
export async function getGamificationProfile(req: Request, res: Response): Promise<Response | void> {
  try {
    const teacher = await prisma.teacher.findUnique({
      where: { id: req.teacherId },
      select: { points: true, name: true },
    });

    const recentLedger = await prisma.gamificationLedger.findMany({
      where: { actorType: 'TEACHER', actorId: req.teacherId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const periods = await gamificationService.getPeriodKeys(prisma);
    const weeklyPeriodKey = `WEEKLY_${periods.WEEKLY}`;
    const alltimePeriodKey = `ALL_TIME_${periods.ALL_TIME}`;

    const weeklyCache = await prisma.leaderboardCache.findUnique({
      where: {
        entityType_entityId_period_branchId: {
          entityType: 'TEACHER',
          entityId: req.teacherId,
          period: weeklyPeriodKey,
          branchId: req.branchId,
        },
      },
    });

    const alltimeCache = await prisma.leaderboardCache.findUnique({
      where: {
        entityType_entityId_period_branchId: {
          entityType: 'TEACHER',
          entityId: req.teacherId,
          period: alltimePeriodKey,
          branchId: req.branchId,
        },
      },
    });

    return res.json({
      success: true,
      points: teacher?.points || 0,
      recentLedger,
      weeklyRank: weeklyCache?.rank || '-',
      alltimeRank: alltimeCache?.rank || '-',
    });
  } catch (error) {
    console.error('[TEACHER] Get gamification profile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve gamification profile.' });
  }
}

/**
 * GET /api/teacher/gamification/leaderboard
 */
export async function getGamificationLeaderboard(req: Request, res: Response): Promise<Response | void> {
  const { periodType = 'WEEKLY' } = req.query;
  try {
    const periods = await gamificationService.getPeriodKeys(prisma);
    let periodKey = '';
    if (periodType === 'WEEKLY') {
      periodKey = `WEEKLY_${periods.WEEKLY}`;
    } else {
      periodKey = `ALL_TIME_${periods.ALL_TIME}`;
    }

    const cacheEntries = await prisma.leaderboardCache.findMany({
      where: {
        entityType: 'TEACHER',
        period: periodKey,
        branchId: req.branchId,
      },
      orderBy: { points: 'desc' },
      take: 10,
    });

    const teacherIds = cacheEntries.map((e) => e.entityId);
    const teachers = await prisma.teacher.findMany({
      where: { id: { in: teacherIds } },
      select: { id: true, name: true },
    });

    const teacherMap: Record<number, string> = {};
    teachers.forEach((t) => {
      teacherMap[t.id] = t.name;
    });

    const leaderboard = cacheEntries.map((entry) => ({
      rank: entry.rank,
      points: entry.points,
      name: teacherMap[entry.entityId] || `Teacher #${entry.entityId}`,
    }));

    return res.json({
      success: true,
      leaderboard,
    });
  } catch (error) {
    console.error('[TEACHER] Get gamification leaderboard error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve gamification leaderboard.' });
  }
}
