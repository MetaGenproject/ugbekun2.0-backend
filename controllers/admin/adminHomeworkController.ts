import { Request, Response } from 'express';
import prisma from '../../lib/prisma';

async function snapshotFromBank(ids: number[], branchId?: number) {
  if (!ids.length) return { questions: [], items: [] as any[] };
  const items = await prisma.questionBank.findMany({
    where: {
      id: { in: ids },
      ...(branchId ? { branchId } : {}),
      status: 'APPROVED',
    },
    include: {
      subject: { select: { id: true, name: true } },
      class: { select: { id: true, name: true } },
    },
  });
  const questions = items.map((item) => ({
    id: item.id,
    questionText: item.questionText,
    type: item.questionType === 'mcq' ? 'MCQ' : item.questionType?.toUpperCase() || 'MCQ',
    questionType: item.questionType,
    options: item.options,
    correctAnswer: item.correctOption,
    correctOption: item.correctOption,
    points: item.marks,
    marks: item.marks,
    subjectId: item.subjectId,
    classId: item.classId,
    termName: item.termName,
    topic: item.topic,
  }));
  return { questions, items };
}

export async function getAdminHomeworks(req: Request, res: Response): Promise<Response | void> {
  try {
    const { classId, subjectId, termName } = (req.query || {}) as any;
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;
    const homeworks = await prisma.homework.findMany({
      where: {
        branchId: req.branchId,
        sessionId,
        ...(classId ? { classId: Number(classId) } : {}),
        ...(subjectId ? { subjectId: Number(subjectId) } : {}),
        ...(termName ? { termName: String(termName) } : {}),
      },
      include: {
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
        submissions: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, homeworks });
  } catch (error) {
    console.error('[ADMIN] Get homeworks error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve homeworks.' });
  }
}

export async function createAdminHomework(req: Request, res: Response): Promise<Response | void> {
  const { title, description, classId, subjectId, dueDate, questionBankIds, termName } = req.body || {};
  if (!title || !classId || !subjectId || !dueDate) {
    return res.status(400).json({ success: false, message: 'Title, class, subject, and due date are required.' });
  }

  const ids = (Array.isArray(questionBankIds) ? questionBankIds : []).map(Number).filter(Boolean);
  if (!ids.length) {
    return res.status(400).json({ success: false, message: 'Save questions to the Question Bank before assigning them.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;
    const { questions, items } = await snapshotFromBank(ids, req.branchId);
    if (items.length !== ids.length) {
      return res.status(400).json({ success: false, message: 'Only reviewed and approved Question Bank items can be assigned. Save drafts first.' });
    }

    const mismatched = items.find(
      (item) => item.subjectId !== Number(subjectId) || (item.classId && item.classId !== Number(classId))
    );
    if (mismatched) {
      return res.status(400).json({
        success: false,
        message: 'Every assigned question must belong to the same subject and class as the homework.',
      });
    }

    const homework = await prisma.homework.create({
      data: {
        title: String(title).trim(),
        description: description || null,
        classId: Number(classId),
        subjectId: Number(subjectId),
        dueDate: new Date(dueDate),
        questions,
        questionBankIds: ids,
        termName: termName || items[0]?.termName || null,
        createdById: (req as any).userId || null,
        createdByRole: 'ADMIN',
        branchId: req.branchId,
        sessionId,
      },
      include: {
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
      },
    });

    return res.json({ success: true, homework, message: 'Homework assigned from the Question Bank.' });
  } catch (error) {
    console.error('[ADMIN] Create homework error:', error);
    return res.status(500).json({ success: false, message: 'Failed to assign homework.' });
  }
}

export async function getAdminHomeworkSubmissions(req: Request, res: Response): Promise<Response | void> {
  try {
    const homework = await prisma.homework.findFirst({
      where: { id: Number(req.params.id), branchId: req.branchId },
      select: { id: true },
    });
    if (!homework) {
      return res.status(404).json({ success: false, message: 'Homework not found.' });
    }
    const submissions = await prisma.homeworkSubmission.findMany({
      where: { homeworkId: homework.id },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, submissions });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to retrieve submissions.' });
  }
}

export { snapshotFromBank };
