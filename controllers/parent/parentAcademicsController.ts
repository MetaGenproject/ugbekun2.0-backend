import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { generateReportCardPdf, generateMontessoriReportCardPdf, generateCommentBasedReportCardPdf } from '../../lib/pdfService';
import { buildStudentAttendanceReport, listSubmittedAttendance } from '../../lib/attendanceRegisterService';
import {
  parseMarkScore,
  resolveClassEvaluationMatrix,
  resolveActiveMatrixColumnsForStage,
  resolveEffectiveMatrixStageForMarks,
  mapStudentMarkToMatrix,
  consolidateMarksByStudentAndSubject,
} from '../../lib/markParser';
import { resolveGradingScale } from '../../lib/gradingService';
import { getRatingLabel } from '../admin/adminMarksReportController';
import {
  resolveSchoolReportBranding,
  computeStudentAttendanceMap,
  resolveNextTermPaymentLabel,
  termLabelForId,
  examMatchesTerm,
  fetchStudentReportOptions,
  resolveStudentReportFilterScope,
  resolveClassPublicationForStudent,
} from '../../lib/reportCardHelper';

/**
 * GET /api/parent/child/:studentId/report-card/options
 * Returns enrolled and mark-recorded sessions, classes, and terms for a linked child.
 */
export async function getChildReportCardOptions(req: Request, res: Response): Promise<Response | void> {
  try {
    if (!req.studentId) {
      return res.status(400).json({ success: false, message: 'Student context unavailable.' });
    }
    const options = await fetchStudentReportOptions(
      prisma,
      req.studentId,
      req.studentBranchId,
      req.childSessionId
    );
    return res.json({ success: true, ...options });
  } catch (error) {
    console.error('[PARENT] Child report card options error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load report card options.' });
  }
}

/**
 * GET /api/parent/child/:studentId/attendance
 */
export async function getChildAttendance(req: Request, res: Response): Promise<Response | void> {
  try {
    if (!req.studentId || !req.studentBranchId) {
      return res.status(400).json({ success: false, message: 'Student context unavailable.' });
    }

    const report = await buildStudentAttendanceReport(prisma, {
      studentId: req.studentId,
      sessionId: req.childSessionId,
      branchId: req.studentBranchId,
    });

    return res.json({
      success: true,
      percentage: report.summary.percentage,
      totalDays: report.summary.totalDays,
      presentCount: report.summary.presentCount,
      absentCount: report.summary.absentCount,
      lateCount: report.summary.lateCount,
      excusedCount: report.summary.excusedCount,
      sickCount: report.summary.sickCount,
      inAttendance: report.summary.inAttendance,
      currentTerm: report.currentTerm,
      sessionName: report.sessionName,
      logs: report.logs.map((l) => ({
        id: l.id,
        attendanceDate: l.attendanceDate,
        status: l.status,
        remark: l.remark,
      })),
      reports: {
        daily: report.daily,
        weekly: report.weekly,
        monthly: report.monthly,
        termly: report.termly,
      },
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
    if (!req.studentId) {
      return res.status(400).json({ success: false, message: 'Student context unavailable.' });
    }

    const scope = await resolveStudentReportFilterScope(prisma, {
      studentId: req.studentId,
      branchId: req.studentBranchId,
      fallbackSessionId: req.childSessionId,
      fallbackClassId: req.childClassId,
      fallbackSectionId: req.childSectionId,
      query: req.query as Record<string, any>,
    });

    if (!scope.isAuthorizedSession) {
      return res.status(403).json({
        success: false,
        message: 'Selected academic session is not available for this child.',
      });
    }
    if (!scope.isAuthorizedClass) {
      return res.status(403).json({
        success: false,
        message: 'Selected class is not associated with this child.',
      });
    }

    const {
      options,
      activeSessionId,
      targetClassId,
      targetSectionId,
      targetTermId,
      targetTermLabel,
    } = scope;

    let isEcdClass = false;
    let isCommentClass = false;
    let clsInfo = null;
    if (targetClassId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: targetClassId },
        select: { id: true, name: true, isEcd: true, usesScores: true },
      });
      isEcdClass = !!clsInfo?.isEcd;
      isCommentClass = clsInfo?.usesScores === false;
    }

    // Per-Class & Per-Term Publication Gating + Real-Time Auto-Publish Support
    const [baseBranding, studentRecord, sessionRow, sectionRow, attendanceRes] = await Promise.all([
      resolveSchoolReportBranding(prisma, req.studentBranchId, {
        classId: targetClassId,
        sectionId: targetSectionId,
        sessionId: activeSessionId,
      }),
      prisma.student.findUnique({
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
      }),
      activeSessionId
        ? prisma.schoolYear.findUnique({ where: { id: activeSessionId }, select: { id: true, schoolYear: true } })
        : Promise.resolve(null),
      targetSectionId
        ? prisma.section.findUnique({ where: { id: targetSectionId }, select: { id: true, name: true } })
        : Promise.resolve(null),
      req.studentBranchId
        ? listSubmittedAttendance(prisma, {
            studentId: req.studentId,
            sessionId: activeSessionId,
            branchId: req.studentBranchId,
          })
        : Promise.resolve({
            logs: [],
            summary: { percentage: 100, totalDays: 0, presentCount: 0, absentCount: 0, lateCount: 0 },
          }),
    ]);

    const schoolBranding = {
      ...baseBranding,
      ...(sessionRow?.schoolYear ? { academicSession: sessionRow.schoolYear } : {}),
      currentTerm: targetTermLabel,
    };

    const selectionMeta = {
      sessionId: activeSessionId || null,
      sessionName: sessionRow?.schoolYear || schoolBranding.academicSession || null,
      classId: targetClassId || null,
      className: clsInfo?.name || null,
      sectionId: targetSectionId || null,
      sectionName: sectionRow?.name || null,
      termId: targetTermId,
      termLabel: targetTermLabel,
      options,
    };

    const {
      isPublished,
      releaseCa1,
      releaseCa2,
      releaseCombinedCa,
      releaseExam,
      releaseFull,
    } = await resolveClassPublicationForStudent(prisma, {
      classId: targetClassId,
      sectionId: targetSectionId,
      sessionId: activeSessionId,
      termId: targetTermId,
      branchId: req.studentBranchId,
      autoPublishReportCards: schoolBranding.autoPublishReportCards !== false,
    });

    if (!isPublished) {
      return res.json({
        success: true,
        isPublished: false,
        ...selectionMeta,
        schoolBranding,
        studentBio: studentRecord,
        attendanceSummary: attendanceRes.summary,
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
        message: `Official report cards for ${clsInfo?.name || "your child's class"} (${targetTermLabel}) have not been released yet by the school administration.`,
      });
    }

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
      const [subjectComments, commentary, mont, nextTermFeesStr] = await Promise.all([
        prisma.subjectCommentAssessment.findMany({
          where: {
            studentId: req.studentId,
            ...(targetClassId ? { classId: targetClassId } : {}),
            ...(activeSessionId ? { sessionId: activeSessionId } : {}),
            termId: targetTermId,
            ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
          },
          include: {
            subject: { select: { id: true, name: true, subjectCode: true } },
          },
          orderBy: { subject: { name: 'asc' } },
        }),
        activeSessionId
          ? prisma.studentCommentary.findFirst({
              where: {
                studentId: req.studentId,
                sessionId: activeSessionId,
                ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
              },
            })
          : Promise.resolve(null),
        prisma.montessoriAssessment.findFirst({
          where: {
            studentId: req.studentId,
            ...(targetClassId ? { classId: targetClassId } : {}),
            ...(targetSectionId ? { sectionId: targetSectionId } : {}),
            ...(activeSessionId ? { sessionId: activeSessionId } : {}),
            ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
          },
          orderBy: { id: 'desc' },
        }),
        resolveNextTermFees(req.studentBranchId, targetClassId),
      ]);

      return res.json({
        success: true,
        usesScores: false,
        isCommentBased: true,
        isEcd: true,
        isPublished: true,
        ...selectionMeta,
        schoolBranding,
        studentBio: studentRecord,
        attendanceSummary: attendanceRes.summary,
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
        teacherComment: commentary?.remark || mont?.narrativeComment || null,
        principalComment: commentary?.reviewNotes || null,
        nextTermFees: schoolBranding.nextTermFees || nextTermFeesStr,
        resumptionDate: schoolBranding.resumptionDate || null,
        nextTermResumptionDate: schoolBranding.resumptionDate || null,
        reportCard: [],
        overallAverage: null,
        rank: null,
        totalMarks: null,
      });
    }

    if (isEcdClass) {
      const assessments = await prisma.montessoriAssessment.findMany({
        where: {
          studentId: req.studentId,
          ...(targetClassId ? { classId: targetClassId } : {}),
          ...(targetSectionId ? { sectionId: targetSectionId } : {}),
          ...(activeSessionId ? { sessionId: activeSessionId } : {}),
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
        },
        include: {
          exam: { select: { name: true, termId: true, publishResult: true } },
        },
        orderBy: { id: 'desc' },
      });
      const matchedEcd = assessments.find((a) => examMatchesTerm(a.exam, targetTermId)) || null;
      return res.json({
        success: true,
        isEcd: true,
        isPublished: true,
        ...selectionMeta,
        schoolBranding,
        studentBio: studentRecord,
        attendanceSummary: attendanceRes.summary,
        visibleStages,
        releaseCa1,
        releaseCa2,
        releaseExam,
        releaseFull,
        assessment: matchedEcd,
      });
    }

    const sessionMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        ...(targetClassId ? { classId: targetClassId } : {}),
        ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        exam: { select: { id: true, name: true, termId: true, resumptionDate: true, publishResult: true } },
      },
    });

    const studentMarks = sessionMarks.filter((m) => examMatchesTerm(m.exam, targetTermId));
    const nextTermFeesStr = await resolveNextTermFees(req.studentBranchId, targetClassId);

    if (studentMarks.length === 0) {
      const commentary = activeSessionId
        ? await prisma.studentCommentary.findFirst({
            where: {
              studentId: req.studentId,
              sessionId: activeSessionId,
              status: 'PRINCIPAL_SIGNED_OFF',
            },
            select: { remark: true, reviewNotes: true },
          })
        : null;

      return res.json({
        success: true,
        isPublished: true,
        ...selectionMeta,
        schoolBranding,
        studentBio: studentRecord,
        attendanceSummary: attendanceRes.summary,
        stage: isExamReleased ? 'FULL' : 'MID_TERM',
        visibleStages,
        releaseCa1,
        releaseCa2,
        releaseExam,
        releaseFull,
        reportCard: [],
        overallAverage: null,
        commentary: commentary?.remark || null,
        teacherComment: commentary?.remark || null,
        principalComment: commentary?.reviewNotes || null,
        rank: null,
        totalClassStudents: 0,
        resumptionDate: schoolBranding.resumptionDate || null,
        nextTermResumptionDate: null,
        nextTermFees: schoolBranding.nextTermFees || nextTermFeesStr,
        message: `No subject scores recorded for ${selectionMeta.className || 'this class'} · ${targetTermLabel} (${selectionMeta.sessionName || 'Session'}).`,
      });
    }

    const [dbMatrix, gradingScale] = await Promise.all([
      resolveClassEvaluationMatrix(prisma, req.studentBranchId, targetClassId),
      resolveGradingScale(prisma, req.studentBranchId, targetClassId),
    ]);

    let defaultStage = 'FULL';
    if (!isExamReleased) {
      if (releaseCombinedCa || (releaseCa1 && releaseCa2)) defaultStage = 'COMBINED_CA';
      else if (releaseCa1) defaultStage = 'CA1';
      else if (releaseCa2) defaultStage = 'CA2';
      else defaultStage = 'COMBINED_CA';
    }
    const requestedStageRaw = String((req.query as any)?.stage || defaultStage).toUpperCase();
    const requestedStage =
      !isExamReleased &&
      (requestedStageRaw === 'FULL' ||
        requestedStageRaw === 'ALL' ||
        requestedStageRaw === 'TERMINAL' ||
        requestedStageRaw === 'EXAM' ||
        requestedStageRaw === 'EXAM_ONLY')
        ? defaultStage
        : requestedStageRaw;

    const subjectIds = Array.from(new Set(studentMarks.map((m) => m.subjectId)));
    const examIds = Array.from(new Set(studentMarks.map((m) => m.examId)));
    const rawClassMarks = await prisma.mark.findMany({
      where: {
        ...(targetClassId ? { classId: targetClassId } : {}),
        ...(targetSectionId ? { sectionId: targetSectionId } : {}),
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        subjectId: { in: subjectIds },
      },
      include: {
        exam: { select: { name: true, termId: true } },
      },
    });

    const termClassMarks = rawClassMarks.filter((m) => examMatchesTerm(m.exam, targetTermId));
    const consolidatedClassMarks = consolidateMarksByStudentAndSubject(
      termClassMarks.length > 0 ? termClassMarks : rawClassMarks,
      dbMatrix
    );
    const consolidatedStudentMarks = consolidateMarksByStudentAndSubject(studentMarks, dbMatrix);

    const {
      activeStage,
      activeColumns,
      activeMaxMarks,
      isCaOnlyStage,
    } = resolveEffectiveMatrixStageForMarks(
      dbMatrix,
      requestedStage,
      consolidatedClassMarks.length > 0 ? consolidatedClassMarks : consolidatedStudentMarks
    );

    const classAverageMap: Record<string, { sum: number; count: number }> = {};
    consolidatedClassMarks.forEach((m) => {
      const key = String(m.subjectId);
      if (!classAverageMap[key]) {
        classAverageMap[key] = { sum: 0, count: 0 };
      }
      const mapped = mapStudentMarkToMatrix(m, dbMatrix, activeStage);
      if (mapped.hasValidScore) {
        classAverageMap[key].sum += mapped.stageTotal;
        classAverageMap[key].count += 1;
      }
    });

    const commentary = activeSessionId
      ? await prisma.studentCommentary.findFirst({
          where: {
            studentId: req.studentId,
            sessionId: activeSessionId,
          },
          select: { remark: true, reviewNotes: true },
        })
      : null;

    let totalScoreSum = 0;
    let totalMaxSum = 0;
    let marksCount = 0;

    const reportCard = consolidatedStudentMarks.flatMap((m) => {
      const mapped = mapStudentMarkToMatrix(m, dbMatrix, activeStage);
      const isAbsent = m.absent === '1' || m.absent === 'true';
      if (!mapped.hasValidScore && !isAbsent) return [];

      const rowMaxMarks = mapped.effectiveMaxMarks || activeMaxMarks;
      if (mapped.hasValidScore) {
        totalScoreSum += mapped.stageTotal;
        totalMaxSum += rowMaxMarks;
        marksCount++;
      }

      const avgData = classAverageMap[String(m.subjectId)];
      const classAverage =
        avgData && avgData.count > 0
          ? Number((avgData.sum / avgData.count).toFixed(1))
          : mapped.hasValidScore
          ? mapped.stageTotal
          : 0;

      // ZERO DATA LEAKAGE: When exam/full is not released, sanitize theoryMark and keep only released stage metrics!
      const caScore = mapped.caTotal > 0 ? String(mapped.caTotal) : (mapped.stageTotal > 0 && !isExamReleased ? String(mapped.stageTotal) : null);

      return [{
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
        maxMarks: rowMaxMarks,
        absent: isAbsent,
        classAverage: isExamReleased || isCaOnlyStage || isCombinedCaOnly ? classAverage : null,
        statusRemark: isAbsent ? 'Absent' : (caScore ? 'Progress recorded' : 'Pending'),
      }];
    });

    // Zero Leakage: Withhold overall average if terminal exam is unreleased
    // For COMBINED_CA only: show CA average, capped at CA total from DB matrix
    const rawAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;
    const normalizedAverage =
      marksCount > 0 && totalMaxSum > 0
        ? Number(((totalScoreSum / totalMaxSum) * 100).toFixed(1))
        : marksCount > 0 && activeMaxMarks > 0
          ? Number((((totalScoreSum / marksCount) / activeMaxMarks) * 100).toFixed(1))
          : rawAverage;
    const overallAverage = isExamReleased && marksCount > 0 ? normalizedAverage : null;
    const combinedCaAverage = (isCombinedCaOnly || isCaOnlyStage) && marksCount > 0 ? rawAverage : null;

    let rank = null;
    let totalClassStudents = 0;

    // ZERO LEAKAGE: Rank MUST NOT be computed or sent for CA-only or Combined CA releases
    // Rank is ONLY computed and sent on full Terminal Exam report cards
    if (isExamReleased && !isCaOnlyStage && targetClassId && targetSectionId && activeSessionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: targetClassId,
          sectionId: targetSectionId,
          sessionId: activeSessionId,
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
        },
        select: { studentId: true },
      });
      const studentIds = enrolls.map((e) => e.studentId);
      totalClassStudents = studentIds.length;

      if (studentIds.length > 0) {
        const allMarks = await prisma.mark.findMany({
          where: {
            studentId: { in: studentIds },
            sessionId: activeSessionId,
            classId: targetClassId,
            examId: { in: examIds },
            ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
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
    } else if (targetClassId && targetSectionId && activeSessionId) {
      const count = await prisma.enroll.count({
        where: {
          classId: targetClassId,
          sectionId: targetSectionId,
          sessionId: activeSessionId,
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
        },
      });
      totalClassStudents = count;
    }

    const montAssessmentForJson = activeSessionId
      ? await prisma.montessoriAssessment.findFirst({
          where: {
            studentId: req.studentId,
            sessionId: activeSessionId,
          },
          orderBy: { id: 'desc' },
        })
      : null;

    return res.json({
      success: true,
      isPublished: true,
      ...selectionMeta,
      schoolBranding,
      studentBio: studentRecord,
      attendanceSummary: attendanceRes.summary,
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
      rawAverage: isExamReleased && !isCaOnlyStage ? rawAverage : null,
      combinedCaAverage: isCombinedCaOnly || isCaOnlyStage ? combinedCaAverage : null,
      commentary: commentary?.remark || null,
      teacherComment: commentary?.remark || null,
      principalComment: commentary?.reviewNotes || null,
      psychomotor: {
        writingMastery: montAssessmentForJson?.writingMastery || 'AC',
        drawingCapability: montAssessmentForJson?.drawingCapability || 'AC',
        physicalCoordination: montAssessmentForJson?.physicalCoordination || 'AC',
        motorSkillProgression: montAssessmentForJson?.motorSkillProgression || 'AC',
      },
      affective: {
        generalPunctuality: montAssessmentForJson?.generalPunctuality || 'AC',
        peerRespect: montAssessmentForJson?.peerRespect || 'AC',
        aestheticNeatness: montAssessmentForJson?.aestheticNeatness || 'AC',
        activeGroupParticipation: montAssessmentForJson?.activeGroupParticipation || 'AC',
      },
      // ZERO LEAKAGE: rank is null unless terminal exam is fully released AND class position is enabled by Admin
      rank:
        isExamReleased &&
        !isCaOnlyStage &&
        schoolBranding.showPosition !== false &&
        (schoolBranding.rankingType !== 'topn' || (rank !== null && rank <= (schoolBranding.rankingLimit || 3)))
          ? rank
          : null,
      showPosition: schoolBranding.showPosition !== false,
      totalClassStudents,
      resumptionDate: studentMarks[0]?.exam?.resumptionDate || schoolBranding.resumptionDate || null,
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
    if (!req.studentId) {
      return res.status(400).json({ success: false, message: 'Student context unavailable.' });
    }

    const { rankingType = 'full', rankingLimit = 3 } = req.query as any;
    const limit = parseInt(rankingLimit as string, 10) || 3;

    const scope = await resolveStudentReportFilterScope(prisma, {
      studentId: req.studentId,
      branchId: req.studentBranchId,
      fallbackSessionId: req.childSessionId,
      fallbackClassId: req.childClassId,
      fallbackSectionId: req.childSectionId,
      query: req.query as Record<string, any>,
    });

    if (!scope.isAuthorizedSession) {
      return res.status(403).json({
        success: false,
        message: 'Selected academic session is not available for this child.',
      });
    }
    if (!scope.isAuthorizedClass) {
      return res.status(403).json({
        success: false,
        message: 'Selected class is not associated with this child.',
      });
    }

    const { activeSessionId, targetClassId, targetSectionId, targetTermId, targetTermLabel } = scope;

    // Per-Class & Per-Term Publication Gating + Auto-Publish Support
    const [baseBranding, sessionRow] = await Promise.all([
      resolveSchoolReportBranding(prisma, req.studentBranchId, {
        classId: targetClassId,
        sectionId: targetSectionId,
        sessionId: activeSessionId,
      }),
      activeSessionId
        ? prisma.schoolYear.findUnique({ where: { id: activeSessionId }, select: { schoolYear: true } })
        : Promise.resolve(null),
    ]);

    const schoolBranding = {
      ...baseBranding,
      ...(sessionRow?.schoolYear ? { academicSession: sessionRow.schoolYear } : {}),
      currentTerm: targetTermLabel,
    };

    const {
      isPublished,
      releaseCa1,
      releaseCa2,
      releaseCombinedCa,
      releaseExam,
      releaseFull,
    } = await resolveClassPublicationForStudent(prisma, {
      classId: targetClassId,
      sectionId: targetSectionId,
      sessionId: activeSessionId,
      termId: targetTermId,
      branchId: req.studentBranchId,
      autoPublishReportCards: schoolBranding.autoPublishReportCards !== false,
    });

    if (!isPublished) {
      return res.status(403).json({
        success: false,
        message: `Official report cards for your child's class (${targetTermLabel}) have not been published yet by the school administration.`,
      });
    }

    const visibleStages: string[] = [];
    if (releaseCa1) visibleStages.push('CA1');
    if (releaseCa2) visibleStages.push('CA2');
    if (releaseExam) visibleStages.push('EXAM');
    if (releaseFull) visibleStages.push('FULL');

    const isExamReleased = Boolean(releaseExam || releaseFull);

    let isEcdClass = false;
    let isCommentClass = false;
    let clsInfo = null;
    if (targetClassId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: targetClassId },
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
      const sessionName = sessionRow?.schoolYear || 'N/A';
      let formTeacherName = 'Class Teacher';

      if (targetSectionId) {
        const sec = await prisma.section.findUnique({ where: { id: targetSectionId }, select: { name: true } });
        sectionName = sec?.name || 'N/A';
      }
      if (targetClassId && targetSectionId && activeSessionId) {
        const formAllocation = await prisma.teacherAllocation.findFirst({
          where: {
            classId: targetClassId,
            sectionId: targetSectionId,
            sessionId: activeSessionId,
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

      const [subjectComments, commentary, nextTermFees] = await Promise.all([
        prisma.subjectCommentAssessment.findMany({
          where: {
            studentId: req.studentId,
            ...(targetClassId ? { classId: targetClassId } : {}),
            ...(activeSessionId ? { sessionId: activeSessionId } : {}),
            termId: targetTermId,
            ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
          },
          include: {
            subject: { select: { name: true, subjectCode: true } },
          },
          orderBy: { subject: { name: 'asc' } },
        }),
        activeSessionId
          ? prisma.studentCommentary.findFirst({
              where: {
                studentId: req.studentId,
                sessionId: activeSessionId,
                ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
              },
            })
          : Promise.resolve(null),
        resolveNextTermFees(req.studentBranchId, targetClassId),
      ]);

      const pdfBuffer = await generateCommentBasedReportCardPdf({
        schoolName: student.branch?.name || 'Ugbekun Schools',
        branchCode: student.branch?.code || 'GEN',
        studentName: `${student.lastName}, ${student.firstName}`,
        registerNo: student.registerNo,
        className: clsInfo.name,
        sectionName,
        sessionName,
        examName: targetTermLabel,
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
      const sessionName = sessionRow?.schoolYear || 'N/A';
      let formTeacherName = 'Class Teacher';

      if (targetSectionId) {
        const sec = await prisma.section.findUnique({ where: { id: targetSectionId }, select: { name: true } });
        sectionName = sec?.name || 'N/A';
      }
      if (targetClassId && targetSectionId && activeSessionId) {
        const formAllocation = await prisma.teacherAllocation.findFirst({
          where: {
            classId: targetClassId,
            sectionId: targetSectionId,
            sessionId: activeSessionId,
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

      const assessments = await prisma.montessoriAssessment.findMany({
        where: {
          studentId: req.studentId,
          ...(targetClassId ? { classId: targetClassId } : {}),
          ...(targetSectionId ? { sectionId: targetSectionId } : {}),
          ...(activeSessionId ? { sessionId: activeSessionId } : {}),
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
          ...(examIdVal ? { examId: examIdVal } : {}),
        },
        include: {
          exam: { select: { name: true, termId: true, resumptionDate: true, publishResult: true } },
        },
        orderBy: { id: 'desc' },
      });

      const assessment = assessments.find((a) => examMatchesTerm(a.exam, targetTermId)) || null;

      if (!assessment) {
        return res.status(404).json({
          success: false,
          message: `No Montessori assessment recorded yet for ${clsInfo.name} (${targetTermLabel}).`,
        });
      }

      const examName = assessment?.exam?.name || targetTermLabel;
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

    const className = clsInfo?.name || 'N/A';
    let sectionName = 'N/A';
    const sessionName = sessionRow?.schoolYear || 'N/A';
    let formTeacherName = 'Class Teacher';

    if (targetSectionId) {
      const sec = await prisma.section.findUnique({ where: { id: targetSectionId }, select: { name: true } });
      sectionName = sec?.name || 'N/A';
    }
    if (targetClassId && targetSectionId && activeSessionId) {
      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: targetClassId,
          sectionId: targetSectionId,
          sessionId: activeSessionId,
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

    const sessionMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        ...(targetClassId ? { classId: targetClassId } : {}),
        ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
      },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, termId: true, resumptionDate: true, publishResult: true } },
      },
    });

    const studentMarks = sessionMarks.filter((m) => examMatchesTerm(m.exam, targetTermId));

    if (studentMarks.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No subject marks recorded yet for ${className} · ${targetTermLabel} (${sessionName}).`,
      });
    }

    const [dbMatrix, gradingScale] = await Promise.all([
      resolveClassEvaluationMatrix(prisma, req.studentBranchId, targetClassId),
      resolveGradingScale(prisma, req.studentBranchId, targetClassId),
    ]);

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
    const requestedStageRaw = String((req.query as any)?.stage || defaultStage).toUpperCase();
    const requestedStage =
      !isExamReleased &&
      (requestedStageRaw === 'FULL' ||
        requestedStageRaw === 'ALL' ||
        requestedStageRaw === 'TERMINAL' ||
        requestedStageRaw === 'EXAM' ||
        requestedStageRaw === 'EXAM_ONLY')
        ? defaultStage
        : requestedStageRaw;

    const subjectIds = Array.from(new Set(studentMarks.map((m) => m.subjectId)));
    const examIds = Array.from(new Set(studentMarks.map((m) => m.examId)));
    const rawClassMarks = await prisma.mark.findMany({
      where: {
        ...(targetClassId ? { classId: targetClassId } : {}),
        ...(targetSectionId ? { sectionId: targetSectionId } : {}),
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        subjectId: { in: subjectIds },
      },
      include: {
        exam: { select: { name: true, termId: true } },
      },
    });

    const termClassMarks = rawClassMarks.filter((m) => examMatchesTerm(m.exam, targetTermId));
    const consolidatedClassMarks = consolidateMarksByStudentAndSubject(
      termClassMarks.length > 0 ? termClassMarks : rawClassMarks,
      dbMatrix
    );
    const consolidatedStudentMarks = consolidateMarksByStudentAndSubject(studentMarks, dbMatrix);

    const {
      activeStage,
      activeColumns,
      activeMaxMarks,
      isCaOnlyStage,
    } = resolveEffectiveMatrixStageForMarks(
      dbMatrix,
      requestedStage,
      consolidatedClassMarks.length > 0 ? consolidatedClassMarks : consolidatedStudentMarks
    );

    const classAverageMap: Record<string, { sum: number; count: number }> = {};
    consolidatedClassMarks.forEach((m) => {
      const key = String(m.subjectId);
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
    let totalMaxSum = 0;
    let marksCount = 0;

    const reportCard = consolidatedStudentMarks.flatMap((m) => {
      const mapped = mapStudentMarkToMatrix(m, dbMatrix, activeStage);
      const isAbsent = m.absent === '1' || m.absent === 'true';
      if (!mapped.hasValidScore && !isAbsent) return [];

      const rowMaxMarks = mapped.effectiveMaxMarks || activeMaxMarks;
      if (mapped.hasValidScore) {
        totalScoreSum += mapped.stageTotal;
        totalMaxSum += rowMaxMarks;
        marksCount++;
      }

      const avgData = classAverageMap[String(m.subjectId)];
      const classAverage =
        avgData && avgData.count > 0
          ? Number((avgData.sum / avgData.count).toFixed(1))
          : mapped.hasValidScore
          ? mapped.stageTotal
          : 0;

      // ZERO DATA LEAKAGE IN PDF:
      return [{
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
        maxMarks: rowMaxMarks,
        absent: isAbsent,
        classAverage: isExamReleased || isCaOnlyStage ? classAverage : null,
      }];
    });

    const rawAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;
    const normalizedAverage =
      marksCount > 0 && totalMaxSum > 0
        ? Number(((totalScoreSum / totalMaxSum) * 100).toFixed(1))
        : marksCount > 0 && activeMaxMarks > 0
          ? Number((((totalScoreSum / marksCount) / activeMaxMarks) * 100).toFixed(1))
          : rawAverage;
    const overallAverage = (isExamReleased || isCaOnlyStage) && marksCount > 0 ? normalizedAverage : 0;
    const nextTermFeesStr = await resolveNextTermFees(req.studentBranchId, targetClassId);

    let rank = null;
    let totalClassStudents = 0;

    if (isExamReleased && !isCaOnlyStage && targetClassId && targetSectionId && activeSessionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: targetClassId,
          sectionId: targetSectionId,
          sessionId: activeSessionId,
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
        },
        select: { studentId: true },
      });
      const studentIds = enrolls.map((e) => e.studentId);
      totalClassStudents = studentIds.length;

      if (studentIds.length > 0) {
        const allMarks = await prisma.mark.findMany({
          where: {
            studentId: { in: studentIds },
            sessionId: activeSessionId,
            classId: targetClassId,
            examId: { in: examIds },
            ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
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
    } else if (targetClassId && targetSectionId && activeSessionId) {
      const count = await prisma.enroll.count({
        where: {
          classId: targetClassId,
          sectionId: targetSectionId,
          sessionId: activeSessionId,
          ...(req.studentBranchId ? { branchId: req.studentBranchId } : {}),
        },
      });
      totalClassStudents = count;
    }

    const [commentaryRecord, montAssessment] = await Promise.all([
      activeSessionId
        ? prisma.studentCommentary.findFirst({
            where: {
              studentId: req.studentId,
              sessionId: activeSessionId,
            },
            select: { remark: true, reviewNotes: true },
          })
        : Promise.resolve(null),
      activeSessionId
        ? prisma.montessoriAssessment.findFirst({
            where: {
              studentId: req.studentId,
              sessionId: activeSessionId,
            },
            orderBy: { id: 'desc' },
          })
        : Promise.resolve(null),
    ]);

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
      rank: schoolBranding.showPosition === false ? null : rank,
      totalClassStudents,
      rankingType: schoolBranding.showPosition === false ? 'hidden' : (schoolBranding.rankingType || rankingType),
      rankingLimit: Number(schoolBranding.rankingLimit || limit),
      showPosition: schoolBranding.showPosition !== false,
      resumptionDate,
      nextTermFees: schoolBranding.nextTermFees || nextTermFeesStr,
      formTeacherName: schoolBranding.classTeacherName || formTeacherName,
      isMidTerm: isCaOnlyStage && activeStage !== 'COMBINED_CA' && activeStage !== 'CA_ONLY',
      stage: activeStage,
      visibleStages,
      photo: student.photo || null,
      gender: student.gender || null,
      birthday: student.birthday || null,
      schoolBranding: {
        ...schoolBranding,
        academicSession: sessionName !== 'N/A' ? sessionName : schoolBranding.academicSession,
        currentTerm: targetTermLabel,
      },
      gradingRanges: gradingScale.ranges,
      assessmentComponents: activeColumns,
      maxTotal: activeMaxMarks,
      assessment: montAssessment || {},
      psychomotor: {
        writingMastery: montAssessment?.writingMastery || 'AC',
        drawingCapability: montAssessment?.drawingCapability || 'AC',
        physicalCoordination: montAssessment?.physicalCoordination || 'AC',
        motorSkillProgression: montAssessment?.motorSkillProgression || 'AC',
      },
      affective: {
        generalPunctuality: montAssessment?.generalPunctuality || 'AC',
        peerRespect: montAssessment?.peerRespect || 'AC',
        aestheticNeatness: montAssessment?.aestheticNeatness || 'AC',
        activeGroupParticipation: montAssessment?.activeGroupParticipation || 'AC',
      },
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
