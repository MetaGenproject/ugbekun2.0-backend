import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';

/**
 * GET /api/teacher/homeworks
 */
export async function getHomeworks(req: Request, res: Response): Promise<Response | void> {
  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const homeworks = await prisma.homework.findMany({
      where: {
        branchId: req.branchId,
        sessionId,
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
  const { title, description, classId, subjectId, dueDate, questions } = req.body;
  if (!title || !classId || !subjectId || !dueDate) {
    return res.status(400).json({ success: false, message: 'Title, Class, Subject, and Due Date are required.' });
  }
  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const homework = await prisma.homework.create({
      data: {
        title,
        description,
        classId: Number(classId),
        subjectId: Number(subjectId),
        dueDate: new Date(dueDate),
        questions: questions || [],
        branchId: req.branchId,
        sessionId,
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
