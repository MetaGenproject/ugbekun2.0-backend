import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';
import {
  canTeacherUseClassSubject,
  hasClassAccess,
  getTeacherAuthorisedClassIds,
  teacherScopedContentOr,
  resolveActiveSessionForClass,
  excludePromotedOutStudents,
} from '../../lib/teacherAccess';
import { mapQuestionBankWrite } from '../../lib/questionDraftService';
import { snapshotFromBank } from '../admin/adminHomeworkController';
import { uploadBase64File } from '../../lib/cloudinary';

/**
 * GET /api/teacher/homeworks
 * Strictly scoped to the teacher's currently assigned classes and subjects.
 */
export async function getHomeworks(req: Request, res: Response): Promise<Response | void> {
  try {
    const { classId, subjectId } = (req.query || {}) as any;
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const authorisedClassIds = await getTeacherAuthorisedClassIds(prisma, req.teacherId);
    if (authorisedClassIds.length === 0) {
      return res.json({ success: true, homeworks: [] });
    }

    if (classId) {
      const targetClassId = Number(classId);
      if (subjectId) {
        const canUse = await canTeacherUseClassSubject(prisma, req.teacherId, targetClassId, Number(subjectId));
        if (!canUse) {
          return res.status(403).json({
            success: false,
            message: 'Access denied: You can only view assignments for your assigned class and subject.',
          });
        }
      } else {
        const canUseClass = await hasClassAccess(prisma, req.teacherId, targetClassId);
        if (!canUseClass) {
          return res.status(403).json({
            success: false,
            message: 'Access denied: You do not have access to assignments for other classes.',
          });
        }
      }
    }

    const scopedOr = await teacherScopedContentOr(prisma, req.teacherId);
    const andConditions: any[] = [
      { branchId: req.branchId },
      { sessionId },
      { classId: { in: authorisedClassIds } },
      { OR: scopedOr },
    ];
    if (classId) andConditions.push({ classId: Number(classId) });
    if (subjectId) andConditions.push({ subjectId: Number(subjectId) });

    const rawHomeworks = await prisma.homework.findMany({
      where: { AND: andConditions },
      include: {
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
        submissions: { select: { id: true, score: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const homeworks = rawHomeworks.map((hw) => {
      const qMeta = (hw.questions && typeof hw.questions === 'object' && !Array.isArray(hw.questions))
        ? (hw.questions as any)
        : null;
      const resolvedQuestions = qMeta?.questions || (Array.isArray(hw.questions) ? hw.questions : []);
      const submissionsList = Array.isArray(hw.submissions) ? hw.submissions : [];
      const submissionsCount = submissionsList.length;
      const markedCount = submissionsList.filter((s) => s.score !== null && s.score !== undefined).length;

      return {
        ...hw,
        className: hw.class?.name || 'Class',
        subjectName: hw.subject?.name || 'Subject',
        maxMarks: qMeta?.maxMarks || 20,
        submissionMode: qMeta?.submissionMode || (resolvedQuestions.length > 0 ? 'ONLINE_QUESTIONS' : 'OFFLINE'),
        attachmentUrl: qMeta?.attachmentUrl || null,
        attachmentName: qMeta?.attachmentName || null,
        questions: resolvedQuestions,
        submissionsCount,
        markedCount,
      };
    });

    return res.json({ success: true, homeworks });
  } catch (error) {
    console.error('[TEACHER] Get homeworks error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve homeworks.' });
  }
}

/**
 * POST /api/teacher/homeworks
 * Assigns homework strictly to the teacher's authorised class & subject.
 * Any Question Bank items attached must strictly belong to the same classId and subjectId.
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

  const targetClassId = Number(classId);
  const targetSubjectId = Number(subjectId);

  const allowed = await canTeacherUseClassSubject(prisma, req.teacherId, targetClassId, targetSubjectId);
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
      ids = Array.from(new Set(questionBankIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)));
    }

    if (Array.isArray(questions) && questions.length > 0) {
      for (const q of questions) {
        const existingId = Number(q.questionBankId || q.id);
        if (Number.isInteger(existingId) && existingId > 0) {
          if (!ids.includes(existingId)) ids.push(existingId);
          continue;
        }
        if (!String(q.questionText || '').trim()) continue;
        const item = await prisma.questionBank.create({
          data: mapQuestionBankWrite(
            {
              questionText: q.questionText,
              questionType: q.questionType || (q.type === 'MCQ' ? 'mcq' : q.type === 'TF' ? 'true_false' : 'theory'),
              options: q.options,
              correctOption: q.correctOption || q.correctAnswer,
              marks: q.marks || q.points || 1,
              subjectId: targetSubjectId,
              classId: targetClassId,
              termName,
              topic: q.topic,
              sourceType: 'MANUAL',
              status: 'APPROVED',
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
      if (bankResult.items.length !== ids.length) {
        return res.status(400).json({
          success: false,
          message: 'One or more selected Question Bank items were not found or are not approved.',
        });
      }

      // STRICT CLASS & SUBJECT VALIDATION: Teachers can NEVER pull questions from another class or subject
      const foreignItem = bankResult.items.find(
        (item) => Number(item.classId) !== targetClassId || Number(item.subjectId) !== targetSubjectId
      );
      if (foreignItem) {
        return res.status(403).json({
          success: false,
          message:
            'Strict Class Restriction: Every Question Bank item selected for an assignment must belong strictly to your assigned class and subject.',
        });
      }

      snapshot = bankResult.questions;
    }

    // Determine final question payload and metadata
    const parsedQuestions = snapshot || (Array.isArray(questions) && questions.length > 0 ? questions : []);
    const resolvedSubmissionMode =
      submissionMode || (attachmentUrl ? 'FILE_UPLOAD' : parsedQuestions.length > 0 ? 'ONLINE_QUESTIONS' : 'OFFLINE');
    const computedMaxMarks =
      Number(maxMarks) ||
      (parsedQuestions.length > 0
        ? parsedQuestions.reduce((sum: number, q: any) => sum + (Number(q.points ?? q.marks) || 1), 0)
        : 20);

    const questionsPayload = {
      questions: parsedQuestions,
      attachmentUrl: attachmentUrl || null,
      attachmentName: attachmentName || null,
      submissionMode: resolvedSubmissionMode,
      maxMarks: computedMaxMarks,
    };

    const homework = await prisma.homework.create({
      data: {
        title: String(title).trim(),
        description: description || null,
        classId: targetClassId,
        subjectId: targetSubjectId,
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

    return res.json({
      success: true,
      homework: {
        ...homework,
        className: homework.class?.name || 'Class',
        subjectName: homework.subject?.name || 'Subject',
        maxMarks: computedMaxMarks,
        submissionMode: resolvedSubmissionMode,
        attachmentUrl: attachmentUrl || null,
        attachmentName: attachmentName || null,
        questions: parsedQuestions,
        submissionsCount: 0,
        markedCount: 0,
      },
      message: 'Homework published successfully.',
    });
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
    const allowed = await canTeacherUseClassSubject(prisma, req.teacherId, homework.classId, homework.subjectId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You can only view submissions for your authorised classes.' });
    }

    const activeSessionId = await resolveActiveSessionForClass(prisma, req.branchId, homework.classId);

    // Fetch enrolled students in the class for the active session
    const rawEnrolls = await prisma.enroll.findMany({
      where: {
        classId: homework.classId,
        sessionId: activeSessionId,
        branchId: req.branchId,
        isAlumni: 0,
        student: { active: true },
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

    const filteredEnrolls = req.branchId
      ? await excludePromotedOutStudents(
          prisma,
          { branchId: req.branchId, sessionId: activeSessionId, classId: homework.classId, sectionId: 0 },
          rawEnrolls
        )
      : rawEnrolls;

    const seenStudentIds = new Set<number>();
    const enrolls = filteredEnrolls.filter((e) => {
      if (seenStudentIds.has(e.studentId)) return false;
      seenStudentIds.add(e.studentId);
      return true;
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

    const allowed = await canTeacherUseClassSubject(prisma, req.teacherId, homework.classId, homework.subjectId);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: 'You can only grade assignments for your authorised class and subject.',
      });
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

