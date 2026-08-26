import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { isFormTeacher } from './teacherDashboardController';
import gamificationService from '../../lib/gamificationService';

/**
 * POST /api/teacher/attendance
 */
export async function saveAttendance(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, attendanceDate, attendanceData } = req.body;
  if (!classId || !sectionId || !attendanceDate || !Array.isArray(attendanceData)) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' });
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req);
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the designated Form Teacher can manage whole-class attendance registers.',
    });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const parsedDate = new Date(attendanceDate);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid attendanceDate format.' });
    }
    const targetDate = new Date(
      Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate())
    );

    const uniqueRecordsMap = new Map();
    for (const item of attendanceData) {
      if (item.studentId) {
        uniqueRecordsMap.set(Number(item.studentId), item);
      }
    }
    const deduplicatedData = Array.from(uniqueRecordsMap.values());

    await prisma.$transaction(async (tx: any) => {
      await tx.attendance.deleteMany({
        where: {
          classId: Number(classId),
          sectionId: Number(sectionId),
          attendanceDate: targetDate,
          sessionId,
          branchId: req.branchId,
        },
      });

      if (deduplicatedData.length > 0) {
        await tx.attendance.createMany({
          data: deduplicatedData.map((a: any) => ({
            studentId: Number(a.studentId),
            classId: Number(classId),
            sectionId: Number(sectionId),
            attendanceDate: targetDate,
            status: a.status,
            remark: a.remark || null,
            sessionId,
            branchId: req.branchId,
          })),
        });
      }
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
      .checkAttendanceTimeliness(prisma, req.teacherId, classId, sectionId, targetDate, req.branchId)
      .catch((err: any) => console.error('[Gamification] Error in attendance trigger:', err.message));

    return res.json({ success: true, message: 'Attendance register submitted successfully.' });
  } catch (error) {
    console.error('[TEACHER] Attendance save error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save attendance.' });
  }
}

/**
 * GET /api/teacher/attendance
 */
export async function getAttendance(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, attendanceDate } = req.query;
  if (!classId || !sectionId || !attendanceDate) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and attendanceDate are required.' });
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req);
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can inspect class attendance registers.',
    });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const parsedDate = new Date(attendanceDate as string);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid attendanceDate format.' });
    }
    const targetDate = new Date(
      Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate())
    );

    const attendanceRecords = await prisma.attendance.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        attendanceDate: targetDate,
        sessionId,
        branchId: req.branchId,
      },
      select: {
        studentId: true,
        status: true,
        remark: true,
      },
    });

    return res.json({ success: true, attendance: attendanceRecords });
  } catch (error) {
    console.error('[TEACHER] Attendance fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch attendance.' });
  }
}
