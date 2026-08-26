import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { autoGradeCbtSubmission } from '../../lib/cbtService';
import gamificationService from '../../lib/gamificationService';

/**
 * GET /api/student/cbt/active-exams
 */
export async function getActiveCbtExams(req: Request, res: Response): Promise<Response | void> {
  try {
    const classId = req.classId;
    if (!classId) {
      return res.json({ success: true, exams: [] });
    }

    const onlineExams = await prisma.onlineExam.findMany({
      where: { classId, branchId: req.branchId },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const distributions = await prisma.cbtDistribution.findMany({
      where: {
        classId,
        branchId: req.branchId,
        isPublished: true,
        ...(req.sectionId ? { OR: [{ sectionId: req.sectionId }, { sectionId: null }] } : {}),
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        group: { select: { id: true, title: true, questionIds: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const allExamIds = [...onlineExams.map((e) => e.id), ...distributions.map((d) => d.id)];
    const submissions = await prisma.onlineExamSubmission.findMany({
      where: {
        studentId: req.studentId,
        onlineExamId: { in: allExamIds },
      },
    });
    const subMap: Record<number, any> = {};
    submissions.forEach((s) => {
      subMap[s.onlineExamId] = s;
    });

    const formattedList = [
      ...distributions.map((dist) => {
        const sub = subMap[dist.id];
        const qCount = Array.isArray(dist.group?.questionIds) ? (dist.group.questionIds as any[]).length : 10;
        return {
          id: dist.id,
          sourceType: 'distribution',
          title: dist.title,
          subjectName: dist.subject?.name || 'General Subject',
          subjectCode: dist.subject?.subjectCode || 'CBT',
          duration: dist.duration || 30,
          passingMark: dist.passingMark || 50,
          showResults: dist.showResults,
          questionCount: qCount,
          instructions: dist.instructions || 'Answer all questions within the allocated time limit.',
          isSubmitted: Boolean(sub && sub.submittedAt),
          totalMark: sub?.totalMark !== null && sub?.totalMark !== undefined ? sub.totalMark : null,
          startedAt: sub?.startedAt || null,
          submittedAt: sub?.submittedAt || null,
        };
      }),
      ...onlineExams.map((ex) => {
        const sub = subMap[ex.id];
        const questions = Array.isArray(ex.questions) ? ex.questions : [];
        return {
          id: ex.id,
          sourceType: 'online_exam',
          title: ex.title,
          subjectName: ex.subject?.name || 'General Subject',
          subjectCode: ex.subject?.subjectCode || 'CBT',
          duration: ex.duration || 30,
          passingMark: ex.passingMark || 50,
          showResults: true,
          questionCount: questions.length,
          instructions: 'Standard CBT online examination.',
          isSubmitted: Boolean(sub && sub.submittedAt),
          totalMark: sub?.totalMark !== null && sub?.totalMark !== undefined ? sub.totalMark : null,
          startedAt: sub?.startedAt || null,
          submittedAt: sub?.submittedAt || null,
        };
      }),
    ];

    return res.json({
      success: true,
      exams: formattedList,
    });
  } catch (error) {
    console.error('[STUDENT] Active CBT exams error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load active CBT exams.' });
  }
}

/**
 * GET /api/student/cbt/exams/:id/take
 */
export async function takeCbtExam(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const examId = Number(id);

  try {
    let examTitle = 'CBT Examination';
    let duration = 30;
    let passingMark = 50;
    let instructions = '';
    let shuffleQuestions = true;
    let showResults = true;
    let rawQuestions: any[] = [];
    let targetOnlineExamId = examId;

    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: examId },
      include: {
        subject: { select: { name: true } },
        group: true,
      },
    });

    if (dist) {
      examTitle = dist.title;
      duration = dist.duration || 30;
      passingMark = dist.passingMark || 50;
      instructions = dist.instructions || '';
      shuffleQuestions = dist.shuffleQuestions;
      showResults = dist.showResults;

      if (dist.group && Array.isArray(dist.group.questionIds) && dist.group.questionIds.length > 0) {
        rawQuestions = await prisma.questionBank.findMany({
          where: { id: { in: (dist.group.questionIds as any[]).map(Number) } },
        });
      } else {
        rawQuestions = await prisma.questionBank.findMany({
          where: { branchId: req.branchId, subjectId: dist.subjectId },
          take: 20,
        });
      }

      let onlineEx = await prisma.onlineExam.findFirst({
        where: {
          title: dist.title,
          classId: dist.classId,
          subjectId: dist.subjectId,
          branchId: req.branchId,
        },
      });
      if (!onlineEx) {
        onlineEx = await prisma.onlineExam.create({
          data: {
            title: dist.title,
            classId: dist.classId,
            subjectId: dist.subjectId,
            duration: dist.duration,
            passingMark: dist.passingMark,
            questions: rawQuestions,
            branchId: req.branchId,
            sessionId: req.sessionId || 5,
            examDate: dist.startDate || new Date(),
          },
        });
      }
      targetOnlineExamId = onlineEx.id;
    } else {
      const onlineExam = await prisma.onlineExam.findUnique({
        where: { id: examId },
        include: { subject: { select: { name: true } } },
      });

      if (!onlineExam) {
        return res.status(404).json({ success: false, message: 'CBT examination not found.' });
      }

      examTitle = onlineExam.title;
      duration = onlineExam.duration || 30;
      passingMark = onlineExam.passingMark || 50;
      rawQuestions = Array.isArray(onlineExam.questions) ? (onlineExam.questions as any[]) : [];
      targetOnlineExamId = onlineExam.id;
    }

    let submission = await prisma.onlineExamSubmission.findFirst({
      where: { onlineExamId: targetOnlineExamId, studentId: req.studentId },
    });

    if (submission && (submission.submittedAt || submission.totalMark !== null)) {
      return res.status(400).json({
        success: false,
        message: 'You have already completed and submitted this examination.',
      });
    }

    if (!submission) {
      submission = await prisma.onlineExamSubmission.create({
        data: {
          onlineExamId: targetOnlineExamId,
          studentId: req.studentId,
          startedAt: new Date(),
          totalMark: null,
        },
      });
    }

    let orderedQuestions = [...rawQuestions];
    if (shuffleQuestions) {
      for (let i = orderedQuestions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [orderedQuestions[i], orderedQuestions[j]] = [orderedQuestions[j], orderedQuestions[i]];
      }
    }

    const sanitizedQuestions = orderedQuestions.map((q, idx) => ({
      id: q.id !== undefined ? q.id : idx,
      questionText: q.questionText || q.question || `Question ${idx + 1}`,
      questionType: q.questionType || q.type || 'mcq',
      options: Array.isArray(q.options) ? q.options : ['A', 'B', 'C', 'D'],
      marks: Number(q.marks || q.points || 1.0),
    }));

    return res.json({
      success: true,
      exam: {
        id: examId,
        onlineExamId: targetOnlineExamId,
        title: examTitle,
        duration,
        passingMark,
        instructions,
        showResults,
        startedAt: submission.startedAt,
        questions: sanitizedQuestions,
      },
    });
  } catch (error) {
    console.error('[STUDENT] Take CBT exam error:', error);
    return res.status(500).json({ success: false, message: 'Failed to launch CBT examination.' });
  }
}

/**
 * POST /api/student/cbt/exams/:id/submit
 */
export async function submitCbtExam(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const examId = Number(id);
  const { answers = [] } = req.body;

  try {
    let rawQuestions: any[] = [];
    let passingMark = 50;
    let showResults = true;
    let targetOnlineExamId = examId;

    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: examId },
      include: { group: true },
    });

    if (dist) {
      passingMark = dist.passingMark || 50;
      showResults = dist.showResults;
      if (dist.group && Array.isArray(dist.group.questionIds) && dist.group.questionIds.length > 0) {
        rawQuestions = await prisma.questionBank.findMany({
          where: { id: { in: (dist.group.questionIds as any[]).map(Number) } },
        });
      } else {
        rawQuestions = await prisma.questionBank.findMany({
          where: { branchId: req.branchId, subjectId: dist.subjectId },
          take: 20,
        });
      }

      const onlineEx = await prisma.onlineExam.findFirst({
        where: {
          title: dist.title,
          classId: dist.classId,
          subjectId: dist.subjectId,
          branchId: req.branchId,
        },
      });
      if (onlineEx) {
        targetOnlineExamId = onlineEx.id;
      }
    } else {
      const onlineExam = await prisma.onlineExam.findUnique({
        where: { id: examId },
      });
      if (!onlineExam) {
        return res.status(404).json({ success: false, message: 'CBT examination not found.' });
      }
      passingMark = onlineExam.passingMark || 50;
      rawQuestions = Array.isArray(onlineExam.questions) ? (onlineExam.questions as any[]) : [];
      targetOnlineExamId = onlineExam.id;
    }

    const existing = await prisma.onlineExamSubmission.findFirst({
      where: {
        studentId: req.studentId,
        OR: [{ onlineExamId: targetOnlineExamId }, { onlineExamId: examId }],
      },
    });

    if (!existing) {
      return res.status(400).json({ success: false, message: 'No active attempt found for this examination.' });
    }

    if (existing.submittedAt !== null && existing.totalMark !== null) {
      return res.status(400).json({ success: false, message: 'You have already submitted this exam.' });
    }

    const grading = autoGradeCbtSubmission({
      questions: rawQuestions,
      studentAnswers: answers,
      passingPercentage: passingMark,
    });

    const updated = await prisma.onlineExamSubmission.update({
      where: { id: existing.id },
      data: {
        answers,
        totalMark: grading.percentage,
        submittedAt: new Date(),
      },
    });

    gamificationService
      .checkOnlineExamPerformance(prisma, req.studentId, updated.id, req.branchId)
      .catch((err: any) => console.error('[Gamification] Error in CBT performance reward:', err.message));

    return res.json({
      success: true,
      message: 'CBT examination submitted and auto-graded successfully!',
      result: {
        totalScore: grading.totalScore,
        totalPossible: grading.totalPossible,
        percentage: grading.percentage,
        grade: grading.grade,
        isPassed: grading.isPassed,
        correctCount: grading.correctCount,
        wrongCount: grading.wrongCount,
        unansweredCount: grading.unansweredCount,
        showResults,
        breakdown: showResults ? grading.breakdown : [],
      },
    });
  } catch (error: any) {
    console.error('[STUDENT] CBT Exam submission error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to submit CBT exam.' });
  }
}
