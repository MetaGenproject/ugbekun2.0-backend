import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { autoGradeCbtSubmission } from '../../lib/cbtService';
import gamificationService from '../../lib/gamificationService';
import { examWindowMessage, examWindowStatus } from '../../lib/examWindow';
import { companionExamKey, findCompanionOnlineExam } from '../../lib/cbtCompanionExam';
import { DEFAULT_CBT_SCALE, recordCbtPercentageOnMarksheet } from '../../lib/cbtMarkRecord';

function normalizeSession(str?: string | null): string {
  if (!str) return '';
  return str.trim().replace('/', '-');
}

function resolveSessionForExam(date: Date | null, sessionId: number | null, sessionById: Map<number, string>, defaultSession: string): string {
  if (sessionId && sessionById.has(sessionId)) {
    return sessionById.get(sessionId)!;
  }
  if (date) {
    const d = new Date(date);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const startYear = month >= 8 ? year : year - 1;
      return `${startYear}-${startYear + 1}`;
    }
  }
  return defaultSession;
}

function detectExamType(title: string): string {
  const lower = (title || '').toLowerCase();
  if (lower.includes('ca 1') || lower.includes('ca1') || lower.includes('first ca') || lower.includes('1st ca') || lower.includes('test 1')) return 'CA 1';
  if (lower.includes('ca 2') || lower.includes('ca2') || lower.includes('second ca') || lower.includes('2nd ca') || lower.includes('test 2')) return 'CA 2';
  if (lower.includes('mid') && (lower.includes('term') || lower.includes('exam') || lower.includes('test'))) return 'Mid-Term Exam';
  if (lower.includes('mock') || lower.includes('practice')) return 'Mock / Practice';
  if (lower.includes('exam') || lower.includes('terminal') || lower.includes('end of term') || lower.includes('final')) return 'Terminal Exam';
  return 'General Assessment';
}

/**
 * GET /api/student/cbt/active-exams
 * Query parameters:
 *  - session: string (e.g. "2026-2027", "2025-2026", or "all")
 *  - examType: string (e.g. "CA 1", "Mid-Term Exam", "all")
 */
export async function getActiveCbtExams(req: Request, res: Response): Promise<Response | void> {
  try {
    const classId = req.classId;
    if (!classId) {
      return res.json({ success: true, exams: [], availableSessions: [], availableExamTypes: [] });
    }

    // Resolve branch current session and system settings
    const branchSetting = await prisma.systemSetting.findFirst({
      where: { branchId: req.branchId },
      select: { academicSession: true, currentTerm: true },
    });
    const currentSessionRaw = branchSetting?.academicSession || '2026-2027';
    const currentSession = normalizeSession(currentSessionRaw);
    const currentTerm = branchSetting?.currentTerm || 'First Term';

    // Retrieve recorded school years to map session IDs and offer past session archives
    const schoolYears = await prisma.schoolYear.findMany({
      select: { id: true, schoolYear: true },
      orderBy: { id: 'desc' },
    });
    const sessionById = new Map<number, string>(schoolYears.map((s) => [s.id, normalizeSession(s.schoolYear)]));

    const onlineExams = await prisma.onlineExam.findMany({
      where: { classId, branchId: req.branchId },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const distributions = await prisma.cbtDistribution.findMany({
      where: {
        classId,
        branchId: req.branchId,
        isPublished: true,
        ...(req.sectionId ? { OR: [{ sectionId: req.sectionId }, { sectionId: null }] } : {}),
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        group: { select: { id: true, title: true, questionIds: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const companionExams = distributions.length
      ? await prisma.onlineExam.findMany({
          where: {
            branchId: req.branchId,
            OR: distributions.map((d) => ({
              title: d.title,
              classId: d.classId,
              subjectId: d.subjectId,
            })),
          },
        })
      : [];
    const companionByKey = new Map(
      companionExams.map((e) => [companionExamKey(e.title, e.classId, e.subjectId), e])
    );
    const coveredKeys = new Set(distributions.map((d) => companionExamKey(d.title, d.classId, d.subjectId)));
    const uniqueExamIds = [...new Set([...onlineExams.map((e) => e.id), ...companionExams.map((e) => e.id)])];
    const submissions =
      uniqueExamIds.length === 0
        ? []
        : await prisma.onlineExamSubmission.findMany({
            where: {
              studentId: req.studentId,
              onlineExamId: { in: uniqueExamIds },
            },
          });
    const subMap: Record<number, any> = {};
    submissions.forEach((s) => {
      subMap[s.onlineExamId] = s;
    });

    const formattedList = [
      ...distributions.map((dist) => {
        const companion = companionByKey.get(companionExamKey(dist.title, dist.classId, dist.subjectId));
        const sub = companion ? subMap[companion.id] : undefined;
        const qCount = Array.isArray(dist.group?.questionIds) ? (dist.group.questionIds as any[]).length : 10;
        const windowStatus = examWindowStatus(dist.startDate, dist.endDate);
        const examDate = dist.startDate || dist.createdAt;
        const examSession = resolveSessionForExam(examDate, companion?.sessionId || null, sessionById, currentSession);
        const isCurrentSession = normalizeSession(examSession) === currentSession;
        const examType = detectExamType(dist.title);

        return {
          id: dist.id,
          sourceType: 'distribution',
          title: dist.title,
          subjectName: dist.subject?.name || 'General Subject',
          subjectCode: dist.subject?.subjectCode || 'CBT',
          duration: dist.duration || 30,
          passingMark: dist.passingMark || 50,
          showResults: dist.showResults,
          questionCount: qCount,
          instructions: dist.instructions || 'Answer all questions within the allocated time limit.',
          isSubmitted: Boolean(sub && sub.submittedAt),
          totalMark: sub?.totalMark !== null && sub?.totalMark !== undefined ? sub.totalMark : null,
          startedAt: sub?.startedAt || null,
          submittedAt: sub?.submittedAt || null,
          startDate: dist.startDate,
          endDate: dist.endDate,
          createdAt: dist.createdAt,
          windowStatus,
          windowMessage: examWindowMessage(windowStatus, dist.startDate, dist.endDate),
          academicSession: examSession,
          isCurrentSession,
          examType,
          isExpired: windowStatus === 'ended',
        };
      }),
      ...onlineExams
        .filter((ex) => !coveredKeys.has(companionExamKey(ex.title, ex.classId, ex.subjectId)))
        .map((ex) => {
        const sub = subMap[ex.id];
        const questions = Array.isArray(ex.questions) ? ex.questions : [];
        const windowStatus = examWindowStatus(ex.examDate, null);
        const examDate = ex.examDate || ex.createdAt;
        const examSession = resolveSessionForExam(examDate, ex.sessionId, sessionById, currentSession);
        const isCurrentSession = normalizeSession(examSession) === currentSession;
        const examType = detectExamType(ex.title);

        return {
          id: ex.id,
          sourceType: 'online_exam',
          title: ex.title,
          subjectName: ex.subject?.name || 'General Subject',
          subjectCode: ex.subject?.subjectCode || 'CBT',
          duration: ex.duration || 30,
          passingMark: ex.passingMark || 50,
          showResults: true,
          questionCount: questions.length,
          instructions: 'Standard CBT online examination.',
          isSubmitted: Boolean(sub && sub.submittedAt),
          totalMark: sub?.totalMark !== null && sub?.totalMark !== undefined ? sub.totalMark : null,
          startedAt: sub?.startedAt || null,
          submittedAt: sub?.submittedAt || null,
          startDate: ex.examDate,
          endDate: null,
          createdAt: ex.createdAt,
          windowStatus,
          windowMessage: examWindowMessage(windowStatus, ex.examDate, null),
          academicSession: examSession,
          isCurrentSession,
          examType,
          isExpired: windowStatus === 'ended',
        };
      }),
    ];

    // Optional query filtering
    const querySession = req.query.session ? String(req.query.session).trim() : null;
    const queryExamType = req.query.examType ? String(req.query.examType).trim() : null;

    let resultList = formattedList;
    if (querySession && querySession !== 'all' && querySession !== 'ALL') {
      const normQuery = normalizeSession(querySession);
      resultList = resultList.filter((e) => normalizeSession(e.academicSession) === normQuery);
    }
    if (queryExamType && queryExamType !== 'all' && queryExamType !== 'All Types') {
      resultList = resultList.filter((e) => e.examType === queryExamType);
    }

    // Available sessions list (current session first, then other school years)
    const distinctSessions = Array.from(
      new Set([
        currentSession,
        ...formattedList.map((e) => e.academicSession),
        ...schoolYears.map((s) => normalizeSession(s.schoolYear)),
      ])
    ).filter(Boolean);

    const availableExamTypes = [
      'All Types',
      'CA 1',
      'CA 2',
      'Mid-Term Exam',
      'Terminal Exam',
      'Mock / Practice',
      'General Assessment',
    ];

    return res.json({
      success: true,
      currentSession,
      currentTerm,
      availableSessions: distinctSessions,
      availableExamTypes,
      exams: resultList,
      totalCount: formattedList.length,
      currentSessionCount: formattedList.filter((e) => e.isCurrentSession).length,
    });
  } catch (error) {
    console.error('[STUDENT] Active CBT exams error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load active CBT exams.' });
  }
}

/**
 * GET /api/student/cbt/exams/:id/take
 */
export async function takeCbtExam(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const examId = Number(id);

  try {
    let examTitle = 'CBT Examination';
    let duration = 30;
    let passingMark = 50;
    let instructions = '';
    let shuffleQuestions = true;
    let showResults = true;
    let rawQuestions: any[] = [];
    let targetOnlineExamId = examId;

    const dist = await prisma.cbtDistribution.findFirst({
      where: {
        id: examId,
        branchId: req.branchId,
        ...(req.classId ? { classId: req.classId } : {}),
      },
      include: {
        subject: { select: { name: true } },
        group: true,
      },
    });

    if (dist) {
      if (!dist.isPublished) {
        return res.status(403).json({ success: false, message: 'This examination is not published yet.' });
      }
      const windowStatus = examWindowStatus(dist.startDate, dist.endDate);
      if (windowStatus !== 'open') {
        return res.status(403).json({
          success: false,
          message: examWindowMessage(windowStatus, dist.startDate, dist.endDate),
          windowStatus,
          startDate: dist.startDate,
          endDate: dist.endDate,
        });
      }
      examTitle = dist.title;
      duration = dist.duration || 30;
      passingMark = dist.passingMark || 50;
      instructions = dist.instructions || '';
      shuffleQuestions = dist.shuffleQuestions;
      showResults = dist.showResults;

      if (dist.group && Array.isArray(dist.group.questionIds) && dist.group.questionIds.length > 0) {
        rawQuestions = await prisma.questionBank.findMany({
          where: { id: { in: (dist.group.questionIds as any[]).map(Number) }, status: 'APPROVED' },
        });
      } else {
        rawQuestions = await prisma.questionBank.findMany({
          where: { branchId: req.branchId, subjectId: dist.subjectId, status: 'APPROVED' },
          take: 20,
        });
      }

      let onlineEx = await findCompanionOnlineExam({
        title: dist.title,
        classId: dist.classId,
        subjectId: dist.subjectId,
        branchId: req.branchId,
      });
      if (!onlineEx) {
        onlineEx = await prisma.onlineExam.create({
          data: {
            title: dist.title,
            classId: dist.classId,
            subjectId: dist.subjectId,
            duration: dist.duration,
            passingMark: dist.passingMark,
            questions: rawQuestions,
            branchId: req.branchId,
            sessionId: req.sessionId || 5,
            examDate: dist.startDate || new Date(),
          },
        });
      }
      targetOnlineExamId = onlineEx.id;
    } else {
      const onlineExam = await prisma.onlineExam.findUnique({
        where: { id: examId },
        include: { subject: { select: { name: true } } },
      });

      if (!onlineExam || onlineExam.branchId !== req.branchId) {
        return res.status(404).json({ success: false, message: 'CBT examination not found.' });
      }
      if (req.classId && onlineExam.classId !== req.classId) {
        return res.status(403).json({ success: false, message: 'This examination is not assigned to your class.' });
      }

      const windowStatus = examWindowStatus(onlineExam.examDate, null);
      if (windowStatus === 'upcoming') {
        return res.status(403).json({
          success: false,
          message: examWindowMessage(windowStatus, onlineExam.examDate, null),
          windowStatus,
        });
      }

      examTitle = onlineExam.title;
      duration = onlineExam.duration || 30;
      passingMark = onlineExam.passingMark || 50;
      rawQuestions = Array.isArray(onlineExam.questions) ? (onlineExam.questions as any[]) : [];
      targetOnlineExamId = onlineExam.id;
    }

    let submission = await prisma.onlineExamSubmission.findFirst({
      where: { onlineExamId: targetOnlineExamId, studentId: req.studentId },
    });

    if (submission && (submission.submittedAt || submission.totalMark !== null)) {
      return res.status(400).json({
        success: false,
        message: 'You have already completed and submitted this examination.',
      });
    }

    if (!submission) {
      submission = await prisma.onlineExamSubmission.create({
        data: {
          onlineExamId: targetOnlineExamId,
          studentId: req.studentId,
          startedAt: new Date(),
          totalMark: null,
        },
      });
    }

    let orderedQuestions = [...rawQuestions];
    if (shuffleQuestions) {
      for (let i = orderedQuestions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [orderedQuestions[i], orderedQuestions[j]] = [orderedQuestions[j], orderedQuestions[i]];
      }
    }

    const sanitizedQuestions = orderedQuestions.map((q, idx) => ({
      id: q.id !== undefined ? q.id : idx,
      questionText: q.questionText || q.question || `Question ${idx + 1}`,
      questionType: q.questionType || q.type || 'mcq',
      options: Array.isArray(q.options) ? q.options : ['A', 'B', 'C', 'D'],
      marks: Number(q.marks || q.points || 1.0),
    }));

    return res.json({
      success: true,
      exam: {
        id: examId,
        onlineExamId: targetOnlineExamId,
        title: examTitle,
        duration,
        passingMark,
        instructions,
        showResults,
        startedAt: submission.startedAt,
        questions: sanitizedQuestions,
      },
    });
  } catch (error) {
    console.error('[STUDENT] Take CBT exam error:', error);
    return res.status(500).json({ success: false, message: 'Failed to launch CBT examination.' });
  }
}

/**
 * POST /api/student/cbt/exams/:id/submit
 */
export async function submitCbtExam(req: Request, res: Response): Promise<Response | void> {
  const { id } = req.params;
  const examId = Number(id);
  const { answers = [] } = req.body;

  try {
    let rawQuestions: any[] = [];
    let passingMark = 50;
    let showResults = true;
    let targetOnlineExamId = examId;

    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: examId },
      include: { group: true },
    });

    if (dist) {
      passingMark = dist.passingMark || 50;
      showResults = dist.showResults;
      if (dist.group && Array.isArray(dist.group.questionIds) && dist.group.questionIds.length > 0) {
        rawQuestions = await prisma.questionBank.findMany({
          where: { id: { in: (dist.group.questionIds as any[]).map(Number) }, status: 'APPROVED' },
        });
      } else {
        rawQuestions = await prisma.questionBank.findMany({
          where: { branchId: req.branchId, subjectId: dist.subjectId, status: 'APPROVED' },
          take: 20,
        });
      }

      let onlineEx = dist.onlineExamId
        ? await prisma.onlineExam.findUnique({ where: { id: dist.onlineExamId } })
        : null;
      if (!onlineEx) {
        onlineEx = await findCompanionOnlineExam({
          title: dist.title,
          classId: dist.classId,
          subjectId: dist.subjectId,
          branchId: dist.branchId || req.branchId || 0,
          onlineExamId: dist.onlineExamId,
        });
      }
      if (onlineEx) {
        targetOnlineExamId = onlineEx.id;
        if (!dist.onlineExamId) {
          await prisma.cbtDistribution.update({
            where: { id: dist.id },
            data: { onlineExamId: onlineEx.id },
          }).catch(() => {});
        }
      }
    } else {
      const onlineExam = await prisma.onlineExam.findUnique({
        where: { id: examId },
      });
      if (!onlineExam) {
        return res.status(404).json({ success: false, message: 'CBT examination not found.' });
      }
      passingMark = onlineExam.passingMark || 50;
      rawQuestions = Array.isArray(onlineExam.questions) ? (onlineExam.questions as any[]) : [];
      targetOnlineExamId = onlineExam.id;
    }

    const existing = await prisma.onlineExamSubmission.findFirst({
      where: {
        studentId: req.studentId,
        OR: [{ onlineExamId: targetOnlineExamId }, { onlineExamId: examId }],
      },
      orderBy: { id: 'desc' },
    });

    if (!existing) {
      return res.status(400).json({ success: false, message: 'No active attempt found for this examination.' });
    }

    if (existing.submittedAt !== null && existing.totalMark !== null) {
      return res.status(400).json({ success: false, message: 'You have already submitted this exam.' });
    }

    const grading = autoGradeCbtSubmission({
      questions: rawQuestions,
      studentAnswers: answers,
      passingPercentage: passingMark,
    });

    const updated = await prisma.onlineExamSubmission.update({
      where: { id: existing.id },
      data: {
        answers,
        totalMark: grading.percentage,
        submittedAt: new Date(),
      },
    });

    const onlineExamMeta =
      dist ||
      (await prisma.onlineExam.findUnique({
        where: { id: targetOnlineExamId },
        select: { classId: true, subjectId: true, branchId: true },
      }));

    const effectiveBranchId = dist?.branchId || req.branchId || (onlineExamMeta as any)?.branchId;

    if (onlineExamMeta && req.studentId && effectiveBranchId) {
      try {
        await recordCbtPercentageOnMarksheet({
          studentId: req.studentId,
          classId: dist?.classId || onlineExamMeta.classId,
          subjectId: dist?.subjectId || onlineExamMeta.subjectId,
          branchId: effectiveBranchId,
          sectionId: dist?.sectionId || req.sectionId || null,
          percentage: grading.percentage,
          source: 'CBT_AUTO',
          submissionId: updated.id,
          scale: DEFAULT_CBT_SCALE,
        });
      } catch (markError: any) {
        console.error('[STUDENT] CBT marksheet record error:', markError?.message || markError);
      }
    }

    gamificationService
      .checkOnlineExamPerformance(prisma, req.studentId, updated.id, req.branchId)
      .catch((err: any) => console.error('[Gamification] Error in CBT performance reward:', err.message));

    return res.json({
      success: true,
      message: 'CBT examination submitted and auto-graded successfully!',
      result: {
        totalScore: grading.totalScore,
        totalPossible: grading.totalPossible,
        percentage: grading.percentage,
        grade: grading.grade,
        isPassed: grading.isPassed,
        correctCount: grading.correctCount,
        wrongCount: grading.wrongCount,
        unansweredCount: grading.unansweredCount,
        showResults,
        breakdown: showResults ? grading.breakdown : [],
      },
    });
  } catch (error: any) {
    console.error('[STUDENT] CBT Exam submission error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to submit CBT exam.' });
  }
}
