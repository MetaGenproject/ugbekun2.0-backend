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
    let ids: number[] = [];
    let snapshot: any = null;

    if (Array.isArray(questionBankIds) && questionBankIds.length > 0) {
      ids = questionBankIds.map(Number).filter(Boolean);
    }

    if (!ids.length && Array.isArray(questions) && questions.length > 0) {
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

    if (ids.length > 0) {
      const bankResult = await snapshotFromBank(ids, req.branchId);
      snapshot = bankResult.questions;
    }

    const homework = await prisma.homework.create({
      data: {
        title,
        description: description || null,
        classId: Number(classId),
        subjectId: Number(subjectId),
        dueDate: new Date(dueDate),
        questions: snapshot || (questions && questions.length > 0 ? questions : null),
        questionBankIds: ids.length > 0 ? ids : null,
        termName: termName || null,
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
 * Returns full class roster with individual submission status:
 * MARKED, AWAITING_MARKING, NOT_SUBMITTED.
 */
export async function getHomeworkSubmissions(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  try {
    const homework = await prisma.homework.findFirst({
      where: { id: Number(id), branchId: req.branchId },
      include: {
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
      },
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

    // Fetch all enrolled students in the class
    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: homework.classId,
        branchId: req.branchId,
        isAlumni: 0,
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            photo: true,
          },
        },
        section: { select: { id: true, name: true } },
      },
      orderBy: [{ roll: 'asc' }, { student: { lastName: 'asc' } }],
    });

    // Fetch all submissions for this homework
    const submissions = await prisma.homeworkSubmission.findMany({
      where: { homeworkId: Number(id) },
      orderBy: { createdAt: 'desc' },
    });

    const submissionMap = new Map<number, any>();
    submissions.forEach((sub) => {
      if (!submissionMap.has(sub.studentId)) {
        submissionMap.set(sub.studentId, sub);
      }
    });

    const isPastDue = new Date() > new Date(homework.dueDate);

    const studentRoster = enrolls.map((e) => {
      const sub = submissionMap.get(e.student.id);
      let fileUrl = null;
      let fileName = null;
      let submissionType = 'ONLINE';

      if (sub && sub.answers) {
        if (typeof sub.answers === 'object') {
          if (Array.isArray(sub.answers)) {
            const fileItem = sub.answers.find((a: any) => a.fileUrl);
            if (fileItem) {
              fileUrl = fileItem.fileUrl;
              fileName = fileItem.fileName || 'Uploaded Assignment';
              submissionType = 'FILE_UPLOAD';
            }
          } else {
            fileUrl = (sub.answers as any).fileUrl || null;
            fileName = (sub.answers as any).fileName || 'Uploaded Assignment';
            submissionType = (sub.answers as any).submissionType || 'ONLINE';
          }
        }
      }

      let status = 'NOT_SUBMITTED';
      if (sub) {
        status = sub.score !== null && sub.score !== undefined ? 'MARKED' : 'AWAITING_MARKING';
      } else if (isPastDue) {
        status = 'MISSING';
      }

      return {
        studentId: e.student.id,
        registerNo: e.student.registerNo,
        firstName: e.student.firstName,
        lastName: e.student.lastName,
        photo: e.student.photo,
        sectionName: e.section?.name || 'Main',
        submissionId: sub?.id || null,
        submitted: !!sub,
        status,
        score: sub?.score ?? null,
        feedback: sub?.feedback || null,
        submittedAt: sub?.createdAt || null,
        fileUrl,
        fileName,
        submissionType,
      };
    });

    return res.json({
      success: true,
      homework: {
        id: homework.id,
        title: homework.title,
        description: homework.description,
        dueDate: homework.dueDate,
        className: homework.class.name,
        subjectName: homework.subject.name,
      },
      submissions: studentRoster,
    });
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
        score: score !== undefined && score !== null ? Number(score) : null,
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

/**
 * POST /api/teacher/homeworks/:id/batch-grade
 * Requirement 8: Offline Assignment Marking & Score Entry.
 * Allows teacher to enter and save marks/feedback for multiple students in one action.
 */
export async function batchGradeHomework(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const { grades } = req.body;

  if (!Array.isArray(grades)) {
    return res.status(400).json({ success: false, message: 'grades array is required.' });
  }

  try {
    const homeworkId = Number(id);
    const homework = await prisma.homework.findUnique({
      where: { id: homeworkId },
    });
    if (!homework) {
      return res.status(404).json({ success: false, message: 'Homework not found.' });
    }

    let updatedCount = 0;
    for (const g of grades) {
      if (!g.studentId) continue;
      const sId = Number(g.studentId);
      const score = g.score !== undefined && g.score !== null && g.score !== '' ? Number(g.score) : null;
      const feedback = g.feedback || null;

      const existing = await prisma.homeworkSubmission.findFirst({
        where: { homeworkId, studentId: sId },
      });

      if (existing) {
        await prisma.homeworkSubmission.update({
          where: { id: existing.id },
          data: { score, feedback },
        });
      } else {
        await prisma.homeworkSubmission.create({
          data: {
            homeworkId,
            studentId: sId,
            answers: [{ submissionType: 'OFFLINE_ENTRY', note: 'Marked by teacher' }],
            score,
            feedback,
          },
        });
      }
      updatedCount++;
    }

    return res.json({
      success: true,
      updatedCount,
      message: `Saved marks for ${updatedCount} students successfully.`,
    });
  } catch (error: any) {
    console.error('[TEACHER] Batch grade homework error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to batch save grades.' });
  }
}

