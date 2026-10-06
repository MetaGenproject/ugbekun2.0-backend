import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';
import { uploadBase64File } from '../../lib/cloudinary';

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
  const { answers, notes, fileUrl, fileName, fileType } = req.body;
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

    const formattedAnswers = Array.isArray(answers) ? [...answers] : [];
    if (fileUrl) {
      hasManual = true;
      formattedAnswers.push({
        submissionType: 'FILE_UPLOAD',
        fileUrl,
        fileName: fileName || 'assignment_submission',
        fileType: fileType || 'file',
        notes: notes || '',
      });
    }

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
    let studentFileAttachment: any = null;
    if (submission && Array.isArray(submission.answers)) {
      const fAns = (submission.answers as any[]).find((a: any) => a?.fileUrl || a?.submissionType === 'FILE_UPLOAD');
      if (fAns) {
        studentFileAttachment = {
          fileUrl: fAns.fileUrl,
          fileName: fAns.fileName || 'Submitted_Document',
          fileType: fAns.fileType || 'file',
        };
      }
    }

    const questions = parseQuestions(homework.questions);
    const questionsMeta = typeof homework.questions === 'object' && homework.questions !== null ? (homework.questions as any) : null;
    const attachmentUrl = questionsMeta?.attachmentUrl || null;
    const attachmentName = questionsMeta?.attachmentName || null;
    const submissionMode = questionsMeta?.submissionMode || (attachmentUrl ? 'FILE_UPLOAD' : (questions.length > 0 ? 'ONLINE_QUESTIONS' : 'OFFLINE'));
    const maxMarks = questionsMeta?.maxMarks || 20;

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
        attachmentUrl,
        attachmentName,
        submissionMode,
        maxMarks,
        submitted: !!submission,
        fileAttachment: studentFileAttachment,
        submission: submission ? {
          ...submission,
          fileAttachment: studentFileAttachment,
        } : null,
      },
    });
  } catch (error) {
    console.error('[STUDENT] Get homework detail error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve homework details.' });
  }
}

/**
 * POST /api/student/homeworks/upload
 * Allows students to upload write-up documents (PDF, Word, Images, TXT) for their homework.
 */
export async function uploadStudentHomeworkFile(req: Request, res: Response): Promise<Response | void> {
  try {
    let fileBuffer: Buffer | null = null;
    let originalName = 'student_writeup';
    let mimeType = 'application/octet-stream';

    if (req.file) {
      fileBuffer = req.file.buffer;
      originalName = req.file.originalname;
      mimeType = req.file.mimetype;
    } else if (req.body?.base64) {
      fileBuffer = Buffer.from(req.body.base64, 'base64');
      originalName = req.body.fileName || 'student_writeup';
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
        folder: 'ugbekun_student_submissions',
      });
      if (url) {
        return res.json({ success: true, url, fileName: originalName, fileType: mimeType });
      }
    } catch (cErr: any) {
      console.warn('[STUDENT HOMEWORK UPLOAD] Cloudinary upload fallback to local disk:', cErr?.message);
    }

    // Local fallback: write to uploads/assignments
    const uploadDir = path.join(__dirname, '../../uploads/assignments');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const safeName = `student_${req.studentId || 'sub'}_${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(uploadDir, safeName);
    fs.writeFileSync(filePath, fileBuffer);

    const localUrl = `/uploads/assignments/${safeName}`;
    return res.json({ success: true, url: localUrl, fileName: originalName, fileType: mimeType });
  } catch (error: any) {
    console.error('[STUDENT HOMEWORK UPLOAD] Error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload assignment file.' });
  }
}
