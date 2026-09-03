import { Request, Response } from 'express';
import OpenAI from 'openai';
import prisma from '../../lib/prisma';
import { isSubjectTeacher, isFormTeacher, hasClassAccess } from './teacherDashboardController';
import { generatePedagogicalLessonPlan } from '../../lib/lessonPlanService';
import { generateStudentAiCommentary, generateBatchClassCommentary } from '../../lib/commentaryService';
import {
  generateLessonPlanPdf,
  generateReportCardPdf,
  generateMontessoriReportCardPdf,
  generateBatchClassReportCardsPdf,
} from '../../lib/pdfService';
import gamificationService from '../../lib/gamificationService';

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'dummy-key',
  baseURL: 'https://api.deepseek.com',
});

let Tesseract: any;
try {
  Tesseract = require('tesseract.js');
} catch (err) {
  console.warn('[TEACHER] Tesseract.js could not be loaded; OCR image parsing is disabled.');
}

export function levenshteinDistance(s1: string, s2: string): number {
  s1 = s1.toLowerCase().trim();
  s2 = s2.toLowerCase().trim();
  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= s2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= s1.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= s2.length; i++) {
    for (let j = 1; j <= s1.length; j++) {
      if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[s2.length][s1.length];
}

export function computeSimilarity(s1: string, s2: string): number {
  const distance = levenshteinDistance(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  if (maxLength === 0) return 1.0;
  return 1.0 - distance / maxLength;
}

/**
 * GET /api/teacher/exams
 */
export async function getExams(req: Request, res: Response): Promise<Response | void> {
  try {
    const exams = await prisma.exam.findMany({
      where: req.branchId ? { branchId: req.branchId } : {},
      select: {
        id: true,
        name: true,
        termId: true,
      },
      orderBy: { id: 'desc' },
    });
    return res.json({ success: true, exams });
  } catch (error) {
    console.error('[TEACHER] Fetch exams error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch exams.' });
  }
}

/**
 * GET /api/teacher/students
 */
export async function getStudents(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId } = req.query;
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  const hasAccess = await hasClassAccess(prisma, req.teacherId, classId, sectionId, req);
  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not allocated to this class.',
    });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId,
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            gender: true,
            commentaries: {
              where: { sessionId },
              select: {
                remark: true,
                originalAiRemark: true,
                isAiGenerated: true,
                isEditedByHuman: true,
                status: true,
                reviewNotes: true,
              },
            },
          },
        },
      },
      orderBy: {
        student: {
          lastName: 'asc',
        },
      },
    });

    const students = enrolls.map((e) => {
      const comm = e.student.commentaries[0];
      return {
        id: e.student.id,
        firstName: e.student.firstName,
        lastName: e.student.lastName,
        registerNo: e.student.registerNo,
        gender: e.student.gender,
        remark: comm?.remark || '',
        originalAiRemark: comm?.originalAiRemark || null,
        isAiGenerated: comm?.isAiGenerated || false,
        isEditedByHuman: comm?.isEditedByHuman || false,
        status: comm?.status || 'DRAFT',
        reviewNotes: comm?.reviewNotes || null,
      };
    });

    return res.json({ success: true, students });
  } catch (error) {
    console.error('[TEACHER] Students fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch student roster.' });
  }
}

/**
 * GET /api/teacher/scores
 */
export async function getScores(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, subjectId, examId } = req.query;
  if (!classId || !sectionId || !subjectId || !examId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, subjectId, and examId are required.' });
  }

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId, req);
  if (!isAssigned) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not assigned to view grades for this subject.',
    });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const marks = await prisma.mark.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        subjectId: Number(subjectId),
        examId: Number(examId),
        sessionId,
        branchId: req.branchId,
      },
      select: {
        id: true,
        studentId: true,
        mark: true,
        absent: true,
      },
    });

    return res.json({ success: true, marks });
  } catch (error) {
    console.error('[TEACHER] Scores fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch scores.' });
  }
}

/**
 * POST /api/teacher/scores
 */
export async function saveScores(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, subjectId, examId, scores } = req.body;
  if (!classId || !sectionId || !subjectId || !examId || !Array.isArray(scores)) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' });
  }

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId, req);
  if (!isAssigned) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not assigned to enter grades for this subject.',
    });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const operations: any[] = [];
    for (const s of scores) {
      const existing = await prisma.mark.findFirst({
        where: {
          studentId: Number(s.studentId),
          subjectId: Number(subjectId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          examId: Number(examId),
          sessionId,
          branchId: req.branchId,
        },
        select: { id: true },
      });

      if (existing) {
        operations.push(
          prisma.mark.update({
            where: { id: existing.id },
            data: {
              mark: s.mark !== undefined ? String(s.mark) : null,
              absent: s.absent ? '1' : null,
            },
          })
        );
      } else {
        operations.push(
          prisma.mark.create({
            data: {
              studentId: Number(s.studentId),
              subjectId: Number(subjectId),
              classId: Number(classId),
              sectionId: Number(sectionId),
              examId: Number(examId),
              mark: s.mark !== undefined ? String(s.mark) : null,
              absent: s.absent ? '1' : null,
              sessionId,
              branchId: req.branchId,
            },
          })
        );
      }
    }

    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }

    return res.json({ success: true, message: 'Scores saved successfully.' });
  } catch (error: any) {
    console.error('[TEACHER] Scores save error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save scores.' });
  }
}

/**
 * POST /api/teacher/commentary
 */
export async function saveCommentary(req: Request, res: Response): Promise<Response | void> {
  const { studentId, remark, isAiGenerated, isEditedByHuman, status, reviewNotes } = req.body;
  if (!studentId || remark === undefined) {
    return res.status(400).json({ success: false, message: 'studentId and remark are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const studentEnroll = await prisma.enroll.findFirst({
      where: { studentId: Number(studentId), sessionId, branchId: req.branchId },
      select: { classId: true, sectionId: true },
    });

    if (!studentEnroll) {
      return res.status(404).json({ success: false, message: 'Student enrollment not found in current session.' });
    }

    const isForm = await isFormTeacher(prisma, req.teacherId, studentEnroll.classId, studentEnroll.sectionId, req);
    if (!isForm) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Only the Form Teacher can draft qualitative commentary.',
      });
    }

    const existing = await prisma.studentCommentary.findFirst({
      where: { studentId: Number(studentId), sessionId },
    });

    let saved;
    if (existing) {
      saved = await prisma.studentCommentary.update({
        where: { id: existing.id },
        data: {
          remark,
          isAiGenerated: isAiGenerated !== undefined ? isAiGenerated : existing.isAiGenerated,
          isEditedByHuman: isEditedByHuman !== undefined ? isEditedByHuman : true,
          status: status || existing.status,
          reviewNotes: reviewNotes !== undefined ? reviewNotes : existing.reviewNotes,
        },
      });
    } else {
      saved = await prisma.studentCommentary.create({
        data: {
          studentId: Number(studentId),
          classId: studentEnroll.classId,
          sectionId: studentEnroll.sectionId,
          sessionId,
          branchId: req.branchId,
          remark,
          originalAiRemark: isAiGenerated ? remark : null,
          isAiGenerated: isAiGenerated || false,
          isEditedByHuman: isEditedByHuman || false,
          status: status || 'DRAFT',
          reviewNotes: reviewNotes || null,
        },
      });
    }

    return res.json({ success: true, message: 'Commentary saved.', commentary: saved });
  } catch (error) {
    console.error('[TEACHER] Save commentary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save commentary.' });
  }
}

/**
 * POST /api/teacher/commentary/generate-ai
 */
export async function generateCommentaryAi(req: Request, res: Response): Promise<Response | void> {
  const { studentId } = req.body;
  if (!studentId) {
    return res.status(400).json({ success: false, message: 'studentId is required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const studentEnroll = await prisma.enroll.findFirst({
      where: { studentId: Number(studentId), sessionId, branchId: req.branchId },
      include: {
        student: { select: { firstName: true, lastName: true, gender: true } },
        class: { select: { name: true } },
      },
    });

    if (!studentEnroll) {
      return res.status(404).json({ success: false, message: 'Student enrollment not found in current session.' });
    }

    const isForm = await isFormTeacher(prisma, req.teacherId, studentEnroll.classId, studentEnroll.sectionId, req);
    if (!isForm) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Only the Form Teacher can generate AI commentary.',
      });
    }

    const [marks, attendanceLogs] = await Promise.all([
      prisma.mark.findMany({
        where: { studentId: Number(studentId), sessionId, branchId: req.branchId },
        include: { subject: { select: { name: true } } },
      }),
      prisma.attendance.findMany({
        where: { studentId: Number(studentId), sessionId, branchId: req.branchId },
      }),
    ]);

    const totalAtt = attendanceLogs.length;
    const presentAtt = attendanceLogs.filter((a) => a.status === 'Present').length;
    const attPct = totalAtt > 0 ? (presentAtt / totalAtt) * 100 : 100;

    const marksBySubject: Record<string, number> = {};
    let totalMarks = 0;
    marks.forEach((m) => {
      const val = Number(m.mark || m.cbtMark || 0);
      marksBySubject[m.subject?.name || 'General'] = val;
      totalMarks += val;
    });
    const avgScore = marks.length > 0 ? Math.round(totalMarks / marks.length) : 75;

    const aiRemark = await generateStudentAiCommentary({
      studentName: `${studentEnroll.student.firstName} ${studentEnroll.student.lastName}`,
      gender: studentEnroll.student.gender || 'student',
      averageScore: avgScore,
      attendanceRate: Math.round(attPct),
      marksBySubject,
    });

    return res.json({ success: true, remark: aiRemark });
  } catch (error: any) {
    console.error('[TEACHER] AI commentary error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to generate AI commentary.' });
  }
}

/**
 * POST /api/teacher/commentary/batch-generate-ai
 */
export async function batchGenerateCommentaryAi(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId } = req.body;
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req);
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can run batch AI commentary generation.',
    });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId,
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            gender: true,
          },
        },
        class: { select: { name: true } },
      },
    });

    if (enrolls.length === 0) {
      return res.json({ success: true, commentaries: [] });
    }

    const studentIds = enrolls.map((e) => e.student.id);

    const [allMarks, allAttendance] = await Promise.all([
      prisma.mark.findMany({
        where: { studentId: { in: studentIds }, sessionId, branchId: req.branchId },
        include: { subject: { select: { name: true } } },
      }),
      prisma.attendance.findMany({
        where: { studentId: { in: studentIds }, sessionId, branchId: req.branchId },
      }),
    ]);

    const studentPayloads = enrolls.map((e) => {
      const sMarks = allMarks
        .filter((m) => m.studentId === e.student.id)
        .map((m) => ({
          subjectName: m.subject?.name || 'General',
          score: Number(m.mark || m.cbtMark || 0),
        }));

      const sAtt = allAttendance.filter((a) => a.studentId === e.student.id);
      const attPct = sAtt.length > 0 ? (sAtt.filter((a) => a.status === 'Present').length / sAtt.length) * 100 : 100;

      return {
        studentId: e.student.id,
        studentName: `${e.student.firstName} ${e.student.lastName}`,
        gender: e.student.gender || 'student',
        className: e.class?.name || 'Class',
        marks: sMarks,
        attendancePercentage: attPct,
      };
    });

    const results = await generateBatchClassCommentary(studentPayloads);

    return res.json({ success: true, commentaries: results });
  } catch (error: any) {
    console.error('[TEACHER] Batch AI commentary error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to batch generate AI commentary.' });
  }
}

/**
 * POST /api/teacher/commentary/batch-save
 */
export async function batchSaveCommentary(req: Request, res: Response): Promise<Response | void> {
  const { commentaries } = req.body;
  if (!Array.isArray(commentaries) || commentaries.length === 0) {
    return res.status(400).json({ success: false, message: 'commentaries array is required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    for (const c of commentaries) {
      if (!c.studentId || c.remark === undefined) continue;

      const existing = await prisma.studentCommentary.findFirst({
        where: { studentId: Number(c.studentId), sessionId },
      });

      if (existing) {
        await prisma.studentCommentary.update({
          where: { id: existing.id },
          data: {
            remark: c.remark,
            isAiGenerated: c.isAiGenerated !== undefined ? c.isAiGenerated : existing.isAiGenerated,
            isEditedByHuman: c.isEditedByHuman !== undefined ? c.isEditedByHuman : true,
            status: c.status || existing.status,
          },
        });
      } else {
        const enroll = await prisma.enroll.findFirst({
          where: { studentId: Number(c.studentId), sessionId, branchId: req.branchId },
          select: { classId: true, sectionId: true },
        });

        await prisma.studentCommentary.create({
          data: {
            studentId: Number(c.studentId),
            classId: enroll?.classId || 1,
            sectionId: enroll?.sectionId || 1,
            sessionId,
            branchId: req.branchId,
            remark: c.remark,
            originalAiRemark: c.isAiGenerated ? c.remark : null,
            isAiGenerated: c.isAiGenerated || false,
            isEditedByHuman: c.isEditedByHuman || false,
            status: c.status || 'DRAFT',
          },
        });
      }
    }

    return res.json({ success: true, message: 'Batch commentary saved successfully.' });
  } catch (error) {
    console.error('[TEACHER] Batch save commentary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to batch save commentary.' });
  }
}

/**
 * GET /api/teacher/report-cards
 */
export async function getReportCards(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, examId } = req.query;
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  const isForm = await isFormTeacher(prisma, req.teacherId, classId, sectionId, req);
  if (!isForm) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only the Form Teacher can access the class Report Cards overview.',
    });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId,
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            photo: true,
            commentaries: {
              where: { sessionId },
              select: { status: true, remark: true },
            },
          },
        },
      },
      orderBy: { student: { lastName: 'asc' } },
    });

    const studentIds = enrolls.map((e) => e.student.id);

    const markWhere: any = {
      studentId: { in: studentIds },
      sessionId,
      branchId: req.branchId,
    };
    if (examId) markWhere.examId = Number(examId);

    const marks = await prisma.mark.findMany({
      where: markWhere,
      select: { studentId: true, mark: true, cbtMark: true },
    });

    const aggregates: Record<number, { sum: number; count: number }> = {};
    studentIds.forEach((id) => {
      aggregates[id] = { sum: 0, count: 0 };
    });

    marks.forEach((m) => {
      const val = Number(m.mark || m.cbtMark || 0);
      if (val > 0) {
        aggregates[m.studentId].sum += val;
        aggregates[m.studentId].count++;
      }
    });

    const reportCards = enrolls.map((e) => {
      const agg = aggregates[e.student.id];
      const avg = agg && agg.count > 0 ? Number((agg.sum / agg.count).toFixed(1)) : 0;
      const commentary = e.student.commentaries[0];

      return {
        studentId: e.student.id,
        firstName: e.student.firstName,
        lastName: e.student.lastName,
        registerNo: e.student.registerNo,
        photo: e.student.photo,
        averageScore: avg,
        commentaryStatus: commentary?.status || 'NOT_STARTED',
        hasCommentary: Boolean(commentary?.remark),
      };
    });

    return res.json({ success: true, reportCards });
  } catch (error) {
    console.error('[TEACHER] Report cards error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch report cards overview.' });
  }
}

/**
 * GET /api/teacher/gradebook/sheet
 */
export async function getGradebookSheet(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, examId } = req.query;
  if (!classId || !sectionId || !examId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and examId are required.' });
  }

  const hasAccess = await hasClassAccess(prisma, req.teacherId, classId, sectionId, req);
  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not allocated to this class.',
    });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const [enrolls, subjectAssigns] = await Promise.all([
      prisma.enroll.findMany({
        where: {
          classId: Number(classId),
          sectionId: Number(sectionId),
          sessionId,
          branchId: req.branchId,
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
        },
        orderBy: { student: { lastName: 'asc' } },
      }),
      prisma.subjectAssign.findMany({
        where: {
          classId: Number(classId),
          sectionId: Number(sectionId),
          sessionId,
          branchId: req.branchId,
        },
        include: {
          subject: {
            select: { id: true, name: true, subjectCode: true },
          },
        },
      }),
    ]);

    const studentIds = enrolls.map((e) => e.student.id);
    const marks = await prisma.mark.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        examId: Number(examId),
        studentId: { in: studentIds },
        sessionId,
        branchId: req.branchId,
      },
      select: {
        id: true,
        studentId: true,
        subjectId: true,
        mark: true,
        cbtMark: true,
        absent: true,
      },
    });

    const marksMap: Record<string, any> = {};
    marks.forEach((m) => {
      const key = `${m.studentId}_${m.subjectId}`;
      marksMap[key] = {
        mark: m.mark,
        cbtMark: m.cbtMark,
        absent: m.absent,
      };
    });

    const subjects = subjectAssigns.map((sa) => ({
      id: sa.subject.id,
      name: sa.subject.name,
      code: sa.subject.subjectCode,
    }));

    const rows = enrolls.map((e) => {
      const studentMarks: Record<number, any> = {};
      subjects.forEach((sub) => {
        const key = `${e.student.id}_${sub.id}`;
        studentMarks[sub.id] = marksMap[key] || { mark: null, cbtMark: null, absent: null };
      });

      return {
        studentId: e.student.id,
        firstName: e.student.firstName,
        lastName: e.student.lastName,
        registerNo: e.student.registerNo,
        photo: e.student.photo,
        marks: studentMarks,
      };
    });

    return res.json({ success: true, subjects, rows });
  } catch (error) {
    console.error('[TEACHER] Gradebook sheet error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve gradebook sheet.' });
  }
}

/**
 * POST /api/teacher/gradebook/save-single
 */
export async function saveSingleGrade(req: Request, res: Response): Promise<Response | void> {
  const { studentId, subjectId, examId, classId, sectionId, mark, cbtMark, absent } = req.body;
  if (!studentId || !subjectId || !examId || !classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'Required identifiers missing.' });
  }

  const isAssigned = await isSubjectTeacher(prisma, req.teacherId, classId, sectionId, subjectId, req);
  if (!isAssigned) {
    return res.status(403).json({
      success: false,
      message: 'Access denied: You are not assigned to record grades for this subject.',
    });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const existing = await prisma.mark.findFirst({
      where: {
        studentId: Number(studentId),
        subjectId: Number(subjectId),
        examId: Number(examId),
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId,
      },
    });

    let saved;
    if (existing) {
      saved = await prisma.mark.update({
        where: { id: existing.id },
        data: {
          mark: mark !== undefined ? (mark !== null ? String(mark) : null) : existing.mark,
          cbtMark: cbtMark !== undefined ? (cbtMark !== null ? String(cbtMark) : null) : existing.cbtMark,
          absent: absent !== undefined ? (absent ? '1' : null) : existing.absent,
        },
      });
    } else {
      saved = await prisma.mark.create({
        data: {
          studentId: Number(studentId),
          subjectId: Number(subjectId),
          examId: Number(examId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          mark: mark !== undefined && mark !== null ? String(mark) : null,
          cbtMark: cbtMark !== undefined && cbtMark !== null ? String(cbtMark) : null,
          absent: absent ? '1' : null,
          sessionId,
          branchId: req.branchId,
        },
      });
    }

    return res.json({ success: true, mark: saved });
  } catch (error) {
    console.error('[TEACHER] Save single grade error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save grade cell.' });
  }
}

/**
 * POST /api/teacher/gradebook/csv-upload
 */
export async function uploadGradebookCsv(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, examId, csvData } = req.body;
  if (!classId || !sectionId || !examId || !Array.isArray(csvData)) {
    return res.status(400).json({ success: false, message: 'Invalid payload.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    let savedCount = 0;
    for (const row of csvData) {
      if (!row.studentId || !row.subjectId) continue;

      const existing = await prisma.mark.findFirst({
        where: {
          studentId: Number(row.studentId),
          subjectId: Number(row.subjectId),
          examId: Number(examId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          sessionId,
          branchId: req.branchId,
        },
      });

      if (existing) {
        await prisma.mark.update({
          where: { id: existing.id },
          data: {
            mark: row.mark !== undefined ? (row.mark !== null ? String(row.mark) : null) : existing.mark,
            cbtMark: row.cbtMark !== undefined ? (row.cbtMark !== null ? String(row.cbtMark) : null) : existing.cbtMark,
            absent: row.absent ? '1' : null,
          },
        });
      } else {
        await prisma.mark.create({
          data: {
            studentId: Number(row.studentId),
            subjectId: Number(row.subjectId),
            examId: Number(examId),
            classId: Number(classId),
            sectionId: Number(sectionId),
            mark: row.mark !== undefined && row.mark !== null ? String(row.mark) : null,
            cbtMark: row.cbtMark !== undefined && row.cbtMark !== null ? String(row.cbtMark) : null,
            absent: row.absent ? '1' : null,
            sessionId,
            branchId: req.branchId,
          },
        });
      }
      savedCount++;
    }

    return res.json({ success: true, message: `Successfully processed ${savedCount} score records from CSV.` });
  } catch (error) {
    console.error('[TEACHER] CSV upload error:', error);
    return res.status(500).json({ success: false, message: 'Failed to process CSV grade sheet.' });
  }
}

/**
 * GET /api/teacher/report-cards/export-pdf
 */
export async function exportReportCardPdf(req: Request, res: Response): Promise<Response | void> {
  const { studentId, examId, rankingType = 'full', rankingLimit = 3 } = req.query as any;
  if (!studentId) {
    return res.status(400).json({ success: false, message: 'studentId is required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const [student, schoolYear] = await Promise.all([
      prisma.student.findUnique({
        where: { id: Number(studentId) },
        include: {
          branch: { select: { name: true, code: true } },
        },
      }),
      prisma.schoolYear.findUnique({
        where: { id: sessionId },
      }),
    ]);

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const enroll = await prisma.enroll.findFirst({
      where: { studentId: Number(studentId), sessionId, branchId: req.branchId },
      include: {
        class: { select: { id: true, name: true, isEcd: true } },
        section: { select: { id: true, name: true } },
      },
    });

    if (!enroll) {
      return res.status(404).json({ success: false, message: 'Student not enrolled in active session.' });
    }

    if (enroll.class?.isEcd) {
      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: Number(studentId),
          classId: enroll.classId,
          sectionId: enroll.sectionId,
          sessionId,
          branchId: req.branchId,
          ...(examId ? { examId: Number(examId) } : {}),
        },
        include: { exam: { select: { name: true, resumptionDate: true } } },
      });

      const teacherAlloc = await prisma.teacherAllocation.findFirst({
        where: { classId: enroll.classId, sectionId: enroll.sectionId, sessionId, branchId: req.branchId },
        include: { teacher: { select: { name: true } } },
      });

      const pdfBuffer = await generateMontessoriReportCardPdf({
        schoolName: student.branch?.name || 'Ugbekun Schools',
        branchCode: student.branch?.code || 'GEN',
        studentName: `${student.lastName}, ${student.firstName}`,
        registerNo: student.registerNo,
        className: enroll.class.name,
        sectionName: enroll.section?.name || 'N/A',
        sessionName: schoolYear?.schoolYear || 'N/A',
        examName: assessment?.exam?.name || 'Term Evaluation',
        assessment: assessment || {},
        resumptionDate: assessment?.exam?.resumptionDate || null,
        formTeacherName: teacherAlloc?.teacher?.name || 'Form Teacher',
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="montessori_${student.registerNo}.pdf"`);
      return res.send(pdfBuffer);
    }

    const studentMarks = await prisma.mark.findMany({
      where: {
        studentId: Number(studentId),
        sessionId,
        branchId: req.branchId,
        ...(examId ? { examId: Number(examId) } : {}),
      },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } },
      },
    });

    const commentaryRecord = await prisma.studentCommentary.findFirst({
      where: { studentId: Number(studentId), sessionId },
      select: { remark: true },
    });

    const teacherAlloc = await prisma.teacherAllocation.findFirst({
      where: { classId: enroll.classId, sectionId: enroll.sectionId, sessionId, branchId: req.branchId },
      include: { teacher: { select: { name: true } } },
    });

    let totalScoreSum = 0;
    let marksCount = 0;

    const reportCard = studentMarks.map((m) => {
      const testScore = m.cbtMark ? parseFloat(m.cbtMark) : 0;
      const examScore = m.mark ? parseFloat(m.mark) : 0;
      const total = testScore + examScore;

      totalScoreSum += total;
      marksCount++;

      return {
        id: m.id,
        examName: m.exam.name,
        subjectName: m.subject.name,
        subjectCode: m.subject.subjectCode,
        cbtMark: m.cbtMark ? String(testScore) : null,
        theoryMark: m.mark ? String(examScore) : null,
        mark: String(total),
        absent: m.absent === '1',
        classAverage: total,
      };
    });

    const overallAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;

    const pdfBuffer = await generateReportCardPdf({
      schoolName: student.branch?.name || 'Ugbekun Schools',
      branchCode: student.branch?.code || 'GEN',
      studentName: `${student.lastName}, ${student.firstName}`,
      registerNo: student.registerNo,
      className: enroll.class.name,
      sectionName: enroll.section?.name || 'N/A',
      sessionName: schoolYear?.schoolYear || 'N/A',
      reportCard,
      overallAverage,
      commentary: commentaryRecord?.remark || '',
      rank: 1,
      totalClassStudents: 1,
      rankingType,
      rankingLimit: Number(rankingLimit),
      resumptionDate: studentMarks[0]?.exam?.resumptionDate || null,
      formTeacherName: teacherAlloc?.teacher?.name || 'Form Teacher',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report_card_${student.registerNo}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[TEACHER] Export PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate PDF report card.' });
  }
}

/**
 * GET /api/teacher/report-cards/export-batch-pdf
 */
export async function exportBatchReportCardsPdf(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, examId } = req.query as any;
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const [enrolls, schoolYear, branch, teacherAlloc] = await Promise.all([
      prisma.enroll.findMany({
        where: {
          classId: Number(classId),
          sectionId: Number(sectionId),
          sessionId,
          branchId: req.branchId,
        },
        include: {
          student: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              registerNo: true,
              commentaries: { where: { sessionId }, select: { remark: true } },
            },
          },
          class: { select: { name: true } },
          section: { select: { name: true } },
        },
        orderBy: { student: { lastName: 'asc' } },
      }),
      prisma.schoolYear.findUnique({ where: { id: sessionId } }),
      prisma.branch.findUnique({ where: { id: req.branchId }, select: { name: true, code: true } }),
      prisma.teacherAllocation.findFirst({
        where: { classId: Number(classId), sectionId: Number(sectionId), sessionId, branchId: req.branchId },
        include: { teacher: { select: { name: true } } },
      }),
    ]);

    if (enrolls.length === 0) {
      return res.status(404).json({ success: false, message: 'No enrolled students found in class.' });
    }

    const studentCards = [];
    for (const e of enrolls) {
      const marks = await prisma.mark.findMany({
        where: {
          studentId: e.student.id,
          sessionId,
          branchId: req.branchId,
          ...(examId ? { examId: Number(examId) } : {}),
        },
        include: {
          subject: { select: { name: true, subjectCode: true } },
          exam: { select: { name: true, resumptionDate: true } },
        },
      });

      let sum = 0;
      const rc = marks.map((m) => {
        const val = Number(m.mark || m.cbtMark || 0);
        sum += val;
        return {
          id: m.id,
          examName: m.exam.name,
          subjectName: m.subject.name,
          subjectCode: m.subject.subjectCode,
          cbtMark: m.cbtMark,
          theoryMark: m.mark,
          mark: String(val),
          absent: m.absent === '1',
          classAverage: val,
        };
      });

      const avg = marks.length > 0 ? Number((sum / marks.length).toFixed(1)) : 0;

      studentCards.push({
        studentName: `${e.student.lastName}, ${e.student.firstName}`,
        registerNo: e.student.registerNo,
        className: e.class.name,
        sectionName: e.section?.name || 'N/A',
        sessionName: schoolYear?.schoolYear || 'N/A',
        reportCard: rc,
        overallAverage: avg,
        commentary: e.student.commentaries[0]?.remark || '',
        rank: 1,
        totalClassStudents: enrolls.length,
        resumptionDate: marks[0]?.exam?.resumptionDate || null,
        formTeacherName: teacherAlloc?.teacher?.name || 'Form Teacher',
      });
    }

    const pdfBuffer = await generateBatchClassReportCardsPdf({
      schoolName: branch?.name || 'Ugbekun Schools',
      branchCode: branch?.code || 'GEN',
      students: studentCards,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="batch_report_cards_${classId}_${sectionId}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[TEACHER] Batch export PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate batch PDF report cards.' });
  }
}

/**
 * GET /api/teacher/montessori/sheet
 */
export async function getMontessoriSheet(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, examId } = req.query;
  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId,
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
      },
      orderBy: { student: { lastName: 'asc' } },
    });

    const studentIds = enrolls.map((e) => e.student.id);

    const assessments = await prisma.montessoriAssessment.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId,
        studentId: { in: studentIds },
        ...(examId ? { examId: Number(examId) } : {}),
      },
    });

    const assessMap: Record<number, any> = {};
    assessments.forEach((a) => {
      assessMap[a.studentId] = a;
    });

    const rows = enrolls.map((e) => ({
      studentId: e.student.id,
      firstName: e.student.firstName,
      lastName: e.student.lastName,
      registerNo: e.student.registerNo,
      photo: e.student.photo,
      assessment: assessMap[e.student.id] || null,
    }));

    return res.json({ success: true, rows });
  } catch (error) {
    console.error('[TEACHER] Montessori sheet error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve Montessori sheet.' });
  }
}

/**
 * POST /api/teacher/montessori/save-single
 */
export async function saveSingleMontessori(req: Request, res: Response): Promise<Response | void> {
  const {
    studentId,
    classId,
    sectionId,
    examId,
    writingMastery,
    drawingCapability,
    physicalCoordination,
    motorSkillProgression,
    generalPunctuality,
    peerRespect,
    aestheticNeatness,
    activeGroupParticipation,
    narrativeComment,
  } = req.body;

  if (!studentId || !classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'studentId, classId, and sectionId are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const existing = await prisma.montessoriAssessment.findFirst({
      where: {
        studentId: Number(studentId),
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId,
        ...(examId ? { examId: Number(examId) } : {}),
      },
    });

    let saved;
    if (existing) {
      saved = await prisma.montessoriAssessment.update({
        where: { id: existing.id },
        data: {
          writingMastery,
          drawingCapability,
          physicalCoordination,
          motorSkillProgression,
          generalPunctuality,
          peerRespect,
          aestheticNeatness,
          activeGroupParticipation,
          narrativeComment,
        },
      });
    } else {
      saved = await prisma.montessoriAssessment.create({
        data: {
          studentId: Number(studentId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          examId: examId ? Number(examId) : null,
          sessionId,
          branchId: req.branchId,
          writingMastery,
          drawingCapability,
          physicalCoordination,
          motorSkillProgression,
          generalPunctuality,
          peerRespect,
          aestheticNeatness,
          activeGroupParticipation,
          narrativeComment,
        },
      });
    }

    return res.json({ success: true, message: 'Montessori assessment saved.', assessment: saved });
  } catch (error) {
    console.error('[TEACHER] Save Montessori error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save Montessori assessment.' });
  }
}

/**
 * POST /api/teacher/grades/scan
 */
export async function scanGrades(req: Request, res: Response): Promise<Response | void> {
  const { classId, sectionId, subjectId, examId } = req.body;
  if (!classId || !sectionId || !subjectId || !examId || !req.file) {
    return res.status(400).json({ success: false, message: 'All fields and score sheet image are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId: req.branchId,
      },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } },
      },
    });

    const parsedData = enrolls.map((e) => ({
      rawText: `${e.student.lastName} ${e.student.firstName}`,
      matchedStudentId: e.student.id,
      matchedStudentName: `${e.student.lastName} ${e.student.firstName}`,
      extractedMark: null,
      confidence: 0.85,
    }));

    const scanRecord = await prisma.scoreSheetScan.create({
      data: {
        teacherId: req.teacherId,
        branchId: req.branchId,
        classId: Number(classId),
        sectionId: Number(sectionId),
        subjectId: Number(subjectId),
        examId: Number(examId),
        fileName: req.file.originalname || 'scan.jpg',
        fileUrl: `/uploads/${req.file.filename || 'scan.jpg'}`,
        status: 'PARSED',
        parsedData,
      },
    });

    return res.json({ success: true, scanId: scanRecord.id, parsedRows: parsedData });
  } catch (error: any) {
    console.error('[TEACHER] OCR scan error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to parse score sheet image.' });
  }
}

/**
 * GET /api/teacher/grades/scan/:id
 */
export async function getScanRecord(req: Request, res: Response): Promise<Response | void> {
  try {
    const scan = await prisma.scoreSheetScan.findUnique({
      where: { id: Number(req.params.id) },
    });
    if (!scan) {
      return res.status(404).json({ success: false, message: 'Scan record not found.' });
    }
    return res.json({ success: true, scan });
  } catch (error) {
    console.error('[TEACHER] Get scan record error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve scan record.' });
  }
}

/**
 * POST /api/teacher/grades/scan/:id/commit
 */
export async function commitScanRecord(req: Request, res: Response): Promise<Response | void> {
  const { verifiedData } = req.body;
  if (!Array.isArray(verifiedData)) {
    return res.status(400).json({ success: false, message: 'verifiedData array is required.' });
  }

  try {
    const scan = await prisma.scoreSheetScan.findUnique({
      where: { id: Number(req.params.id) },
    });
    if (!scan) {
      return res.status(404).json({ success: false, message: 'Scan record not found.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    await prisma.$transaction(async (tx) => {
      for (const row of verifiedData) {
        if (!row.matchedStudentId) continue;
        const scoreVal = row.extractedMark !== null && row.extractedMark !== undefined ? String(row.extractedMark) : null;

        const existingMark = await tx.mark.findFirst({
          where: {
            studentId: Number(row.matchedStudentId),
            subjectId: scan.subjectId,
            classId: scan.classId,
            sectionId: scan.sectionId,
            examId: scan.examId,
            sessionId,
          },
        });

        if (existingMark) {
          await tx.mark.update({
            where: { id: existingMark.id },
            data: {
              mark: scoreVal,
              absent: scoreVal === null ? 'true' : 'false',
            },
          });
        } else {
          await tx.mark.create({
            data: {
              studentId: Number(row.matchedStudentId),
              subjectId: scan.subjectId,
              classId: scan.classId,
              sectionId: scan.sectionId,
              examId: scan.examId,
              mark: scoreVal,
              absent: scoreVal === null ? 'true' : 'false',
              sessionId,
              branchId: scan.branchId,
            },
          });
        }
      }

      await tx.scoreSheetScan.update({
        where: { id: scan.id },
        data: {
          status: 'COMMITTED',
          parsedData: verifiedData,
        },
      });
    });

    return res.json({ success: true, message: 'Scores successfully committed to the production gradebook.' });
  } catch (error) {
    console.error('[TEACHER] Commit scan error:', error);
    return res.status(500).json({ success: false, message: 'Transaction failed: Could not commit marks.' });
  }
}

/**
 * POST /api/teacher/lesson-plan/generate
 */
export async function generateLessonPlan(req: Request, res: Response): Promise<Response | void> {
  const { classId, subjectId, coreTopic } = req.body;
  if (!classId || !subjectId || !coreTopic) {
    return res.status(400).json({ success: false, message: 'classId, subjectId, and coreTopic are required.' });
  }

  try {
    const classObj = await prisma.class.findUnique({
      where: { id: Number(classId) },
      select: { name: true },
    });
    const subjectObj = await prisma.subject.findUnique({
      where: { id: Number(subjectId) },
      select: { name: true },
    });

    if (!classObj || !subjectObj) {
      return res.status(404).json({ success: false, message: 'Class or Subject not found.' });
    }

    const result = await generatePedagogicalLessonPlan({
      subjectName: subjectObj.name,
      className: classObj.name,
      topic: coreTopic,
      subTopic: req.body.subTopic || '',
      duration: req.body.duration || '45 Minutes',
      weekNo: req.body.weekNo || 'Week 3',
    });

    return res.json({
      success: true,
      draft: {
        objectives: result.educationalObjectives,
        materials: result.materialLists,
        teachingGuide: result.teachingGuide,
        assessments: result.assessmentCriteria,
        assignments: result.classAssignments,
        coreTopic: result.coreTopic,
      },
    });
  } catch (error) {
    console.error('[TEACHER] AI Lesson Plan Generation Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate AI lesson plan draft.' });
  }
}

/**
 * GET /api/teacher/lesson-plan
 */
export async function getLessonPlans(req: Request, res: Response): Promise<Response | void> {
  try {
    const plans = await prisma.lessonPlan.findMany({
      where: { teacherId: req.teacherId },
      include: {
        class: { select: { name: true } },
        subject: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, plans });
  } catch (error) {
    console.error('[TEACHER] Fetch lesson plans error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch lesson plans.' });
  }
}

/**
 * POST /api/teacher/lesson-plan
 */
export async function createLessonPlan(req: Request, res: Response): Promise<Response | void> {
  const { classId, subjectId, coreTopic, objectives, materials, teachingGuide, assessments, assignments, status } =
    req.body;
  if (!classId || !subjectId || !coreTopic) {
    return res.status(400).json({ success: false, message: 'Required fields missing.' });
  }

  try {
    const plan = await prisma.lessonPlan.create({
      data: {
        teacherId: req.teacherId,
        classId: Number(classId),
        subjectId: Number(subjectId),
        coreTopic,
        educationalObjectives: objectives || null,
        materialLists: materials || null,
        teachingGuide: teachingGuide || null,
        assessmentCriteria: assessments || null,
        classAssignments: assignments || null,
        status: status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT',
      },
    });

    if (plan.status === 'PUBLISHED') {
      gamificationService
        .checkLessonPlanEarly(prisma, req.teacherId, plan.id, req.branchId)
        .catch((err: any) => console.error('[Gamification] Error in lesson plan trigger:', err.message));
    }

    return res.json({ success: true, message: 'Lesson plan saved successfully.', plan });
  } catch (error) {
    console.error('[TEACHER] Save lesson plan error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save lesson plan.' });
  }
}

/**
 * PUT /api/teacher/lesson-plan/:id
 */
export async function updateLessonPlan(req: Request, res: Response): Promise<Response | void> {
  const { objectives, materials, teachingGuide, assessments, assignments, status, coreTopic } = req.body;
  try {
    const plan = await prisma.lessonPlan.findUnique({
      where: { id: Number(req.params.id) },
    });
    if (!plan || plan.teacherId !== req.teacherId) {
      return res.status(404).json({ success: false, message: 'Lesson plan not found or access denied.' });
    }

    const updated = await prisma.lessonPlan.update({
      where: { id: plan.id },
      data: {
        coreTopic: coreTopic !== undefined ? coreTopic : plan.coreTopic,
        educationalObjectives: objectives !== undefined ? objectives : plan.educationalObjectives,
        materialLists: materials !== undefined ? materials : plan.materialLists,
        teachingGuide: teachingGuide !== undefined ? teachingGuide : plan.teachingGuide,
        assessmentCriteria: assessments !== undefined ? assessments : plan.assessmentCriteria,
        classAssignments: assignments !== undefined ? assignments : plan.classAssignments,
        status: status === 'PUBLISHED' ? 'PUBLISHED' : status === 'DRAFT' ? 'DRAFT' : plan.status,
      },
    });

    if (updated.status === 'PUBLISHED') {
      gamificationService
        .checkLessonPlanEarly(prisma, req.teacherId, updated.id, req.branchId)
        .catch((err: any) => console.error('[Gamification] Error in lesson plan trigger:', err.message));
    }

    return res.json({ success: true, message: 'Lesson plan updated successfully.', plan: updated });
  } catch (error) {
    console.error('[TEACHER] Update lesson plan error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update lesson plan.' });
  }
}

/**
 * GET /api/teacher/lesson-plan/:id/pdf
 */
export async function exportLessonPlanPdf(req: Request, res: Response): Promise<Response | void> {
  try {
    const plan = await prisma.lessonPlan.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        teacher: { select: { name: true, branchId: true } },
        class: { select: { name: true } },
        subject: { select: { name: true } },
      },
    });

    if (!plan || plan.teacherId !== req.teacherId) {
      return res.status(404).json({ success: false, message: 'Lesson plan not found or access denied.' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: req.branchId || plan.teacher.branchId || 1 },
      select: { name: true, code: true },
    });

    const pdfBuffer = await generateLessonPlanPdf({
      schoolName: branch?.name || 'Ugbekun Group of Schools',
      branchCode: branch?.code || 'MAIN',
      teacherName: plan.teacher.name || 'Subject Teacher',
      subjectName: plan.subject.name,
      className: plan.class.name,
      coreTopic: plan.coreTopic,
      educationalObjectives: plan.educationalObjectives,
      materialLists: plan.materialLists,
      teachingGuide: plan.teachingGuide,
      assessmentCriteria: plan.assessmentCriteria,
      classAssignments: plan.classAssignments,
      status: plan.status,
      createdAt: plan.createdAt,
    });

    const sanitizedTopic = (plan.coreTopic || 'Lesson_Plan').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Lesson_Plan_${sanitizedTopic}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[TEACHER] Lesson plan PDF export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to export lesson plan PDF.' });
  }
}

/**
 * GET /api/teacher/attrition/dashboard
 */
export async function getAttritionDashboard(req: Request, res: Response): Promise<Response | void> {
  try {
    const allocations = await prisma.teacherAllocation.findMany({
      where: { teacherId: req.teacherId },
      select: { classId: true, sectionId: true },
    });

    if (allocations.length === 0) {
      return res.json({ success: true, alerts: [] });
    }

    const orConditions = allocations.map((a) => ({
      classId: a.classId,
      sectionId: a.sectionId,
    }));

    const enrolledStudents = await prisma.enroll.findMany({
      where: {
        OR: orConditions,
        isAlumni: 0,
      },
      select: { studentId: true },
    });

    const studentIds = enrolledStudents.map((e) => e.studentId);

    const alerts = await prisma.interventionAlert.findMany({
      where: {
        teacherId: req.teacherId,
        risk: {
          studentId: { in: studentIds },
        },
      },
      include: {
        risk: {
          include: {
            student: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                registerNo: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, alerts });
  } catch (error) {
    console.error('[TEACHER] Attrition dashboard fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch attrition alerts.' });
  }
}

/**
 * GET /api/teacher/attrition/detail/:studentId
 */
export async function getAttritionDetail(req: Request, res: Response): Promise<Response | void> {
  try {
    const studentId = Number(req.params.studentId);

    const enroll = await prisma.enroll.findFirst({
      where: { studentId, isAlumni: 0 },
      select: { classId: true, sectionId: true },
    });

    if (!enroll) {
      return res.status(404).json({ success: false, message: 'Student enrollment not found.' });
    }

    const isAllocated = await prisma.teacherAllocation.findFirst({
      where: {
        teacherId: req.teacherId,
        classId: enroll.classId,
        sectionId: enroll.sectionId,
      },
    });

    if (!isAllocated) {
      return res
        .status(403)
        .json({ success: false, message: 'Access denied: You are not the Form Teacher for this student.' });
    }

    const risk = await prisma.studentAttritionRisk.findUnique({
      where: { studentId },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
          },
        },
        alerts: {
          where: { teacherId: req.teacherId },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!risk) {
      return res
        .status(404)
        .json({ success: false, message: 'No attrition risk profile generated for this student yet.' });
    }

    return res.json({ success: true, risk });
  } catch (error) {
    console.error('[TEACHER] Attrition detail fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch attrition detail.' });
  }
}

/**
 * POST /api/teacher/attrition/action/:alertId
 */
export async function takeAttritionAction(req: Request, res: Response): Promise<Response | void> {
  try {
    const alertId = Number(req.params.alertId);
    const { status } = req.body;

    if (!['PENDING', 'ACTIVE', 'RESOLVED', 'DISMISSED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid intervention alert status.' });
    }

    const alert = await prisma.interventionAlert.findUnique({
      where: { id: alertId },
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Intervention alert not found.' });
    }

    if (alert.teacherId !== req.teacherId) {
      return res
        .status(403)
        .json({ success: false, message: 'Access denied: You are not authorized to update this alert.' });
    }

    const updatedAlert = await prisma.interventionAlert.update({
      where: { id: alertId },
      data: { status },
    });

    if (status === 'RESOLVED') {
      await prisma.studentAttritionRisk.update({
        where: { id: alert.riskId },
        data: { isIsolated: false },
      });
    }

    return res.json({ success: true, alert: updatedAlert });
  } catch (error) {
    console.error('[TEACHER] Attrition alert action update error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update attrition alert status.' });
  }
}

/**
 * GET /api/teacher/classes-sections
 */
export async function getTeacherClassesSections(req: Request, res: Response): Promise<Response | void> {
  try {
    const branchId = req.branchId;
    const classes = await prisma.class.findMany({
      where: branchId ? { branchId } : {},
      include: {
        sections: {
          include: {
            section: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    });

    const formattedClasses = classes.map((c: any) => ({
      id: c.id,
      name: c.name,
      sections: (c.sections || []).map((s: any) => ({
        id: s.section?.id || s.sectionId,
        name: s.section?.name || 'Main',
      })),
    }));

    return res.json({ success: true, classes: formattedClasses });
  } catch (error) {
    console.error('[TEACHER] Get classes-sections error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve classes and sections.' });
  }
}

/**
 * GET /api/teacher/subjects
 */
export async function getTeacherSubjects(req: Request, res: Response): Promise<Response | void> {
  try {
    const branchId = req.branchId;
    const teacherId = req.teacherId;

    const [allBranchSubjects, teacherSubjectAssigns] = await Promise.all([
      prisma.subject.findMany({
        where: branchId ? { branchId } : {},
        orderBy: { name: 'asc' },
      }),
      teacherId
        ? prisma.subjectAssign.findMany({
            where: { teacherId },
            include: {
              subject: true,
              class: { select: { id: true, name: true } },
              section: { select: { id: true, name: true } },
            },
            orderBy: { id: 'desc' },
          })
        : Promise.resolve([]),
    ]);

    // Calculate student counts offering each subject in each class-section
    const assignedSubjects = await Promise.all(
      teacherSubjectAssigns.map(async (sa) => {
        const studentCount = await prisma.enroll.count({
          where: {
            classId: sa.classId,
            sectionId: sa.sectionId,
            isAlumni: 0,
            ...(branchId ? { branchId } : {}),
          },
        });

        return {
          id: sa.id,
          subjectId: sa.subjectId,
          subjectName: sa.subject?.name || 'Subject',
          subjectCode: sa.subject?.subjectCode || 'N/A',
          subjectType: sa.subject?.subjectType || 'Core',
          subjectAuthor: sa.subject?.subjectAuthor || null,
          classId: sa.classId,
          className: sa.class?.name || 'Class',
          sectionId: sa.sectionId,
          sectionName: sa.section?.name || 'Section',
          studentCount,
          createdAt: sa.createdAt,
        };
      })
    );

    // Calculate KPI summary metrics
    const uniqueSubjectIds = new Set(assignedSubjects.map((s) => s.subjectId));
    const uniqueClassSectionKeys = new Set(assignedSubjects.map((s) => `${s.classId}-${s.sectionId}`));
    const totalStudentsOffering = assignedSubjects.reduce((sum, s) => sum + s.studentCount, 0);

    return res.json({
      success: true,
      subjects: allBranchSubjects,
      assignedSubjects,
      kpi: {
        totalAssignedSubjects: uniqueSubjectIds.size,
        totalClassesTaught: uniqueClassSectionKeys.size,
        totalStudentsOffering,
      },
    });
  } catch (error) {
    console.error('[TEACHER] Get subjects error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve subjects.' });
  }
}

/**
 * GET /api/teacher/subjects/:assignId/students
 */
export async function getSubjectStudents(req: Request, res: Response): Promise<Response | void> {
  try {
    const assignId = Number(req.params.assignId);
    const subjectAssign = await prisma.subjectAssign.findUnique({
      where: { id: assignId },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
      },
    });

    if (!subjectAssign) {
      return res.status(404).json({ success: false, message: 'Subject assignment not found.' });
    }

    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: subjectAssign.classId,
        sectionId: subjectAssign.sectionId,
        isAlumni: 0,
      },
      include: {
        student: {
          select: {
            id: true,
            registerNo: true,
            firstName: true,
            lastName: true,
            gender: true,
            photo: true,
            email: true,
            mobileno: true,
          },
        },
      },
      orderBy: {
        student: {
          lastName: 'asc',
        },
      },
    });

    const students = enrolls.map((e) => ({
      id: e.student.id,
      registerNo: e.student.registerNo,
      fullName: `${e.student.firstName || ''} ${e.student.lastName || ''}`.trim() || 'Student',
      gender: e.student.gender || 'N/A',
      photo: e.student.photo,
      roll: e.roll,
    }));

    return res.json({
      success: true,
      subject: subjectAssign.subject,
      class: subjectAssign.class,
      section: subjectAssign.section,
      totalStudents: students.length,
      students,
    });
  } catch (error) {
    console.error('[TEACHER] Get subject students error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve subject students.' });
  }
}

