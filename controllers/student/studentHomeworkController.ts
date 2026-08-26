import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';

/**
 * POST /api/student/homeworks/:id/submit
 */
export async function submitHomework(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const { answers } = req.body;
  if (!answers || !Array.isArray(answers)) {
    return res.status(400).json({ success: false, message: 'Answers array is required.' });
  }
  try {
    const homework = await prisma.homework.findUnique({
      where: { id: Number(id) },
    });
    if (!homework) {
      return res.status(404).json({ success: false, message: 'Homework assignment not found.' });
    }

    const existing = await prisma.homeworkSubmission.findFirst({
      where: {
        homeworkId: homework.id,
        studentId: req.studentId,
      },
    });
    if (existing) {
      return res.status(400).json({ success: false, message: 'You have already submitted this homework.' });
    }

    const questions = (homework.questions || []) as any[];
    let totalScore = 0;
    let hasManual = false;

    for (const q of questions) {
      const studentAns = answers.find((a: any) => a.questionId === q.id);
      if (q.type === 'MCQ' || q.type === 'TF') {
        if (
          studentAns &&
          String(studentAns.answerText).trim().toLowerCase() === String(q.correctAnswer).trim().toLowerCase()
        ) {
          totalScore += Number(q.points || 1);
        }
      } else if (q.type === 'DOCUMENT' || q.type === 'AUDIO') {
        hasManual = true;
      }
    }

    const submission = await prisma.homeworkSubmission.create({
      data: {
        homeworkId: homework.id,
        studentId: req.studentId,
        answers,
        score: totalScore,
        feedback: hasManual ? 'Pending manual grading for documents/audios.' : 'Auto-graded.',
      },
    });

    gamificationService
      .checkHomeworkSubmissionEarly(prisma, req.studentId, submission.id, req.branchId)
      .catch((err: any) => console.error('[Gamification] Error in early homework submission check:', err.message));

    return res.json({ success: true, submission, message: 'Homework submitted successfully.' });
  } catch (error) {
    console.error('[STUDENT] Homework submission error:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit homework.' });
  }
}
