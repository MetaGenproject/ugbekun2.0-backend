import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { assertTeacherQuestionAccess, canTeacherUseClassSubject, teacherScopedContentOr } from '../../lib/teacherAccess';
import { mapQuestionBankWrite } from '../../lib/questionDraftService';

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
    const distByExam = new Map<number, { startDate: Date | null; endDate: Date | null; shuffleQuestions: boolean; showResults: boolean }>();
    if (exams.length) {
      const dists = await prisma.cbtDistribution.findMany({
        where: {
          branchId: req.branchId,
          onlineExamId: { in: exams.map((e) => e.id) },
        },
        select: { onlineExamId: true, startDate: true, endDate: true, shuffleQuestions: true, showResults: true },
      });
      dists.forEach((d) => {
        if (d.onlineExamId) distByExam.set(d.onlineExamId, d);
      });
    }
    return res.json({
      success: true,
      exams: exams.map((exam) => ({
        ...exam,
        ...(distByExam.get(exam.id) || {}),
      })),
    });
  } catch (error) {
    console.error('[TEACHER] Get online-exams error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve online exams.' });
  }
}

/**
 * POST /api/teacher/online-exams
 */
export async function createOnlineExam(req: Request, res: Response): Promise<Response | void> {
  const { title, classId, subjectId, passingMark, questions, duration, examDate, questionBankIds, startDate, endDate, shuffleQuestions = true, showResults = true, isPublished = true, instructions } = req.body;
  if (!title || !classId || !subjectId) {
    return res.status(400).json({ success: false, message: 'Title, Class, and Subject are required.' });
  }
  const allowed = await canTeacherUseClassSubject(prisma, req.teacherId, classId, subjectId);
  if (!allowed) {
    return res.status(403).json({ success: false, message: 'You can only assign examinations for your authorised class and subject.' });
  }
  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;
    const bankIds = (Array.isArray(questionBankIds) ? questionBankIds : []).map(Number).filter(Boolean);
    let snapshot = Array.isArray(questions) ? questions : [];
    if (bankIds.length) {
      const approved = await prisma.questionBank.findMany({
        where: { id: { in: bankIds }, branchId: req.branchId, status: 'APPROVED' },
      });
      if (approved.length !== bankIds.length) {
        return res.status(400).json({
          success: false,
          message: 'Only reviewed and approved Question Bank items can be assigned to a class.',
        });
      }
      snapshot = approved.map((q) => ({
        id: q.id,
        questionText: q.questionText,
        questionType: q.questionType,
        options: q.options,
        correctOption: q.correctOption,
        marks: q.marks,
      }));
    }
    if (!snapshot.length) {
      return res.status(400).json({ success: false, message: 'Select approved questions from the Question Bank before assigning the examination.' });
    }

    const parsedStart = startDate ? new Date(startDate) : examDate ? new Date(examDate) : new Date();
    const parsedEnd = endDate ? new Date(endDate) : new Date(parsedStart.getTime() + (Number(duration) || 30) * 60 * 1000);
    if (Number.isNaN(parsedStart.getTime()) || Number.isNaN(parsedEnd.getTime()) || parsedEnd <= parsedStart) {
      return res.status(400).json({ success: false, message: 'Provide a valid sitting window. Closes must be after Opens.' });
    }

    const totalMarks = snapshot.reduce((sum: number, q: any) => sum + Number(q.marks || 1), 0);
    const group = await prisma.questionGroup.create({
      data: {
        branchId: req.branchId,
        title: `${String(title).trim()} paper`,
        groupCode: `TCH-${Date.now().toString().slice(-6)}`,
        subjectId: Number(subjectId),
        classId: Number(classId),
        questionIds: bankIds.length ? bankIds : snapshot.map((q: any) => q.id).filter(Boolean),
        totalMarks,
      },
    });

    const exam = await prisma.onlineExam.create({
      data: {
        title,
        classId: Number(classId),
        subjectId: Number(subjectId),
        passingMark: passingMark !== undefined ? Number(passingMark) : 50,
        duration: duration !== undefined ? Number(duration) : 30,
        questions: snapshot,
        examDate: parsedStart,
        branchId: req.branchId,
        sessionId,
      },
    });

    const dist = await prisma.cbtDistribution.create({
      data: {
        branchId: req.branchId,
        title: String(title).trim(),
        instructions: instructions ? String(instructions).trim() : null,
        duration: Number(duration) || 30,
        passingMark: passingMark !== undefined ? Number(passingMark) : 50,
        isPublished: Boolean(isPublished),
        shuffleQuestions: Boolean(shuffleQuestions),
        showResults: Boolean(showResults),
        groupId: group.id,
        classId: Number(classId),
        subjectId: Number(subjectId),
        startDate: parsedStart,
        endDate: parsedEnd,
        onlineExamId: exam.id,
      },
    });

    return res.json({
      success: true,
      exam,
      distribution: dist,
      message: 'CBT sitting assigned. Students can take this paper in the scheduled window.',
    });
  } catch (error) {
    console.error('[TEACHER] Create online exam error:', error);
    return res.status(500).json({ success: false, message: 'Failed to publish online exam.' });
  }
}

/**
 * GET /api/teacher/question-bank
 */
export async function getQuestionBank(req: Request, res: Response): Promise<Response | void> {
  const { subjectId, classId, termName } = req.query;
  try {
    const whereClause: any = {
      branchId: req.branchId,
      OR: await teacherScopedContentOr(prisma, req.teacherId),
    };
    if (subjectId) whereClause.subjectId = Number(subjectId);
    if (classId) whereClause.classId = Number(classId);
    if (termName) whereClause.termName = String(termName);
    if (req.query.questionType) whereClause.questionType = String(req.query.questionType);
    if (req.query.sourceType) whereClause.sourceType = String(req.query.sourceType);
    if (req.query.status) whereClause.status = String(req.query.status);

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
  const { questionText, subjectId, classId } = req.body;
  if (!questionText || !subjectId || !classId) {
    return res.status(400).json({ success: false, message: 'Question text, class, and subject are required so the item can be classified in the Question Bank.' });
  }
  const allowed = await canTeacherUseClassSubject(prisma, req.teacherId, classId, subjectId);
  if (!allowed) {
    return res.status(403).json({ success: false, message: 'You can only bank questions for your authorised class and subject.' });
  }
  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const item = await prisma.questionBank.create({
      data: mapQuestionBankWrite(req.body, {
        branchId: req.branchId,
        sessionId: globalSetting?.sessionId || null,
        createdById: req.teacherId,
        createdByRole: 'TEACHER',
      }),
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } },
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
    const existing = await prisma.questionBank.findUnique({ where: { id: Number(id) } });
    const allowed = await assertTeacherQuestionAccess(prisma, req.teacherId, existing, req.branchId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You can only edit questions for your authorised class and subject.' });
    }
    if (classId && subjectId) {
      const nextAllowed = await canTeacherUseClassSubject(prisma, req.teacherId, classId, subjectId);
      if (!nextAllowed) {
        return res.status(403).json({ success: false, message: 'You cannot move this question to a class or subject you are not assigned to.' });
      }
    }
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
        ...(req.body.termName !== undefined ? { termName: req.body.termName || null } : {}),
        ...(req.body.topic !== undefined ? { topic: req.body.topic || null } : {}),
        ...(req.body.difficulty !== undefined ? { difficulty: req.body.difficulty } : {}),
        ...(req.body.category !== undefined ? { category: req.body.category || null } : {}),
        ...(req.body.sourceType !== undefined ? { sourceType: req.body.sourceType || null } : {}),
        ...(req.body.status !== undefined ? { status: req.body.status } : {}),
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
    const existing = await prisma.questionBank.findUnique({ where: { id: Number(id) } });
    const allowed = await assertTeacherQuestionAccess(prisma, req.teacherId, existing, req.branchId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You can only delete questions for your authorised class and subject.' });
    }
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
