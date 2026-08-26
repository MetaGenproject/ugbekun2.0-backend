import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import {
  parseAikenFormat,
  parseCsvFormat,
  parseJsonFormat,
  generateAiCurriculumQuestions,
} from '../../lib/cbtService';

/**
 * GET /api/admin/exams
 */
export async function getExams(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const exams = await prisma.exam.findMany({
      where: { branchId },
      orderBy: { id: 'desc' },
    });

    return res.json({ success: true, exams });
  } catch (error) {
    console.error('[ADMIN] Fetch exams error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch exams.' });
  }
}

/**
 * POST /api/admin/exams
 */
export async function createExam(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, term, sessionId } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Exam name is required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSession = sessionId ? Number(sessionId) : globalSetting?.sessionId || 1;

    const exam = await prisma.exam.create({
      data: {
        name: name.trim(),
        termId: term ? Number(term) : 1,
        typeId: 1,
        remark: 'Exam',
        markDistribution: '[]',
        sessionId: activeSession,
        branchId,
      },
    });

    return res.status(201).json({ success: true, exam, message: 'Exam created successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Create exam error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create exam.' });
  }
}

/**
 * GET /api/admin/evaluation-matrices
 */
export async function getEvaluationMatrices(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const matrices = await prisma.evaluationMatrix.findMany({
      where: { branchId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    return res.json({ success: true, matrices });
  } catch (error) {
    console.error('[ADMIN] Fetch evaluation matrices error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch evaluation matrices.' });
  }
}

/**
 * POST /api/admin/evaluation-matrices
 */
export async function createEvaluationMatrix(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, code, description, totalMarks, isDefault, components } = req.body;

    if (!name || !code) {
      return res.status(400).json({ success: false, message: 'Matrix Name and Matrix Code are required.' });
    }

    if (!Array.isArray(components) || components.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one assessment component is required.' });
    }

    if (isDefault) {
      await prisma.evaluationMatrix.updateMany({
        where: { branchId },
        data: { isDefault: false },
      });
    }

    const matrix = await prisma.evaluationMatrix.create({
      data: {
        branchId,
        name: name.trim(),
        code: code.trim().toUpperCase(),
        description: description ? description.trim() : null,
        totalMarks: totalMarks ? Number(totalMarks) : 100,
        isDefault: Boolean(isDefault),
        components: components,
      },
    });

    return res.json({ success: true, matrix, message: 'Evaluation Matrix created successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Create evaluation matrix error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create evaluation matrix.' });
  }
}

/**
 * PUT /api/admin/evaluation-matrices/:id
 */
export async function updateEvaluationMatrix(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const matrixId = Number(req.params.id);
    const { name, code, description, totalMarks, isDefault, components } = req.body;

    const existing = await prisma.evaluationMatrix.findFirst({
      where: { id: matrixId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Evaluation Matrix not found.' });
    }

    if (isDefault && !existing.isDefault) {
      await prisma.evaluationMatrix.updateMany({
        where: { branchId },
        data: { isDefault: false },
      });
    }

    const updated = await prisma.evaluationMatrix.update({
      where: { id: matrixId },
      data: {
        name: name ? name.trim() : existing.name,
        code: code ? code.trim().toUpperCase() : existing.code,
        description: description !== undefined ? (description ? description.trim() : null) : existing.description,
        totalMarks: totalMarks !== undefined ? Number(totalMarks) : existing.totalMarks,
        isDefault: isDefault !== undefined ? Boolean(isDefault) : existing.isDefault,
        components: components !== undefined ? components : existing.components,
      },
    });

    return res.json({ success: true, matrix: updated, message: 'Evaluation Matrix updated successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Update evaluation matrix error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update evaluation matrix.' });
  }
}

/**
 * DELETE /api/admin/evaluation-matrices/:id
 */
export async function deleteEvaluationMatrix(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const matrixId = Number(req.params.id);

    const existing = await prisma.evaluationMatrix.findFirst({
      where: { id: matrixId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Evaluation Matrix not found.' });
    }

    await prisma.evaluationMatrix.delete({
      where: { id: matrixId },
    });

    return res.json({ success: true, message: 'Evaluation Matrix deleted successfully.' });
  } catch (error) {
    console.error('[ADMIN] Delete evaluation matrix error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete evaluation matrix.' });
  }
}

/**
 * POST /api/admin/evaluation-matrices/:id/set-default
 */
export async function setDefaultEvaluationMatrix(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const matrixId = Number(req.params.id);

    await prisma.$transaction([
      prisma.evaluationMatrix.updateMany({
        where: { branchId },
        data: { isDefault: false },
      }),
      prisma.evaluationMatrix.update({
        where: { id: matrixId },
        data: { isDefault: true },
      }),
    ]);

    return res.json({ success: true, message: 'Default evaluation matrix updated.' });
  } catch (error) {
    console.error('[ADMIN] Set default matrix error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update default evaluation matrix.' });
  }
}

/**
 * POST /api/admin/evaluation-matrices/assign-class
 */
export async function assignMatrixToClass(req: Request, res: Response): Promise<Response | void> {
  try {
    const { classId, evaluationMatrixId } = req.body;

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const updatedClass = await prisma.class.update({
      where: { id: Number(classId) },
      data: {
        evaluationMatrixId: evaluationMatrixId ? Number(evaluationMatrixId) : null,
      },
      include: {
        evaluationMatrix: true,
      },
    });

    return res.json({
      success: true,
      class: updatedClass,
      message: 'Evaluation Matrix assigned to class successfully.',
    });
  } catch (error) {
    console.error('[ADMIN] Assign evaluation matrix to class error:', error);
    return res.status(500).json({ success: false, message: 'Failed to assign evaluation matrix to class.' });
  }
}

/**
 * GET /api/admin/exam-halls
 */
export async function getExamHalls(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const halls = await prisma.examHall.findMany({
      where: { branchId },
      include: {
        invigilator: { select: { id: true, name: true, email: true, phone: true } },
      },
      orderBy: [{ createdAt: 'asc' }],
    });

    return res.json({ success: true, halls });
  } catch (error) {
    console.error('[ADMIN] Fetch exam halls error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch exam halls.' });
  }
}

/**
 * POST /api/admin/exam-halls
 */
export async function createExamHall(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, code, capacity, location, facilities, invigilatorId, status } = req.body;

    if (!name || !code) {
      return res.status(400).json({ success: false, message: 'Hall Name and Hall Code are required.' });
    }

    const hall = await prisma.examHall.create({
      data: {
        branchId,
        name: name.trim(),
        code: code.trim().toUpperCase(),
        capacity: capacity ? Number(capacity) : 50,
        location: location ? location.trim() : null,
        facilities: facilities ? facilities.trim() : null,
        status: status ? status.toUpperCase() : 'ACTIVE',
        invigilatorId: invigilatorId ? Number(invigilatorId) : null,
      },
      include: {
        invigilator: { select: { id: true, name: true, email: true, phone: true } },
      },
    });

    return res.json({ success: true, hall, message: 'Exam Hall created successfully.' });
  } catch (error) {
    console.error('[ADMIN] Create exam hall error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create exam hall.' });
  }
}

/**
 * PUT /api/admin/exam-halls/:id
 */
export async function updateExamHall(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const hallId = Number(req.params.id);
    const { name, code, capacity, location, facilities, invigilatorId, status } = req.body;

    const existing = await prisma.examHall.findFirst({
      where: { id: hallId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Exam Hall not found.' });
    }

    const updated = await prisma.examHall.update({
      where: { id: hallId },
      data: {
        name: name ? name.trim() : existing.name,
        code: code ? code.trim().toUpperCase() : existing.code,
        capacity: capacity !== undefined ? Number(capacity) : existing.capacity,
        location: location !== undefined ? (location ? location.trim() : null) : existing.location,
        facilities: facilities !== undefined ? (facilities ? facilities.trim() : null) : existing.facilities,
        status: status ? status.toUpperCase() : existing.status,
        invigilatorId:
          invigilatorId !== undefined ? (invigilatorId ? Number(invigilatorId) : null) : existing.invigilatorId,
      },
      include: {
        invigilator: { select: { id: true, name: true, email: true, phone: true } },
      },
    });

    return res.json({ success: true, hall: updated, message: 'Exam Hall updated successfully.' });
  } catch (error) {
    console.error('[ADMIN] Update exam hall error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update exam hall.' });
  }
}

/**
 * DELETE /api/admin/exam-halls/:id
 */
export async function deleteExamHall(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const hallId = Number(req.params.id);

    const existing = await prisma.examHall.findFirst({
      where: { id: hallId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Exam Hall not found.' });
    }

    await prisma.examHall.delete({
      where: { id: hallId },
    });

    return res.json({ success: true, message: 'Exam Hall deleted successfully.' });
  } catch (error) {
    console.error('[ADMIN] Delete exam hall error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete exam hall.' });
  }
}

/**
 * GET /api/admin/exam-schedule
 */
export async function getExamSchedule(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, hallId } = req.query;

    const where: any = { branchId };
    if (classId) where.classId = Number(classId);
    if (sectionId) where.sectionId = Number(sectionId);
    if (hallId) where.hallId = Number(hallId);

    const slots = await prisma.examScheduleSlot.findMany({
      where,
      include: {
        class: { select: { id: true, name: true, nameNumeric: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        hall: { select: { id: true, name: true, code: true, capacity: true, location: true } },
        invigilator: { select: { id: true, name: true, email: true, phone: true } },
      },
      orderBy: [{ examDate: 'asc' }, { startTime: 'asc' }],
    });

    return res.json({ success: true, slots });
  } catch (error) {
    console.error('[ADMIN] Fetch exam schedule error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch exam schedule.' });
  }
}

/**
 * POST /api/admin/exam-schedule/slot
 */
export async function createExamScheduleSlot(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const {
      id,
      classId,
      sectionId,
      subjectId,
      examDate,
      startTime,
      endTime,
      hallId,
      invigilatorId,
      instructions,
      isPublished = true,
    } = req.body;

    if (!classId || !subjectId || !examDate || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'Class, Subject, Exam Date, Start Time, and End Time are required.',
      });
    }

    const parsedDate = new Date(examDate);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid exam date format.' });
    }

    if (hallId) {
      const hallConflict = await prisma.examScheduleSlot.findFirst({
        where: {
          branchId,
          hallId: Number(hallId),
          examDate: parsedDate,
          ...(id ? { id: { not: Number(id) } } : {}),
          OR: [
            { startTime: { lte: startTime }, endTime: { gt: startTime } },
            { startTime: { lt: endTime }, endTime: { gte: endTime } },
            { startTime: { gte: startTime }, endTime: { lte: endTime } },
          ],
        },
        include: {
          class: { select: { name: true } },
          subject: { select: { name: true } },
          hall: { select: { name: true } },
        },
      });

      if (hallConflict) {
        return res.status(400).json({
          success: false,
          message: `Venue Collision Warning: ${hallConflict.hall?.name || 'Exam Hall'} is already booked for ${
            hallConflict.subject?.name || 'an exam'
          } (${hallConflict.class?.name || 'Class'}) on ${examDate} between ${hallConflict.startTime} - ${
            hallConflict.endTime
          }.`,
        });
      }
    }

    if (invigilatorId) {
      const invigilatorConflict = await prisma.examScheduleSlot.findFirst({
        where: {
          branchId,
          invigilatorId: Number(invigilatorId),
          examDate: parsedDate,
          ...(id ? { id: { not: Number(id) } } : {}),
          OR: [
            { startTime: { lte: startTime }, endTime: { gt: startTime } },
            { startTime: { lt: endTime }, endTime: { gte: endTime } },
            { startTime: { gte: startTime }, endTime: { lte: endTime } },
          ],
        },
        include: {
          class: { select: { name: true } },
          subject: { select: { name: true } },
          invigilator: { select: { name: true } },
        },
      });

      if (invigilatorConflict) {
        return res.status(400).json({
          success: false,
          message: `Invigilator Collision Warning: Supervisor ${
            invigilatorConflict.invigilator?.name || ''
          } is already assigned to ${invigilatorConflict.subject?.name || 'an exam'} in ${
            invigilatorConflict.class?.name || 'another class'
          } on ${examDate} between ${invigilatorConflict.startTime} - ${invigilatorConflict.endTime}.`,
        });
      }
    }

    let slot;
    if (id) {
      slot = await prisma.examScheduleSlot.update({
        where: { id: Number(id) },
        data: {
          classId: Number(classId),
          sectionId: sectionId ? Number(sectionId) : null,
          subjectId: Number(subjectId),
          examDate: parsedDate,
          startTime,
          endTime,
          hallId: hallId ? Number(hallId) : null,
          invigilatorId: invigilatorId ? Number(invigilatorId) : null,
          instructions: instructions ? instructions.trim() : null,
          isPublished: Boolean(isPublished),
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
          hall: { select: { id: true, name: true, code: true } },
          invigilator: { select: { id: true, name: true } },
        },
      });
    } else {
      slot = await prisma.examScheduleSlot.create({
        data: {
          branchId,
          classId: Number(classId),
          sectionId: sectionId ? Number(sectionId) : null,
          subjectId: Number(subjectId),
          examDate: parsedDate,
          startTime,
          endTime,
          hallId: hallId ? Number(hallId) : null,
          invigilatorId: invigilatorId ? Number(invigilatorId) : null,
          instructions: instructions ? instructions.trim() : null,
          isPublished: Boolean(isPublished),
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true } },
          hall: { select: { id: true, name: true, code: true } },
          invigilator: { select: { id: true, name: true } },
        },
      });
    }

    return res.json({ success: true, slot, message: 'Exam timetable slot saved.' });
  } catch (error: any) {
    console.error('[ADMIN] Save exam schedule slot error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save exam schedule slot.' });
  }
}

/**
 * DELETE /api/admin/exam-schedule/slot/:id
 */
export async function deleteExamScheduleSlot(req: Request, res: Response): Promise<Response | void> {
  try {
    const slotId = Number(req.params.id);

    await prisma.examScheduleSlot.delete({
      where: { id: slotId },
    });

    return res.json({ success: true, message: 'Exam timetable slot removed.' });
  } catch (error) {
    console.error('[ADMIN] Delete exam schedule slot error:', error);
    return res.status(500).json({ success: false, message: 'Failed to remove exam schedule slot.' });
  }
}

/**
 * POST /api/admin/exam-schedule/publish
 */
export async function publishExamSchedule(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, isPublished = true } = req.body;

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const where: any = { branchId, classId: Number(classId) };
    if (sectionId) where.sectionId = Number(sectionId);

    await prisma.examScheduleSlot.updateMany({
      where,
      data: { isPublished: Boolean(isPublished) },
    });

    return res.json({
      success: true,
      message: isPublished
        ? 'Exam schedule published and distributed to class successfully.'
        : 'Exam schedule set to draft for class.',
    });
  } catch (error) {
    console.error('[ADMIN] Publish exam schedule error:', error);
    return res.status(500).json({ success: false, message: 'Failed to publish exam schedule.' });
  }
}

/**
 * POST /api/admin/exam-schedule/clear
 */
export async function clearExamSchedule(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId } = req.body;

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const where: any = { branchId, classId: Number(classId) };
    if (sectionId) where.sectionId = Number(sectionId);

    await prisma.examScheduleSlot.deleteMany({ where });

    return res.json({ success: true, message: 'Exam schedule cleared for this class.' });
  } catch (error) {
    console.error('[ADMIN] Clear exam schedule error:', error);
    return res.status(500).json({ success: false, message: 'Failed to clear exam schedule.' });
  }
}

/**
 * GET /api/admin/cbt/groups
 */
export async function getCbtGroups(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const groups = await prisma.questionGroup.findMany({
      where: { branchId },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, groups });
  } catch (error) {
    console.error('[ADMIN] Fetch CBT groups error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch question groups.' });
  }
}

/**
 * POST /api/admin/cbt/groups
 */
export async function createCbtGroup(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { title, groupCode, subjectId, classId, questionIds = [], totalMarks = 100 } = req.body;
    if (!title || !groupCode || !subjectId) {
      return res.status(400).json({ success: false, message: 'Group Title, Code, and Subject are required.' });
    }

    const group = await prisma.questionGroup.create({
      data: {
        branchId,
        title: title.trim(),
        groupCode: groupCode.trim().toUpperCase(),
        subjectId: Number(subjectId),
        classId: classId ? Number(classId) : null,
        questionIds: Array.isArray(questionIds) ? questionIds : [],
        totalMarks: parseFloat(totalMarks) || 100.0,
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } },
      },
    });

    return res.status(201).json({ success: true, group, message: 'Question group created successfully.' });
  } catch (error) {
    console.error('[ADMIN] Create CBT group error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create question group.' });
  }
}

/**
 * DELETE /api/admin/cbt/groups/:id
 */
export async function deleteCbtGroup(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const groupId = Number(req.params.id);

    await prisma.questionGroup.deleteMany({
      where: { id: groupId, branchId },
    });

    return res.json({ success: true, message: 'Question group deleted.' });
  } catch (error) {
    console.error('[ADMIN] Delete CBT group error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete question group.' });
  }
}

/**
 * GET /api/admin/cbt/distributions
 */
export async function getCbtDistributions(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const distributions = await prisma.cbtDistribution.findMany({
      where: { branchId },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        group: { select: { id: true, title: true, groupCode: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, distributions });
  } catch (error) {
    console.error('[ADMIN] Fetch CBT distributions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch CBT distributions.' });
  }
}

/**
 * POST /api/admin/cbt/distributions
 */
export async function createCbtDistribution(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const {
      id,
      title,
      instructions,
      duration = 30,
      passingMark = 50.0,
      isPublished = true,
      shuffleQuestions = true,
      showResults = true,
      groupId,
      classId,
      sectionId,
      subjectId,
      startDate,
      endDate,
    } = req.body;

    if (!title || !classId || !subjectId) {
      return res.status(400).json({ success: false, message: 'Title, Class, and Subject are required.' });
    }

    let dist;
    if (id) {
      dist = await prisma.cbtDistribution.update({
        where: { id: Number(id) },
        data: {
          title: title.trim(),
          instructions: instructions ? instructions.trim() : null,
          duration: Number(duration) || 30,
          passingMark: Number(passingMark) || 50.0,
          isPublished: Boolean(isPublished),
          shuffleQuestions: Boolean(shuffleQuestions),
          showResults: Boolean(showResults),
          groupId: groupId ? Number(groupId) : null,
          classId: Number(classId),
          sectionId: sectionId ? Number(sectionId) : null,
          subjectId: Number(subjectId),
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true } },
          group: { select: { id: true, title: true, groupCode: true } },
        },
      });
    } else {
      dist = await prisma.cbtDistribution.create({
        data: {
          branchId,
          title: title.trim(),
          instructions: instructions ? instructions.trim() : null,
          duration: Number(duration) || 30,
          passingMark: Number(passingMark) || 50.0,
          isPublished: Boolean(isPublished),
          shuffleQuestions: Boolean(shuffleQuestions),
          showResults: Boolean(showResults),
          groupId: groupId ? Number(groupId) : null,
          classId: Number(classId),
          sectionId: sectionId ? Number(sectionId) : null,
          subjectId: Number(subjectId),
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true } },
          group: { select: { id: true, title: true, groupCode: true } },
        },
      });
    }

    let resolvedQuestions: any[] = [];
    if (groupId) {
      const grp = await prisma.questionGroup.findUnique({ where: { id: Number(groupId) } });
      if (grp && Array.isArray(grp.questionIds) && grp.questionIds.length > 0) {
        resolvedQuestions = await prisma.questionBank.findMany({
          where: { id: { in: (grp.questionIds as any[]).map(Number) } },
        });
      }
    }
    if (resolvedQuestions.length === 0) {
      resolvedQuestions = await prisma.questionBank.findMany({
        where: { branchId, subjectId: Number(subjectId) },
        take: 20,
      });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSessionId = globalSetting?.sessionId || 5;

    let onlineExam = await prisma.onlineExam.findFirst({
      where: {
        title: title.trim(),
        classId: Number(classId),
        subjectId: Number(subjectId),
        branchId,
      },
    });

    if (onlineExam) {
      await prisma.onlineExam.update({
        where: { id: onlineExam.id },
        data: {
          duration: Number(duration) || 30,
          passingMark: Number(passingMark) || 50.0,
          questions: resolvedQuestions,
          sessionId: activeSessionId,
        },
      });
    } else {
      await prisma.onlineExam.create({
        data: {
          title: title.trim(),
          classId: Number(classId),
          subjectId: Number(subjectId),
          passingMark: Number(passingMark) || 50.0,
          duration: Number(duration) || 30,
          branchId,
          sessionId: activeSessionId,
          questions: resolvedQuestions,
          examDate: startDate ? new Date(startDate) : new Date(),
        },
      });
    }

    return res.json({ success: true, distribution: dist, message: 'CBT Test distributed to class successfully.' });
  } catch (error) {
    console.error('[ADMIN] Create CBT distribution error:', error);
    return res.status(500).json({ success: false, message: 'Failed to distribute CBT test.' });
  }
}

/**
 * POST /api/admin/cbt/distributions/:id/toggle-publish
 */
export async function togglePublishCbtDistribution(req: Request, res: Response): Promise<Response | void> {
  try {
    const distId = Number(req.params.id);
    const { isPublished } = req.body;

    const updated = await prisma.cbtDistribution.update({
      where: { id: distId },
      data: { isPublished: Boolean(isPublished) },
    });

    return res.json({
      success: true,
      distribution: updated,
      message: isPublished ? 'CBT test published live for students.' : 'CBT test unpublished (Draft Mode).',
    });
  } catch (error) {
    console.error('[ADMIN] Toggle CBT publish error:', error);
    return res.status(500).json({ success: false, message: 'Failed to toggle CBT publication status.' });
  }
}

/**
 * DELETE /api/admin/cbt/distributions/:id
 */
export async function deleteCbtDistribution(req: Request, res: Response): Promise<Response | void> {
  try {
    const distId = Number(req.params.id);
    await prisma.cbtDistribution.delete({ where: { id: distId } });
    return res.json({ success: true, message: 'CBT distribution deleted.' });
  } catch (error) {
    console.error('[ADMIN] Delete CBT distribution error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete CBT distribution.' });
  }
}

/**
 * GET /api/admin/cbt/question-bank
 */
export async function getCbtQuestionBank(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { subjectId, classId, search, page = 1, limit = 50 } = req.query;
    const p = parseInt(page as string, 10);
    const l = parseInt(limit as string, 10);
    const skip = (p - 1) * l;

    const where: any = { branchId };
    if (subjectId) where.subjectId = Number(subjectId);
    if (classId) where.classId = Number(classId);
    if (search) {
      where.questionText = { contains: search, mode: 'insensitive' };
    }

    const [items, total] = await Promise.all([
      prisma.questionBank.findMany({
        where,
        include: {
          subject: { select: { id: true, name: true, subjectCode: true } },
          class: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: l,
      }),
      prisma.questionBank.count({ where }),
    ]);

    return res.json({
      success: true,
      items,
      total,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
      },
    });
  } catch (error) {
    console.error('[ADMIN] Fetch question bank error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch question bank.' });
  }
}

/**
 * POST /api/admin/cbt/question-bank
 */
export async function createCbtQuestion(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const {
      questionText,
      questionType = 'mcq',
      options = [],
      correctOption = 'A',
      marks = 1.0,
      subjectId,
      classId,
    } = req.body;
    if (!questionText || !subjectId) {
      return res.status(400).json({ success: false, message: 'Question prompt and Subject are required.' });
    }

    const item = await prisma.questionBank.create({
      data: {
        branchId,
        questionText: questionText.trim(),
        questionType,
        options: Array.isArray(options) ? options : [],
        correctOption: String(correctOption).trim().toUpperCase(),
        marks: parseFloat(marks) || 1.0,
        subjectId: Number(subjectId),
        classId: classId ? Number(classId) : null,
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } },
      },
    });

    return res.status(201).json({ success: true, item, message: 'Question created successfully.' });
  } catch (error) {
    console.error('[ADMIN] Create question bank item error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create question.' });
  }
}

/**
 * PUT /api/admin/cbt/question-bank/:id
 */
export async function updateCbtQuestion(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const { questionText, questionType, options, correctOption, marks, subjectId, classId } = req.body;

    const item = await prisma.questionBank.update({
      where: { id },
      data: {
        ...(questionText ? { questionText: questionText.trim() } : {}),
        ...(questionType ? { questionType } : {}),
        ...(options ? { options: Array.isArray(options) ? options : [] } : {}),
        ...(correctOption ? { correctOption: String(correctOption).trim().toUpperCase() } : {}),
        ...(marks !== undefined ? { marks: parseFloat(marks) } : {}),
        ...(subjectId ? { subjectId: Number(subjectId) } : {}),
        ...(classId !== undefined ? { classId: classId ? Number(classId) : null } : {}),
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } },
      },
    });

    return res.json({ success: true, item, message: 'Question updated successfully.' });
  } catch (error) {
    console.error('[ADMIN] Update question bank item error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update question.' });
  }
}

/**
 * DELETE /api/admin/cbt/question-bank/:id
 */
export async function deleteCbtQuestion(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    await prisma.questionBank.delete({ where: { id } });
    return res.json({ success: true, message: 'Question deleted successfully.' });
  } catch (error) {
    console.error('[ADMIN] Delete question bank item error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete question.' });
  }
}

/**
 * POST /api/admin/cbt/question-bank/import
 */
export async function importCbtQuestions(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { format = 'aiken', data, subjectId, classId } = req.body;
    if (!data || !subjectId) {
      return res.status(400).json({ success: false, message: 'Import Data and Subject are required.' });
    }

    const sId = Number(subjectId);
    const cId = classId ? Number(classId) : null;

    let parsedQuestions: any[] = [];
    if (format === 'aiken') {
      parsedQuestions = parseAikenFormat(typeof data === 'string' ? data : '');
    } else if (format === 'csv') {
      parsedQuestions = parseCsvFormat(typeof data === 'string' ? data : '');
    } else if (format === 'json') {
      parsedQuestions = parseJsonFormat(data);
    }

    if (parsedQuestions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid questions could be parsed from the provided format syntax.',
      });
    }

    const insertData = parsedQuestions.map((q: any) => ({
      branchId,
      subjectId: sId,
      classId: cId,
      questionText: q.questionText,
      questionType: q.questionType || 'mcq',
      options: q.options,
      correctOption: q.correctOption || 'A',
      marks: q.marks || 1.0,
    }));

    await prisma.questionBank.createMany({
      data: insertData,
    });

    return res.status(201).json({
      success: true,
      count: insertData.length,
      message: `Successfully imported ${insertData.length} question(s) into Question Bank.`,
    });
  } catch (error: any) {
    console.error('[ADMIN] Import question bank error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to import questions.' });
  }
}

/**
 * POST /api/admin/cbt/question-bank/ai-generate
 */
export async function aiGenerateCbtQuestions(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { subjectId, classId, topic, classLevel, count = 5, questionType = 'mcq' } = req.body;
    if (!subjectId || !topic) {
      return res.status(400).json({ success: false, message: 'Subject and Topic are required.' });
    }

    const sId = Number(subjectId);
    const cId = classId ? Number(classId) : null;

    const subject = await prisma.subject.findUnique({
      where: { id: sId },
      select: { name: true },
    });

    const generated = generateAiCurriculumQuestions({
      subjectName: subject?.name || 'General Studies',
      topic: topic.trim(),
      classLevel: classLevel || 'Secondary',
      questionCount: Number(count) || 5,
      questionType,
    });

    const insertData = generated.map((q: any) => ({
      branchId,
      subjectId: sId,
      classId: cId,
      questionText: q.questionText,
      questionType: q.questionType,
      options: q.options,
      correctOption: q.correctOption,
      marks: q.marks,
    }));

    await prisma.questionBank.createMany({
      data: insertData,
    });

    return res.status(201).json({
      success: true,
      count: insertData.length,
      questions: generated,
      message: `AI generated and imported ${insertData.length} question(s) for "${topic}".`,
    });
  } catch (error) {
    console.error('[ADMIN] AI generate question bank error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate AI questions.' });
  }
}

/**
 * GET /api/admin/cbt/distributions/:id/analytics
 */
export async function getCbtDistributionAnalytics(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const distId = Number(req.params.id);
    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: distId },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        group: true,
      },
    });

    if (!dist) {
      return res.status(404).json({ success: false, message: 'CBT Distribution not found.' });
    }

    let questions: any[] = [];
    if (dist.group && Array.isArray(dist.group.questionIds) && dist.group.questionIds.length > 0) {
      questions = await prisma.questionBank.findMany({
        where: { id: { in: (dist.group.questionIds as any[]).map(Number) } },
      });
    } else {
      questions = await prisma.questionBank.findMany({
        where: { branchId, subjectId: dist.subjectId },
        take: 20,
      });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const enrollWhere: any = {
      classId: dist.classId,
      branchId,
      sessionId,
    };
    if (dist.sectionId) enrollWhere.sectionId = dist.sectionId;

    const enrollments = await prisma.enroll.findMany({
      where: enrollWhere,
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true, active: true } },
      },
    });
    const activeStudents = enrollments.filter((e) => e.student && e.student.active);

    const submissions = await prisma.onlineExamSubmission.findMany({
      where: {
        studentId: { in: activeStudents.map((e) => e.student.id) },
      },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } },
      },
      orderBy: { submittedAt: 'desc' },
    });

    const studentRoster = activeStudents.map((e) => {
      const st = e.student;
      const sub = submissions.find((s) => s.studentId === st.id);
      return {
        studentId: st.id,
        studentName: `${st.lastName}, ${st.firstName}`,
        registerNo: st.registerNo || 'Pending',
        isSubmitted: Boolean(sub && sub.submittedAt),
        totalMark: sub?.totalMark !== null && sub?.totalMark !== undefined ? sub.totalMark : null,
        submittedAt: sub?.submittedAt || null,
      };
    });

    const submittedOnly = studentRoster.filter((s) => s.isSubmitted && s.totalMark !== null);
    const totalScoreSum = submittedOnly.reduce((acc, s) => acc + Number(s.totalMark), 0);
    const averageScore = submittedOnly.length > 0 ? totalScoreSum / submittedOnly.length : 0;
    const highestScore = submittedOnly.length > 0 ? Math.max(...submittedOnly.map((s) => Number(s.totalMark))) : 0;
    const lowestScore = submittedOnly.length > 0 ? Math.min(...submittedOnly.map((s) => Number(s.totalMark))) : 0;
    const passedCount = submittedOnly.filter((s) => Number(s.totalMark) >= (dist.passingMark || 50)).length;
    const passRate = submittedOnly.length > 0 ? (passedCount / submittedOnly.length) * 100 : 0;

    return res.json({
      success: true,
      distribution: dist,
      totalEnrolled: activeStudents.length,
      submittedCount: submittedOnly.length,
      pendingCount: activeStudents.length - submittedOnly.length,
      averageScore: Math.round(averageScore * 10) / 10,
      highestScore,
      lowestScore,
      passRate: Math.round(passRate * 10) / 10,
      questionsCount: questions.length,
      students: studentRoster,
    });
  } catch (error) {
    console.error('[ADMIN] Fetch CBT distribution analytics error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load CBT analytics.' });
  }
}

/**
 * POST /api/admin/cbt/distributions/:id/sync-marks
 */
export async function syncCbtMarks(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const distId = Number(req.params.id);
    const { targetExamId, maxScoreBase = 40 } = req.body;

    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: distId },
      include: { class: true, subject: true },
    });

    if (!dist) {
      return res.status(404).json({ success: false, message: 'CBT Distribution not found.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    let examId = targetExamId ? Number(targetExamId) : null;
    if (!examId) {
      let activeExam = await prisma.exam.findFirst({
        where: { branchId, sessionId },
        orderBy: { id: 'desc' },
      });
      if (!activeExam) {
        activeExam = await prisma.exam.findFirst({
          where: { branchId },
          orderBy: { id: 'desc' },
        });
      }
      examId = activeExam?.id || null;
    }

    const enrollWhere: any = {
      classId: dist.classId,
      branchId,
      sessionId,
    };
    if (dist.sectionId) enrollWhere.sectionId = dist.sectionId;

    const enrollments = await prisma.enroll.findMany({
      where: enrollWhere,
      select: { studentId: true, classId: true, sectionId: true },
    });

    const studentIds = enrollments.map((e) => e.studentId);

    const submissions = await prisma.onlineExamSubmission.findMany({
      where: {
        studentId: { in: studentIds },
      },
      orderBy: { submittedAt: 'desc' },
    });

    let syncCount = 0;

    await prisma.$transaction(async (tx: any) => {
      for (const enroll of enrollments) {
        const sub = submissions.find((s) => s.studentId === enroll.studentId);
        if (!sub || sub.totalMark === null || sub.totalMark === undefined) continue;

        const scaledCbtMark = (Number(sub.totalMark) / 100) * Number(maxScoreBase);
        const roundedCbtMark = Math.round(scaledCbtMark * 10) / 10;

        const existingMark = await tx.mark.findFirst({
          where: {
            studentId: enroll.studentId,
            classId: enroll.classId,
            subjectId: dist.subjectId,
            branchId,
            sessionId,
            ...(examId ? { examId } : {}),
          },
        });

        if (existingMark) {
          await tx.mark.update({
            where: { id: existingMark.id },
            data: {
              cbtMark: String(roundedCbtMark),
            },
          });
        } else {
          await tx.mark.create({
            data: {
              studentId: enroll.studentId,
              classId: enroll.classId,
              sectionId: enroll.sectionId,
              subjectId: dist.subjectId,
              examId: examId || 1,
              sessionId,
              branchId,
              mark: '0',
              cbtMark: String(roundedCbtMark),
              absent: '0',
            },
          });
        }
        syncCount++;
      }
    });

    return res.json({
      success: true,
      syncCount,
      message: `Successfully synchronized CBT scores for ${syncCount} student(s) into official mark register.`,
    });
  } catch (error: any) {
    console.error('[ADMIN] Sync CBT marks error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to sync CBT marks.' });
  }
}

/**
 * POST /api/admin/cbt/sync
 */
export async function syncCbtLegacy(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { examId, maxScoreBase = 40 } = req.body;

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const targetExamId = examId ? Number(examId) : 1;

    const submissions = await prisma.onlineExamSubmission.findMany({
      where: {
        student: { branchId },
      },
      include: {
        onlineExam: { select: { classId: true, subjectId: true } },
        student: { select: { id: true } },
      },
    });

    let syncCount = 0;

    await prisma.$transaction(async (tx: any) => {
      for (const sub of submissions) {
        if (!sub.onlineExam || sub.totalMark === null || sub.totalMark === undefined) continue;

        const classId = sub.onlineExam.classId;
        const subjectId = sub.onlineExam.subjectId;
        const studentId = sub.student.id;

        const scaledCbtMark = (Number(sub.totalMark) / 100) * Number(maxScoreBase);
        const roundedCbtMark = Math.round(scaledCbtMark * 10) / 10;

        const existingMark = await tx.mark.findFirst({
          where: {
            studentId,
            classId,
            subjectId,
            branchId,
            sessionId,
            examId: targetExamId,
          },
        });

        if (existingMark) {
          await tx.mark.update({
            where: { id: existingMark.id },
            data: {
              cbtMark: String(roundedCbtMark),
            },
          });
        } else {
          await tx.mark.create({
            data: {
              studentId,
              classId,
              subjectId,
              examId: targetExamId,
              sessionId,
              branchId,
              mark: '0',
              cbtMark: String(roundedCbtMark),
              absent: '0',
            },
          });
        }
        syncCount++;
      }
    });

    return res.json({
      success: true,
      syncCount,
      message: `Successfully synchronized ${syncCount} CBT test results into academic records.`,
    });
  } catch (error: any) {
    console.error('[ADMIN] Legacy CBT sync error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to sync CBT records.' });
  }
}
