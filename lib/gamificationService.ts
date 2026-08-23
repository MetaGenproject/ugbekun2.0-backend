import crypto from 'crypto';

/**
 * Generates an idempotency key to prevent double-awarding points for the same action.
 * Hash: SHA256(actorType_actorId_actionType_referenceId)
 */
export function generateIdempotencyKey(
  actorType: string,
  actorId: number | string,
  actionType: string,
  referenceId?: number | string | null
): string {
  const input = `${actorType}_${actorId}_${actionType}_${referenceId || 'N/A'}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Calculates period strings for leaderboard cache grouping:
 * - DAILY: YYYY-MM-DD
 * - WEEKLY: YYYY-[W]WW (based on Monday)
 * - MONTHLY: YYYY-MM
 * - TERMLY: SESSION_[sessionId]
 * - ALL_TIME: ALL_TIME
 */
export async function getPeriodKeys(tx: any, date: Date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');

  // Daily
  const daily = `${yyyy}-${mm}-${dd}`;

  // Monthly
  const monthly = `${yyyy}-${mm}`;

  // Weekly (Monday of current week)
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  const monday = new Date(date);
  monday.setDate(diff);
  const wYyyy = monday.getFullYear();
  const wMm = String(monday.getMonth() + 1).padStart(2, '0');
  const wDd = String(monday.getDate()).padStart(2, '0');
  const weekly = `${wYyyy}-W-${wMm}-${wDd}`;

  // Termly (Current active session from GlobalSettings)
  let termly = 'SESSION_UNKNOWN';
  try {
    const settings = await tx.globalSettings.findFirst({
      orderBy: { id: 'desc' },
      select: { sessionId: true },
    });
    if (settings?.sessionId) {
      termly = `SESSION_${settings.sessionId}`;
    }
  } catch (err: any) {
    console.error('Error fetching global session settings for gamification termly key:', err.message);
  }

  return {
    DAILY: daily,
    WEEKLY: weekly,
    MONTHLY: monthly,
    TERMLY: termly,
    ALL_TIME: 'ALL_TIME',
  };
}

/**
 * Verifies if the point award would violate the branch's weekly limit.
 * If config is missing for a branch, defaults to 5000 points.
 */
export async function checkBranchMintLimit(tx: any, branchId: number, requestedPoints: number): Promise<boolean> {
  if (!branchId) return true; // Bypass if no branch scoping (e.g. global master admin)

  const config = await tx.gamificationConfig.findUnique({
    where: { branchId },
  });
  const limit = config?.weeklyMintLimit ?? 5000;

  // Calculate start of current week (Monday 12:00 AM)
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);

  // Sum all positive points awarded in ledger under this branch since Monday
  const ledgerSum = await tx.gamificationLedger.aggregate({
    where: {
      createdAt: { gte: monday },
      points: { gt: 0 },
      metadata: {
        path: ['branchId'],
        equals: branchId,
      },
    },
    _sum: { points: true },
  });

  const currentlyMinted = ledgerSum._sum.points || 0;
  return currentlyMinted + requestedPoints <= limit;
}

/**
 * Increments or creates the cached leaderboard entries for all periods.
 */
export async function updateLeaderboardCache(
  tx: any,
  {
    actorType,
    actorId,
    points,
    branchId,
  }: { actorType: string; actorId: number; points: number; branchId: number }
) {
  if (!branchId) return;

  const periods = await getPeriodKeys(tx);
  const periodKeys = Object.entries(periods);

  for (const [periodType, periodValue] of periodKeys) {
    const period = `${periodType}_${periodValue}`;
    await tx.leaderboardCache.upsert({
      where: {
        entityType_entityId_period_branchId: {
          entityType: actorType,
          entityId: actorId,
          period,
          branchId,
        },
      },
      create: {
        entityType: actorType,
        entityId: actorId,
        period,
        branchId,
        points: points,
      },
      update: {
        points: { increment: points },
      },
    });

    await recalculateLeaderboardRanks(tx, { entityType: actorType, period, branchId });
  }
}

export interface AwardPointsOptions {
  actorType: 'TEACHER' | 'STUDENT' | string;
  actorId: number;
  points: number;
  actionType: string;
  referenceEntity?: string;
  referenceId?: number | string | null;
  branchId?: number | null;
  metadata?: Record<string, any>;
}

/**
 * Core engine method to award points within an atomic Prisma transaction.
 * Incorporates idempotency guards and branch-level weekly limits.
 */
export async function awardPoints(
  prisma: any,
  {
    actorType,
    actorId,
    points,
    actionType,
    referenceEntity,
    referenceId,
    branchId,
    metadata = {},
  }: AwardPointsOptions
) {
  if (points === 0) return null;

  const idempotencyKey = generateIdempotencyKey(actorType, actorId, actionType, referenceId);

  // Inject branchId into metadata for tracking/limit checks
  metadata.branchId = branchId;

  return prisma.$transaction(async (tx: any) => {
    // 1. Guard against duplicate event processing
    const existing = await tx.gamificationLedger.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      console.log(`[Gamification] Action ignored. Duplicate event found for key: ${idempotencyKey}`);
      return existing;
    }

    // 2. Validate branch weekly mint limits (skip for point deductions/debits)
    if (points > 0 && branchId) {
      const isWithinLimit = await checkBranchMintLimit(tx, branchId, points);
      if (!isWithinLimit) {
        throw new Error(`Point award rejected: weekly mint cap for branch ${branchId} exceeded.`);
      }
    }

    // 3. Create the ledger entry
    const ledgerEntry = await tx.gamificationLedger.create({
      data: {
        actorType,
        actorId,
        points,
        actionType,
        referenceEntity,
        referenceId: referenceId ? Number(referenceId) || undefined : undefined,
        idempotencyKey,
        metadata,
      },
    });

    // 4. Update the primary entity cached balance
    if (actorType === 'TEACHER') {
      await tx.teacher.update({
        where: { id: actorId },
        data: { points: { increment: points } },
      });
    } else if (actorType === 'STUDENT') {
      await tx.student.update({
        where: { id: actorId },
        data: { xp: { increment: points } },
      });
    }

    // 5. Update cached leaderboard records
    if (branchId) {
      await updateLeaderboardCache(tx, { actorType, actorId, points, branchId });
    }

    console.log(`[Gamification] Awarded ${points} points to ${actorType} ID ${actorId} [Action: ${actionType}]`);
    return ledgerEntry;
  });
}

/**
 * Runs a consistency check between cached points and the actual transactional ledger sum.
 */
export async function verifyLedgerIntegrity(prisma: any, actorType: string, actorId: number) {
  const sumAggregate = await prisma.gamificationLedger.aggregate({
    where: { actorType, actorId },
    _sum: { points: true },
  });
  const ledgerTotal = sumAggregate._sum.points || 0;

  let cachedTotal = 0;
  if (actorType === 'TEACHER') {
    const teacher = await prisma.teacher.findUnique({
      where: { id: actorId },
      select: { points: true },
    });
    cachedTotal = teacher?.points || 0;
  } else if (actorType === 'STUDENT') {
    const student = await prisma.student.findUnique({
      where: { id: actorId },
      select: { xp: true },
    });
    cachedTotal = student?.xp || 0;
  }

  const discrepancy = cachedTotal - ledgerTotal;

  return {
    verified: discrepancy === 0,
    discrepancy,
    ledgerTotal,
    cachedTotal,
  };
}

/**
 * Admin function to recalculate the LeaderboardCache ranks for a branch and period.
 */
export async function recalculateLeaderboardRanks(
  prisma: any,
  { entityType, period, branchId }: { entityType: string; period: string; branchId: number }
) {
  return prisma.$executeRaw`
    UPDATE leaderboard_caches
    SET rank = ranked.seq
    FROM (
      SELECT id, row_number() OVER (ORDER BY points DESC) AS seq
      FROM leaderboard_caches
      WHERE entity_type = ${entityType} AND period = ${period} AND branch_id = ${branchId}
    ) AS ranked
    WHERE leaderboard_caches.id = ranked.id
  `;
}

export async function checkAttendanceTimeliness(
  prisma: any,
  teacherId: number,
  classId: number | string,
  sectionId: number | string,
  attendanceDate: string | Date,
  branchId: number
) {
  try {
    const enrollmentCount = await prisma.enroll.count({
      where: { classId: Number(classId), sectionId: Number(sectionId), active: true },
    });

    const attendances = await prisma.attendance.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        attendanceDate: new Date(attendanceDate),
      },
    });

    if (enrollmentCount === 0 || attendances.length < enrollmentCount) return;

    const targetDeadline = new Date(attendanceDate);
    targetDeadline.setUTCHours(9, 0, 0, 0); // 9:00 AM UTC

    const latestSubmission = attendances.reduce((latest: Date, current: any) => {
      const created = current.createdAt || new Date();
      return created > latest ? created : latest;
    }, new Date(0));

    if (latestSubmission <= targetDeadline) {
      await awardPoints(prisma, {
        actorType: 'TEACHER',
        actorId: teacherId,
        points: 50,
        actionType: 'ATTENDANCE_9AM',
        referenceEntity: 'Attendance',
        referenceId: Number(classId),
        branchId,
        metadata: { classId, sectionId, attendanceDate },
      });
    }
  } catch (err: any) {
    console.error('[Gamification] checkAttendanceTimeliness error:', err.message);
  }
}

export async function checkLessonPlanEarly(
  prisma: any,
  teacherId: number,
  lessonPlanId: number | string,
  branchId?: number
) {
  try {
    if (!branchId) return;

    const config = await prisma.gamificationConfig.findUnique({
      where: { branchId },
    });
    if (!config?.termStartDate) return;

    const lessonPlan = await prisma.lessonPlan.findUnique({
      where: { id: Number(lessonPlanId) },
    });
    if (!lessonPlan || lessonPlan.status !== 'PUBLISHED') return;

    const publishTime = lessonPlan.updatedAt || lessonPlan.createdAt || new Date();
    if (publishTime < config.termStartDate) {
      await awardPoints(prisma, {
        actorType: 'TEACHER',
        actorId: teacherId,
        points: 200,
        actionType: 'LESSON_PLAN_EARLY',
        referenceEntity: 'LessonPlan',
        referenceId: Number(lessonPlanId),
        branchId,
        metadata: { termStartDate: config.termStartDate, publishTime },
      });
    }
  } catch (err: any) {
    console.error('[Gamification] checkLessonPlanEarly error:', err.message);
  }
}

export async function checkHomeworkGradingTimeliness(
  prisma: any,
  teacherId: number,
  homeworkId: number | string,
  branchId?: number
) {
  try {
    const homework = await prisma.homework.findUnique({
      where: { id: Number(homeworkId) },
    });
    if (!homework) return;

    const submissions = await prisma.homeworkSubmission.findMany({
      where: { homeworkId: Number(homeworkId) },
    });

    if (submissions.length === 0) return;

    const allGraded = submissions.every((sub: any) => sub.score !== null);
    if (!allGraded) return;

    const latestGradingTime = submissions.reduce((latest: Date, current: any) => {
      const updated = current.updatedAt || current.createdAt || new Date();
      return updated > latest ? updated : latest;
    }, new Date(0));

    const deadline48h = new Date(homework.dueDate);
    deadline48h.setHours(deadline48h.getHours() + 48);

    if (latestGradingTime <= deadline48h) {
      await awardPoints(prisma, {
        actorType: 'TEACHER',
        actorId: teacherId,
        points: 100,
        actionType: 'ASSIGNMENT_GRADED_48H',
        referenceEntity: 'Homework',
        referenceId: Number(homeworkId),
        branchId,
        metadata: { dueDate: homework.dueDate, gradedTime: latestGradingTime },
      });
    }
  } catch (err: any) {
    console.error('[Gamification] checkHomeworkGradingTimeliness error:', err.message);
  }
}

export async function checkStudentCommentaryApproval(
  prisma: any,
  commentaryId: number | string,
  status: string,
  branchId?: number
) {
  try {
    if (status === 'REJECTED') {
      await prisma.studentCommentary.update({
        where: { id: Number(commentaryId) },
        data: { rejectionCount: { increment: 1 } },
      });
      return;
    }

    if (status === 'PRINCIPAL_SIGNED_OFF') {
      const commentary = await prisma.studentCommentary.findUnique({
        where: { id: Number(commentaryId) },
      });
      if (!commentary) return;

      if (commentary.rejectionCount === 0) {
        const allocation = await prisma.teacherAllocation.findFirst({
          where: {
            classId: commentary.classId,
            sectionId: commentary.sectionId,
            sessionId: commentary.sessionId,
          },
        });

        if (allocation?.teacherId) {
          await awardPoints(prisma, {
            actorType: 'TEACHER',
            actorId: allocation.teacherId,
            points: 150,
            actionType: 'COMMENTARY_APPROVED_FLAWLESS',
            referenceEntity: 'StudentCommentary',
            referenceId: Number(commentaryId),
            branchId,
            metadata: { studentId: commentary.studentId, sessionId: commentary.sessionId },
          });
        }
      }
    }
  } catch (err: any) {
    console.error('[Gamification] checkStudentCommentaryApproval error:', err.message);
  }
}

export async function checkHomeworkSubmissionEarly(
  prisma: any,
  studentId: number | string,
  homeworkSubmissionId: number | string,
  branchId?: number
) {
  try {
    const submission = await prisma.homeworkSubmission.findUnique({
      where: { id: Number(homeworkSubmissionId) },
      include: { homework: true },
    });
    if (!submission) return;

    if (submission.createdAt < submission.homework.dueDate) {
      await awardPoints(prisma, {
        actorType: 'STUDENT',
        actorId: Number(studentId),
        points: 30,
        actionType: 'HOMEWORK_SUBMISSION_EARLY',
        referenceEntity: 'HomeworkSubmission',
        referenceId: Number(homeworkSubmissionId),
        branchId,
        metadata: { homeworkId: submission.homeworkId, dueDate: submission.homework.dueDate },
      });
    }
  } catch (err: any) {
    console.error('[Gamification] checkHomeworkSubmissionEarly error:', err.message);
  }
}

export async function checkOnlineExamPerformance(
  prisma: any,
  studentId: number | string,
  examSubmissionId: number | string,
  branchId?: number
) {
  try {
    const submission = await prisma.onlineExamSubmission.findUnique({
      where: { id: Number(examSubmissionId) },
      include: { onlineExam: true },
    });
    if (!submission || submission.totalMark === null) return;

    const questions = submission.onlineExam.questions || [];
    const maxScore = questions.reduce((sum: number, q: any) => sum + Number(q.points || 1), 0);

    if (maxScore > 0 && submission.totalMark / maxScore >= 0.8) {
      await awardPoints(prisma, {
        actorType: 'STUDENT',
        actorId: Number(studentId),
        points: 75,
        actionType: 'EXAM_HIGH_SCORE',
        referenceEntity: 'OnlineExamSubmission',
        referenceId: Number(examSubmissionId),
        branchId,
        metadata: { score: submission.totalMark, maxScore },
      });
    }
  } catch (err: any) {
    console.error('[Gamification] checkOnlineExamPerformance error:', err.message);
  }
}

export default {
  awardPoints,
  verifyLedgerIntegrity,
  recalculateLeaderboardRanks,
  generateIdempotencyKey,
  getPeriodKeys,
  checkAttendanceTimeliness,
  checkLessonPlanEarly,
  checkHomeworkGradingTimeliness,
  checkStudentCommentaryApproval,
  checkHomeworkSubmissionEarly,
  checkOnlineExamPerformance,
};
