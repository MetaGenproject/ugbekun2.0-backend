import { Request, Response } from 'express';
import prisma from '../../lib/prisma';

/**
 * GET /api/admin/attendance/staff
 */
export async function getStaffAttendance(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { date } = req.query;
    let targetDate;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date as string)) {
      const [y, m, d] = (date as string).split('-').map(Number);
      targetDate = new Date(y, m - 1, d, 0, 0, 0, 0);
    } else {
      targetDate = new Date();
      targetDate.setHours(0, 0, 0, 0);
    }

    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);

    const teachers = await prisma.teacher.findMany({
      where: { branchId },
      select: { id: true, name: true, email: true, phone: true, department: true },
      orderBy: [{ name: 'asc' }],
    });

    const attendanceRecords = await prisma.staffAttendance.findMany({
      where: {
        branchId,
        attendanceDate: {
          gte: targetDate,
          lt: nextDate,
        },
      },
    });

    const attendanceMap: Record<number, any> = {};
    let presentCount = 0;
    let absentCount = 0;
    let lateCount = 0;
    let halfDayCount = 0;
    let onLeaveCount = 0;

    attendanceRecords.forEach((att: any) => {
      attendanceMap[att.teacherId] = {
        id: att.id,
        status: att.status ? att.status.toUpperCase() : 'PRESENT',
        clockIn: att.clockIn || '',
        clockOut: att.clockOut || '',
        remark: att.remark || '',
      };

      const st = (att.status || '').toUpperCase();
      if (st === 'PRESENT') presentCount++;
      else if (st === 'ABSENT') absentCount++;
      else if (st === 'LATE') lateCount++;
      else if (st === 'HALF_DAY') halfDayCount++;
      else if (st === 'ON_LEAVE') onLeaveCount++;
      else presentCount++;
    });

    const totalStaff = teachers.length;
    const attendanceRate =
      totalStaff > 0 ? Math.round(((presentCount + lateCount + halfDayCount) / totalStaff) * 100) : 0;

    return res.json({
      success: true,
      teachers,
      attendanceMap,
      metrics: {
        totalStaff,
        presentCount,
        absentCount,
        lateCount,
        halfDayCount,
        onLeaveCount,
        attendanceRate,
      },
    });
  } catch (error) {
    console.error('[ADMIN] Fetch staff attendance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch staff attendance.' });
  }
}

/**
 * POST /api/admin/attendance/staff/batch-save
 */
export async function saveStaffAttendanceBatch(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { date, attendance } = req.body;

    if (!date || !Array.isArray(attendance)) {
      return res.status(400).json({ success: false, message: 'Invalid payload.' });
    }

    let targetDate;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date as string)) {
      const [y, m, d] = (date as string).split('-').map(Number);
      targetDate = new Date(y, m - 1, d, 0, 0, 0, 0);
    } else {
      targetDate = new Date();
      targetDate.setHours(0, 0, 0, 0);
    }

    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);

    let savedCount = 0;

    for (const item of attendance) {
      if (!item.teacherId) continue;
      const tId = Number(item.teacherId);
      const statusStr = item.status ? String(item.status).toUpperCase() : 'PRESENT';
      const clockInStr = item.clockIn ? String(item.clockIn).trim() : null;
      const clockOutStr = item.clockOut ? String(item.clockOut).trim() : null;
      const remarkStr = item.remark ? String(item.remark).trim() : null;

      const existing = await prisma.staffAttendance.findFirst({
        where: {
          branchId,
          teacherId: tId,
          attendanceDate: {
            gte: targetDate,
            lt: nextDate,
          },
        },
      });

      if (existing) {
        await prisma.staffAttendance.update({
          where: { id: existing.id },
          data: {
            status: statusStr,
            clockIn: clockInStr,
            clockOut: clockOutStr,
            remark: remarkStr,
          },
        });
      } else {
        await prisma.staffAttendance.create({
          data: {
            branchId,
            teacherId: tId,
            attendanceDate: targetDate,
            status: statusStr,
            clockIn: clockInStr,
            clockOut: clockOutStr,
            remark: remarkStr,
          },
        });
      }
      savedCount++;
    }

    return res.json({
      success: true,
      savedCount,
      message: `Staff attendance saved successfully (${savedCount} records).`,
    });
  } catch (error) {
    console.error('[ADMIN] Batch save staff attendance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save staff attendance.' });
  }
}
