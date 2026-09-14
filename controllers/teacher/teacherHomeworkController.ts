import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';
import { canTeacherUseClassSubject, teacherScopedContentOr } from '../../lib/teacherAccess';
import { mapQuestionBankWrite } from '../../lib/questionDraftService';
import { snapshotFromBank } from '../admin/adminHomeworkController';

/**
 * GET /api/teacher/homeworks
 */
export async function getHomeworks(req: Request, res: Response): Promise<Response | void> {
  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;
    const scopedOr = await teacherScopedContentOr(prisma, req.teacherId);

    const homeworks = await prisma.homework.findMany({
      where: {
        branchId: req.branchId,
        sessionId,
        OR: [
          ...(req.teacherId ? [{ createdById: req.teacherId, createdByRole: 'TEACHER' }] : []),
          ...scopedOr,
        ],
      },
      include: {
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, homeworks });
  } catch (error) {
    console.error('[TEACHER] Get homeworks error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve homeworks.' });
  }
}

/**
 * POST /api/teacher/homeworks
 */
export async function createHomework(req: Request, res: Response): Promise<Response | void> {
  const { title, description, classId, subjectId, dueDate, questions, questionBankIds, termName } = req.body;
  if (!title || !classId || !subjectId || !dueDate) {
    return res.status(400).json({ success: false, message: 'Title, Class, Subject, and Due Date are required.' });
  }

  const allowed = await canTeacherUseClassSubject(prisma, req.teacherId, classId, subjectId);
  if (!allowed) {
    return res.status(403).json({
      success: false,
      message: 'You can only assign homework to your authorised class and subject.',
    });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;
    let ids = (Array.isArray(questionBankIds) ? questionBankIds : [])
      .map(Number)
      .filter(Boolean);

    if (!ids.length && Array.isArray(questions) && questions.length) {
      for (const q of questions) {
        const existingId = Number(q.id);
        if (Number.isInteger(existingId) && existingId > 0) {
          ids.push(existingId);
          continue;
        }
        const item = await prisma.questionBank.create({
          data: mapQuestionBankWrite(
            {
              questionText: q.questionText,
              questionType: q.questionType || (q.type === 'MCQ' ? 'mcq' : 'theory'),
              options: q.options,
              correctOption: q.correctOption || q.correctAnswer,
              marks: q.marks || q.points,
              subjectId,
              classId,
              termName,
              topic: q.topic,
              sourceType: q.id ? 'BANK' : 'MANUAL',
            },
            {
              branchId: req.branchId,
              sessionId,
              createdById: req.teacherId,
              createdByRole: 'TEACHER',
            }
          ),
        });
        ids.push(item.id);
      }
    }

    if (!ids.length) {
      return res.status(400).json({
        success: false,
        message: 'Save questions to the Question Bank before assigning homework.',
      });
    }

    const { questions: snapshot, items } = await snapshotFromBank(ids, req.branchId);
    if (items.length !== ids.length) {
      return res.status(400).json({
        success: false,
        message: 'Only reviewed and approved Question Bank items can be assigned. Save drafts first.',
      });
    }
    const mismatched = items.find(
      (item) => item.subjectId !== Number(subjectId) || (item.classId && item.classId !== Number(classId))
    );
    if (mismatched) {
      return res.status(400).json({
        success: false,
        message: 'Assigned questions must match this class and subject.',
      });
    }

    const homework = await prisma.homework.create({
      data: {
        title,
        description,
        classId: Number(classId),
        subjectId: Number(subjectId),
        dueDate: new Date(dueDate),
        questions: snapshot,
        questionBankIds: ids,
        termName: termName || items[0]?.termName || null,
        createdById: req.teacherId,
        createdByRole: 'TEACHER',
        branchId: req.branchId,
        sessionId,
      },
      include: {
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
      },
    });

    await prisma.teacherActivity
      .create({
        data: {
          branchId: req.branchId,
          teacherId: req.teacherId,
          activity: `You assigned a new homework: ${title}`,
          type: 'HOMEWORK',
        },
      })
      .catch(() => null);

    return res.json({ success: true, homework, message: 'Homework published successfully.' });
  } catch (error) {
    console.error('[TEACHER] Create homework error:', error);
    return res.status(500).json({ success: false, message: 'Failed to publish homework.' });
  }
}

/**
 * GET /api/teacher/homeworks/:id/submissions
 */
export async function getHomeworkSubmissions(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  try {
    const homework = await prisma.homework.findFirst({
      where: { id: Number(id), branchId: req.branchId },
      select: { id: true, classId: true, subjectId: true, createdById: true, createdByRole: true },
    });
    if (!homework) {
      return res.status(404).json({ success: false, message: 'Homework not found.' });
    }
    const allowed =
      (homework.createdById === req.teacherId && homework.createdByRole === 'TEACHER') ||
      (await canTeacherUseClassSubject(prisma, req.teacherId, homework.classId, homework.subjectId));
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You can only view submissions for your authorised classes.' });
    }
    const submissions = await prisma.homeworkSubmission.findMany({
      where: { homeworkId: Number(id) },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, submissions });
  } catch (error) {
    console.error('[TEACHER] Get homework submissions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve submissions.' });
  }
}

/**
 * POST /api/teacher/homeworks/submissions/:id/grade
 */
export async function gradeHomeworkSubmission(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const { score, feedback } = req.body;
  try {
    const submission = await prisma.homeworkSubmission.update({
      where: { id: Number(id) },
      data: {
        score: score !== undefined ? Number(score) : null,
        feedback: feedback || null,
      },
    });

    gamificationService
      .checkHomeworkGradingTimeliness(prisma, req.teacherId, submission.homeworkId, req.branchId)
      .catch((err: any) => console.error('[Gamification] Error in homework grading trigger:', err.message));

    return res.json({ success: true, submission, message: 'Submission graded successfully.' });
  } catch (error) {
    console.error('[TEACHER] Grade homework submission error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save grade/feedback.' });
  }
}
