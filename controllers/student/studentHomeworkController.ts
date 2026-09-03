import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';

function parseQuestions(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parseQuestions(parsed);
    } catch {
      return [];
    }
  }
  if (typeof raw === 'object' && Array.isArray((raw as any).questions)) {
    return (raw as any).questions;
  }
  return [];
}

/**
 * POST /api/student/homeworks/:id/submit
 */
export async function submitHomework(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const { answers, notes } = req.body;
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

    const questions = parseQuestions(homework.questions);
    let totalScore = 0;
    let maxPossibleScore = 0;
    let hasManual = false;

    const formattedAnswers = Array.isArray(answers) ? answers : [];

    if (questions.length > 0) {
      for (const q of questions) {
        const qPoints = Number(q.points || q.marks || 1);
        maxPossibleScore += qPoints;

        const studentAns = formattedAnswers.find((a: any) => String(a.questionId) === String(q.id));
        const typeUpper = String(q.type || q.questionType || '').toUpperCase();

        if (typeUpper === 'MCQ' || typeUpper === 'TF') {
          const expected = String(q.correctAnswer || q.correctOption || '').trim().toLowerCase();
          const actual = String(studentAns?.answerText || '').trim().toLowerCase();

          if (actual && expected && actual === expected) {
            totalScore += qPoints;
          }
        } else {
          hasManual = true;
        }
      }
    } else {
      hasManual = true;
    }

    const submission = await prisma.homeworkSubmission.create({
      data: {
        homeworkId: homework.id,
        studentId: req.studentId,
        answers: formattedAnswers.length > 0 ? formattedAnswers : [{ notes: notes || 'Submitted' }],
        score: hasManual ? null : totalScore,
        feedback: hasManual ? 'Pending teacher review & grading.' : `Auto-graded: ${totalScore}/${maxPossibleScore}`,
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

/**
 * GET /api/student/homeworks/:id
 */
export async function getHomeworkDetail(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  try {
    const homework = await prisma.homework.findUnique({
      where: { id: Number(id) },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } },
        submissions: {
          where: { studentId: req.studentId },
          select: { id: true, answers: true, score: true, feedback: true, createdAt: true },
        },
      },
    });

    if (!homework) {
      return res.status(404).json({ success: false, message: 'Homework assignment not found.' });
    }

    const submission = homework.submissions[0] || null;
    const questions = parseQuestions(homework.questions);

    return res.json({
      success: true,
      homework: {
        id: homework.id,
        title: homework.title,
        description: homework.description,
        subjectName: homework.subject?.name || 'General',
        className: homework.class?.name || '',
        dueDate: homework.dueDate,
        questions,
        submitted: !!submission,
        score: submission?.score ?? null,
        submissionScore: submission?.score ?? null,
        submissionStatus: submission ? (submission.score !== null ? 'GRADED' : 'SUBMITTED') : 'PENDING',
        feedback: submission?.feedback || null,
        submission,
      },
    });
  } catch (error) {
    console.error('[STUDENT] Get homework detail error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve homework details.' });
  }
}
