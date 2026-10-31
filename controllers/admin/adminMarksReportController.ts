import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';
import {
  generateReportCardPdf,
  generateMontessoriReportCardPdf,
  generateCommentBasedReportCardPdf,
  generateBatchClassReportCardsPdf,
} from '../../lib/pdfService';
import { generateBatchClassCommentary } from '../../lib/commentaryService';
import {
  listSubmittedAttendance,
  summarizeSubmittedAttendanceByStudent,
  summarizeSubmittedLogs,
} from '../../lib/attendanceRegisterService';
import { parseMarkScore } from '../../lib/markParser';
import { resolveGradingScale } from '../../lib/gradingService';

export function getRatingLabel(rating: number): string {
  switch (rating) {
    case 1:
      return '1 - Emerging';
    case 2:
      return '2 - Developing';
    case 3:
      return '3 - Satisfactory';
    case 4:
      return '4 - Proficient';
    case 5:
      return '5 - Advanced';
    default:
      return `${rating} / 5`;
  }
}

/**
 * GET /api/admin/marks-entry
 */
export async function getMarksEntry(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, subjectId, sessionId } = req.query;

    if (!classId || !subjectId) {
      return res.status(400).json({ success: false, message: 'classId and subjectId are required.' });
    }

    const cId = Number(classId);
    const subId = Number(subjectId);
    const secId = sectionId ? Number(sectionId) : undefined;

    const classData = await prisma.class.findFirst({
      where: { id: cId, branchId },
      include: { evaluationMatrix: true },
    });

    if (!classData) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    let matrix: any = classData.evaluationMatrix;
    if (!matrix) {
      matrix = await prisma.evaluationMatrix.findFirst({
        where: { branchId, isDefault: true },
      });
    }
    if (!matrix) {
      matrix = await prisma.evaluationMatrix.findFirst({
        where: { branchId },
      });
    }
    if (matrix) {
      matrix = {
        ...matrix,
        generalHeading: matrix.generalHeading && String(matrix.generalHeading).trim() ? String(matrix.generalHeading).trim() : 'Termly Report',
      };
    } else {
      matrix = {
        id: 0,
        name: 'Continuous Assessment & Examination',
        code: 'CA-EXAM',
        generalHeading: 'Termly Report',
        description: 'Standard Assessment Matrix',
        totalMarks: 100,
        isDefault: true,
        components: [
          { code: 'CA', name: 'Continuous Assessment', maxMarks: 40, passMarks: 20 },
          { code: 'EXAM', name: 'Terminal Examination', maxMarks: 60, passMarks: 30 },
        ],
      };
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    let activeSession = sessionId ? Number(sessionId) : globalSetting?.sessionId || 6;

    const enrollWhere: any = {
      classId: cId,
      branchId,
      isAlumni: 0,
      sessionId: activeSession,
    };
    if (secId) enrollWhere.sectionId = secId;

    let enrolls = await prisma.enroll.findMany({
      where: enrollWhere,
      include: {
        student: {
          select: { id: true, firstName: true, lastName: true, registerNo: true, gender: true },
        },
        section: { select: { id: true, name: true } },
      },
      orderBy: [{ roll: 'asc' }, { id: 'desc' }],
    });

    if (enrolls.length === 0) {
      // Fallback: look for latest session enrollments for this class
      const fallbackEnroll = await prisma.enroll.findFirst({
        where: { classId: cId, branchId, isAlumni: 0, ...(secId ? { sectionId: secId } : {}) },
        orderBy: { sessionId: 'desc' },
        select: { sessionId: true },
      });
      if (fallbackEnroll?.sessionId) {
        activeSession = fallbackEnroll.sessionId;
        enrolls = await prisma.enroll.findMany({
          where: {
            classId: cId,
            branchId,
            isAlumni: 0,
            sessionId: activeSession,
            ...(secId ? { sectionId: secId } : {}),
          },
          include: {
            student: {
              select: { id: true, firstName: true, lastName: true, registerNo: true, gender: true },
            },
            section: { select: { id: true, name: true } },
          },
          orderBy: [{ roll: 'asc' }, { id: 'desc' }],
        });
      }
    }

    // Exclude students who have since been promoted or enrolled in a higher/different class in this branch
    const candidateStudentIds = Array.from(new Set(enrolls.map((e) => e.studentId)));
    if (candidateStudentIds.length > 0) {
      const latestEnrolls = await prisma.enroll.findMany({
        where: {
          studentId: { in: candidateStudentIds },
          branchId,
          isAlumni: 0,
        },
        orderBy: [{ sessionId: 'desc' }, { id: 'desc' }],
      });

      const latestClassByStudent = new Map<number, number>();
      for (const le of latestEnrolls) {
        if (!latestClassByStudent.has(le.studentId)) {
          latestClassByStudent.set(le.studentId, le.classId);
        }
      }

      enrolls = enrolls.filter((e) => {
        const currentActiveClsId = latestClassByStudent.get(e.studentId);
        return currentActiveClsId === cId;
      });
    }

    const studentMap = new Map<number, any>();
    for (const e of enrolls) {
      if (e.student && !studentMap.has(e.student.id)) {
        studentMap.set(e.student.id, {
          id: e.student.id,
          name: [e.student.firstName, e.student.lastName].filter(Boolean).join(' ') || `Student #${e.student.id}`,
          roll: e.roll ? String(e.roll) : null,
          registerNo: e.student.registerNo,
          sectionName: e.section?.name,
        });
      }
    }

    const students = Array.from(studentMap.values());
    const studentIds = students.map((s) => s.id);

    // Query onlineExamSubmissions for CBT scores
    let cbtSubmissions: any[] = [];
    if (studentIds.length > 0) {
      try {
        cbtSubmissions = await prisma.onlineExamSubmission.findMany({
          where: {
            studentId: { in: studentIds },
            OR: [
              { submittedAt: { not: null } },
              { totalMark: { not: null } },
            ],
            onlineExam: {
              classId: cId,
              subjectId: subId,
              branchId,
            },
          },
          include: {
            onlineExam: {
              select: { id: true, title: true },
            },
          },
          orderBy: { id: 'desc' },
        });
      } catch (cbtErr) {
        console.warn('[MARKS] Could not fetch CBT submissions for marks entry:', cbtErr);
        cbtSubmissions = [];
      }
    }

    const cbtSubmissionMap: Record<number, any> = {};
    cbtSubmissions.forEach((sub) => {
      if (!cbtSubmissionMap[sub.studentId]) {
        cbtSubmissionMap[sub.studentId] = sub;
      }
    });

    const existingMarks = await prisma.mark.findMany({
      where: {
        branchId,
        classId: cId,
        subjectId: subId,
        sessionId: activeSession,
        ...(secId ? { sectionId: secId } : {}),
      },
    });

    const marksMap: Record<number, any> = {};
    existingMarks.forEach((m) => {
      let parsedComponents = {};
      try {
        if (m.mark && m.mark.startsWith('{')) {
          parsedComponents = JSON.parse(m.mark);
        }
      } catch (err) {
        // fallback
      }

      const cbtSub = cbtSubmissionMap[m.studentId];
      const hasCbtMark = m.cbtMark !== null && m.cbtMark !== undefined && String(m.cbtMark).trim() !== '';
      const cbtSubScore = cbtSub
        ? (cbtSub.totalMark !== null && cbtSub.totalMark !== undefined
            ? String(cbtSub.totalMark)
            : (cbtSub.score !== null && cbtSub.score !== undefined ? String(cbtSub.score) : null))
        : null;
      const effectiveCbt = hasCbtMark ? String(m.cbtMark) : cbtSubScore;

      marksMap[m.studentId] = {
        id: m.id,
        mark: m.mark,
        cbtMark: effectiveCbt,
        cbtSource: m.cbtSource || (cbtSub ? 'ONLINE_EXAM_SUBMISSION' : null),
        cbtExamTitle: cbtSub?.onlineExam?.title || null,
        cbtTotalMarks: cbtSub?.onlineExam?.totalMarks || null,
        absent: m.absent === '1' || m.absent === 'true',
        components: parsedComponents,
      };
    });

    // Populate for enrolled students who completed a CBT test but do not yet have a mark entry
    studentIds.forEach((sId) => {
      if (!marksMap[sId] && cbtSubmissionMap[sId]) {
        const cbtSub = cbtSubmissionMap[sId];
        const fallbackMark = cbtSub.totalMark !== null && cbtSub.totalMark !== undefined
          ? String(cbtSub.totalMark)
          : (cbtSub.score !== null && cbtSub.score !== undefined ? String(cbtSub.score) : null);
        marksMap[sId] = {
          id: 0,
          mark: '',
          cbtMark: fallbackMark,
          cbtSource: 'ONLINE_EXAM_SUBMISSION',
          cbtExamTitle: cbtSub.onlineExam?.title || null,
          cbtTotalMarks: cbtSub.onlineExam?.totalMarks || null,
          absent: false,
          components: {},
        };
      }
    });

    const parsedTermId = req.query.termId ? Number(req.query.termId) : 1;
    const commentsMap: Record<number, any> = {};
    if (classData.usesScores === false && studentIds.length > 0) {
      const existingComments = await prisma.subjectCommentAssessment.findMany({
        where: {
          studentId: { in: studentIds },
          classId: cId,
          subjectId: subId,
          sessionId: activeSession,
          termId: parsedTermId,
          branchId,
        },
      });
      existingComments.forEach((c) => {
        commentsMap[c.studentId] = {
          id: c.id,
          comment: c.comment,
          rating: c.rating,
          ratingLabel: getRatingLabel(c.rating),
        };
      });
    }

    return res.json({
      success: true,
      matrix,
      students,
      marksMap,
      commentsMap,
      usesScores: classData.usesScores ?? true,
      isCommentBased: !(classData.usesScores ?? true),
      classData: {
        id: classData.id,
        name: classData.name,
        evaluationMatrixId: classData.evaluationMatrixId,
        usesScores: classData.usesScores ?? true,
        isEcd: classData.isEcd || false,
        isCommentBased: !(classData.usesScores ?? true),
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Fetch marks entry error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch marks entry data.' });
  }
}

/**
 * GET /api/admin/subject-comments
 * Retrieve qualitative developmental comments for a class, subject, session, and term.
 */
export async function getSubjectComments(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId, subjectId, sessionId, termId } = req.query;

  if (!classId || !subjectId) {
    return res.status(400).json({ success: false, message: 'classId and subjectId are required.' });
  }

  try {
    const cId = Number(classId);
    const subId = Number(subjectId);
    const parsedTermId = termId ? Number(termId) : 1;

    const classData = await prisma.class.findFirst({
      where: { id: cId, branchId },
    });

    if (!classData) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    let activeSession = sessionId ? Number(sessionId) : globalSetting?.sessionId || 6;

    const enrollWhere: any = {
      classId: cId,
      branchId,
      isAlumni: 0,
      sessionId: activeSession,
    };
    if (sectionId) enrollWhere.sectionId = Number(sectionId);

    const enrolls = await prisma.enroll.findMany({
      where: enrollWhere,
      include: {
        student: {
          select: { id: true, firstName: true, lastName: true, registerNo: true, gender: true },
        },
        section: { select: { id: true, name: true } },
      },
      orderBy: [{ roll: 'asc' }, { id: 'desc' }],
    });

    const studentIds = Array.from(new Set(enrolls.map((e) => e.studentId)));

    const comments = await prisma.subjectCommentAssessment.findMany({
      where: {
        studentId: { in: studentIds },
        classId: cId,
        subjectId: subId,
        sessionId: activeSession,
        termId: parsedTermId,
        branchId,
      },
    });

    const commentsMap: Record<number, any> = {};
    comments.forEach((c) => {
      commentsMap[c.studentId] = {
        id: c.id,
        comment: c.comment,
        rating: c.rating,
        ratingLabel: getRatingLabel(c.rating),
      };
    });

    const students = enrolls.map((e) => ({
      id: e.student.id,
      name: [e.student.firstName, e.student.lastName].filter(Boolean).join(' ') || `Student #${e.student.id}`,
      registerNo: e.student.registerNo,
      sectionName: e.section?.name,
      comment: commentsMap[e.student.id]?.comment || '',
      rating: commentsMap[e.student.id]?.rating || 3,
    }));

    return res.json({
      success: true,
      usesScores: classData.usesScores,
      isCommentBased: !classData.usesScores,
      classData: { id: classData.id, name: classData.name, usesScores: classData.usesScores },
      students,
      commentsMap,
    });
  } catch (error: any) {
    console.error('[ADMIN] Fetch subject comments error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch subject comments.' });
  }
}

/**
 * POST /api/admin/subject-comments/batch-save
 * Batch upserts qualitative subject comments and 1-5 ratings.
 */
export async function saveSubjectCommentsBatch(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, subjectId, sessionId, termId, assessments } = req.body;

  if (!classId || !subjectId || !Array.isArray(assessments)) {
    return res.status(400).json({
      success: false,
      message: 'classId, subjectId, and assessments array are required.',
    });
  }

  const cId = Number(classId);
  const subId = Number(subjectId);
  const parsedTermId = termId ? Number(termId) : 1;

  try {
    const classData = await prisma.class.findFirst({
      where: { id: cId, branchId },
    });

    if (!classData) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSession = sessionId ? Number(sessionId) : globalSetting?.sessionId || 6;

    const savedRecords = await prisma.$transaction(async (tx) => {
      const results: any[] = [];

      for (const item of assessments) {
        if (!item.studentId) continue;
        const studentId = Number(item.studentId);
        const comment = typeof item.comment === 'string' ? item.comment.trim() : '';
        let rating = Number(item.rating) || 3;
        if (rating < 1) rating = 1;
        if (rating > 5) rating = 5;

        const student = await tx.student.findFirst({
          where: { id: studentId, branchId },
        });
        if (!student) continue;

        const record = await tx.subjectCommentAssessment.upsert({
          where: {
            studentId_subjectId_termId_sessionId: {
              studentId,
              subjectId: subId,
              termId: parsedTermId,
              sessionId: activeSession,
            },
          },
          create: {
            studentId,
            subjectId: subId,
            classId: cId,
            termId: parsedTermId,
            sessionId: activeSession,
            branchId,
            comment,
            rating,
          },
          update: {
            comment,
            rating,
            classId: cId,
          },
        });
        results.push(record);
      }
      return results;
    });

    return res.json({
      success: true,
      message: `Successfully saved ${savedRecords.length} developmental comment assessments.`,
      savedCount: savedRecords.length,
    });
  } catch (error: any) {
    console.error('[ADMIN] Batch save subject comments error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save subject comments.' });
  }
}

/**
 * POST /api/admin/marks-entry/batch-save
 */
export async function saveMarksEntryBatch(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, subjectId, sessionId, examId, marks } = req.body;

    if (!classId || !subjectId || !Array.isArray(marks)) {
      return res.status(400).json({ success: false, message: 'Invalid batch save payload.' });
    }

    const cId = Number(classId);
    const subId = Number(subjectId);
    const secId = sectionId ? Number(sectionId) : 1;
    const exId = examId ? Number(examId) : 1;
    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSession = sessionId ? Number(sessionId) : globalSetting?.sessionId || 1;

    let savedCount = 0;

    for (const item of marks) {
      if (!item.studentId) continue;

      const sId = Number(item.studentId);
      const isAbsentStr = item.absent ? '1' : '0';
      const markValue = item.components ? JSON.stringify(item.components) : String(item.mark || '0');

      const existing = await prisma.mark.findFirst({
        where: {
          branchId,
          classId: cId,
          subjectId: subId,
          studentId: sId,
          sessionId: activeSession,
        },
      });

      if (existing) {
        await prisma.mark.update({
          where: { id: existing.id },
          data: {
            mark: markValue,
            absent: isAbsentStr,
          },
        });
      } else {
        await prisma.mark.create({
          data: {
            branchId,
            classId: cId,
            sectionId: secId,
            subjectId: subId,
            studentId: sId,
            examId: exId,
            sessionId: activeSession,
            mark: markValue,
            absent: isAbsentStr,
          },
        });
      }
      savedCount++;
    }

    return res.json({
      success: true,
      savedCount,
      message: `Batch marks save completed (${savedCount} student records updated).`,
    });
  } catch (error: any) {
    console.error('[ADMIN] Batch save marks error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to batch save marks.' });
  }
}

/**
 * POST /api/admin/marks-entry/ai-distribute
 */
export async function aiDistributeMarks(req: Request, res: Response): Promise<Response | void> {
  try {
    const { matrixComponents, studentTotals } = req.body;

    if (!Array.isArray(matrixComponents) || matrixComponents.length === 0) {
      return res.status(400).json({ success: false, message: 'Matrix components are required.' });
    }

    if (!Array.isArray(studentTotals) || studentTotals.length === 0) {
      return res.status(400).json({ success: false, message: 'Student totals array is required.' });
    }

    const matrixTotalMax =
      matrixComponents.reduce((sum: number, c: any) => sum + (Number(c.maxMarks) || 0), 0) || 100;

    const distributedMarksMap: Record<number, any> = {};

    studentTotals.forEach((st: any) => {
      const studentId = st.studentId;
      const totalScore = Math.min(Math.max(Number(st.totalScore) || 0, 0), matrixTotalMax);

      const components: Record<string, number> = {};
      let allocatedSum = 0;

      matrixComponents.forEach((comp: any, idx: number) => {
        const compMax = Number(comp.maxMarks) || 0;
        const isLast = idx === matrixComponents.length - 1;

        if (isLast) {
          components[comp.name] = Math.max(0, Math.round(totalScore - allocatedSum));
        } else {
          const ratio = compMax / matrixTotalMax;
          const assigned = Math.round(totalScore * ratio);
          components[comp.name] = assigned;
          allocatedSum += assigned;
        }
      });

      distributedMarksMap[studentId] = {
        totalScore,
        components,
      };
    });

    return res.json({
      success: true,
      distributedMarksMap,
      message: `Proportionally distributed scores across ${matrixComponents.length} assessment categories.`,
    });
  } catch (error: any) {
    console.error('[ADMIN] AI marks distribution error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to distribute marks.' });
  }
}

/**
 * Helper to resolve the correct academic session ID for report cards.
 * If a session is requested by the client, use it.
 * Otherwise, fall back to global settings, and if that session has 0 enrollments
 * for this branch, intelligently detect the latest session with enrollments.
 */
async function resolveReportCardSession(branchId?: number, requestedSessionId?: any): Promise<number> {
  if (requestedSessionId && !isNaN(Number(requestedSessionId)) && Number(requestedSessionId) > 0) {
    return Number(requestedSessionId);
  }

  const globalSetting = await prisma.globalSettings.findFirst();
  const defaultSessionId = globalSetting?.sessionId || 5;

  if (branchId) {
    const enrollCount = await prisma.enroll.count({
      where: { sessionId: defaultSessionId, branchId },
    });
    if (enrollCount > 0) {
      return defaultSessionId;
    }

    const latestWithStudents = await prisma.enroll.findFirst({
      where: { branchId },
      orderBy: { sessionId: 'desc' },
      select: { sessionId: true },
    });
    if (latestWithStudents?.sessionId) {
      return latestWithStudents.sessionId;
    }
  }

  return defaultSessionId;
}

/**
 * GET /api/admin/commentary/pending
 */
export async function getPendingCommentary(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const sessionId = await resolveReportCardSession(branchId, req.query.sessionId);

    const commentaries = await prisma.studentCommentary.findMany({
      where: {
        branchId,
        sessionId,
      },
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
      orderBy: {
        updatedAt: 'desc',
      },
    });

    return res.json({ success: true, commentaries });
  } catch (error) {
    console.error('[ADMIN] Fetch pending commentaries error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch commentaries.' });
  }
}

/**
 * POST /api/admin/commentary/review
 */
export async function reviewCommentary(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { commentaryId, status, reviewNotes } = req.body;

  if (!commentaryId || !status) {
    return res.status(400).json({ success: false, message: 'commentaryId and status are required.' });
  }

  if (!['PRINCIPAL_SIGNED_OFF', 'REJECTED'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status. Must be PRINCIPAL_SIGNED_OFF or REJECTED.' });
  }

  try {
    const existing = await prisma.studentCommentary.findUnique({
      where: { id: Number(commentaryId) },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Commentary record not found.' });
    }

    if (existing.branchId !== branchId) {
      return res.status(403).json({ success: false, message: 'Access denied: commentary belongs to another branch.' });
    }

    await prisma.studentCommentary.update({
      where: { id: existing.id },
      data: {
        status,
        reviewerId: req.userId,
        reviewNotes: reviewNotes || null,
      },
    });

    gamificationService
      .checkStudentCommentaryApproval(prisma, existing.id, status, branchId!)
      .catch((err: any) => console.error('[Gamification] Error in commentary review trigger:', err.message));

    return res.json({ success: true, message: `Commentary ${status.toLowerCase()} successfully.` });
  } catch (error) {
    console.error('[ADMIN] Review commentary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to review commentary.' });
  }
}

/**
 * GET /api/admin/report-cards/classes
 */
export async function getReportCardClasses(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const sessionId = await resolveReportCardSession(branchId, req.query.sessionId);

    const sessions = await prisma.schoolYear.findMany({
      orderBy: { id: 'desc' },
      select: { id: true, schoolYear: true },
    });

    const classes = await prisma.class.findMany({
      where: { branchId },
      include: {
        sections: {
          select: {
            section: { select: { id: true, name: true } },
          },
        },
        enrolls: {
          where: { sessionId, branchId },
          select: { studentId: true, sectionId: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    const classPubs = await prisma.classReportCardPublication.findMany({
      where: {
        sessionId,
        isPublished: true,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
      },
      select: { classId: true, sectionId: true },
    });
    const publishedClassIds = new Set(classPubs.map((p) => p.classId));

    const formatted = classes.map((c) => {
      const secMap: Record<number, any> = {};
      c.sections.forEach((s) => {
        if (s.section) {
          secMap[s.section.id] = {
            id: s.section.id,
            name: s.section.name,
            studentCount: 0,
          };
        }
      });

      c.enrolls.forEach((e) => {
        if (secMap[e.sectionId]) {
          secMap[e.sectionId].studentCount += 1;
        }
      });

      return {
        id: c.id,
        name: c.name,
        isEcd: c.isEcd || false,
        usesScores: c.usesScores ?? true,
        isCommentBased: !(c.usesScores ?? true),
        isPublished: publishedClassIds.has(c.id),
        totalEnrolled: c.enrolls.length,
        sections: Object.values(secMap),
      };
    });

    return res.json({
      success: true,
      sessionId,
      sessions: sessions.map((s) => ({ id: s.id, name: s.schoolYear })),
      classes: formatted,
    });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Get classes error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch classes.' });
  }
}

async function resolveNextTermFees(prismaClient: any, branchId?: number | null, classId?: number | null): Promise<string> {
  if (!branchId) return '₦125,000';
  try {
    const feeAssignments = await prismaClient.feeAssignment.findMany({
      where: {
        branchId,
        active: true,
        ...(classId ? { OR: [{ classId }, { classId: null }] } : {}),
      },
      include: {
        feeType: { select: { amount: true, active: true } },
      },
    });

    let sum = 0;
    feeAssignments.forEach((fa: any) => {
      if (fa.feeType && fa.feeType.active) {
        sum += Number(fa.feeType.amount || 0);
      }
    });

    if (sum > 0) {
      return `₦${sum.toLocaleString()}`;
    }
  } catch {
    // fallback
  }
  return '₦125,000';
}

/**
 * GET /api/admin/report-cards/students
 */
export async function getReportCardStudents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId, sessionId: reqSessionId, stage, termId } = (req.query || {}) as any;

  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    const parsedClassId = Number(classId);
    const parsedSectionId = Number(sectionId);
    // COMBINED_CA is the new scope: CA1 + CA2, out of (maxCA1 + maxCA2), rank hidden
    const activeStage = String(stage || 'FULL').toUpperCase();
    const isCombinedCaScope = activeStage === 'COMBINED_CA';
    const parsedTermId = termId ? Number(termId) : 1;

    let sessionId = await resolveReportCardSession(branchId, reqSessionId);

    const cls = await prisma.class.findUnique({
      where: { id: parsedClassId },
      select: { name: true, isEcd: true, usesScores: true },
    });

    let enrolls = await prisma.enroll.findMany({
      where: {
        classId: parsedClassId,
        sectionId: parsedSectionId,
        sessionId,
        branchId,
        isAlumni: 0,
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            gender: true,
            photo: true,
          },
        },
      },
      orderBy: [{ student: { lastName: 'asc' } }, { id: 'desc' }],
    });

    // Fallback: If 0 students in the given session, look for the latest session with enrollments for this class & section
    if (enrolls.length === 0) {
      const fallbackEnroll = await prisma.enroll.findFirst({
        where: {
          classId: parsedClassId,
          sectionId: parsedSectionId,
          branchId,
          isAlumni: 0,
        },
        orderBy: { sessionId: 'desc' },
        select: { sessionId: true },
      });

      if (fallbackEnroll?.sessionId) {
        sessionId = fallbackEnroll.sessionId;
        enrolls = await prisma.enroll.findMany({
          where: {
            classId: parsedClassId,
            sectionId: parsedSectionId,
            sessionId,
            branchId,
            isAlumni: 0,
          },
          include: {
            student: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                registerNo: true,
                gender: true,
                photo: true,
              },
            },
          },
          orderBy: [{ student: { lastName: 'asc' } }, { id: 'desc' }],
        });
      }
    }

    // Fallback 2: If still 0, check if students are enrolled in this class regardless of section
    if (enrolls.length === 0) {
      const fallbackClassEnroll = await prisma.enroll.findFirst({
        where: {
          classId: parsedClassId,
          branchId,
          isAlumni: 0,
        },
        orderBy: { sessionId: 'desc' },
        select: { sessionId: true },
      });

      if (fallbackClassEnroll?.sessionId) {
        sessionId = fallbackClassEnroll.sessionId;
        enrolls = await prisma.enroll.findMany({
          where: {
            classId: parsedClassId,
            sessionId,
            branchId,
            isAlumni: 0,
          },
          include: {
            student: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                registerNo: true,
                gender: true,
                photo: true,
              },
            },
          },
          orderBy: [{ student: { lastName: 'asc' } }, { id: 'desc' }],
        });
      }
    }

    // Exclude students who have since been promoted or enrolled in a higher/different class in this branch
    const candidateStudentIds = Array.from(new Set(enrolls.map((e) => e.studentId)));
    if (candidateStudentIds.length > 0) {
      const latestEnrolls = await prisma.enroll.findMany({
        where: {
          studentId: { in: candidateStudentIds },
          branchId,
          isAlumni: 0,
        },
        orderBy: [{ sessionId: 'desc' }, { id: 'desc' }],
      });

      const latestClassByStudent = new Map<number, number>();
      for (const le of latestEnrolls) {
        if (!latestClassByStudent.has(le.studentId)) {
          latestClassByStudent.set(le.studentId, le.classId);
        }
      }

      enrolls = enrolls.filter((e) => {
        const currentActiveClsId = latestClassByStudent.get(e.studentId);
        return currentActiveClsId === parsedClassId;
      });
    }

    const reportStudentMap = new Map<number, any>();
    for (const e of enrolls) {
      if (e.student && !reportStudentMap.has(e.studentId)) {
        reportStudentMap.set(e.studentId, e);
      }
    }
    const dedupedEnrolls = Array.from(reportStudentMap.values());
    const studentIds = dedupedEnrolls.map((e) => e.studentId);

    const marks = await prisma.mark.findMany({
      where: {
        studentId: { in: studentIds },
        sessionId,
        branchId,
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        exam: { select: { id: true, name: true } },
      },
    });

    const commentaries = await prisma.studentCommentary.findMany({
      where: {
        studentId: { in: studentIds },
        sessionId,
        branchId,
      },
    });
    const commMap: Record<number, any> = {};
    commentaries.forEach((c) => {
      commMap[c.studentId] = c;
    });

    const montessoriList = await prisma.montessoriAssessment.findMany({
      where: {
        studentId: { in: studentIds },
        sessionId,
        branchId,
      },
    });
    const montMap: Record<number, any> = {};
    montessoriList.forEach((m) => {
      montMap[m.studentId] = m;
    });

    const isCommentClass = cls?.usesScores === false;
    const studentCommentsMap: Record<number, any[]> = {};
    if (isCommentClass && studentIds.length > 0) {
      const subjectCommentsList = await prisma.subjectCommentAssessment.findMany({
        where: {
          studentId: { in: studentIds },
          classId: parsedClassId,
          sessionId,
          termId: parsedTermId,
          branchId,
        },
        include: {
          subject: { select: { id: true, name: true, subjectCode: true } },
        },
        orderBy: { subject: { name: 'asc' } },
      });

      studentIds.forEach((id) => {
        studentCommentsMap[id] = [];
      });
      subjectCommentsList.forEach((sc) => {
        if (!studentCommentsMap[sc.studentId]) studentCommentsMap[sc.studentId] = [];
        studentCommentsMap[sc.studentId].push({
          id: sc.id,
          subjectId: sc.subjectId,
          subjectName: sc.subject?.name || 'Subject',
          subjectCode: sc.subject?.subjectCode || 'N/A',
          comment: sc.comment,
          rating: sc.rating,
          ratingLabel: getRatingLabel(sc.rating),
        });
      });
    }

    const { logs: attendanceRecords } = await listSubmittedAttendance(prisma, {
      studentIds,
      classId: parsedClassId,
      sectionId: parsedSectionId,
      sessionId,
      branchId,
    });
    const attendanceByStudent = summarizeSubmittedAttendanceByStudent(attendanceRecords);
    const attMap: Record<number, { total: number; present: number; absent: number; late: number }> = {};
    studentIds.forEach((id) => {
      const summary = attendanceByStudent.get(id) || summarizeSubmittedLogs([]);
      attMap[id] = {
        total: summary.totalDays,
        present: summary.inAttendance,
        absent: summary.absentCount,
        late: summary.lateCount,
      };
    });

    const studentMarksMap: Record<number, any[]> = {};
    const studentAggregates: Record<number, any> = {};
    studentIds.forEach((id) => {
      studentMarksMap[id] = [];
      studentAggregates[id] = { sum: 0, count: 0, totalMarks: 0 };
    });

    marks.forEach((m) => {
      const parsed = parseMarkScore(m.mark, m.cbtMark);
      if (studentMarksMap[m.studentId]) {
        // Stage filtering: isolate CA1, CA2, Combined CA, or Exam
        let scoreForStage = parsed.total;
        if (activeStage === 'CA1') {
          scoreForStage = parsed.testScore > 0 ? parsed.testScore : parsed.total;
        } else if (activeStage === 'CA2') {
          scoreForStage = parsed.testScore > 0 ? parsed.testScore : parsed.total;
        } else if (activeStage === 'COMBINED_CA') {
          // Combined CA: sum CA1 + CA2 component scores (testScore is CA mark)
          scoreForStage = parsed.testScore > 0 ? parsed.testScore : parsed.total;
        } else if (activeStage === 'EXAM') {
          scoreForStage = parsed.examScore > 0 ? parsed.examScore : parsed.total;
        }

        studentMarksMap[m.studentId].push({
          id: m.id,
          examName: m.exam?.name || 'Evaluation',
          subjectName: m.subject?.name || 'Subject',
          subjectCode: m.subject?.subjectCode || 'N/A',
          cbtMark: parsed.testScore > 0 ? String(parsed.testScore) : null,
          theoryMark: isCombinedCaScope ? null : (parsed.examScore > 0 ? String(parsed.examScore) : null), // strip exam column in COMBINED_CA
          mark: parsed.hasValidScore ? String(parsed.total) : null,
          stageScore: scoreForStage,
          absent: m.absent === '1' || m.absent === 'true',
        });
        if (parsed.hasValidScore) {
          studentAggregates[m.studentId].sum += scoreForStage;
          studentAggregates[m.studentId].count += 1;
          studentAggregates[m.studentId].totalMarks += scoreForStage;
        }
      }
    });

    const scores = studentIds.map((id) => ({
      id,
      avg: studentAggregates[id].count > 0 ? studentAggregates[id].sum / studentAggregates[id].count : 0,
    }));
    scores.sort((a, b) => b.avg - a.avg);

    const rankMap: Record<number, number> = {};
    scores.forEach((item, idx) => {
      rankMap[item.id] = idx + 1;
    });

    const studentList = dedupedEnrolls.map((e) => {
      const st = e.student;
      const agg = studentAggregates[st.id] || { sum: 0, count: 0, totalMarks: 0 };
      const avg = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(1)) : 0;
      const rk = rankMap[st.id] || null;
      const comm = commMap[st.id];
      const mont = montMap[st.id];
      const att = attMap[st.id] || { total: 0, present: 0, absent: 0, late: 0 };
      const subComments = studentCommentsMap[st.id] || [];

      let grade = 'F';
      if (avg >= 70) grade = 'A';
      else if (avg >= 60) grade = 'B';
      else if (avg >= 50) grade = 'C';
      else if (avg >= 45) grade = 'D';
      else if (avg >= 40) grade = 'E';

      const getOrdinal = (n: number) => {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
      };

      return {
        id: st.id,
        studentName: `${st.lastName}, ${st.firstName}`,
        firstName: st.firstName,
        lastName: st.lastName,
        admissionNo: st.registerNo || 'N/A',
        registerNo: st.registerNo,
        className: cls?.name || 'Classroom',
        gender: st.gender || 'N/A',
        usesScores: !isCommentClass,
        isCommentBased: isCommentClass,
        totalMarks: isCommentClass ? null : agg.totalMarks,
        average: isCommentClass ? null : avg,
        grade: isCommentClass ? null : grade,
        // COMBINED_CA: rank and promotion are strictly hidden per spec
        position: (isCommentClass || isCombinedCaScope) ? null : (rk ? `${getOrdinal(rk)} out of ${studentIds.length}` : 'N/A'),
        rank: (isCommentClass || isCombinedCaScope) ? null : rk,
        attendanceDays: att.total > 0 ? `${att.present} / ${att.total} Days` : '0 Days Logged',
        presentCount: att.present,
        absentCount: att.absent,
        totalAttendanceDays: att.total,
        teacherComment: comm?.remark || mont?.narrativeComment || '',
        principalComment:
          comm?.reviewNotes ||
          (isCommentClass
            ? 'Demonstrating positive qualitative developmental progression.'
            : (avg >= 70
              ? 'Promoted with distinction.'
              : avg >= 50
              ? 'Good progress. Promoted.'
              : 'Needs improvement.')),
        commentStatus: comm?.status || 'PENDING',
        isAiGenerated: comm?.isAiGenerated || false,
        psychomotor: {
          writingMastery: mont?.writingMastery || 'AC',
          drawingCapability: mont?.drawingCapability || 'AC',
          physicalCoordination: mont?.physicalCoordination || 'AC',
          motorSkillProgression: mont?.motorSkillProgression || 'AC',
        },
        affective: {
          generalPunctuality: mont?.generalPunctuality || 'AC',
          peerRespect: mont?.peerRespect || 'AC',
          aestheticNeatness: mont?.aestheticNeatness || 'AC',
          activeGroupParticipation: mont?.activeGroupParticipation || 'AC',
        },
        isEcd: cls?.isEcd || false,
        subjectsCount: isCommentClass ? subComments.length : (studentMarksMap[st.id]?.length || 0),
        reportCard: isCommentClass ? [] : (studentMarksMap[st.id] || []),
        subjectComments: subComments,
      };
    });

    const classPub = await prisma.classReportCardPublication.findFirst({
      where: {
        classId: parsedClassId,
        sessionId,
        ...(parsedSectionId ? { OR: [{ sectionId: parsedSectionId }, { sectionId: null }] } : {}),
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
      },
      orderBy: { id: 'desc' },
    });
    const isPublished = Boolean(
      classPub && (classPub.isPublished || classPub.releaseCa1 || classPub.releaseCa2 || classPub.releaseExam || classPub.releaseFull)
    );

    return res.json({
      success: true,
      sessionId,
      stage: activeStage,
      isCombinedCaScope,
      // maxTotal: for COMBINED_CA scope this should be the sum of CA component maxMarks (e.g. 40 for CA1+CA2 each out of 20)
      // The frontend uses this to render the /40 header on combined CA report cards
      maxTotal: isCombinedCaScope ? null : 100, // null = let frontend compute from component weights
      termId: parsedTermId,
      className: cls?.name || 'Classroom',
      classId: parsedClassId,
      sectionId: parsedSectionId,
      isEcd: cls?.isEcd || false,
      usesScores: cls?.usesScores ?? true,
      isCommentBased: isCommentClass,
      isPublished,
      publication: classPub ? {
        isPublished: classPub.isPublished,
        releaseCa1: classPub.releaseCa1,
        releaseCa2: classPub.releaseCa2,
        releaseCombinedCa: classPub.releaseCombinedCa,
        releaseExam: classPub.releaseExam,
        releaseFull: classPub.releaseFull,
        termId: classPub.termId,
      } : {
        isPublished: false,
        releaseCa1: false,
        releaseCa2: false,
        releaseCombinedCa: false,
        releaseExam: false,
        releaseFull: false,
        termId: parsedTermId,
      },
      totalStudents: studentList.length,
      students: studentList,
    });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Get students error:', error);
    return res.status(500).json({ success: false, message: 'Failed to compile student report cards.' });
  }
}

/**
 * GET /api/admin/report-cards/export-pdf
 */
export async function exportReportCardPdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId, studentId, rankingType = 'full', rankingLimit = 3, sessionId: reqSessionId } = (req.query || {}) as any;

  if (!classId || !sectionId || !studentId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and studentId are required.' });
  }

  try {
    const parsedStudentId = Number(studentId);
    const parsedClassId = Number(classId);
    const parsedSectionId = Number(sectionId);

    const studentEnroll = await prisma.enroll.findFirst({
      where: {
        studentId: parsedStudentId,
        classId: parsedClassId,
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { sessionId: 'desc' },
      select: { sessionId: true },
    });

    const sessionId = reqSessionId
      ? Number(reqSessionId)
      : (studentEnroll?.sessionId || (await resolveReportCardSession(branchId)));

    const student = await prisma.student.findUnique({
      where: { id: parsedStudentId },
      include: { branch: { select: { name: true, code: true } } },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const cls = await prisma.class.findUnique({ where: { id: parsedClassId }, select: { name: true, isEcd: true, usesScores: true } });
    const sec = await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } });
    const sess = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } });

    const className = cls?.name || 'Classroom';
    const sectionName = sec?.name || 'Main';
    const sessionName = sess?.schoolYear || 'Active Session';

    let formTeacherName = 'Form Teacher';
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
      include: { teacher: { select: { name: true } } },
    });
    if (formAllocation?.teacher) formTeacherName = formAllocation.teacher.name;

    if (cls?.usesScores === false) {
      const subjectComments = await prisma.subjectCommentAssessment.findMany({
        where: {
          studentId: parsedStudentId,
          classId: parsedClassId,
          sessionId,
          branchId,
        },
        include: { subject: { select: { name: true, subjectCode: true } } },
        orderBy: { subject: { name: 'asc' } },
      });

      const commentary = await prisma.studentCommentary.findFirst({
        where: { studentId: parsedStudentId, sessionId, branchId },
      });

      const mont = await prisma.montessoriAssessment.findFirst({
        where: { studentId: parsedStudentId, sessionId, branchId },
      });

      const nextTermFees = await resolveNextTermFees(prisma, branchId, parsedClassId);

      const pdfBuffer = await generateCommentBasedReportCardPdf({
        schoolName: student.branch?.name || 'Ugbekun Schools',
        branchCode: student.branch?.code || 'GEN',
        studentName: `${student.lastName}, ${student.firstName}`,
        registerNo: student.registerNo,
        className,
        sectionName,
        sessionName,
        examName: 'Developmental Evaluation',
        subjectComments: subjectComments.map((sc) => ({
          subjectName: sc.subject?.name || 'Subject',
          comment: sc.comment,
          rating: sc.rating,
          ratingLabel: getRatingLabel(sc.rating),
        })),
        teacherComment: commentary?.remark || mont?.narrativeComment || 'Pupil displays steady qualitative developmental progression.',
        principalComment: commentary?.reviewNotes || 'Demonstrating positive qualitative developmental milestones.',
        nextTermFees,
        resumptionDate: null,
        formTeacherName,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="report_card_${student.lastName}_${student.firstName}.pdf"`
      );
      return res.send(pdfBuffer);
    }

    if (cls?.isEcd) {
      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: parsedStudentId,
          classId: parsedClassId,
          sectionId: parsedSectionId,
          sessionId,
          branchId,
        },
        include: { exam: { select: { name: true, resumptionDate: true } } },
      });

      const pdfBuffer = await generateMontessoriReportCardPdf({
        schoolName: student.branch?.name || 'Ugbekun Schools',
        branchCode: student.branch?.code || 'GEN',
        studentName: `${student.lastName}, ${student.firstName}`,
        registerNo: student.registerNo,
        className,
        sectionName,
        sessionName,
        examName: assessment?.exam?.name || 'Term Evaluation',
        assessment: assessment || {},
        resumptionDate: assessment?.exam?.resumptionDate || null,
        formTeacherName,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="report_card_${student.lastName}_${student.firstName}.pdf"`
      );
      return res.send(pdfBuffer);
    }

    const marks = await prisma.mark.findMany({
      where: { studentId: parsedStudentId, sessionId, branchId },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } },
      },
    });

    const allClassMarks = await prisma.mark.findMany({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
      select: { examId: true, subjectId: true, mark: true, cbtMark: true, studentId: true },
    });
    const avgMap: Record<string, any> = {};
    allClassMarks.forEach((m) => {
      const k = `${m.examId}-${m.subjectId}`;
      if (!avgMap[k]) avgMap[k] = { sum: 0, count: 0 };
      const parsed = parseMarkScore(m.mark, m.cbtMark);
      if (parsed.hasValidScore) {
        avgMap[k].sum += parsed.total;
        avgMap[k].count += 1;
      }
    });

    let totalSum = 0;
    let marksCount = 0;
    const reportCard = marks.map((m) => {
      const parsed = parseMarkScore(m.mark, m.cbtMark);
      if (parsed.hasValidScore) {
        totalSum += parsed.total;
        marksCount += 1;
      }

      const k = `${m.examId}-${m.subjectId}`;
      const cAvg =
        avgMap[k] && avgMap[k].count > 0 ? Number((avgMap[k].sum / avgMap[k].count).toFixed(1)) : parsed.total;

      return {
        id: m.id,
        examName: m.exam?.name || 'Term Evaluation',
        subjectName: m.subject?.name || 'Subject',
        subjectCode: m.subject?.subjectCode || 'N/A',
        cbtMark: parsed.testScore > 0 ? String(parsed.testScore) : null,
        theoryMark: parsed.examScore > 0 ? String(parsed.examScore) : null,
        mark: parsed.hasValidScore ? String(parsed.total) : null,
        absent: m.absent === '1' || m.absent === 'true',
        classAverage: cAvg,
      };
    });

    const overallAverage = marksCount > 0 ? Number((totalSum / marksCount).toFixed(1)) : 0;

    const enrolls = await prisma.enroll.findMany({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
      select: { studentId: true },
    });
    const studentIds = enrolls.map((e) => e.studentId);
    const aggMap: Record<number, any> = {};
    studentIds.forEach((id) => {
      aggMap[id] = { sum: 0, count: 0 };
    });
    allClassMarks.forEach((m) => {
      if (aggMap[m.studentId]) {
        const parsed = parseMarkScore(m.mark, m.cbtMark);
        if (parsed.hasValidScore) {
          aggMap[m.studentId].sum += parsed.total;
          aggMap[m.studentId].count += 1;
        }
      }
    });
    const scoreRankList = studentIds
      .map((id) => ({
        id,
        avg: aggMap[id]?.count > 0 ? aggMap[id].sum / aggMap[id].count : 0,
      }))
      .sort((a, b) => b.avg - a.avg);

    const rankIdx = scoreRankList.findIndex((s) => s.id === parsedStudentId);
    const rank = rankIdx !== -1 ? rankIdx + 1 : null;

    const comm = await prisma.studentCommentary.findFirst({
      where: { studentId: parsedStudentId, sessionId, branchId },
    });

    const gradingScale = await resolveGradingScale(prisma, branchId, parsedClassId);
    const nextTermFeesStr = await resolveNextTermFees(prisma, branchId, parsedClassId);
    const activeStage = String((req.query as any)?.stage || 'FULL').toUpperCase();
    const isMidTerm = activeStage === 'CA1' || activeStage === 'CA2';

    const pdfBuffer = await generateReportCardPdf({
      schoolName: student.branch?.name || 'Ugbekun Schools',
      branchCode: student.branch?.code || 'GEN',
      studentName: `${student.lastName}, ${student.firstName}`,
      registerNo: student.registerNo,
      className,
      sectionName,
      sessionName,
      reportCard,
      overallAverage,
      commentary: comm?.remark || '',
      rank,
      totalClassStudents: studentIds.length,
      rankingType,
      rankingLimit: Number(rankingLimit),
      resumptionDate: marks[0]?.exam?.resumptionDate || null,
      nextTermFees: nextTermFeesStr,
      formTeacherName,
      gradingRanges: gradingScale.ranges,
      isMidTerm,
      stage: activeStage,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report_card_${student.lastName}_${student.firstName}.pdf"`
    );
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Single PDF export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate report card PDF.' });
  }
}

/**
 * GET /api/admin/report-cards/export-batch-pdf
 */
export async function exportBatchReportCardsPdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId, rankingType = 'full', rankingLimit = 3, sessionId: reqSessionId, stage, termId } = (req.query || {}) as any;

  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    const parsedClassId = Number(classId);
    const parsedSectionId = Number(sectionId);
    const activeStage = String(stage || 'FULL').toUpperCase();
    const isMidTerm = activeStage === 'CA1' || activeStage === 'CA2';

    let sessionId = reqSessionId ? Number(reqSessionId) : 0;
    if (!sessionId) {
      const classEnroll = await prisma.enroll.findFirst({
        where: { classId: parsedClassId, sectionId: parsedSectionId, branchId },
        orderBy: { sessionId: 'desc' },
        select: { sessionId: true },
      });
      sessionId = classEnroll?.sessionId || (await resolveReportCardSession(branchId));
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true, code: true },
    });

    const cls = await prisma.class.findUnique({ where: { id: parsedClassId }, select: { name: true, isEcd: true, usesScores: true } });
    const sec = await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } });
    const sess = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } });

    const className = cls?.name || 'Classroom';
    const sectionName = sec?.name || 'Main';
    const sessionName = sess?.schoolYear || 'Active Session';

    let formTeacherName = 'Form Teacher';
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
      include: { teacher: { select: { name: true } } },
    });
    if (formAllocation?.teacher) formTeacherName = formAllocation.teacher.name;

    let enrolls = await prisma.enroll.findMany({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } },
      },
      orderBy: { student: { lastName: 'asc' } },
    });

    if (enrolls.length === 0) {
      const fallbackEnroll = await prisma.enroll.findFirst({
        where: { classId: parsedClassId, sectionId: parsedSectionId, branchId },
        orderBy: { sessionId: 'desc' },
        select: { sessionId: true },
      });
      if (fallbackEnroll?.sessionId) {
        sessionId = fallbackEnroll.sessionId;
        enrolls = await prisma.enroll.findMany({
          where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
          include: {
            student: { select: { id: true, firstName: true, lastName: true, registerNo: true } },
          },
          orderBy: { student: { lastName: 'asc' } },
        });
      }
    }

    const studentIds = enrolls.map((e) => e.studentId);

    if (studentIds.length === 0) {
      return res.status(404).json({ success: false, message: 'No enrolled students found in this class/section.' });
    }

    const allMarks = await prisma.mark.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } },
      },
    });

    const avgMap: Record<string, any> = {};
    allMarks.forEach((m) => {
      const k = `${m.examId}-${m.subjectId}`;
      if (!avgMap[k]) avgMap[k] = { sum: 0, count: 0 };
      const parsed = parseMarkScore(m.mark, m.cbtMark);
      if (parsed.hasValidScore) {
        avgMap[k].sum += parsed.total;
        avgMap[k].count += 1;
      }
    });

    const studentAggregates: Record<number, any> = {};
    const studentMarksMap: Record<number, any[]> = {};
    studentIds.forEach((id) => {
      studentAggregates[id] = { sum: 0, count: 0 };
      studentMarksMap[id] = [];
    });

    allMarks.forEach((m) => {
      const parsed = parseMarkScore(m.mark, m.cbtMark);

      if (studentMarksMap[m.studentId]) {
        const k = `${m.examId}-${m.subjectId}`;
        const cAvg =
          avgMap[k] && avgMap[k].count > 0 ? Number((avgMap[k].sum / avgMap[k].count).toFixed(1)) : parsed.total;

        let scoreForStage = parsed.total;
        if (activeStage === 'CA1') {
          scoreForStage = parsed.testScore > 0 ? parsed.testScore : parsed.total;
        } else if (activeStage === 'CA2') {
          scoreForStage = parsed.testScore > 0 ? parsed.testScore : parsed.total;
        } else if (activeStage === 'EXAM') {
          scoreForStage = parsed.examScore > 0 ? parsed.examScore : parsed.total;
        }

        studentMarksMap[m.studentId].push({
          id: m.id,
          examName: m.exam?.name || 'Evaluation',
          subjectName: m.subject?.name || 'Subject',
          subjectCode: m.subject?.subjectCode || 'N/A',
          cbtMark: parsed.testScore > 0 ? String(parsed.testScore) : null,
          theoryMark: parsed.examScore > 0 ? String(parsed.examScore) : null,
          mark: parsed.hasValidScore ? String(parsed.total) : null,
          stageScore: scoreForStage,
          absent: m.absent === '1' || m.absent === 'true',
          classAverage: cAvg,
        });

        if (parsed.hasValidScore) {
          studentAggregates[m.studentId].sum += scoreForStage;
          studentAggregates[m.studentId].count += 1;
        }
      }
    });

    const rankList = studentIds
      .map((id) => ({
        id,
        avg: studentAggregates[id].count > 0 ? studentAggregates[id].sum / studentAggregates[id].count : 0,
      }))
      .sort((a, b) => b.avg - a.avg);

    const rankMap: Record<number, number> = {};
    rankList.forEach((item, idx) => {
      rankMap[item.id] = idx + 1;
    });

    const commentaries = await prisma.studentCommentary.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId },
    });
    const commMap: Record<number, any> = {};
    commentaries.forEach((c) => {
      commMap[c.studentId] = c;
    });

    const montessoriList = await prisma.montessoriAssessment.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId },
      include: { exam: { select: { name: true, resumptionDate: true } } },
    });
    const montMap: Record<number, any> = {};
    montessoriList.forEach((m) => {
      montMap[m.studentId] = m;
    });

    const gradingScale = await resolveGradingScale(prisma, branchId, parsedClassId);
    const nextTermFeesStr = await resolveNextTermFees(prisma, branchId, parsedClassId);

    const isCommentClass = cls?.usesScores === false;
    const subjectCommentsByStudent: Record<number, any[]> = {};
    if (isCommentClass && studentIds.length > 0) {
      const subjectCommentsList = await prisma.subjectCommentAssessment.findMany({
        where: {
          studentId: { in: studentIds },
          classId: parsedClassId,
          sessionId,
          branchId,
        },
        include: { subject: { select: { name: true, subjectCode: true } } },
        orderBy: { subject: { name: 'asc' } },
      });
      subjectCommentsList.forEach((sc) => {
        if (!subjectCommentsByStudent[sc.studentId]) subjectCommentsByStudent[sc.studentId] = [];
        subjectCommentsByStudent[sc.studentId].push({
          subjectName: sc.subject?.name || 'Subject',
          comment: sc.comment,
          rating: sc.rating,
          ratingLabel: getRatingLabel(sc.rating),
        });
      });
    }

    const batchStudents = enrolls.map((e) => {
      const st = e.student;
      const agg = studentAggregates[st.id] || { sum: 0, count: 0 };
      const avg = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(1)) : 0;
      const rk = rankMap[st.id] || null;
      const comm = commMap[st.id];
      const mont = montMap[st.id];

      return {
        studentName: `${st.lastName}, ${st.firstName}`,
        registerNo: st.registerNo || 'N/A',
        isEcd: cls?.isEcd || false,
        usesScores: !isCommentClass,
        isCommentBased: isCommentClass,
        reportCard: isCommentClass ? [] : (studentMarksMap[st.id] || []),
        subjectComments: subjectCommentsByStudent[st.id] || [],
        overallAverage: isCommentClass ? 0 : avg,
        commentary: comm?.remark || '',
        rank: isCommentClass ? null : rk,
        totalClassStudents: studentIds.length,
        rankingType,
        rankingLimit: Number(rankingLimit),
        resumptionDate: allMarks[0]?.exam?.resumptionDate || null,
        nextTermFees: nextTermFeesStr,
        formTeacherName,
        examName: mont?.exam?.name || 'Term Evaluation',
        assessment: mont || {},
        gradingRanges: gradingScale.ranges,
        isMidTerm,
        stage: activeStage,
      };
    });

    const pdfBuffer = await generateBatchClassReportCardsPdf({
      schoolName: branch?.name || 'Ugbekun Schools',
      branchCode: branch?.code || 'GEN',
      className,
      sectionName,
      sessionName,
      students: batchStudents,
    });

    const safeClassName = className.replace(/\s+/g, '_');
    const safeSectionName = sectionName.replace(/\s+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="batch_report_cards_${safeClassName}_${safeSectionName}.pdf"`
    );
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Batch PDF export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate batch report cards PDF.' });
  }
}

/**
 * POST /api/admin/report-cards/commentary
 */
export async function saveReportCardCommentary(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { studentId, classId, sectionId, remark, principalRemark, status = 'PRINCIPAL_SIGNED_OFF', sessionId: reqSessionId } = req.body || {};

  if (!studentId || !classId || !sectionId || !remark) {
    return res.status(400).json({ success: false, message: 'studentId, classId, sectionId, and remark are required.' });
  }

  try {
    let sessionId = reqSessionId ? Number(reqSessionId) : 0;
    if (!sessionId) {
      const studentEnroll = await prisma.enroll.findFirst({
        where: { studentId: Number(studentId), classId: Number(classId), branchId },
        orderBy: { sessionId: 'desc' },
        select: { sessionId: true },
      });
      sessionId = studentEnroll?.sessionId || (await resolveReportCardSession(branchId));
    }

    const commentary = await prisma.studentCommentary.upsert({
      where: {
        studentId_sessionId: {
          studentId: Number(studentId),
          sessionId,
        },
      },
      update: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        remark: remark.trim(),
        reviewNotes: principalRemark ? principalRemark.trim() : undefined,
        status,
        reviewerId: req.userId,
        isEditedByHuman: true,
        branchId,
      },
      create: {
        studentId: Number(studentId),
        classId: Number(classId),
        sectionId: Number(sectionId),
        remark: remark.trim(),
        reviewNotes: principalRemark ? principalRemark.trim() : undefined,
        status,
        reviewerId: req.userId,
        sessionId,
        branchId,
      },
    });

    return res.json({ success: true, message: 'Commentary saved to student report card.', commentary });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Save commentary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save commentary.' });
  }
}

/**
 * POST /api/admin/report-cards/behavioral
 */
export async function saveReportCardBehavioral(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { studentId, classId, sectionId, psychomotor = {}, affective = {}, narrativeComment, sessionId: reqSessionId } = req.body || {};

  if (!studentId || !classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'studentId, classId, and sectionId are required.' });
  }

  try {
    let sessionId = reqSessionId ? Number(reqSessionId) : 0;
    if (!sessionId) {
      const studentEnroll = await prisma.enroll.findFirst({
        where: { studentId: Number(studentId), classId: Number(classId), branchId },
        orderBy: { sessionId: 'desc' },
        select: { sessionId: true },
      });
      sessionId = studentEnroll?.sessionId || (await resolveReportCardSession(branchId));
    }

    const exam = await prisma.exam.findFirst({
      where: { branchId, sessionId },
      select: { id: true },
    });
    const examId = exam?.id || 1;

    const assessment = await prisma.montessoriAssessment.upsert({
      where: {
        studentId_examId_sessionId: {
          studentId: Number(studentId),
          examId,
          sessionId,
        },
      },
      update: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        writingMastery: psychomotor.writingMastery,
        drawingCapability: psychomotor.drawingCapability,
        physicalCoordination: psychomotor.physicalCoordination,
        motorSkillProgression: psychomotor.motorSkillProgression,
        generalPunctuality: affective.generalPunctuality,
        peerRespect: affective.peerRespect,
        aestheticNeatness: affective.aestheticNeatness,
        activeGroupParticipation: affective.activeGroupParticipation,
        narrativeComment: narrativeComment ? narrativeComment.trim() : undefined,
        branchId,
      },
      create: {
        studentId: Number(studentId),
        classId: Number(classId),
        sectionId: Number(sectionId),
        examId,
        sessionId,
        writingMastery: psychomotor.writingMastery || 'AC',
        drawingCapability: psychomotor.drawingCapability || 'AC',
        physicalCoordination: psychomotor.physicalCoordination || 'AC',
        motorSkillProgression: psychomotor.motorSkillProgression || 'AC',
        generalPunctuality: affective.generalPunctuality || 'AC',
        peerRespect: affective.peerRespect || 'AC',
        aestheticNeatness: affective.aestheticNeatness || 'AC',
        activeGroupParticipation: affective.activeGroupParticipation || 'AC',
        narrativeComment: narrativeComment ? narrativeComment.trim() : undefined,
        branchId,
      },
    });

    return res.json({ success: true, message: 'Behavioral and psychomotor ratings saved successfully.', assessment });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Save behavioral error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save behavioral ratings.' });
  }
}

/**
 * POST /api/admin/report-cards/ai-comments
 */
export async function generateAiComments(req: Request, res: Response): Promise<Response | void> {
  const { studentName = 'The student', averageScore = 75 } = req.body || {};

  try {
    const avg = Number(averageScore) || 75;
    let teacherComment = '';
    let principalComment = '';

    if (avg >= 80) {
      teacherComment = `${studentName} has demonstrated exceptional intellectual mastery, intellectual curiosity, and exemplary discipline throughout this academic term. A stellar role model for classmates.`;
      principalComment = `An outstanding academic distinction. Commended for scholastic excellence and promoted with honors!`;
    } else if (avg >= 70) {
      teacherComment = `${studentName} exhibits strong analytical capability and steady academic commitment. Consistently puts in commendable effort across all subjects.`;
      principalComment = `Very good academic performance. Promoted with praise. Keep up the high standard!`;
    } else if (avg >= 60) {
      teacherComment = `${studentName} is a hardworking and attentive pupil who shows solid understanding of core concepts. Encouraged to participate more actively in classroom discussions.`;
      principalComment = `Satisfactory terminal result. Has the capability to achieve even higher grades next session. Promoted.`;
    } else if (avg >= 50) {
      teacherComment = `${studentName} has made fair progress this term. Regular study revision and attention to homework assignments will yield stronger attainment.`;
      principalComment = `Pass grade achieved. Advised to focus diligently on foundational subjects during the upcoming term.`;
    } else {
      teacherComment = `${studentName} requires closer academic guidance and targeted remedial assistance to improve overall comprehension and performance.`;
      principalComment = `Performance falls below the expected benchmark. Recommended for structured holiday remedial support.`;
    }

    return res.json({
      success: true,
      teacherComment,
      principalComment,
      isAiGenerated: true,
    });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] AI comments error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate comments.' });
  }
}

/**
 * POST /api/admin/report-cards/batch-generate-commentary
 */
export async function batchGenerateCommentary(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId, tone = 'constructive', behavioralTags = [], sessionId: reqSessionId } = req.body || {};

  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    let sessionId = reqSessionId ? Number(reqSessionId) : 0;
    if (!sessionId) {
      const classEnroll = await prisma.enroll.findFirst({
        where: { classId: Number(classId), sectionId: Number(sectionId), branchId },
        orderBy: { sessionId: 'desc' },
        select: { sessionId: true },
      });
      sessionId = classEnroll?.sessionId || (await resolveReportCardSession(branchId));
    }

    const enrollments = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        branchId,
        sessionId,
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            gender: true,
          },
        },
      },
    });

    const studentsData: any[] = [];

    for (const enr of enrollments) {
      const st = enr.student;
      if (!st) continue;

      const marks = await prisma.mark.findMany({
        where: { studentId: st.id, sessionId, branchId },
        include: { subject: { select: { name: true } } },
      });

      const marksBySubject: any = {};
      for (const m of marks) {
        if (!m.mark || m.absent === '1') continue;
        const parsed = parseMarkScore(m.mark, m.cbtMark);
        if (parsed.hasValidScore) {
          marksBySubject[m.subject.name] = parsed.total;
        }
      }

      const scoresList: number[] = Object.values(marksBySubject) as any;
      const avg =
        scoresList.length > 0
          ? Math.round(scoresList.reduce((a: number, b: number) => a + b, 0) / scoresList.length)
          : 70;

      const { summary: attSummary } = await listSubmittedAttendance(prisma, {
        studentId: st.id,
        sessionId,
        branchId,
      });
      const attendanceRate = Math.round(attSummary.percentage);

      const existingComm = await prisma.studentCommentary.findUnique({
        where: {
          studentId_sessionId: {
            studentId: st.id,
            sessionId,
          },
        },
      });

      studentsData.push({
        studentId: st.id,
        studentName: `${st.firstName} ${st.lastName}`,
        registerNo: st.registerNo || '',
        averageScore: avg,
        attendanceRate,
        marksBySubject,
        behavioralTags,
        existingRemark: existingComm?.remark || null,
      });
    }

    const batchGenerated = await generateBatchClassCommentary(studentsData, tone);

    return res.json({
      success: true,
      count: batchGenerated.length,
      commentaries: batchGenerated,
    });
  } catch (err) {
    console.error('[ADMIN] Batch commentary generate error:', err);
    return res.status(500).json({ success: false, message: 'Failed to batch generate commentary.' });
  }
}

/**
 * POST /api/admin/report-cards/batch-save-commentary
 */
export async function batchSaveCommentary(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId, commentaries = [], status = 'APPROVED_BY_PRINCIPAL', sessionId: reqSessionId } = req.body || {};

  if (!classId || !sectionId || !Array.isArray(commentaries)) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and commentaries array required.' });
  }

  try {
    let sessionId = reqSessionId ? Number(reqSessionId) : 0;
    if (!sessionId) {
      const classEnroll = await prisma.enroll.findFirst({
        where: { classId: Number(classId), sectionId: Number(sectionId), branchId },
        orderBy: { sessionId: 'desc' },
        select: { sessionId: true },
      });
      sessionId = classEnroll?.sessionId || (await resolveReportCardSession(branchId));
    }

    let savedCount = 0;

    for (const item of commentaries) {
      if (!item.studentId || !item.remark) continue;

      await prisma.studentCommentary.upsert({
        where: {
          studentId_sessionId: {
            studentId: Number(item.studentId),
            sessionId,
          },
        },
        update: {
          classId: Number(classId),
          sectionId: Number(sectionId),
          remark: item.remark.trim(),
          reviewNotes: item.principalRemark ? item.principalRemark.trim() : undefined,
          status,
          reviewerId: req.userId,
          isEditedByHuman: true,
          branchId,
        },
        create: {
          studentId: Number(item.studentId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          remark: item.remark.trim(),
          reviewNotes: item.principalRemark ? item.principalRemark.trim() : undefined,
          status,
          reviewerId: req.userId,
          sessionId,
          branchId,
        },
      });
      savedCount++;
    }

    return res.json({
      success: true,
      savedCount,
      message: `Batch commentary saved for ${savedCount} students.`,
    });
  } catch (err) {
    console.error('[ADMIN] Batch save commentary error:', err);
    return res.status(500).json({ success: false, message: 'Failed to batch save commentary.' });
  }
}

/**
 * GET /api/admin/report-cards/publish-status
 */
export async function getReportCardPublishStatus(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { sessionId: reqSessionId, classId, sectionId, termId } = (req.query || {}) as any;

  try {
    const sessionId = await resolveReportCardSession(branchId, reqSessionId);
    const parsedTermId = termId ? Number(termId) : undefined;

    // If checking for a specific class
    if (classId) {
      const parsedClassId = Number(classId);
      const parsedSectionId = sectionId ? Number(sectionId) : null;
      const classPub = await prisma.classReportCardPublication.findFirst({
        where: {
          classId: parsedClassId,
          sessionId,
          ...(parsedSectionId ? { OR: [{ sectionId: parsedSectionId }, { sectionId: null }] } : {}),
          ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
          ...(parsedTermId ? { termId: parsedTermId } : {}),
        },
        orderBy: { id: 'desc' },
      });

      const cls = await prisma.class.findUnique({
        where: { id: parsedClassId },
        select: { name: true },
      });

      const isPublished = Boolean(
        classPub && (classPub.isPublished || classPub.releaseCa1 || classPub.releaseCa2 || classPub.releaseExam || classPub.releaseFull)
      );

      return res.json({
        success: true,
        sessionId,
        classId: parsedClassId,
        className: cls?.name || 'Class',
        isPublished,
        releaseCa1: Boolean(classPub?.releaseCa1),
        releaseCa2: Boolean(classPub?.releaseCa2),
        releaseCombinedCa: Boolean(classPub?.releaseCombinedCa),
        releaseExam: Boolean(classPub?.releaseExam),
        releaseFull: Boolean(classPub?.releaseFull),
        termId: classPub?.termId || parsedTermId || 1,
      });
    }

    // Session-wide overview of all published classes
    const [allClasses, publishedPubs] = await Promise.all([
      prisma.class.findMany({
        where: { ...(branchId ? { branchId } : {}) },
        select: { id: true, name: true },
      }),
      prisma.classReportCardPublication.findMany({
        where: {
          sessionId,
          isPublished: true,
          ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
          ...(parsedTermId ? { termId: parsedTermId } : {}),
        },
        select: { classId: true, releaseCa1: true, releaseCa2: true, releaseExam: true, releaseFull: true },
      }),
    ]);

    const publishedClassSet = new Set(publishedPubs.map((p) => p.classId));
    const publishedClassesCount = allClasses.filter((c) => publishedClassSet.has(c.id)).length;
    const isSessionFullyPublished = allClasses.length > 0 && publishedClassesCount === allClasses.length;

    return res.json({
      success: true,
      sessionId,
      isPublished: publishedClassesCount > 0,
      isFullyPublished: isSessionFullyPublished,
      publishedClassesCount,
      totalClassesCount: allClasses.length,
      classes: allClasses.map((c) => ({
        id: c.id,
        name: c.name,
        isPublished: publishedClassSet.has(c.id),
      })),
    });
  } catch (err) {
    console.error('[ADMIN] Get publish status error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve report card publication status.' });
  }
}

/**
 * POST /api/admin/report-cards/toggle-publish
 * Solely accessible by School Admin
 */
export async function togglePublishReportCards(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const adminUserId = req.userId;
  const {
    classId,
    sectionId,
    sessionId: reqSessionId,
    publish,
    publishAllClasses,
    releaseCa1,
    releaseCa2,
    releaseCombinedCa,
    releaseExam,
    releaseFull,
    termId,
  } = req.body || {};

  try {
    const sessionId = await resolveReportCardSession(branchId, reqSessionId);
    const parsedTermId = termId ? Number(termId) : 1;

    let targetCa1 = releaseCa1 !== undefined ? Boolean(releaseCa1) : undefined;
    let targetCa2 = releaseCa2 !== undefined ? Boolean(releaseCa2) : undefined;
    let targetCombinedCa = releaseCombinedCa !== undefined ? Boolean(releaseCombinedCa) : undefined;
    let targetExam = releaseExam !== undefined ? Boolean(releaseExam) : undefined;
    let targetFull = releaseFull !== undefined ? Boolean(releaseFull) : undefined;

    if (targetFull === true) {
      targetCa1 = true;
      targetCa2 = true;
      targetCombinedCa = true;
      targetExam = true;
      targetFull = true;
    } else if (publish === false && targetCa1 === undefined && targetCa2 === undefined && targetCombinedCa === undefined && targetExam === undefined && targetFull === undefined) {
      targetCa1 = false;
      targetCa2 = false;
      targetCombinedCa = false;
      targetExam = false;
      targetFull = false;
    } else if (publish === true && targetCa1 === undefined && targetCa2 === undefined && targetCombinedCa === undefined && targetExam === undefined && targetFull === undefined) {
      targetCa1 = true;
      targetCa2 = true;
      targetCombinedCa = true;
      targetExam = true;
      targetFull = true;
    }

    const finalCa1 = targetCa1 ?? false;
    const finalCa2 = targetCa2 ?? false;
    const finalCombinedCa = targetCombinedCa ?? false;
    const finalExam = targetExam ?? false;
    const finalFull = targetFull ?? false;
    const finalIsPublished = Boolean(finalCa1 || finalCa2 || finalCombinedCa || finalExam || finalFull);

    // Option A: Admin chooses to bulk publish/unpublish ALL classes in the session
    if (publishAllClasses) {
      const allClasses = await prisma.class.findMany({
        where: { ...(branchId ? { branchId } : {}) },
        select: { id: true },
      });

      for (const cls of allClasses) {
        const existing = await prisma.classReportCardPublication.findFirst({
          where: {
            classId: cls.id,
            sessionId,
            ...(branchId ? { branchId } : {}),
            termId: parsedTermId,
          },
        });

        if (existing) {
          await prisma.classReportCardPublication.update({
            where: { id: existing.id },
            data: {
              isPublished: finalIsPublished,
              releaseCa1: finalCa1,
              releaseCa2: finalCa2,
              releaseCombinedCa: finalCombinedCa,
              releaseExam: finalExam,
              releaseFull: finalFull,
              termId: parsedTermId,
              publishedBy: adminUserId || null,
              publishedAt: new Date(),
            },
          });
        } else {
          await prisma.classReportCardPublication.create({
            data: {
              classId: cls.id,
              sessionId,
              branchId: branchId || null,
              termId: parsedTermId,
              isPublished: finalIsPublished,
              releaseCa1: finalCa1,
              releaseCa2: finalCa2,
              releaseCombinedCa: finalCombinedCa,
              releaseExam: finalExam,
              releaseFull: finalFull,
              publishedBy: adminUserId || null,
              publishedAt: new Date(),
            },
          });
        }
      }

      // Also sync exam table publishResult for global compatibility
      await prisma.exam.updateMany({
        where: {
          sessionId,
          ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
        },
        data: {
          publishResult: finalIsPublished ? 1 : 0,
        },
      });

      const stagesText = finalFull
        ? 'Full Terminal Report'
        : [finalCa1 && 'CA1', finalCa2 && 'CA2', finalCombinedCa && 'Combined CA', finalExam && 'Exam'].filter(Boolean).join(' + ') || 'Draft';
      const actionText = finalIsPublished ? `published (${stagesText}) to students & parents` : 'returned to moderation/draft mode';
      return res.json({
        success: true,
        isPublished: finalIsPublished,
        releaseCa1: finalCa1,
        releaseCa2: finalCa2,
        releaseCombinedCa: finalCombinedCa,
        releaseExam: finalExam,
        releaseFull: finalFull,
        termId: parsedTermId,
        scope: 'all_classes',
        message: 'Report cards for ALL ' + allClasses.length + ' classes successfully ' + actionText + '.',
      });
    }

    // Option B: Admin publishes/unpublishes specifically for a single class
    if (!classId) {
      return res.status(400).json({
        success: false,
        message: 'Please select a specific Class to publish, or choose publishAllClasses.',
      });
    }

    const parsedClassId = Number(classId);
    const parsedSectionId = sectionId ? Number(sectionId) : null;

    const existing = await prisma.classReportCardPublication.findFirst({
      where: {
        classId: parsedClassId,
        sessionId,
        ...(parsedSectionId ? { sectionId: parsedSectionId } : {}),
        ...(branchId ? { branchId } : {}),
        termId: parsedTermId,
      },
    });

    if (existing) {
      await prisma.classReportCardPublication.update({
        where: { id: existing.id },
        data: {
          isPublished: finalIsPublished,
          releaseCa1: finalCa1,
          releaseCa2: finalCa2,
          releaseCombinedCa: finalCombinedCa,
          releaseExam: finalExam,
          releaseFull: finalFull,
          termId: parsedTermId,
          publishedBy: adminUserId || null,
          publishedAt: new Date(),
        },
      });
    } else {
      await prisma.classReportCardPublication.create({
        data: {
          classId: parsedClassId,
          sectionId: parsedSectionId,
          sessionId,
          branchId: branchId || null,
          termId: parsedTermId,
          isPublished: finalIsPublished,
          releaseCa1: finalCa1,
          releaseCa2: finalCa2,
          releaseCombinedCa: finalCombinedCa,
          releaseExam: finalExam,
          releaseFull: finalFull,
          publishedBy: adminUserId || null,
          publishedAt: new Date(),
        },
      });
    }

    const cls = await prisma.class.findUnique({
      where: { id: parsedClassId },
      select: { name: true },
    });

    const stagesText = finalFull
      ? 'Full Terminal Report'
      : [finalCa1 && 'CA1', finalCa2 && 'CA2', finalCombinedCa && 'Combined CA', finalExam && 'Exam'].filter(Boolean).join(' + ') || 'Draft';
    const actionText = finalIsPublished ? `published (${stagesText}) to students & parents` : 'returned to draft mode';
    return res.json({
      success: true,
      isPublished: finalIsPublished,
      releaseCa1: finalCa1,
      releaseCa2: finalCa2,
      releaseCombinedCa: finalCombinedCa,
      releaseExam: finalExam,
      releaseFull: finalFull,
      termId: parsedTermId,
      classId: parsedClassId,
      className: cls?.name || 'Class',
      message: 'Report cards for ' + (cls?.name || 'Class') + ' successfully ' + actionText + '. Other classes remain unaffected.',
    });
  } catch (err) {
    console.error('[ADMIN] Toggle class publish error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update class publication status.' });
  }
}
