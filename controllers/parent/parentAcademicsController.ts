import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { generateReportCardPdf, generateMontessoriReportCardPdf, generateCommentBasedReportCardPdf } from '../../lib/pdfService';
import { listSubmittedAttendance } from '../../lib/attendanceRegisterService';
import {
  parseMarkScore,
  resolveClassEvaluationMatrix,
  resolveActiveMatrixColumnsForStage,
  mapStudentMarkToMatrix,
} from '../../lib/markParser';
import { resolveGradingScale } from '../../lib/gradingService';
import { getRatingLabel } from '../admin/adminMarksReportController';
import { resolveSchoolReportBranding, computeStudentAttendanceMap, resolveNextTermPaymentLabel } from '../../lib/reportCardHelper';

/**
 * GET /api/parent/child/:studentId/attendance
 */
export async function getChildAttendance(req: Request, res: Response): Promise<Response | void> {
  try {
    const { logs, summary } = await listSubmittedAttendance(prisma, {
      studentId: req.studentId,
      sessionId: req.childSessionId,
      branchId: req.studentBranchId,
    });

    return res.json({
      success: true,
      percentage: summary.percentage,
      totalDays: summary.totalDays,
      presentCount: summary.presentCount,
      absentCount: summary.absentCount,
      lateCount: summary.lateCount,
      logs: logs.map((l) => ({
        id: l.id,
        attendanceDate: l.attendanceDate,
        status: l.status,
        remark: l.remark,
      })),
    });
  } catch (error) {
    console.error('[PARENT] Child attendance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve child attendance logs.' });
  }
}

/**
 * GET /api/parent/child/:studentId/tasks
 */
export async function getChildTasks(req: Request, res: Response): Promise<Response | void> {
  if (!req.childClassId) {
    return res.json({ success: true, notes: [], onlineExams: [] });
  }

  try {
    const allNotes = await prisma.teacherNote.findMany({
      where: { branchId: req.studentBranchId },
      include: {
        teacher: { select: { name: true } },
      },
    });

    const notes = allNotes
      .filter((n) => n.classId.split(',').map((s) => s.trim()).includes(String(req.childClassId)))
      .map((n) => ({
        id: n.id,
        title: n.title,
        description: n.description,
        fileName: n.fileName,
        encName: n.encName,
        teacherName: n.teacher?.name || 'Staff',
        createdAt: n.createdAt,
      }));

    const onlineExams = await prisma.onlineExam.findMany({
      where: {
        classId: req.childClassId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
      },
      include: {
        subject: { select: { name: true } },
        submissions: {
          where: { studentId: req.studentId },
          select: { totalMark: true, createdAt: true },
        },
      },
    });

    const homeworks = await prisma.homework.findMany({
      where: {
        classId: req.childClassId,
        branchId: req.studentBranchId,
      },
      include: {
        subject: { select: { name: true } },
        submissions: {
          where: { studentId: req.studentId },
          select: { id: true, score: true, feedback: true, createdAt: true },
        },
      },
      orderBy: { dueDate: 'desc' },
      take: 30,
    });

    const formattedAssignments = homeworks.map((hw) => {
      const sub = hw.submissions[0] || null;
      let status = 'NOT_SUBMITTED';
      if (sub) {
        status = sub.score !== null && sub.score !== undefined ? 'MARKED' : 'AWAITING_MARKING';
      }
      return {
        id: hw.id,
        title: hw.title,
        description: hw.description,
        subjectName: hw.subject?.name || 'General',
        dueDate: hw.dueDate,
        submitted: !!sub,
        status,
        score: sub ? sub.score : null,
        feedback: sub ? sub.feedback : null,
        submittedAt: sub ? sub.createdAt : null,
        createdAt: hw.createdAt,
      };
    });

    return res.json({
      success: true,
      notes,
      homeworks: formattedAssignments,
      assignments: formattedAssignments,
      onlineExams: onlineExams.map((ex) => {
        const submission = ex.submissions[0] || null;
        return {
          id: ex.id,
          title: ex.title,
          subjectName: ex.subject.name,
          passingMark: ex.passingMark,
          submitted: !!submission,
          score: submission ? submission.totalMark : null,
          submittedAt: submission ? submission.createdAt : null,
          createdAt: ex.createdAt,
        };
      }),
    });
  } catch (error) {
    console.error('[PARENT] Child tasks error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve child tasks.' });
  }
}

/**
 * GET /api/parent/child/:studentId/grades
 */
async function resolveNextTermFees(branchId?: number | null, classId?: number | null): Promise<string> {
  if (!branchId) return '';
  try {
    const settings = await prisma.systemSetting.findUnique({
      where: { branchId },
      select: { nextTermFees: true, currencySymbol: true },
    });
    if (settings?.nextTermFees) {
      const label = await resolveNextTermPaymentLabel(
        prisma,
        branchId,
        5,
        classId || undefined,
        settings.nextTermFees,
        settings.currencySymbol || '₦'
      );
      if (label && label.trim().length > 0 && label !== 'To Be Announced') {
        return label;
      }
    }

    const feeAssignments = await prisma.feeAssignment.findMany({
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
    feeAssignments.forEach((fa) => {
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
  return '';
}

/**
 * GET /api/parent/child/:studentId/grades
 */
export async function getChildGrades(req: Request, res: Response): Promise<Response | void> {
  try {
    let isEcdClass = false;
    let isCommentClass = false;
    let clsInfo = null;
    if (req.childClassId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: req.childClassId },
        select: { name: true, isEcd: true, usesScores: true },
      });
      isEcdClass = !!clsInfo?.isEcd;
      isCommentClass = clsInfo?.usesScores === false;
    }

    // Per-Class Publication Gating + Real-Time Auto-Publish Support
    const [classPub, schoolBranding, studentRecord] = await Promise.all([
      req.childClassId && req.childSessionId
        ? prisma.classReportCardPublication.findFirst({
            where: {
              classId: req.childClassId,
              sessionId: req.childSessionId,
              ...(req.studentBranchId ? { OR: [{ branchId: req.studentBranchId }, { branchId: null }] } : {}),
            },
          })
        : Promise.resolve(null),
      resolveSchoolReportBranding(prisma, req.studentBranchId, {
        classId: req.childClassId || undefined,
        sectionId: req.childSectionId || undefined,
        sessionId: req.childSessionId || undefined,
      }),
      req.studentId
        ? prisma.student.findUnique({
            where: { id: req.studentId },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              registerNo: true,
              photo: true,
              gender: true,
              birthday: true,
            },
          })
        : Promise.resolve(null),
    ]);

    const hasExplicitPub = Boolean(classPub);
    const isPublished = hasExplicitPub
      ? Boolean(
          classPub &&
            classPub.isPublished &&
            (classPub.releaseCa1 ||
              classPub.releaseCa2 ||
              classPub.releaseCombinedCa ||
              classPub.releaseExam ||
              classPub.releaseFull)
        )
      : Boolean(schoolBranding.autoPublishReportCards !== false);

    if (!isPublished) {
      return res.json({
        success: true,
        isPublished: false,
        schoolBranding,
        studentBio: studentRecord,
        visibleStages: [],
        releaseCa1: false,
        releaseCa2: false,
        releaseCombinedCa: false,
        releaseExam: false,
        releaseFull: false,
        reportCard: [],
        overallAverage: null,
        commentary: null,
        rank: null,
        totalClassStudents: 0,
        message: 'Official report cards for your child\'s class have not been released yet by the school administration.',
      });
    }

    const releaseCa1 = hasExplicitPub ? Boolean(classPub?.releaseCa1) : true;
    const releaseCa2 = hasExplicitPub ? Boolean(classPub?.releaseCa2) : true;
    const releaseCombinedCa = hasExplicitPub ? Boolean(classPub?.releaseCombinedCa) : true;
    const releaseExam = hasExplicitPub ? Boolean(classPub?.releaseExam) : true;
    const releaseFull = hasExplicitPub ? Boolean(classPub?.releaseFull) : true;

    const visibleStages: string[] = [];
    if (releaseCa1) visibleStages.push('CA1');
    if (releaseCa2) visibleStages.push('CA2');
    if (releaseCombinedCa) visibleStages.push('COMBINED_CA');
    if (releaseExam) visibleStages.push('EXAM');
    if (releaseFull) visibleStages.push('FULL');

    // ZERO LEAKAGE RULE: exam scores and ranking MUST NOT be sent when only CA/Combined CA is released
    const isExamReleased = Boolean(releaseExam || releaseFull);
    const isCombinedCaOnly = releaseCombinedCa && !isExamReleased;

    if (isCommentClass) {
      const subjectComments = await prisma.subjectCommentAssessment.findMany({
        where: {
          studentId: req.studentId,
          classId: req.childClassId,
          sessionId: req.childSessionId,
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
        },
        include: {
          subject: { select: { id: true, name: true, subjectCode: true } },
        },
        orderBy: { subject: { name: 'asc' } },
      });

      const commentary = await prisma.studentCommentary.findFirst({
        where: {
          studentId: req.studentId,
          sessionId: req.childSessionId,
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
        },
      });

      const mont = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: req.studentId,
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
        },
      });

      const nextTermFeesStr = await resolveNextTermFees(req.studentBranchId, req.childClassId);

      return res.json({
        success: true,
        usesScores: false,
        isCommentBased: true,
        isEcd: true,
        isPublished: true,
        visibleStages,
        releaseCa1,
        releaseCa2,
        releaseExam,
        releaseFull,
        assessment: mont || null,
        subjectComments: subjectComments.map((sc) => ({
          id: sc.id,
          subjectId: sc.subjectId,
          subjectName: sc.subject?.name || 'Learning Domain',
          subjectCode: sc.subject?.subjectCode || 'N/A',
          comment: sc.comment,
          rating: sc.rating,
          ratingLabel: getRatingLabel(sc.rating),
        })),
        commentary: commentary?.remark || mont?.narrativeComment || null,
        nextTermFees: nextTermFeesStr,
        reportCard: [],
        overallAverage: null,
        rank: null,
        totalMarks: null,
      });
    }

    if (isEcdClass) {
      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: req.studentId,
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
        include: {
          exam: { select: { name: true, publishResult: true } },
        },
      });
      return res.json({
        success: true,
        isEcd: true,
        isPublished: true,
        visibleStages,
        releaseCa1,
        releaseCa2,
        releaseExam,
        releaseFull,
        assessment: assessment || null,
      });
    }

    const studentMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        exam: { select: { id: true, name: true, resumptionDate: true, publishResult: true } },
      },
    });

    const nextTermFeesStr = await resolveNextTermFees(req.studentBranchId, req.childClassId);

    if (studentMarks.length === 0) {
      const commentary = await prisma.studentCommentary.findFirst({
        where: {
          studentId: req.studentId,
          sessionId: req.childSessionId,
          status: 'PRINCIPAL_SIGNED_OFF',
        },
        select: { remark: true },
      });

      return res.json({
        success: true,
        isPublished: true,
        stage: isExamReleased ? 'FULL' : 'MID_TERM',
        visibleStages,
        releaseCa1,
        releaseCa2,
        releaseExam,
        releaseFull,
        reportCard: [],
        overallAverage: null,
        commentary: commentary?.remark || null,
        rank: null,
        totalClassStudents: 0,
        nextTermResumptionDate: null,
        nextTermFees: nextTermFeesStr,
        message: 'Report cards are published. No subject scores recorded yet for this session.',
      });
    }

    const [dbMatrix, gradingScale] = await Promise.all([
      resolveClassEvaluationMatrix(prisma, req.studentBranchId, req.childClassId),
      resolveGradingScale(prisma, req.studentBranchId, req.childClassId),
    ]);

    let defaultStage = 'FULL';
    if (!isExamReleased) {
      if (releaseCombinedCa || (releaseCa1 && releaseCa2)) defaultStage = 'COMBINED_CA';
      else if (releaseCa1) defaultStage = 'CA1';
      else if (releaseCa2) defaultStage = 'CA2';
      else defaultStage = 'COMBINED_CA';
    }
    const requestedStage = String((req.query as any)?.stage || defaultStage).toUpperCase();
    const {
      activeStage,
      activeColumns,
      activeMaxMarks,
      isCaOnlyStage,
    } = resolveActiveMatrixColumnsForStage(dbMatrix, requestedStage);

    const subjectIds = Array.from(new Set(studentMarks.map((m) => m.subjectId)));
    const classMarks = await prisma.mark.findMany({
      where: {
        classId: req.childClassId,
        sectionId: req.childSectionId,
        sessionId: req.childSessionId,
        subjectId: { in: subjectIds },
      },
    });

    const classAverageMap: Record<string, { sum: number; count: number }> = {};
    classMarks.forEach((m) => {
      const key = `${m.examId}-${m.subjectId}`;
      if (!classAverageMap[key]) {
        classAverageMap[key] = { sum: 0, count: 0 };
      }
      const mapped = mapStudentMarkToMatrix(m, dbMatrix, activeStage);
      if (mapped.hasValidScore) {
        classAverageMap[key].sum += mapped.stageTotal;
        classAverageMap[key].count += 1;
      }
    });

    const commentary = await prisma.studentCommentary.findFirst({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId,
      },
      select: { remark: true, reviewNotes: true },
    });

    let totalScoreSum = 0;
    let marksCount = 0;

    const reportCard = studentMarks.map((m) => {
      const mapped = mapStudentMarkToMatrix(m, dbMatrix, activeStage);

      if (mapped.hasValidScore) {
        totalScoreSum += mapped.stageTotal;
        marksCount++;
      }

      const avgKey = `${m.examId}-${m.subjectId}`;
      const avgData = classAverageMap[avgKey];
      const classAverage =
        avgData && avgData.count > 0
          ? Number((avgData.sum / avgData.count).toFixed(1))
          : mapped.hasValidScore
          ? mapped.stageTotal
          : 0;

      // ZERO DATA LEAKAGE: When exam/full is not released, sanitize theoryMark, mark (total) and classAverage!
      const caScore = mapped.caTotal > 0 ? String(mapped.caTotal) : (mapped.stageTotal > 0 && !isExamReleased ? String(mapped.stageTotal) : null);

      return {
        id: m.id,
        examName: m.exam.name,
        subjectName: m.subject.name,
        subjectCode: m.subject.subjectCode,
        // ZERO LEAKAGE: CBT/CA marks only if CA stages released
        cbtMark: releaseCa1 || releaseCombinedCa || isExamReleased ? (mapped.caTotal > 0 ? String(mapped.caTotal) : null) : null,
        ca1Score: releaseCa1 || releaseCombinedCa || isExamReleased ? (mapped.componentScores['CA1'] ?? (mapped.caTotal > 0 ? mapped.caTotal : null)) : null,
        ca2Score: releaseCa2 || releaseCombinedCa || isExamReleased ? (mapped.componentScores['CA2'] ?? null) : null,
        // ZERO LEAKAGE: exam/theory marks completely withheld when exam is not released
        theoryMark: isExamReleased && !isCaOnlyStage ? (mapped.examTotal > 0 ? String(mapped.examTotal) : null) : null,
        mark: (isExamReleased || isCombinedCaOnly || isCaOnlyStage) ? (mapped.hasValidScore ? String(mapped.stageTotal) : null) : null,
        componentScores: mapped.componentScores,
        maxMarks: activeMaxMarks,
        absent: m.absent === '1' || m.absent === 'true',
        classAverage: isExamReleased ? classAverage : null,
        statusRemark: m.absent === '1' || m.absent === 'true' ? 'Absent' : (caScore ? 'Progress recorded' : 'Pending'),
      };
    });

    // Zero Leakage: Withhold overall average if terminal exam is unreleased
    // For COMBINED_CA only: show CA average, capped at CA total from DB matrix
    const rawAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;
    const normalizedAverage =
      marksCount > 0 && activeMaxMarks > 0
        ? Number((((totalScoreSum / marksCount) / activeMaxMarks) * 100).toFixed(1))
        : rawAverage;
    const overallAverage = isExamReleased && marksCount > 0 ? normalizedAverage : null;
    const combinedCaAverage = (isCombinedCaOnly || isCaOnlyStage) && marksCount > 0 ? rawAverage : null;

    let rank = null;
    let totalClassStudents = 0;

    // ZERO LEAKAGE: Rank MUST NOT be computed or sent for CA-only or Combined CA releases
    // Rank is ONLY computed and sent on full Terminal Exam report cards
    if (isExamReleased && !isCaOnlyStage && req.childClassId && req.childSectionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
        select: { studentId: true },
      });
      const studentIds = enrolls.map((e) => e.studentId);
      totalClassStudents = studentIds.length;

      if (studentIds.length > 0) {
        const allMarks = await prisma.mark.findMany({
          where: {
            studentId: { in: studentIds },
            sessionId: req.childSessionId,
            branchId: req.studentBranchId,
          },
          select: { studentId: true, mark: true, cbtMark: true },
        });

        const studentAggregates: Record<number, { sum: number; count: number }> = {};
        studentIds.forEach((id) => {
          studentAggregates[id] = { sum: 0, count: 0 };
        });

        allMarks.forEach((m) => {
          const mapped = mapStudentMarkToMatrix(m, dbMatrix, activeStage);
          if (mapped.hasValidScore) {
            studentAggregates[m.studentId].sum += mapped.stageTotal;
            studentAggregates[m.studentId].count += 1;
          }
        });

        const rankedList = studentIds.map((id) => {
          const agg = studentAggregates[id];
          const average = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(2)) : 0;
          return { studentId: id, average };
        });

        rankedList.sort((a, b) => b.average - a.average);

        const myIndex = rankedList.findIndex((x) => x.studentId === req.studentId);
        if (myIndex !== -1) {
          rank = myIndex + 1;
        }
      }
    } else if (req.childClassId && req.childSectionId) {
      const count = await prisma.enroll.count({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
      });
      totalClassStudents = count;
    }

    return res.json({
      success: true,
      isPublished: true,
      schoolBranding,
      studentBio: studentRecord,
      stage: isExamReleased && !isCaOnlyStage ? 'FULL' : (isCombinedCaOnly || isCaOnlyStage ? 'COMBINED_CA' : 'MID_TERM'),
      isCaOnlyStage,
      maxTotal: activeMaxMarks,
      caMaxMarks: dbMatrix.caMaxMarks,
      fullMaxMarks: dbMatrix.fullMaxMarks,
      assessmentComponents: activeColumns,
      allMatrixColumns: dbMatrix.columns,
      gradingScale,
      visibleStages,
      releaseCa1,
      releaseCa2,
      releaseCombinedCa,
      releaseExam,
      releaseFull,
      reportCard,
      // ZERO LEAKAGE: omit overallAverage when exam not released; send combinedCaAverage for combined CA
      overallAverage: isExamReleased && !isCaOnlyStage ? overallAverage : null,
      combinedCaAverage: isCombinedCaOnly || isCaOnlyStage ? combinedCaAverage : null,
      commentary: commentary?.remark || null,
      teacherComment: commentary?.remark || null,
      principalComment: commentary?.reviewNotes || null,
      // ZERO LEAKAGE: rank is null unless terminal exam is fully released
      rank: isExamReleased && !isCaOnlyStage ? rank : null,
      totalClassStudents,
      nextTermResumptionDate: studentMarks[0]?.exam?.resumptionDate || schoolBranding.resumptionDate || null,
      nextTermFees: schoolBranding.nextTermFees || nextTermFeesStr,
    });
  } catch (error) {
    console.error('[PARENT] Child grades error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve child grade card.' });
  }
}

/**
 * GET /api/parent/child/:studentId/export-pdf
 */
export async function exportChildReportPdf(req: Request, res: Response): Promise<Response | void> {
  try {
    const { rankingType = 'full', rankingLimit = 3 } = req.query as any;
    const limit = parseInt(rankingLimit as string, 10) || 3;

    // Per-Class Publication Gating + Auto-Publish Support
    const [classPub, schoolBranding] = await Promise.all([
      req.childClassId && req.childSessionId
        ? prisma.classReportCardPublication.findFirst({
            where: {
              classId: req.childClassId,
              sessionId: req.childSessionId,
              ...(req.studentBranchId ? { OR: [{ branchId: req.studentBranchId }, { branchId: null }] } : {}),
            },
          })
        : Promise.resolve(null),
      resolveSchoolReportBranding(prisma, req.studentBranchId, {
        classId: req.childClassId || undefined,
        sectionId: req.childSectionId || undefined,
        sessionId: req.childSessionId || undefined,
      }),
    ]);

    const hasExplicitPub = Boolean(classPub);
    const isPublished = hasExplicitPub
      ? Boolean(
          classPub &&
            classPub.isPublished &&
            (classPub.releaseCa1 ||
              classPub.releaseCa2 ||
              classPub.releaseCombinedCa ||
              classPub.releaseExam ||
              classPub.releaseFull)
        )
      : Boolean(schoolBranding.autoPublishReportCards !== false);

    if (!isPublished) {
      return res.status(403).json({
        success: false,
        message: 'Official report cards for your child\'s class have not been published yet by the school administration.',
      });
    }

    const releaseCa1 = hasExplicitPub ? Boolean(classPub?.releaseCa1) : true;
    const releaseCa2 = hasExplicitPub ? Boolean(classPub?.releaseCa2) : true;
    const releaseExam = hasExplicitPub ? Boolean(classPub?.releaseExam) : true;
    const releaseFull = hasExplicitPub ? Boolean(classPub?.releaseFull) : true;

    const visibleStages: string[] = [];
    if (releaseCa1) visibleStages.push('CA1');
    if (releaseCa2) visibleStages.push('CA2');
    if (releaseExam) visibleStages.push('EXAM');
    if (releaseFull) visibleStages.push('FULL');

    const isExamReleased = Boolean(releaseExam || releaseFull);

    let isEcdClass = false;
    let isCommentClass = false;
    let clsInfo = null;
    if (req.childClassId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: req.childClassId },
        select: { name: true, isEcd: true, usesScores: true },
      });
      isEcdClass = !!clsInfo?.isEcd;
      isCommentClass = clsInfo?.usesScores === false;
    }

    if (isCommentClass && clsInfo) {
      const student = await prisma.student.findUnique({
        where: { id: req.studentId },
        include: {
          branch: { select: { name: true, code: true } },
        },
      });
      if (!student) {
        return res.status(404).json({ success: false, message: 'Student not found.' });
      }

      let sectionName = 'N/A';
      let sessionName = 'N/A';
      let formTeacherName = 'Class Teacher';

      if (req.childSectionId) {
        const sec = await prisma.section.findUnique({ where: { id: req.childSectionId }, select: { name: true } });
        sectionName = sec?.name || 'N/A';
        const sess = await prisma.schoolYear.findUnique({ where: { id: req.childSessionId }, select: { schoolYear: true } });
        sessionName = sess?.schoolYear || 'N/A';

        const formAllocation = await prisma.teacherAllocation.findFirst({
          where: {
            classId: req.childClassId,
            sectionId: req.childSectionId,
            sessionId: req.childSessionId,
            ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
          },
          include: {
            teacher: { select: { name: true } },
          },
        });
        if (formAllocation?.teacher) {
          formTeacherName = formAllocation.teacher.name;
        }
      }

      const subjectComments = await prisma.subjectCommentAssessment.findMany({
        where: {
          studentId: req.studentId,
          classId: req.childClassId,
          sessionId: req.childSessionId,
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
        },
        include: {
          subject: { select: { name: true, subjectCode: true } },
        },
        orderBy: { subject: { name: 'asc' } },
      });

      const commentary = await prisma.studentCommentary.findFirst({
        where: {
          studentId: req.studentId,
          sessionId: req.childSessionId,
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
        },
      });

      const nextTermFees = await resolveNextTermFees(req.studentBranchId, req.childClassId);

      const pdfBuffer = await generateCommentBasedReportCardPdf({
        schoolName: student.branch?.name || 'Ugbekun Schools',
        branchCode: student.branch?.code || 'GEN',
        studentName: `${student.lastName}, ${student.firstName}`,
        registerNo: student.registerNo,
        className: clsInfo.name,
        sectionName,
        sessionName,
        examName: 'Developmental Evaluation',
        subjectComments: subjectComments.map((sc) => ({
          subjectName: sc.subject?.name || 'Subject',
          comment: sc.comment,
          rating: sc.rating,
          ratingLabel: getRatingLabel(sc.rating),
        })),
        teacherComment: commentary?.remark || 'Pupil displays steady qualitative developmental progression.',
        principalComment: commentary?.reviewNotes || 'Demonstrating positive qualitative developmental milestones.',
        nextTermFees,
        resumptionDate: null,
        formTeacherName,
      });

      const safeLastName = (student.lastName || 'Student').replace(/\s+/g, '_');
      const safeFirstName = (student.firstName || 'Pupil').replace(/\s+/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="developmental_report_${safeLastName}_${safeFirstName}.pdf"`
      );
      return res.send(pdfBuffer);
    }

    if (isEcdClass && clsInfo) {
      const student = await prisma.student.findUnique({
        where: { id: req.studentId },
        include: {
          branch: { select: { name: true, code: true } },
        },
      });
      if (!student) {
        return res.status(404).json({ success: false, message: 'Student not found.' });
      }

      let sectionName = 'N/A';
      let sessionName = 'N/A';
      let formTeacherName = 'Class Teacher';

      if (req.childSectionId) {
        const sec = await prisma.section.findUnique({ where: { id: req.childSectionId }, select: { name: true } });
        sectionName = sec?.name || 'N/A';
        const sess = await prisma.schoolYear.findUnique({ where: { id: req.childSessionId }, select: { schoolYear: true } });
        sessionName = sess?.schoolYear || 'N/A';

        const formAllocation = await prisma.teacherAllocation.findFirst({
          where: {
            classId: req.childClassId,
            sectionId: req.childSectionId,
            sessionId: req.childSessionId,
            branchId: req.studentBranchId,
          },
          include: {
            teacher: { select: { name: true } },
          },
        });
        if (formAllocation?.teacher) {
          formTeacherName = formAllocation.teacher.name;
        }
      }

      const examIdVal = req.query.examId ? Number(req.query.examId) : undefined;

      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: req.studentId,
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
          ...(examIdVal ? { examId: examIdVal } : {}),
        },
        include: {
          exam: { select: { name: true, resumptionDate: true, publishResult: true } },
        },
      });

      if (!assessment) {
        return res.status(404).json({
          success: false,
          message: 'No Montessori assessment recorded yet for this student.',
        });
      }

      const examName = assessment?.exam?.name || 'Term Evaluation';
      const resumptionDate = assessment?.exam?.resumptionDate || null;

      const pdfBuffer = await generateMontessoriReportCardPdf({
        schoolName: student.branch?.name || 'Ugbekun Schools',
        branchCode: student.branch?.code || 'GEN',
        studentName: `${student.lastName}, ${student.firstName}`,
        registerNo: student.registerNo,
        className: clsInfo.name,
        sectionName,
        sessionName,
        examName,
        assessment: assessment || {},
        resumptionDate,
        formTeacherName,
      });

      const safeLastName = (student.lastName || 'Student').replace(/\s+/g, '_');
      const safeFirstName = (student.firstName || 'Grades').replace(/\s+/g, '_');

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="report_card_${safeLastName}_${safeFirstName}.pdf"`);
      return res.send(pdfBuffer);
    }

    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: {
        branch: { select: { name: true, code: true } },
      },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    let className = 'N/A';
    let sectionName = 'N/A';
    let sessionName = 'N/A';
    let formTeacherName = 'Class Teacher';

    if (req.childClassId && req.childSectionId) {
      const cls = await prisma.class.findUnique({ where: { id: req.childClassId }, select: { name: true } });
      className = cls?.name || 'N/A';
      const sec = await prisma.section.findUnique({ where: { id: req.childSectionId }, select: { name: true } });
      sectionName = sec?.name || 'N/A';
      const sess = await prisma.schoolYear.findUnique({ where: { id: req.childSessionId }, select: { schoolYear: true } });
      sessionName = sess?.schoolYear || 'N/A';

      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
        include: {
          teacher: { select: { name: true } },
        },
      });
      if (formAllocation?.teacher) {
        formTeacherName = formAllocation.teacher.name;
      }
    }

    const studentMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
      },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true, publishResult: true } },
      },
    });

    if (studentMarks.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No subject marks recorded yet for this child in the published session.',
      });
    }

    const [dbMatrix, gradingScale] = await Promise.all([
      resolveClassEvaluationMatrix(prisma, req.studentBranchId, req.childClassId),
      resolveGradingScale(prisma, req.studentBranchId, req.childClassId),
    ]);

    const releaseCombinedCa = hasExplicitPub ? Boolean(classPub?.releaseCombinedCa) : true;
    if (releaseCombinedCa && !visibleStages.includes('COMBINED_CA')) {
      visibleStages.push('COMBINED_CA');
    }

    let defaultStage = 'FULL';
    if (!isExamReleased) {
      if (releaseCombinedCa || (releaseCa1 && releaseCa2)) defaultStage = 'COMBINED_CA';
      else if (releaseCa1) defaultStage = 'CA1';
      else if (releaseCa2) defaultStage = 'CA2';
      else defaultStage = 'COMBINED_CA';
    }
    const requestedStage = String((req.query as any)?.stage || defaultStage).toUpperCase();
    const {
      activeStage,
      activeColumns,
      activeMaxMarks,
      isCaOnlyStage,
    } = resolveActiveMatrixColumnsForStage(dbMatrix, requestedStage);

    const subjectIds = Array.from(new Set(studentMarks.map((m) => m.subjectId)));
    const classMarks = await prisma.mark.findMany({
      where: {
        classId: req.childClassId,
        sectionId: req.childSectionId,
        sessionId: req.childSessionId,
        subjectId: { in: subjectIds },
      },
    });

    const classAverageMap: Record<string, { sum: number; count: number }> = {};
    classMarks.forEach((m) => {
      const key = `${m.examId}-${m.subjectId}`;
      if (!classAverageMap[key]) {
        classAverageMap[key] = { sum: 0, count: 0 };
      }
      const mapped = mapStudentMarkToMatrix(m, dbMatrix, activeStage);
      if (mapped.hasValidScore) {
        classAverageMap[key].sum += mapped.stageTotal;
        classAverageMap[key].count += 1;
      }
    });

    let totalScoreSum = 0;
    let marksCount = 0;

    const reportCard = studentMarks.map((m) => {
      const mapped = mapStudentMarkToMatrix(m, dbMatrix, activeStage);

      if (mapped.hasValidScore) {
        totalScoreSum += mapped.stageTotal;
        marksCount++;
      }

      const avgKey = `${m.examId}-${m.subjectId}`;
      const avgData = classAverageMap[avgKey];
      const classAverage =
        avgData && avgData.count > 0
          ? Number((avgData.sum / avgData.count).toFixed(1))
          : mapped.hasValidScore
          ? mapped.stageTotal
          : 0;

      // ZERO DATA LEAKAGE IN PDF:
      return {
        id: m.id,
        examName: m.exam.name,
        subjectName: m.subject.name,
        subjectCode: m.subject.subjectCode,
        cbtMark: releaseCa1 || releaseCombinedCa || isExamReleased ? (mapped.caTotal > 0 ? String(mapped.caTotal) : null) : null,
        ca1Score: releaseCa1 || releaseCombinedCa || isExamReleased ? (mapped.componentScores['CA1'] ?? (mapped.caTotal > 0 ? mapped.caTotal : null)) : null,
        ca2Score: releaseCa2 || releaseCombinedCa || isExamReleased ? (mapped.componentScores['CA2'] ?? null) : null,
        theoryMark: isExamReleased && !isCaOnlyStage ? (mapped.examTotal > 0 ? String(mapped.examTotal) : null) : null,
        mark: (isExamReleased || isCaOnlyStage) ? (mapped.hasValidScore ? String(mapped.stageTotal) : null) : null,
        componentScores: mapped.componentScores,
        maxMarks: activeMaxMarks,
        absent: m.absent === '1' || m.absent === 'true',
        classAverage: isExamReleased ? classAverage : null,
      };
    });

    const rawAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;
    const normalizedAverage =
      marksCount > 0 && activeMaxMarks > 0
        ? Number((((totalScoreSum / marksCount) / activeMaxMarks) * 100).toFixed(1))
        : rawAverage;
    const overallAverage = (isExamReleased || isCaOnlyStage) && marksCount > 0 ? normalizedAverage : 0;
    const nextTermFeesStr = await resolveNextTermFees(req.studentBranchId, req.childClassId);

    let rank = null;
    let totalClassStudents = 0;

    if (isExamReleased && !isCaOnlyStage && req.childClassId && req.childSectionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
        select: { studentId: true },
      });
      const studentIds = enrolls.map((e) => e.studentId);
      totalClassStudents = studentIds.length;

      if (studentIds.length > 0) {
        const allMarks = await prisma.mark.findMany({
          where: {
            studentId: { in: studentIds },
            sessionId: req.childSessionId,
            branchId: req.studentBranchId,
          },
          select: { studentId: true, mark: true, cbtMark: true },
        });

        const studentAggregates: Record<number, { sum: number; count: number }> = {};
        studentIds.forEach((id) => {
          studentAggregates[id] = { sum: 0, count: 0 };
        });

        allMarks.forEach((m) => {
          const mapped = mapStudentMarkToMatrix(m, dbMatrix, activeStage);
          if (mapped.hasValidScore) {
            studentAggregates[m.studentId].sum += mapped.stageTotal;
            studentAggregates[m.studentId].count += 1;
          }
        });

        const rankedList = studentIds.map((id) => {
          const agg = studentAggregates[id];
          const average = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(2)) : 0;
          return { studentId: id, average };
        });

        rankedList.sort((a, b) => b.average - a.average);

        const myIndex = rankedList.findIndex((x) => x.studentId === req.studentId);
        if (myIndex !== -1) {
          rank = myIndex + 1;
        }
      }
    } else if (req.childClassId && req.childSectionId) {
      const count = await prisma.enroll.count({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
      });
      totalClassStudents = count;
    }

    const commentaryRecord = await prisma.studentCommentary.findFirst({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId,
      },
      select: { remark: true, reviewNotes: true },
    });

    const resumptionDate = studentMarks[0]?.exam.resumptionDate || schoolBranding.resumptionDate || null;

    const pdfBuffer = await generateReportCardPdf({
      schoolName: schoolBranding.schoolName || student.branch?.name || 'Ugbekun Schools',
      branchCode: schoolBranding.branchCode || student.branch?.code || 'GEN',
      studentName: `${student.lastName}, ${student.firstName}`,
      registerNo: student.registerNo,
      className,
      sectionName,
      sessionName,
      reportCard,
      overallAverage,
      commentary: commentaryRecord?.remark || '',
      teacherComment: commentaryRecord?.remark || '',
      principalComment: commentaryRecord?.reviewNotes || '',
      rank,
      totalClassStudents,
      rankingType,
      rankingLimit: limit,
      resumptionDate,
      nextTermFees: schoolBranding.nextTermFees || nextTermFeesStr,
      formTeacherName: schoolBranding.classTeacherName || formTeacherName,
      isMidTerm: isCaOnlyStage && activeStage !== 'COMBINED_CA' && activeStage !== 'CA_ONLY',
      stage: activeStage,
      visibleStages,
      photo: student.photo || null,
      gender: student.gender || null,
      birthday: student.birthday || null,
      schoolBranding,
      gradingRanges: gradingScale.ranges,
      assessmentComponents: activeColumns,
      maxTotal: activeMaxMarks,
    });

    const safeLastName = (student.lastName || 'Student').replace(/\s+/g, '_');
    const safeFirstName = (student.firstName || 'Grades').replace(/\s+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report_card_${safeLastName}_${safeFirstName}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[PARENT] Export PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate PDF report card.' });
  }
}

/**
 * GET /api/parent/classes-sections
 */
export async function getClassesSections(req: Request, res: Response): Promise<Response | void> {
  try {
    const classes = await prisma.class.findMany({
      where: { branchId: req.branchId },
      include: {
        sections: {
          include: {
            section: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return res.json({ success: true, classes });
  } catch (error) {
    console.error('[PARENT] Get classes-sections error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load classes and sections.' });
  }
}

/**
 * GET /api/parent/sibling-requests
 */
export async function getSiblingRequests(req: Request, res: Response): Promise<Response | void> {
  try {
    const requests = await prisma.parentSiblingRequest.findMany({
      where: { parentId: req.parentId, branchId: req.branchId },
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const formatted = requests.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      gender: r.gender,
      birthday: r.birthday,
      status: r.status,
      rejectionReason: r.rejectionReason,
      className: r.class?.name || 'Class',
      sectionName: r.section?.name || 'General',
      createdAt: r.createdAt,
    }));

    return res.json({ success: true, siblingRequests: formatted });
  } catch (error) {
    console.error('[PARENT] Get sibling requests error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load sibling requests.' });
  }
}

/**
 * POST /api/parent/sibling-requests
 */
export async function createSiblingRequest(req: Request, res: Response): Promise<Response | void> {
  try {
    const { firstName, lastName, gender, birthday, classId, sectionId } = req.body || {};

    if (!firstName || !lastName || !gender || !classId || !sectionId) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, gender, class, and section are required.',
      });
    }

    const cls = await prisma.class.findFirst({
      where: { id: Number(classId), branchId: req.branchId },
    });
    const sec = await prisma.section.findFirst({
      where: { id: Number(sectionId), branchId: req.branchId },
    });

    if (!cls || !sec) {
      return res.status(400).json({ success: false, message: 'Invalid class or section selected.' });
    }

    const duplicate = await prisma.parentSiblingRequest.findFirst({
      where: {
        parentId: req.parentId,
        branchId: req.branchId,
        firstName: { equals: firstName.trim(), mode: 'insensitive' },
        lastName: { equals: lastName.trim(), mode: 'insensitive' },
        status: { in: ['pending', 'approved'] },
      },
    });

    if (duplicate) {
      return res.status(400).json({ success: false, message: 'A request for this child has already been submitted.' });
    }

    const siblingRequest = await prisma.parentSiblingRequest.create({
      data: {
        parentId: req.parentId,
        branchId: req.branchId,
        classId: Number(classId),
        sectionId: Number(sectionId),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        gender,
        birthday: birthday ? new Date(birthday) : null,
        status: 'pending',
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Sibling request submitted successfully.',
      siblingRequest,
    });
  } catch (error) {
    console.error('[PARENT] Create sibling request error:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit sibling request.' });
  }
}

/**
 * GET /api/parent/events
 */
export async function getEvents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const events = await prisma.event.findMany({
      where: {
        branchId,
        sessionId,
      },
      orderBy: {
        startDate: 'asc',
      },
    });

    return res.json({ success: true, events });
  } catch (error) {
    console.error('[PARENT] Get events error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch events.' });
  }
}

/**
 * GET /api/parent/child/:studentId/timetable
 */
export async function getChildTimetable(req: Request, res: Response): Promise<Response | void> {
  if (!req.childClassId) {
    return res.json({ success: true, timetableSlots: [], examScheduleSlots: [] });
  }

  try {
    let timetableSlots = await prisma.timetableSlot.findMany({
      where: {
        classId: req.childClassId,
        branchId: req.studentBranchId,
        isPublished: true,
        ...(req.childSectionId
          ? {
              OR: [{ sectionId: req.childSectionId }, { sectionId: null }],
            }
          : {}),
      },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        teacher: { select: { id: true, name: true, phone: true, photo: true } },
      },
      orderBy: [{ startTime: 'asc' }],
    });

    if (timetableSlots.length === 0) {
      timetableSlots = await prisma.timetableSlot.findMany({
        where: {
          classId: req.childClassId,
          branchId: req.studentBranchId,
          isPublished: true,
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true } },
          teacher: { select: { id: true, name: true, phone: true, photo: true } },
        },
        orderBy: [{ startTime: 'asc' }],
      });
    }

    if (timetableSlots.length === 0) {
      timetableSlots = await prisma.timetableSlot.findMany({
        where: {
          classId: req.childClassId,
          branchId: req.studentBranchId,
        },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true } },
          teacher: { select: { id: true, name: true, phone: true, photo: true } },
        },
        orderBy: [{ startTime: 'asc' }],
      });
    }

    let examScheduleSlots = await prisma.examScheduleSlot.findMany({
      where: {
        classId: req.childClassId,
        branchId: req.studentBranchId,
        isPublished: true,
        ...(req.childSectionId
          ? {
              OR: [{ sectionId: req.childSectionId }, { sectionId: null }],
            }
          : {}),
      },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        hall: { select: { name: true, location: true } },
        invigilator: { select: { name: true } },
      },
      orderBy: { examDate: 'asc' },
    });

    if (examScheduleSlots.length === 0) {
      examScheduleSlots = await prisma.examScheduleSlot.findMany({
        where: {
          classId: req.childClassId,
          branchId: req.studentBranchId,
          isPublished: true,
        },
        include: {
          subject: { select: { name: true, subjectCode: true } },
          hall: { select: { name: true, location: true } },
          invigilator: { select: { name: true } },
        },
        orderBy: { examDate: 'asc' },
      });
    }

    const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const grouped: Record<string, any[]> = {};
    DAYS.forEach((d) => {
      grouped[d] = [];
    });

    const mappedSlots = timetableSlots.map((slot) => {
      const item = {
        id: slot.id,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        time: `${slot.startTime} - ${slot.endTime}`,
        type: slot.type,
        title:
          slot.title ||
          slot.subject?.name ||
          (slot.type === 'BREAK' ? 'Break / Recess' : slot.type === 'ASSEMBLY' ? 'Morning Assembly' : 'Class Period'),
        subjectId: slot.subjectId,
        subjectName: slot.subject?.name || null,
        subjectCode: slot.subject?.subjectCode || null,
        teacherId: slot.teacherId,
        teacherName: slot.teacher?.name || null,
        teacherPhone: slot.teacher?.phone || null,
        teacherPhoto: slot.teacher?.photo || null,
        className: slot.class?.name || null,
        sectionName: slot.section?.name || null,
        roomLabel: slot.section?.name || null,
      };

      if (grouped[slot.dayOfWeek]) {
        grouped[slot.dayOfWeek].push(item);
      } else {
        grouped[slot.dayOfWeek] = [item];
      }

      return item;
    });

    return res.json({
      success: true,
      timetableSlots: mappedSlots,
      grouped,
      examScheduleSlots: examScheduleSlots.map((slot) => ({
        id: slot.id,
        examDate: slot.examDate,
        startTime: slot.startTime,
        endTime: slot.endTime,
        instructions: slot.instructions,
        subjectName: slot.subject.name,
        subjectCode: slot.subject.subjectCode,
        hallName: slot.hall?.name || 'Main Exam Hall',
        invigilatorName: slot.invigilator?.name || 'Invigilator',
      })),
    });
  } catch (error) {
    console.error('[PARENT] Get child timetable error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve timetable slots.' });
  }
}
