import { findCompanionOnlineExam } from '../../lib/cbtCompanionExam';
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

    const whereClause: any = {
      ...(req.branchId ? { branchId: req.branchId } : {}),
    };
    if (req.teacherId) {
      whereClause.OR = await teacherScopedContentOr(prisma, req.teacherId);
    }

    const exams = await prisma.onlineExam.findMany({
      where: whereClause,
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

import { recordCbtPercentageOnMarksheet, DEFAULT_CBT_SCALE, resolveActiveSessionId, resolveTermExamId } from '../../lib/cbtMarkRecord';

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
      include: {
        onlineExam: true,
      },
    });

    if (submission && submission.onlineExam) {
      const branchId = req.branchId || submission.onlineExam.branchId;
      if (branchId) {
        await recordCbtPercentageOnMarksheet({
          studentId: submission.studentId,
          classId: submission.onlineExam.classId,
          subjectId: submission.onlineExam.subjectId,
          branchId,
          percentage: Number(score),
          source: 'CBT_SYNC',
          submissionId: submission.id,
          scale: DEFAULT_CBT_SCALE,
        }).catch((e) => console.error('[TEACHER] gradeOnlineExam marksheet sync error:', e));
      }
    }

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
  const {
    title,
    passingMark,
    duration,
    examDate,
    startDate,
    endDate,
    shuffleQuestions,
    showResults,
    classId,
    subjectId,
  } = req.body;
  try {
    const exam = await prisma.onlineExam.update({
      where: { id: Number(id) },
      data: {
        title: title !== undefined ? String(title).trim() : undefined,
        passingMark: passingMark !== undefined && passingMark !== '' ? Number(passingMark) : undefined,
        duration: duration !== undefined && duration !== '' ? Number(duration) : undefined,
        examDate: examDate ? new Date(examDate) : undefined,
        classId: classId ? Number(classId) : undefined,
        subjectId: subjectId ? Number(subjectId) : undefined,
      },
    });

    // Also update any linked CbtDistribution records so student portal and admin portal stay synced
    await prisma.cbtDistribution.updateMany({
      where: { onlineExamId: Number(id) },
      data: {
        title: title !== undefined ? String(title).trim() : undefined,
        passingMark: passingMark !== undefined && passingMark !== '' ? Number(passingMark) : undefined,
        duration: duration !== undefined && duration !== '' ? Number(duration) : undefined,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        shuffleQuestions: shuffleQuestions !== undefined ? Boolean(shuffleQuestions) : undefined,
        showResults: showResults !== undefined ? Boolean(showResults) : undefined,
        classId: classId ? Number(classId) : undefined,
        subjectId: subjectId ? Number(subjectId) : undefined,
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


/**
 * POST /api/teacher/cbt/distributions/:id/extend-date
 * POST /api/teacher/cbt/distributions/:id/reschedule
 * Allows the teacher in charge of the subject/class to extend the CBT sitting deadline.
 */
export async function extendCbtDistributionDate(req: Request, res: Response): Promise<Response | void> {
  const distId = Number(req.params.id);
  const { startDate, endDate } = req.body;

  if (!startDate || !endDate) {
    return res.status(400).json({ success: false, message: 'New start and end dates/times are required.' });
  }

  const parsedStart = new Date(startDate);
  const parsedEnd = new Date(endDate);
  if (isNaN(parsedStart.getTime()) || isNaN(parsedEnd.getTime())) {
    return res.status(400).json({ success: false, message: 'Invalid date/time provided.' });
  }
  if (parsedEnd <= parsedStart) {
    return res.status(400).json({ success: false, message: 'End date/time must be after the start date/time.' });
  }

  try {
    const existing = await prisma.cbtDistribution.findFirst({
      where: { id: distId, branchId: req.branchId },
      include: { class: true, subject: true },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'CBT examination not found.' });
    }

    // Verify teacher has access to this subject and class if teacherId exists
    const teacherId = (req as any).teacherId || (req as any).user?.teacherId;
    if (teacherId) {
      const allowed = await canTeacherUseClassSubject(prisma, teacherId, existing.classId, existing.subjectId);
      if (!allowed) {
        return res.status(403).json({ success: false, message: 'You can only extend dates for subjects assigned to you.' });
      }
    }

    const updated = await prisma.cbtDistribution.update({
      where: { id: distId },
      data: {
        startDate: parsedStart,
        endDate: parsedEnd,
      },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        group: { select: { id: true, title: true, groupCode: true } },
      },
    });

    // Also update companion online exam if present
    const companion = await findCompanionOnlineExam(existing);
    if (companion) {
      await prisma.onlineExam.update({
        where: { id: companion.id },
        data: { examDate: parsedStart },
      });
    }

    return res.json({
      success: true,
      message: 'CBT assessment sitting deadline extended successfully. Students can now take this examination.',
      distribution: updated,
    });
  } catch (error) {
    console.error('[TEACHER] Extend CBT distribution date error:', error);
    return res.status(500).json({ success: false, message: 'Failed to extend examination deadline.' });
  }
}

/**
 * GET /api/teacher/cbt/distributions/:id/analytics
 */
export async function getTeacherCbtDistributionAnalytics(req: Request, res: Response): Promise<Response | void> {
  const teacherId = req.teacherId;
  const branchId = req.branchId;
  const distId = Number(req.params.id);

  try {
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

    if (teacherId) {
      const allowed = await canTeacherUseClassSubject(prisma, teacherId, dist.classId, dist.subjectId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'Accessed can not be granted meet Admin for the priveleges..',
        });
      }
    }

    const effectiveBranchId = branchId || dist.branchId;

    let questions: any[] = [];
    if (dist.group && Array.isArray(dist.group.questionIds) && dist.group.questionIds.length > 0) {
      questions = await prisma.questionBank.findMany({
        where: { id: { in: (dist.group.questionIds as any[]).map(Number) }, status: 'APPROVED' },
      });
    } else {
      questions = await prisma.questionBank.findMany({
        where: { branchId: effectiveBranchId, subjectId: dist.subjectId, status: 'APPROVED' },
        take: 20,
      });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const enrollWhere: any = {
      classId: dist.classId,
      branchId: effectiveBranchId,
      sessionId,
    };
    if (dist.sectionId) enrollWhere.sectionId = dist.sectionId;

    let enrollments = await prisma.enroll.findMany({
      where: enrollWhere,
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true, active: true } },
      },
    });

    if (enrollments.length === 0) {
      enrollments = await prisma.enroll.findMany({
        where: {
          classId: dist.classId,
          ...(dist.sectionId ? { sectionId: dist.sectionId } : {}),
          ...(effectiveBranchId ? { branchId: effectiveBranchId } : {}),
          isAlumni: 0,
        },
        include: {
          student: { select: { id: true, firstName: true, lastName: true, registerNo: true, active: true } },
        },
      });
    }

    const companion = await findCompanionOnlineExam(dist);
    const examIdsToMatch = Array.from(
      new Set([companion?.id, dist.onlineExamId, dist.id].filter((x): x is number => typeof x === 'number' && x > 0))
    );

    const submissions = examIdsToMatch.length > 0
      ? await prisma.onlineExamSubmission.findMany({
          where: {
            onlineExamId: { in: examIdsToMatch },
          },
          include: {
            student: { select: { id: true, firstName: true, lastName: true, registerNo: true, active: true } },
          },
          orderBy: { submittedAt: 'desc' },
        })
      : [];

    const activeStudents = enrollments.filter((e) => e.student && e.student.active);
    const seenStudentIds = new Set(activeStudents.map((e) => e.student.id));

    for (const sub of submissions) {
      if (sub.student && !seenStudentIds.has(sub.student.id)) {
        seenStudentIds.add(sub.student.id);
        activeStudents.push({
          student: sub.student,
          classId: dist.classId,
          sectionId: dist.sectionId,
        } as any);
      }
    }

    const studentIds = activeStudents.map((e) => e.student.id);

    const markRows =
      studentIds.length > 0
        ? await prisma.mark.findMany({
            where: {
              subjectId: dist.subjectId,
              classId: dist.classId,
              ...(effectiveBranchId ? { branchId: effectiveBranchId } : {}),
              studentId: { in: studentIds },
            },
            select: {
              studentId: true,
              cbtMark: true,
              cbtSource: true,
              cbtScale: true,
            },
            orderBy: { id: 'desc' },
          })
        : [];
    const markByStudent: Record<number, (typeof markRows)[number]> = {};
    markRows.forEach((row) => {
      if (!markByStudent[row.studentId]) {
        markByStudent[row.studentId] = row;
      }
    });

    const studentRoster = activeStudents.map((e) => {
      const st = e.student;
      const sub = submissions.find((s) => s.studentId === st.id);
      const recorded = markByStudent[st.id];
      return {
        studentId: st.id,
        studentName: `${st.lastName}, ${st.firstName}`,
        registerNo: st.registerNo || 'Pending',
        isSubmitted: Boolean(sub && (sub.submittedAt || sub.totalMark !== null)),
        totalMark: sub?.totalMark !== null && sub?.totalMark !== undefined ? sub.totalMark : null,
        submittedAt: sub?.submittedAt || null,
        reportCbtMark: recorded?.cbtMark ?? null,
        cbtSource: recorded?.cbtSource ?? null,
        cbtScale: recorded?.cbtScale || DEFAULT_CBT_SCALE,
        onReportCard: Boolean(recorded?.cbtMark),
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
    console.error('[TEACHER] Fetch CBT distribution analytics error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load CBT analytics.' });
  }
}

/**
 * POST /api/teacher/cbt/distributions/:id/sync-marks
 */
export async function syncTeacherCbtMarks(req: Request, res: Response): Promise<Response | void> {
  const teacherId = req.teacherId;
  const branchId = req.branchId;
  const distId = Number(req.params.id);
  const maxScoreBase = Number(req.body?.maxScoreBase) || DEFAULT_CBT_SCALE;
  const overwriteOverride = Boolean(req.body?.overwriteOverride);

  try {
    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: distId },
    });

    if (!dist) {
      return res.status(404).json({ success: false, message: 'CBT Distribution not found.' });
    }

    if (teacherId) {
      const allowed = await canTeacherUseClassSubject(prisma, teacherId, dist.classId, dist.subjectId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'Accessed can not be granted meet Admin for the priveleges..',
        });
      }
    }

    const effectiveBranchId = dist.branchId || branchId;
    const companion = await findCompanionOnlineExam(dist);
    const examIdsToMatch = Array.from(
      new Set([companion?.id, dist.onlineExamId, dist.id].filter((x): x is number => typeof x === 'number' && x > 0))
    );

    const sessionId = await resolveActiveSessionId();
    const examId = await resolveTermExamId(effectiveBranchId, sessionId, req.body?.targetExamId);
    if (!examId) {
      return res.status(400).json({
        success: false,
        message: 'Create a term examination first so CBT scores can land on report cards.',
      });
    }

    const submissions = examIdsToMatch.length > 0
      ? await prisma.onlineExamSubmission.findMany({
          where: {
            onlineExamId: { in: examIdsToMatch },
            totalMark: { not: null },
          },
          orderBy: { submittedAt: 'desc' },
        })
      : [];

    if (submissions.length === 0) {
      return res.json({ success: true, syncCount: 0, skippedOverrides: 0, message: 'No completed submissions found to sync.' });
    }

    let syncCount = 0;
    let skippedOverrides = 0;

    await prisma.$transaction(async (tx: any) => {
      for (const sub of submissions) {
        if (sub.totalMark === null || sub.totalMark === undefined) continue;

        const result = await recordCbtPercentageOnMarksheet({
          studentId: sub.studentId,
          classId: dist.classId,
          sectionId: dist.sectionId,
          subjectId: dist.subjectId,
          branchId: effectiveBranchId,
          sessionId,
          examId,
          percentage: Number(sub.totalMark),
          source: 'CBT_SYNC',
          submissionId: sub.id,
          scale: maxScoreBase,
          overwriteOverride,
          tx,
        });
        if (result.skipped && result.reason === 'admin_override') {
          skippedOverrides++;
          continue;
        }
        if (!result.skipped) syncCount++;
      }
    });

    return res.json({
      success: true,
      syncCount,
      skippedOverrides,
      message:
        skippedOverrides > 0
          ? `Recorded CBT scores for ${syncCount} student(s). ${skippedOverrides} admin-corrected score(s) were left unchanged.`
          : `CBT scores recorded for ${syncCount} student(s) on the official mark register and report cards.`,
    });
  } catch (error: any) {
    console.error('[TEACHER] Sync CBT marks error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to sync CBT marks.' });
  }
}
