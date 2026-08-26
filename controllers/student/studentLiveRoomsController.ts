import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma';

// Helper to generate Jitsi room token for student
export function generateStudentJitsiToken({ roomName, student }: { roomName: string; student: any }) {
  const appId = process.env.JITSI_APP_ID || 'vpaas-magic-cookie-ugbekun';
  const appSecret = process.env.JITSI_APP_SECRET || 'jitsi_dummy_secret_key';

  const payload = {
    aud: 'jitsi',
    iss: appId,
    sub: appId,
    room: roomName,
    moderator: false,
    context: {
      user: {
        id: `student_${student.id}`,
        name: `${student.firstName} ${student.lastName}`,
        email: student.email || '',
        avatar: student.photo || '',
      },
      features: {
        recording: false,
        livestreaming: false,
        'screen-sharing': true,
      },
    },
  };
  return jwt.sign(payload, appSecret, { algorithm: 'HS256', expiresIn: '2h' });
}

/**
 * GET /api/student/media
 */
export async function getMedia(req: Request, res: Response): Promise<Response | void> {
  try {
    if (!req.classId) {
      return res.json({ success: true, items: [] });
    }

    const classObj = await prisma.class.findUnique({
      where: { id: req.classId },
      select: { nameNumeric: true },
    });

    let tier = 'Primary';
    if (classObj) {
      const num = parseInt(classObj.nameNumeric || '1', 10);
      if (isNaN(num) || num < 1) {
        tier = 'Preschool';
      } else if (num >= 7) {
        tier = 'Secondary';
      }
    }

    const items = await prisma.mediaItem.findMany({
      where: { classTier: tier },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, items });
  } catch (error) {
    console.error('[STUDENT] Fetch media error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch media library.' });
  }
}

/**
 * GET /api/student/live-rooms
 */
export async function getLiveRooms(req: Request, res: Response): Promise<Response | void> {
  try {
    if (!req.classId) {
      return res.json({ success: true, rooms: [] });
    }

    const rooms = await prisma.liveRoom.findMany({
      where: {
        type: 'STUDENT_CLASSROOM',
        classId: req.classId,
        sectionId: req.sectionId || undefined,
      },
      orderBy: { scheduledAt: 'desc' },
    });

    return res.json({ success: true, rooms });
  } catch (error) {
    console.error('[STUDENT] Fetch live rooms error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch live classrooms.' });
  }
}

/**
 * GET /api/student/live-rooms/:roomName/token
 */
export async function getLiveRoomToken(req: Request, res: Response): Promise<Response | void> {
  const roomName = String(req.params.roomName);
  try {
    const room = await prisma.liveRoom.findUnique({
      where: { roomName },
    });
    if (!room) {
      return res.status(404).json({ success: false, message: 'Classroom room not found.' });
    }

    if (room.type === 'STUDENT_CLASSROOM' && room.classId !== req.classId) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not enrolled in this class.' });
    }

    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
    });

    const token = generateStudentJitsiToken({
      roomName,
      student,
    });

    return res.json({ success: true, token, roomName });
  } catch (error) {
    console.error('[STUDENT] Live token error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate live classroom token.' });
  }
}
