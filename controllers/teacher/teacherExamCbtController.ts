import { Request, Response } from 'express';
import prisma from '../../lib/prisma';

/**
 * GET /api/teacher/online-exams
 */
export async function getOnlineExams(req: Request, res: Response): Promise<Response | void> {
  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const exams = await prisma.onlineExam.findMany({
      where: {
        ...(req.branchId ? { branchId: req.branchId } : {}),
      },
      include: {
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
        submissions: {
          select: { id: true, totalMark: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, exams });
  } catch (error) {
    console.error('[TEACHER] Get online-exams error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve online exams.' });
  }
}

/**
 * POST /api/teacher/online-exams
 */
export async function createOnlineExam(req: Request, res: Response): Promise<Response | void> {
  const { title, classId, subjectId, passingMark, questions, duration, examDate } = req.body;
  if (!title || !classId || !subjectId) {
    return res.status(400).json({ success: false, message: 'Title, Class, and Subject are required.' });
  }
  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const exam = await prisma.onlineExam.create({
      data: {
        title,
        classId: Number(classId),
        subjectId: Number(subjectId),
        passingMark: passingMark !== undefined ? Number(passingMark) : 0,
        duration: duration !== undefined ? Number(duration) : 0,
        questions: questions || [],
        examDate: examDate ? new Date(examDate) : null,
        branchId: req.branchId,
        sessionId,
      },
    });
    return res.json({ success: true, exam, message: 'Online exam published successfully.' });
  } catch (error) {
    console.error('[TEACHER] Create online exam error:', error);
    return res.status(500).json({ success: false, message: 'Failed to publish online exam.' });
  }
}

/**
 * GET /api/teacher/question-bank
 */
export async function getQuestionBank(req: Request, res: Response): Promise<Response | void> {
  const { subjectId, classId } = req.query;
  try {
    const whereClause: any = {
      branchId: req.branchId,
    };
    if (subjectId) {
      whereClause.subjectId = Number(subjectId);
    }
    if (classId) {
      whereClause.classId = Number(classId);
    }

    const items = await prisma.questionBank.findMany({
      where: whereClause,
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, items });
  } catch (error) {
    console.error('[TEACHER] Get question-bank error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve Question Bank items.' });
  }
}

/**
 * POST /api/teacher/question-bank
 */
export async function createQuestionBankItem(req: Request, res: Response): Promise<Response | void> {
  const { questionText, questionType, options, correctOption, marks, subjectId, classId } = req.body;
  if (!questionText || !subjectId) {
    return res.status(400).json({ success: false, message: 'Question text and Subject are required.' });
  }
  try {
    const item = await prisma.questionBank.create({
      data: {
        questionText,
        questionType: questionType || 'mcq',
        options: options || null,
        correctOption: correctOption || null,
        marks: marks !== undefined ? Number(marks) : 1.0,
        subjectId: Number(subjectId),
        classId: classId ? Number(classId) : null,
        branchId: req.branchId,
      },
    });
    return res.json({ success: true, item, message: 'Question saved to Question Bank successfully.' });
  } catch (error) {
    console.error('[TEACHER] Create question-bank item error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save question to bank.' });
  }
}

/**
 * PUT /api/teacher/question-bank/:id
 */
export async function updateQuestionBankItem(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const { questionText, questionType, options, correctOption, marks, subjectId, classId } = req.body;
  try {
    const item = await prisma.questionBank.update({
      where: { id: Number(id) },
      data: {
        questionText,
        questionType,
        options,
        correctOption,
        marks: marks !== undefined ? Number(marks) : undefined,
        subjectId: subjectId ? Number(subjectId) : undefined,
        classId: classId ? Number(classId) : null,
      },
    });
    return res.json({ success: true, item, message: 'Question updated successfully.' });
  } catch (error) {
    console.error('[TEACHER] Update question-bank item error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update question.' });
  }
}

/**
 * DELETE /api/teacher/question-bank/:id
 */
export async function deleteQuestionBankItem(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  try {
    await prisma.questionBank.delete({
      where: { id: Number(id) },
    });
    return res.json({ success: true, message: 'Question removed from bank.' });
  } catch (error) {
    console.error('[TEACHER] Delete question-bank item error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete question.' });
  }
}

/**
 * POST /api/teacher/online-exams/distribute
 */
export async function distributeOnlineExam(req: Request, res: Response): Promise<Response | void> {
  const { examId, title, subjectId, passingMark, duration, questions, classIds, examDate } = req.body;
  if (!classIds || !Array.isArray(classIds) || classIds.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one target class is required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    let finalTitle = title;
    let finalSubjectId = Number(subjectId);
    let finalPassingMark = passingMark !== undefined ? Number(passingMark) : 0;
    let finalDuration = duration !== undefined ? Number(duration) : 0;
    let finalQuestions = questions || [];
    let finalExamDate = examDate ? new Date(examDate) : null;

    if (examId) {
      const existingExam = await prisma.onlineExam.findUnique({
        where: { id: Number(examId) },
      });
      if (!existingExam) {
        return res.status(404).json({ success: false, message: 'Source exam not found.' });
      }
      finalTitle = existingExam.title;
      finalSubjectId = existingExam.subjectId;
      finalPassingMark = existingExam.passingMark;
      finalDuration = existingExam.duration;
      finalQuestions = existingExam.questions;
      finalExamDate = examDate ? new Date(examDate) : existingExam.examDate;
    }

    if (!finalTitle || !finalSubjectId) {
      return res.status(400).json({ success: false, message: 'Exam title and Subject are required.' });
    }

    const createdExams = [];
    for (const cid of classIds) {
      const created = await prisma.onlineExam.create({
        data: {
          title: finalTitle,
          classId: Number(cid),
          subjectId: finalSubjectId,
          passingMark: finalPassingMark,
          duration: finalDuration,
          questions: finalQuestions,
          examDate: finalExamDate,
          branchId: req.branchId,
          sessionId,
        },
      });
      createdExams.push(created);
    }

    return res.json({
      success: true,
      message: `Exam successfully distributed to ${classIds.length} classes.`,
      examsCount: createdExams.length,
    });
  } catch (error) {
    console.error('[TEACHER] Distribute exam error:', error);
    return res.status(500).json({ success: false, message: 'Failed to distribute exam.' });
  }
}

/**
 * GET /api/teacher/online-exams/:id/submissions
 */
export async function getOnlineExamSubmissions(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  try {
    const submissions = await prisma.onlineExamSubmission.findMany({
      where: { onlineExamId: Number(id) },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, submissions });
  } catch (error) {
    console.error('[TEACHER] Get online-exam submissions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve submissions.' });
  }
}

/**
 * POST /api/teacher/online-exams/submissions/:id/grade
 */
export async function gradeOnlineExamSubmission(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const { score } = req.body;
  try {
    const submission = await prisma.onlineExamSubmission.update({
      where: { id: Number(id) },
      data: {
        totalMark: Number(score),
      },
    });
    return res.json({ success: true, submission, message: 'Submission graded successfully.' });
  } catch (error) {
    console.error('[TEACHER] Grade online-exam submission error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save grade.' });
  }
}

/**
 * PUT /api/teacher/online-exams/:id
 */
export async function updateOnlineExam(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const { title, passingMark, duration, examDate } = req.body;
  try {
    const exam = await prisma.onlineExam.update({
      where: { id: Number(id) },
      data: {
        title,
        passingMark: passingMark !== undefined ? Number(passingMark) : undefined,
        duration: duration !== undefined ? Number(duration) : undefined,
        examDate: examDate ? new Date(examDate) : null,
      },
    });
    return res.json({ success: true, exam, message: 'Online exam updated successfully.' });
  } catch (error) {
    console.error('[TEACHER] Update online exam error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update online exam.' });
  }
}

/**
 * DELETE /api/teacher/online-exams/:id
 */
export async function deleteOnlineExam(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  try {
    await prisma.onlineExamSubmission.deleteMany({
      where: { onlineExamId: Number(id) },
    });
    await prisma.onlineExam.delete({
      where: { id: Number(id) },
    });
    return res.json({ success: true, message: 'Online exam deleted successfully.' });
  } catch (error) {
    console.error('[TEACHER] Delete online exam error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete online exam.' });
  }
}
