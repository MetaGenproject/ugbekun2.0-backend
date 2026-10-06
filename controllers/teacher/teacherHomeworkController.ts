import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';
import { canTeacherUseClassSubject, teacherScopedContentOr } from '../../lib/teacherAccess';
import { mapQuestionBankWrite } from '../../lib/questionDraftService';
import { snapshotFromBank } from '../admin/adminHomeworkController';
import { uploadBase64File } from '../../lib/cloudinary';

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
  const {
    title,
    description,
    classId,
    subjectId,
    dueDate,
    questions,
    questionBankIds,
    termName,
    attachmentUrl,
    attachmentName,
    submissionMode,
    maxMarks,
  } = req.body;

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
              marks: q.marks || q.points || 1,
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

    // Determine final question payload and metadata
    const parsedQuestions = snapshot || (Array.isArray(questions) && questions.length > 0 ? questions : []);
    const resolvedSubmissionMode = submissionMode || (attachmentUrl ? 'FILE_UPLOAD' : (parsedQuestions.length > 0 ? 'ONLINE_QUESTIONS' : 'OFFLINE'));

    const questionsPayload = {
      questions: parsedQuestions,
      attachmentUrl: attachmentUrl || null,
      attachmentName: attachmentName || null,
      submissionMode: resolvedSubmissionMode,
      maxMarks: Number(maxMarks) || 20,
    };

    const homework = await prisma.homework.create({
      data: {
        title,
        description: description || null,
        classId: Number(classId),
        subjectId: Number(subjectId),
        dueDate: new Date(dueDate),
        questions: questionsPayload,
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

    const maxScore = (homework.questions as any)?.maxMarks || 20;

    const studentRoster = enrolls.map((e) => {
      const sub = submissionMap.get(e.student.id);
      let fileUrl = null;
      let fileName = null;
      let submissionType = 'ONLINE';

      if (sub && sub.answers) {
        if (typeof sub.answers === 'object') {
          if (Array.isArray(sub.answers)) {
            const fileItem = sub.answers.find((a: any) => a.fileUrl || a.fileAttachment?.fileUrl);
            if (fileItem) {
              fileUrl = fileItem.fileUrl || fileItem.fileAttachment?.fileUrl;
              fileName = fileItem.fileName || fileItem.fileAttachment?.fileName || 'Uploaded Assignment';
              submissionType = 'FILE_UPLOAD';
            }
          } else {
            fileUrl = (sub.answers as any).fileUrl || (sub.answers as any).fileAttachment?.fileUrl || null;
            fileName = (sub.answers as any).fileName || (sub.answers as any).fileAttachment?.fileName || 'Uploaded Assignment';
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

      const fullName = `${e.student.firstName || ''} ${e.student.lastName || ''}`.trim() || 'Student';

      return {
        studentId: e.student.id,
        name: fullName,
        firstName: e.student.firstName,
        lastName: e.student.lastName,
        registerNo: e.student.registerNo,
        photo: e.student.photo,
        sectionName: e.section?.name || 'Main',
        submissionId: sub?.id || null,
        submitted: !!sub,
        status,
        score: sub?.score ?? null,
        maxScore,
        feedback: sub?.feedback || null,
        submittedAt: sub?.createdAt || null,
        fileUrl,
        fileName,
        fileAttachment: fileUrl ? { fileUrl, fileName: fileName || 'Uploaded Assignment', fileType: 'file' } : null,
        submissionType,
        answers: sub?.answers || null,
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
        attachmentUrl: (homework.questions as any)?.attachmentUrl || null,
        attachmentName: (homework.questions as any)?.attachmentName || null,
        submissionMode: (homework.questions as any)?.submissionMode || 'ONLINE',
        maxMarks: maxScore,
        questions: (homework.questions as any)?.questions || homework.questions,
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

/**
 * POST /api/teacher/homeworks/upload
 * Supports file uploads for assignment materials (PDF, Word, image worksheets).
 */
export async function uploadHomeworkMaterial(req: Request, res: Response): Promise<Response | void> {
  try {
    let fileBuffer: Buffer | null = null;
    let originalName = 'assignment_file';
    let mimeType = 'application/octet-stream';

    if (req.file) {
      fileBuffer = req.file.buffer;
      originalName = req.file.originalname;
      mimeType = req.file.mimetype;
    } else if (req.body?.base64) {
      fileBuffer = Buffer.from(req.body.base64, 'base64');
      originalName = req.body.fileName || 'assignment_file';
      mimeType = req.body.mime || 'application/octet-stream';
    }

    if (!fileBuffer) {
      return res.status(400).json({ success: false, message: 'No file provided.' });
    }

    // Try Cloudinary first
    try {
      const base64Str = fileBuffer.toString('base64');
      const url = await uploadBase64File({
        base64: base64Str,
        mime: mimeType,
        folder: 'ugbekun_assignments',
      });
      if (url) {
        return res.json({ success: true, url, fileName: originalName, fileType: mimeType });
      }
    } catch (cErr: any) {
      console.warn('[HOMEWORK UPLOAD] Cloudinary upload fallback to local disk:', cErr?.message);
    }

    // Local fallback: write to uploads/assignments
    const uploadDir = path.join(__dirname, '../../uploads/assignments');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const safeName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(uploadDir, safeName);
    fs.writeFileSync(filePath, fileBuffer);

    const localUrl = `/uploads/assignments/${safeName}`;
    return res.json({ success: true, url: localUrl, fileName: originalName, fileType: mimeType });
  } catch (error: any) {
    console.error('[HOMEWORK UPLOAD] Error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload homework file.' });
  }
}

