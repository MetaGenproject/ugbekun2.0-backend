import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { generateReportCardPdf, generateMontessoriReportCardPdf } from '../../lib/pdfService';
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
import {
  resolveSchoolReportBranding,
  resolveTermIdFromInput,
  termLabelForId,
  examMatchesTerm,
  fetchStudentReportOptions,
  resolveClassPublicationForStudent,
  resolveStudentStageAccess,
} from '../../lib/reportCardHelper';

/**
 * GET /api/student/report-card/options
 * Returns the authenticated student's enrolled sessions, classes, and terms for report card generation.
 */
export async function getReportCardOptions(req: Request, res: Response): Promise<Response | void> {
  try {
    if (!req.studentId) {
      return res.status(400).json({ success: false, message: 'Student context unavailable.' });
    }
    const options = await fetchStudentReportOptions(prisma, req.studentId, req.branchId, req.sessionId);
    return res.json({ success: true, ...options });
  } catch (error) {
    console.error('[STUDENT] Report card options error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load report card options.' });
  }
}

/**
 * GET /api/student/attendance
 */
export async function getAttendance(req: Request, res: Response): Promise<Response | void> {
  try {
    if (!req.studentId || !req.branchId) {
      return res.status(400).json({ success: false, message: 'Student context unavailable.' });
    }

    const report = await buildStudentAttendanceReport(prisma, {
      studentId: req.studentId,
      sessionId: req.sessionId,
      branchId: req.branchId,
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
    console.error('[STUDENT] Attendance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve attendance logs.' });
  }
}

/**
 * GET /api/student/tasks
 */
export async function getTasks(req: Request, res: Response): Promise<Response | void> {
  let targetClassId = req.classId;
  if (!targetClassId && req.studentId) {
    const latestEnroll = await prisma.enroll.findFirst({
      where: { studentId: req.studentId },
      orderBy: { id: 'desc' },
      select: { classId: true },
    });
    targetClassId = latestEnroll?.classId || null;
  }

  if (!targetClassId) {
    return res.json({ success: true, notes: [], onlineExams: [], homeworks: [] });
  }

  try {
    const [allNotes, onlineExams, homeworks] = await Promise.all([
      prisma.teacherNote.findMany({
        where: { branchId: req.branchId },
        include: {
          teacher: { select: { name: true } },
        },
      }),
      prisma.onlineExam.findMany({
        where: {
          classId: targetClassId,
          ...(req.branchId ? { branchId: req.branchId } : {}),
        },
        include: {
          subject: { select: { name: true } },
          submissions: {
            where: { studentId: req.studentId },
            select: { totalMark: true, createdAt: true },
          },
        },
      }),
      prisma.homework.findMany({
        where: {
          classId: targetClassId,
          ...(req.branchId ? { branchId: req.branchId } : {}),
        },
        include: {
          subject: { select: { name: true } },
          submissions: {
            where: { studentId: req.studentId },
            select: { id: true, score: true, feedback: true, createdAt: true },
          },
        },
        orderBy: { dueDate: 'asc' },
      }),
    ]);

    const notes = allNotes
      .filter((n) => n.classId.split(',').map((s) => s.trim()).includes(String(targetClassId)))
      .map((n) => ({
        id: n.id,
        title: n.title,
        description: n.description,
        fileName: n.fileName,
        encName: n.encName,
        teacherName: n.teacher?.name || 'Staff',
        createdAt: n.createdAt,
      }));

    return res.json({
      success: true,
      notes,
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
      homeworks: homeworks.map((hw) => {
        const submission = hw.submissions[0] || null;
        return {
          id: hw.id,
          title: hw.title,
          subjectName: hw.subject?.name || 'General',
          dueDate: hw.dueDate,
          description: hw.description,
          questions: hw.questions || [],
          submitted: !!submission,
          submissionScore: submission?.score ?? null,
          submissionStatus: submission ? (submission.score !== null ? 'GRADED' : 'SUBMITTED') : 'PENDING',
          feedback: submission?.feedback || null,
          submittedAt: submission?.createdAt || null,
        };
      }),
    });
  } catch (error) {
    console.error('[STUDENT] Tasks error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve tasks.' });
  }
}

/**
 * GET /api/student/grades
 * Supports optional ?sessionId=&classId=&termId=&stage= filters scoped to the authenticated student.
 */
export async function getGrades(req: Request, res: Response): Promise<Response | void> {
  try {
    if (!req.studentId) {
      return res.status(400).json({ success: false, message: 'Student context unavailable.' });
    }

    const reqSessionId = req.query.sessionId ? Number(req.query.sessionId) : null;
    const reqClassId = req.query.classId ? Number(req.query.classId) : null;
    const reqTermId = req.query.termId ? Number(req.query.termId) : null;

    const options = await fetchStudentReportOptions(prisma, req.studentId, req.branchId, req.sessionId);
    const activeSessionId = reqSessionId || req.sessionId || options.currentSessionId || undefined;
    const matchedClassOption =
      options.classes.find(
        (c) =>
          (reqClassId ? c.classId === reqClassId : true) &&
          (activeSessionId ? c.sessionId === activeSessionId : true)
      ) ||
      (reqClassId ? options.classes.find((c) => c.classId === reqClassId) : undefined);

    if (reqClassId && !matchedClassOption) {
      return res.status(403).json({
        success: false,
        message: 'You are not enrolled in the selected class.',
      });
    }

    const targetClassId = reqClassId || matchedClassOption?.classId || req.classId || undefined;
    const targetSectionId = matchedClassOption?.sectionId || req.sectionId || undefined;
    const targetTermId = resolveTermIdFromInput(reqTermId, options.currentTermLabel);
    const targetTermLabel = termLabelForId(targetTermId);

    let isEcdClass = false;
    let clsInfo = null;
    if (targetClassId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: targetClassId },
        select: { id: true, name: true, isEcd: true },
      });
      isEcdClass = !!clsInfo?.isEcd;
    }

    // Per-Class Publication Gating + Auto-Publish Support
    const [baseBranding, studentRecord, sessionRow, sectionRow, attendanceRes] =
      await Promise.all([
        resolveSchoolReportBranding(prisma, req.branchId, {
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
        req.branchId
          ? listSubmittedAttendance(prisma, {
              studentId: req.studentId,
              sessionId: activeSessionId,
              branchId: req.branchId,
            })
          : Promise.resolve({ logs: [], summary: { percentage: 100, totalDays: 0, presentCount: 0, absentCount: 0, lateCount: 0 } }),
      ]);

    const schoolBranding = {
      ...baseBranding,
      ...(sessionRow?.schoolYear ? { academicSession: sessionRow.schoolYear } : {}),
      currentTerm: targetTermLabel,
    };

    const [pubState, dbMatrix] = await Promise.all([
      resolveClassPublicationForStudent(prisma, {
        classId: targetClassId,
        sectionId: targetSectionId,
        sessionId: activeSessionId,
        termId: targetTermId,
        branchId: req.branchId,
        autoPublishReportCards: schoolBranding.autoPublishReportCards !== false,
      }),
      isEcdClass
        ? Promise.resolve(null)
        : resolveClassEvaluationMatrix(prisma, req.branchId, targetClassId),
    ]);

    const stageAccess = resolveStudentStageAccess({
      dbMatrix,
      pubState,
      requestedStageRaw: (req.query as any)?.stage,
      isEcd: isEcdClass,
      className: clsInfo?.name,
      termLabel: targetTermLabel,
    });

    const selectionMeta = {
      sessionId: activeSessionId || null,
      sessionName: sessionRow?.schoolYear || schoolBranding.academicSession || null,
      classId: targetClassId || null,
      className: clsInfo?.name || null,
      sectionId: targetSectionId || null,
      sectionName: sectionRow?.name || null,
      termId: targetTermId,
      termLabel: targetTermLabel,
      requestedStage: stageAccess.requestedStage,
      visibleStages: stageAccess.publishedStages,
      options,
    };

    if (!stageAccess.allowed) {
      return res.json({
        success: true,
        isPublished: false,
        ...selectionMeta,
        stage: stageAccess.requestedStage,
        schoolBranding,
        studentBio: studentRecord,
        reportCard: [],
        overallAverage: null,
        commentary: null,
        rank: null,
        totalClassStudents: 0,
        message: stageAccess.denialMessage,
      });
    }

    if (isEcdClass) {
      const ecdWhere = {
        studentId: req.studentId,
        classId: targetClassId,
        ...(targetSectionId ? { sectionId: targetSectionId } : {}),
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        ...(req.branchId ? { branchId: req.branchId } : {}),
      };
      const allEcdAssessments = await prisma.montessoriAssessment.findMany({
        where: ecdWhere,
        include: {
          exam: { select: { name: true, termId: true, publishResult: true } },
        },
        orderBy: { id: 'desc' },
      });
      const matchedEcd =
        allEcdAssessments.find((a) => examMatchesTerm(a.exam, targetTermId)) || null;
      return res.json({
        success: true,
        isEcd: true,
        isPublished: true,
        ...selectionMeta,
        schoolBranding,
        studentBio: studentRecord,
        assessment: matchedEcd,
      });
    }

    const sessionMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        ...(targetClassId ? { classId: targetClassId } : {}),
        ...(req.branchId ? { branchId: req.branchId } : {}),
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        exam: { select: { id: true, name: true, termId: true, resumptionDate: true, publishResult: true } },
      },
    });

    const studentMarks = sessionMarks.filter((m) => examMatchesTerm(m.exam, targetTermId));

    if (studentMarks.length === 0) {
      const commentary = activeSessionId
        ? await prisma.studentCommentary.findFirst({
            where: {
              studentId: req.studentId,
              sessionId: activeSessionId,
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
        reportCard: [],
        overallAverage: null,
        commentary: commentary?.remark || null,
        teacherComment: commentary?.remark || null,
        principalComment: commentary?.reviewNotes || null,
        resumptionDate: schoolBranding.resumptionDate || null,
        nextTermFees: schoolBranding.nextTermFees || null,
        attendanceSummary: attendanceRes.summary,
        rank: null,
        totalClassStudents: 0,
        message: `No subject scores recorded for ${selectionMeta.className || 'this class'} · ${targetTermLabel} (${selectionMeta.sessionName || 'Session'}).`,
      });
    }

    const gradingScale = await resolveGradingScale(prisma, req.branchId, targetClassId);
    const requestedStage = stageAccess.resolvedStage;

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

      return [{
        id: m.id,
        examName: m.exam.name,
        subjectName: m.subject.name,
        subjectCode: m.subject.subjectCode,
        cbtMark: mapped.caTotal > 0 ? String(mapped.caTotal) : null,
        cbtScale: (m as any).cbtScale || 10,
        theoryMark: isCaOnlyStage ? null : (mapped.examTotal > 0 ? String(mapped.examTotal) : null),
        mark: mapped.hasValidScore ? String(mapped.stageTotal) : null,
        componentScores: mapped.componentScores,
        maxMarks: rowMaxMarks,
        absent: isAbsent,
        classAverage,
      }];
    });

    const rawAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;
    const overallAverage =
      marksCount > 0 && totalMaxSum > 0
        ? Number(((totalScoreSum / totalMaxSum) * 100).toFixed(1))
        : marksCount > 0 && activeMaxMarks > 0
          ? Number((((totalScoreSum / marksCount) / activeMaxMarks) * 100).toFixed(1))
          : rawAverage;

    let rank = null;
    let totalClassStudents = 0;

    if (!isCaOnlyStage && targetClassId && targetSectionId && activeSessionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: targetClassId,
          sectionId: targetSectionId,
          sessionId: activeSessionId,
          ...(req.branchId ? { branchId: req.branchId } : {}),
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
            ...(req.branchId ? { branchId: req.branchId } : {}),
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
      stage: activeStage,
      isCaOnlyStage,
      maxTotal: activeMaxMarks,
      assessmentComponents: activeColumns,
      allMatrixColumns: dbMatrix.columns,
      gradingScale,
      schoolBranding,
      studentBio: studentRecord,
      attendanceSummary: attendanceRes.summary,
      reportCard,
      overallAverage,
      rawAverage,
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
      resumptionDate: studentMarks[0]?.exam?.resumptionDate || schoolBranding.resumptionDate || null,
      nextTermFees: schoolBranding.nextTermFees || null,
      rank:
        schoolBranding.showPosition !== false &&
        (schoolBranding.rankingType !== 'topn' || (rank !== null && rank <= (schoolBranding.rankingLimit || 3)))
          ? rank
          : null,
      showPosition: schoolBranding.showPosition !== false,
      totalClassStudents,
    });
  } catch (error) {
    console.error('[STUDENT] Grades error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve grade card.' });
  }
}

/**
 * GET /api/student/grades/export-pdf
 * Supports optional ?sessionId=&classId=&termId=&stage= filters scoped to the authenticated student.
 */
export async function exportGradesPdf(req: Request, res: Response): Promise<Response | void> {
  try {
    if (!req.studentId) {
      return res.status(400).json({ success: false, message: 'Student context unavailable.' });
    }

    const { rankingType = 'full', rankingLimit = 3 } = req.query as any;
    const limit = parseInt(rankingLimit as string, 10) || 3;
    const reqSessionId = req.query.sessionId ? Number(req.query.sessionId) : null;
    const reqClassId = req.query.classId ? Number(req.query.classId) : null;
    const reqTermId = req.query.termId ? Number(req.query.termId) : null;

    const options = await fetchStudentReportOptions(prisma, req.studentId, req.branchId, req.sessionId);
    const activeSessionId = reqSessionId || req.sessionId || options.currentSessionId || undefined;
    const matchedClassOption =
      options.classes.find(
        (c) =>
          (reqClassId ? c.classId === reqClassId : true) &&
          (activeSessionId ? c.sessionId === activeSessionId : true)
      ) ||
      (reqClassId ? options.classes.find((c) => c.classId === reqClassId) : undefined);

    if (reqClassId && !matchedClassOption) {
      return res.status(403).json({
        success: false,
        message: 'You are not enrolled in the selected class.',
      });
    }

    const targetClassId = reqClassId || matchedClassOption?.classId || req.classId || undefined;
    const targetSectionId = matchedClassOption?.sectionId || req.sectionId || undefined;
    const targetTermId = resolveTermIdFromInput(reqTermId, options.currentTermLabel);
    const targetTermLabel = termLabelForId(targetTermId);

    // Per-Class Publication Gating + Auto-Publish Support
    const baseBranding = await resolveSchoolReportBranding(prisma, req.branchId, {
      classId: targetClassId,
      sectionId: targetSectionId,
      sessionId: activeSessionId,
    });

    const schoolBranding = {
      ...baseBranding,
      currentTerm: targetTermLabel,
    };

    let isEcdClass = false;
    let clsInfo = null;
    if (targetClassId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: targetClassId },
        select: { name: true, isEcd: true },
      });
      isEcdClass = !!clsInfo?.isEcd;
    }

    const [pubState, dbMatrix] = await Promise.all([
      resolveClassPublicationForStudent(prisma, {
        classId: targetClassId,
        sectionId: targetSectionId,
        sessionId: activeSessionId,
        termId: targetTermId,
        branchId: req.branchId,
        autoPublishReportCards: schoolBranding.autoPublishReportCards !== false,
      }),
      isEcdClass
        ? Promise.resolve(null)
        : resolveClassEvaluationMatrix(prisma, req.branchId, targetClassId),
    ]);

    const {
      releaseCa1,
      releaseCa2,
      releaseCombinedCa,
      releaseExam,
      releaseFull,
    } = pubState;

    const stageAccess = resolveStudentStageAccess({
      dbMatrix,
      pubState,
      requestedStageRaw: (req.query as any)?.stage,
      isEcd: isEcdClass,
      className: clsInfo?.name,
      termLabel: targetTermLabel,
    });

    if (!stageAccess.allowed) {
      return res.status(403).json({
        success: false,
        message: stageAccess.denialMessage,
      });
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

      if (targetSectionId && activeSessionId) {
        const sec = await prisma.section.findUnique({ where: { id: targetSectionId }, select: { name: true } });
        sectionName = sec?.name || 'N/A';
        const sess = await prisma.schoolYear.findUnique({ where: { id: activeSessionId }, select: { schoolYear: true } });
        sessionName = sess?.schoolYear || 'N/A';

        const formAllocation = await prisma.teacherAllocation.findFirst({
          where: {
            classId: targetClassId,
            sectionId: targetSectionId,
            sessionId: activeSessionId,
            branchId: req.branchId,
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
          classId: targetClassId,
          ...(targetSectionId ? { sectionId: targetSectionId } : {}),
          ...(activeSessionId ? { sessionId: activeSessionId } : {}),
          ...(req.branchId ? { branchId: req.branchId } : {}),
          ...(examIdVal ? { examId: examIdVal } : {}),
        },
        include: {
          exam: { select: { name: true, termId: true, resumptionDate: true, publishResult: true } },
        },
        orderBy: { id: 'desc' },
      });

      const assessment =
        assessments.find((a) => examMatchesTerm(a.exam, targetTermId)) || null;

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

    let className = clsInfo?.name || 'N/A';
    let sectionName = 'N/A';
    let sessionName = 'N/A';
    let formTeacherName = 'Class Teacher';

    if (targetSectionId) {
      const sec = await prisma.section.findUnique({ where: { id: targetSectionId }, select: { name: true } });
      sectionName = sec?.name || 'N/A';
    }
    if (activeSessionId) {
      const sess = await prisma.schoolYear.findUnique({ where: { id: activeSessionId }, select: { schoolYear: true } });
      sessionName = sess?.schoolYear || 'N/A';
    }
    if (targetClassId && targetSectionId && activeSessionId) {
      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: targetClassId,
          sectionId: targetSectionId,
          sessionId: activeSessionId,
          branchId: req.branchId,
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
        ...(req.branchId ? { branchId: req.branchId } : {}),
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

    const gradingScale = await resolveGradingScale(prisma, req.branchId, targetClassId);
    const requestedStage = stageAccess.resolvedStage;

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

      return [{
        id: m.id,
        examName: m.exam.name,
        subjectName: m.subject.name,
        subjectCode: m.subject.subjectCode,
        cbtMark: mapped.caTotal > 0 ? String(mapped.caTotal) : null,
        theoryMark: isCaOnlyStage ? null : (mapped.examTotal > 0 ? String(mapped.examTotal) : null),
        mark: mapped.hasValidScore ? String(mapped.stageTotal) : null,
        componentScores: mapped.componentScores,
        maxMarks: rowMaxMarks,
        absent: isAbsent,
        classAverage,
      }];
    });

    const rawAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;
    const overallAverage =
      marksCount > 0 && totalMaxSum > 0
        ? Number(((totalScoreSum / totalMaxSum) * 100).toFixed(1))
        : marksCount > 0 && activeMaxMarks > 0
          ? Number((((totalScoreSum / marksCount) / activeMaxMarks) * 100).toFixed(1))
          : rawAverage;

    let rank = null;
    let totalClassStudents = 0;

    if (!isCaOnlyStage && targetClassId && targetSectionId && activeSessionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: targetClassId,
          sectionId: targetSectionId,
          sessionId: activeSessionId,
          ...(req.branchId ? { branchId: req.branchId } : {}),
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
            ...(req.branchId ? { branchId: req.branchId } : {}),
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
      nextTermFees: schoolBranding.nextTermFees || null,
      formTeacherName: schoolBranding.classTeacherName || formTeacherName,
      photo: student.photo || null,
      gender: student.gender || null,
      birthday: student.birthday || null,
      schoolBranding: {
        ...schoolBranding,
        academicSession: sessionName !== 'N/A' ? sessionName : schoolBranding.academicSession,
        currentTerm: targetTermLabel,
      },
      gradingRanges: gradingScale.ranges,
      stage: activeStage,
      isMidTerm: isCaOnlyStage && activeStage !== 'COMBINED_CA' && activeStage !== 'CA_ONLY',
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
    console.error('[STUDENT] Export PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate PDF report card.' });
  }
}

/**
 * GET /api/student/events
 */
export async function getEvents(req: Request, res: Response): Promise<Response | void> {
  try {
    const events = await prisma.event.findMany({
      where: {
        branchId: req.branchId,
        sessionId: req.sessionId,
      },
      orderBy: {
        startDate: 'asc',
      },
    });
    return res.json({ success: true, events });
  } catch (error) {
    console.error('[STUDENT] Get events error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch events.' });
  }
}

/**
 * GET /api/student/teachers
 */
export async function getTeachers(req: Request, res: Response): Promise<Response | void> {
  if (!req.classId) {
    return res.json({ success: true, formTeacher: null, subjectTeachers: [] });
  }

  try {
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: {
        classId: req.classId,
        ...(req.sectionId ? { sectionId: req.sectionId } : {}),
        branchId: req.branchId,
      },
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            photo: true,
            department: true,
            qualifications: true,
          },
        },
      },
      orderBy: { id: 'desc' },
    });

    const subjectAssigns = await prisma.subjectAssign.findMany({
      where: {
        classId: req.classId,
        ...(req.sectionId
          ? {
              OR: [
                { sectionId: req.sectionId },
                { sectionId: 0 },
              ],
            }
          : {}),
        ...(req.branchId ? { branchId: req.branchId } : {}),
      },
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            photo: true,
            department: true,
          },
        },
        subject: { select: { id: true, name: true, subjectCode: true } },
      },
    });

    const teacherMap = new Map();
    subjectAssigns.forEach((sa) => {
      if (!sa.teacher) return;
      const tid = sa.teacher.id;
      if (!teacherMap.has(tid)) {
        teacherMap.set(tid, {
          id: sa.teacher.id,
          name: sa.teacher.name,
          email: sa.teacher.email,
          phone: sa.teacher.phone,
          photo: sa.teacher.photo,
          department: sa.teacher.department,
          subjects: [],
        });
      }
      teacherMap.get(tid).subjects.push({
        id: sa.subject.id,
        name: sa.subject.name,
        code: sa.subject.subjectCode,
      });
    });

    return res.json({
      success: true,
      formTeacher: formAllocation?.teacher || null,
      subjectTeachers: Array.from(teacherMap.values()),
    });
  } catch (error) {
    console.error('[STUDENT] Get teachers error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve teachers directory.' });
  }
}

/**
 * GET /api/student/timetable
 */
export async function getTimetable(req: Request, res: Response): Promise<Response | void> {
  if (!req.classId) {
    return res.json({ success: true, timetableSlots: [], examScheduleSlots: [] });
  }

  try {
    // 1. Try matching student's section or class-wide slots (sectionId: null)
    let timetableSlots = await prisma.timetableSlot.findMany({
      where: {
        classId: req.classId,
        branchId: req.branchId,
        isPublished: true,
        ...(req.sectionId
          ? {
              OR: [{ sectionId: req.sectionId }, { sectionId: null }],
            }
          : {}),
      },
      include: {
        class: { select: { id: true, name: true, nameNumeric: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } },
        teacher: { select: { id: true, name: true, phone: true, photo: true } },
      },
      orderBy: [{ startTime: 'asc' }],
    });

    // 2. Fallback: if student's specific section has 0 slots, load all published slots for this class
    if (timetableSlots.length === 0) {
      timetableSlots = await prisma.timetableSlot.findMany({
        where: {
          classId: req.classId,
          branchId: req.branchId,
          isPublished: true,
        },
        include: {
          class: { select: { id: true, name: true, nameNumeric: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } },
          teacher: { select: { id: true, name: true, phone: true, photo: true } },
        },
        orderBy: [{ startTime: 'asc' }],
      });
    }

    // 3. Fallback: if isPublished filtered everything out, load class slots
    if (timetableSlots.length === 0) {
      timetableSlots = await prisma.timetableSlot.findMany({
        where: {
          classId: req.classId,
          branchId: req.branchId,
        },
        include: {
          class: { select: { id: true, name: true, nameNumeric: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } },
          teacher: { select: { id: true, name: true, phone: true, photo: true } },
        },
        orderBy: [{ startTime: 'asc' }],
      });
    }

    let examScheduleSlots = await prisma.examScheduleSlot.findMany({
      where: {
        classId: req.classId,
        branchId: req.branchId,
        isPublished: true,
        ...(req.sectionId
          ? {
              OR: [{ sectionId: req.sectionId }, { sectionId: null }],
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
          classId: req.classId,
          branchId: req.branchId,
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
        subjectType: slot.subject?.subjectType || null,
        teacherId: slot.teacherId,
        teacherName: slot.teacher?.name || null,
        teacherPhone: slot.teacher?.phone || null,
        teacherPhoto: slot.teacher?.photo || null,
        className: slot.class?.name || null,
        sectionName: slot.section?.name || null,
        roomLabel: slot.section?.name || null,
        sessionId: slot.sessionId,
        isPublished: slot.isPublished,
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
    console.error('[STUDENT] Timetable error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve timetable slots.' });
  }
}
