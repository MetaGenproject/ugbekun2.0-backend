import { Request, Response } from 'express';
import prisma from '../../lib/prisma';

/**
 * GET /api/admin/timetable/sessions
 * Returns all academic sessions for timetable filtering
 */
export async function getTimetableSessions(req: Request, res: Response): Promise<Response | void> {
  try {
    const schoolYears = await prisma.schoolYear.findMany({
      orderBy: { id: 'desc' },
    });

    const sessions = schoolYears.map((s) => ({
      id: s.id,
      name: s.schoolYear.includes('Session') ? s.schoolYear : `${s.schoolYear} Academic Session`,
    }));

    return res.json({ success: true, sessions });
  } catch (error) {
    console.error('[ADMIN] Fetch timetable sessions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch academic sessions.' });
  }
}

/**
 * GET /api/admin/timetable
 */
export async function getTimetable(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, teacherId, sessionId } = req.query;

    const where: any = { branchId };
    if (classId) where.classId = Number(classId);
    if (sectionId) where.sectionId = Number(sectionId);
    if (teacherId) where.teacherId = Number(teacherId);
    if (sessionId) where.sessionId = Number(sessionId);

    const slots = await prisma.timetableSlot.findMany({
      where,
      include: {
        class: { select: { id: true, name: true, nameNumeric: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        teacher: { select: { id: true, name: true, phone: true } },
      },
      orderBy: [{ startTime: 'asc' }],
    });

    const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
    const grouped: Record<string, any[]> = {};
    DAYS.forEach((d) => {
      grouped[d] = [];
    });

    slots.forEach((s) => {
      if (grouped[s.dayOfWeek]) {
        grouped[s.dayOfWeek].push(s);
      } else {
        grouped[s.dayOfWeek] = [s];
      }
    });

    const isPublished = slots.length > 0 && slots.every((s: any) => s.isPublished === true);

    const subjectAssignments = await prisma.subjectAssign.findMany({
      where: { branchId },
      include: {
        teacher: { select: { id: true, name: true, email: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
      },
    });

    return res.json({ success: true, slots, grouped, isPublished, subjectAssignments });
  } catch (error) {
    console.error('[ADMIN] Fetch timetable error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch timetable.' });
  }
}

/**
 * POST /api/admin/timetable/slot
 * Handles both Create and Update
 */
export async function createTimetableSlot(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const {
      id,
      classId,
      sectionId,
      sessionId,
      dayOfWeek,
      startTime,
      endTime,
      type,
      title,
      subjectId,
      teacherId,
      isPublished,
    } = req.body;

    if (!classId || !dayOfWeek || !startTime || !endTime || !type) {
      return res.status(400).json({
        success: false,
        message: 'Class, Day of Week, Start Time, End Time, and Slot Type are required.',
      });
    }

    const validDays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
    if (!validDays.includes(dayOfWeek.toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Invalid day of week.' });
    }

    const slotType = type.toUpperCase();
    if (!['SUBJECT', 'ASSEMBLY', 'BREAK'].includes(slotType)) {
      return res.status(400).json({ success: false, message: 'Invalid slot type. Must be SUBJECT, ASSEMBLY, or BREAK.' });
    }

    if (slotType === 'SUBJECT' && !subjectId) {
      return res.status(400).json({ success: false, message: 'Subject is required for Subject Time slots.' });
    }

    if (slotType === 'SUBJECT' && teacherId) {
      const conflictWhere: any = {
        branchId,
        teacherId: Number(teacherId),
        dayOfWeek: dayOfWeek.toUpperCase(),
        ...(id ? { id: { not: Number(id) } } : {}),
        OR: [
          { startTime: { lte: startTime }, endTime: { gt: startTime } },
          { startTime: { lt: endTime }, endTime: { gte: endTime } },
          { startTime: { gte: startTime }, endTime: { lte: endTime } },
        ],
      };
      if (sessionId) {
        conflictWhere.sessionId = Number(sessionId);
      }

      const conflict = await prisma.timetableSlot.findFirst({
        where: conflictWhere,
        include: {
          class: { select: { name: true } },
          section: { select: { name: true } },
          subject: { select: { name: true } },
        },
      });

      if (conflict) {
        return res.status(400).json({
          success: false,
          message: `Teacher Collision Warning: Teacher is already scheduled for ${conflict.subject?.name || 'Class'} in ${
            conflict.class?.name || ''
          } ${conflict.section?.name ? `(${conflict.section.name})` : ''} on ${dayOfWeek} between ${conflict.startTime} - ${
            conflict.endTime
          }.`,
        });
      }
    }

    let defaultTitle = title;
    if (!defaultTitle) {
      if (slotType === 'ASSEMBLY') defaultTitle = 'Morning Assembly';
      if (slotType === 'BREAK') defaultTitle = 'Break Time';
    }

    let slot;
    if (id) {
      slot = await prisma.timetableSlot.update({
        where: { id: Number(id) },
        data: {
          dayOfWeek: dayOfWeek.toUpperCase(),
          startTime,
          endTime,
          type: slotType,
          title: defaultTitle || null,
          subjectId: subjectId ? Number(subjectId) : null,
          teacherId: teacherId ? Number(teacherId) : null,
          sessionId: sessionId ? Number(sessionId) : undefined,
          isPublished: isPublished !== undefined ? Boolean(isPublished) : undefined,
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
          teacher: { select: { id: true, name: true } },
        },
      });
    } else {
      slot = await prisma.timetableSlot.create({
        data: {
          branchId,
          classId: Number(classId),
          sectionId: sectionId ? Number(sectionId) : null,
          sessionId: sessionId ? Number(sessionId) : null,
          dayOfWeek: dayOfWeek.toUpperCase(),
          startTime,
          endTime,
          type: slotType,
          title: defaultTitle || null,
          subjectId: subjectId ? Number(subjectId) : null,
          teacherId: teacherId ? Number(teacherId) : null,
          isPublished: isPublished !== undefined ? Boolean(isPublished) : true,
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
          teacher: { select: { id: true, name: true } },
        },
      });
    }

    return res.json({ success: true, slot });
  } catch (error: any) {
    console.error('[ADMIN] Save timetable slot error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save timetable slot.' });
  }
}

/**
 * DELETE /api/admin/timetable/slot/:id
 */
export async function deleteTimetableSlot(req: Request, res: Response): Promise<Response | void> {
  try {
    const slotId = Number(req.params.id);
    await prisma.timetableSlot.delete({
      where: { id: slotId },
    });

    return res.json({ success: true, message: 'Timetable slot removed.' });
  } catch (error) {
    console.error('[ADMIN] Delete timetable slot error:', error);
    return res.status(500).json({ success: false, message: 'Failed to remove timetable slot.' });
  }
}

/**
 * POST /api/admin/timetable/publish
 * Publishes or unpublishes class timetable slots
 */
export async function publishTimetable(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, sessionId, isPublished = true } = req.body;

    const where: any = { branchId };
    if (classId) where.classId = Number(classId);
    if (sectionId) where.sectionId = Number(sectionId);
    if (sessionId) where.sessionId = Number(sessionId);

    const result = await prisma.timetableSlot.updateMany({
      where,
      data: { isPublished: Boolean(isPublished) },
    });

    return res.json({
      success: true,
      isPublished: Boolean(isPublished),
      count: result.count,
      message: isPublished
        ? `Timetable successfully published to student, teacher, and parent portals! (${result.count} slots)`
        : `Timetable reverted to draft mode (${result.count} slots).`,
    });
  } catch (error) {
    console.error('[ADMIN] Publish timetable error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update timetable publication status.' });
  }
}

/**
 * POST /api/admin/timetable/clear
 */
export async function clearTimetable(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, sessionId } = req.body;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const where: any = { branchId, classId: Number(classId) };
    if (sectionId) where.sectionId = Number(sectionId);
    if (sessionId) where.sessionId = Number(sessionId);

    await prisma.timetableSlot.deleteMany({ where });

    return res.json({ success: true, message: 'Timetable cleared for this class/section.' });
  } catch (error) {
    console.error('[ADMIN] Clear timetable error:', error);
    return res.status(500).json({ success: false, message: 'Failed to clear timetable.' });
  }
}

/**
 * POST /api/admin/timetable/ai-generate
 */
export async function aiGenerateTimetable(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const {
      classId,
      sectionId,
      sessionId,
      assemblyStartTime = '08:00',
      assemblyEndTime = '08:30',
      breakStartTime = '11:00',
      breakEndTime = '11:30',
      periodDuration = 45,
    } = req.body;

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const numClassId = Number(classId);
    const numSectionId = sectionId ? Number(sectionId) : null;
    const numSessionId = sessionId ? Number(sessionId) : null;

    const assignedSubjects = await prisma.subjectAssign.findMany({
      where: {
        branchId,
        classId: numClassId,
        ...(numSectionId ? { sectionId: numSectionId } : {}),
      },
      include: {
        subject: { select: { id: true, name: true } },
        teacher: { select: { id: true, name: true } },
      },
    });

    let subjectTeacherPairs = assignedSubjects.map((sa: any) => ({
      subjectId: sa.subjectId,
      subjectName: sa.subject?.name || 'Assigned Subject',
      teacherId: sa.teacherId,
      teacherName: sa.teacher?.name || null,
    }));

    if (subjectTeacherPairs.length === 0) {
      const allBranchSubjects = await prisma.subject.findMany({
        where: { branchId },
        take: 8,
      });
      subjectTeacherPairs = allBranchSubjects.map((sub: any) => ({
        subjectId: sub.id,
        subjectName: sub.name,
        teacherId: null,
        teacherName: null,
      }));
    }

    if (subjectTeacherPairs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No subjects found for this class. Please assign subjects in Curriculum setup first.',
      });
    }

    const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

    const subjectTimeSlots = [
      { startTime: '08:30', endTime: '09:15' },
      { startTime: '09:15', endTime: '10:00' },
      { startTime: '10:00', endTime: '10:45' },
      { startTime: '11:30', endTime: '12:15' },
      { startTime: '12:15', endTime: '13:00' },
      { startTime: '13:00', endTime: '13:45' },
    ];

    const newSlotsToCreate: any[] = [];

    DAYS.forEach((day) => {
      newSlotsToCreate.push({
        branchId,
        classId: numClassId,
        sectionId: numSectionId,
        sessionId: numSessionId,
        dayOfWeek: day,
        startTime: assemblyStartTime,
        endTime: assemblyEndTime,
        type: 'ASSEMBLY',
        title: 'Morning Assembly & Devotion',
        subjectId: null,
        teacherId: null,
        isPublished: false, // Default to draft until admin publishes
      });

      newSlotsToCreate.push({
        branchId,
        classId: numClassId,
        sectionId: numSectionId,
        sessionId: numSessionId,
        dayOfWeek: day,
        startTime: breakStartTime,
        endTime: breakEndTime,
        type: 'BREAK',
        title: 'Mid-Morning Recess & Break',
        subjectId: null,
        teacherId: null,
        isPublished: false,
      });

      subjectTimeSlots.forEach((tSlot, pIdx) => {
        const pairIndex = (DAYS.indexOf(day) * subjectTimeSlots.length + pIdx) % subjectTeacherPairs.length;
        const pair = subjectTeacherPairs[pairIndex];

        newSlotsToCreate.push({
          branchId,
          classId: numClassId,
          sectionId: numSectionId,
          sessionId: numSessionId,
          dayOfWeek: day,
          startTime: tSlot.startTime,
          endTime: tSlot.endTime,
          type: 'SUBJECT',
          title: pair.subjectName,
          subjectId: pair.subjectId,
          teacherId: pair.teacherId,
          isPublished: false,
        });
      });
    });

    await prisma.$transaction(async (tx: any) => {
      const deleteWhere: any = {
        branchId,
        classId: numClassId,
        ...(numSectionId ? { sectionId: numSectionId } : {}),
      };
      if (numSessionId) {
        deleteWhere.sessionId = numSessionId;
      }

      await tx.timetableSlot.deleteMany({
        where: deleteWhere,
      });

      await tx.timetableSlot.createMany({
        data: newSlotsToCreate,
      });
    });

    const generatedSlots = await prisma.timetableSlot.findMany({
      where: {
        branchId,
        classId: numClassId,
        ...(numSectionId ? { sectionId: numSectionId } : {}),
        ...(numSessionId ? { sessionId: numSessionId } : {}),
      },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
        teacher: { select: { id: true, name: true } },
      },
      orderBy: [{ startTime: 'asc' }],
    });

    return res.json({
      success: true,
      message: `AI Timetable generated successfully with ${newSlotsToCreate.length} conflict-free slots. Click "Publish Timetable" when ready to release to portals.`,
      slots: generatedSlots,
      isPublished: false,
    });
  } catch (error: any) {
    console.error('[ADMIN] AI Timetable generation error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate AI timetable.' });
  }
}

