import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';

/**
 * GET /api/student/trivia/active
 */
export async function getActiveTrivia(req: Request, res: Response): Promise<Response | void> {
  try {
    const questions = await prisma.triviaQuestion.findMany({
      where: { active: true },
      orderBy: { id: 'desc' },
    });

    const submissions = await prisma.triviaSubmission.findMany({
      where: { studentId: req.studentId },
    });

    const answeredMap: Record<number, any> = {};
    submissions.forEach((s) => {
      answeredMap[s.triviaQuestionId] = {
        isCorrect: s.isCorrect,
        selectedOption: s.selectedOption,
      };
    });

    const mappedQuestions = questions.map((q) => {
      const submission = answeredMap[q.id];
      return {
        id: q.id,
        questionText: q.questionText,
        options: q.options,
        timeLimitSeconds: q.timeLimitSeconds,
        points: q.points,
        difficulty: q.difficulty,
        answered: !!submission,
        isCorrect: submission ? submission.isCorrect : null,
        selectedOption: submission ? submission.selectedOption : null,
      };
    });

    const streakRecord = await prisma.studentTriviaStreak.findFirst({
      where: { studentId: req.studentId },
    });

    return res.json({
      success: true,
      questions: mappedQuestions,
      streak: streakRecord
        ? {
            currentStreak: streakRecord.currentStreak,
            highestStreak: streakRecord.highestStreak,
          }
        : { currentStreak: 0, highestStreak: 0 },
    });
  } catch (error) {
    console.error('[STUDENT] Active trivia error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve active trivia.' });
  }
}

/**
 * POST /api/student/trivia/submit
 */
export async function submitTrivia(req: Request, res: Response): Promise<Response | void> {
  const { triviaQuestionId, selectedOption, timeTakenMs } = req.body;
  if (triviaQuestionId === undefined || selectedOption === undefined || timeTakenMs === undefined) {
    return res
      .status(400)
      .json({ success: false, message: 'triviaQuestionId, selectedOption, and timeTakenMs are required.' });
  }

  try {
    const question = await prisma.triviaQuestion.findUnique({
      where: { id: Number(triviaQuestionId) },
    });

    if (!question) {
      return res.status(404).json({ success: false, message: 'Trivia question not found.' });
    }

    const existing = await prisma.triviaSubmission.findFirst({
      where: {
        triviaQuestionId: question.id,
        studentId: req.studentId,
      },
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'You have already answered this question.' });
    }

    if (timeTakenMs < 500) {
      return res.status(400).json({ success: false, message: 'Submission rejected: Answered suspiciously fast.' });
    }

    const timeLimitMs = (question.timeLimitSeconds + 3) * 1000;
    if (timeTakenMs > timeLimitMs) {
      return res.status(400).json({ success: false, message: 'Submission rejected: Time limit exceeded.' });
    }

    const isCorrect = Number(selectedOption) === question.correctOption;

    await prisma.triviaSubmission.create({
      data: {
        studentId: req.studentId,
        triviaQuestionId: question.id,
        selectedOption: Number(selectedOption),
        isCorrect,
        timeTakenMs,
      },
    });

    let currentStreak = 0;
    let streakBonus = 0;
    let pointsAwarded = 0;

    if (isCorrect) {
      const streakRecord = await prisma.studentTriviaStreak.findFirst({
        where: { studentId: req.studentId },
      });

      const now = new Date();
      if (!streakRecord) {
        currentStreak = 1;
        await prisma.studentTriviaStreak.create({
          data: {
            studentId: req.studentId,
            currentStreak: 1,
            highestStreak: 1,
            lastActiveDate: now,
          },
        });
      } else {
        const lastDate = new Date(streakRecord.lastActiveDate);
        const todayZero = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const lastZero = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate());
        const diffTime = Math.abs(todayZero.getTime() - lastZero.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays === 1) {
          currentStreak = streakRecord.currentStreak + 1;
          await prisma.studentTriviaStreak.update({
            where: { id: streakRecord.id },
            data: {
              currentStreak,
              highestStreak: Math.max(streakRecord.highestStreak, currentStreak),
              lastActiveDate: now,
            },
          });
        } else if (diffDays === 0) {
          currentStreak = streakRecord.currentStreak;
          await prisma.studentTriviaStreak.update({
            where: { id: streakRecord.id },
            data: { lastActiveDate: now },
          });
        } else {
          currentStreak = 1;
          await prisma.studentTriviaStreak.update({
            where: { id: streakRecord.id },
            data: {
              currentStreak: 1,
              lastActiveDate: now,
            },
          });
        }
      }

      streakBonus = Math.min(currentStreak * 5, 50);
      pointsAwarded = question.points + streakBonus;

      await gamificationService.awardPoints(prisma, {
        actorType: 'STUDENT',
        actorId: req.studentId,
        points: pointsAwarded,
        actionType: 'TRIVIA_CORRECT',
        referenceEntity: 'TriviaQuestion',
        referenceId: question.id,
        branchId: req.branchId,
        metadata: { selectedOption, streakBonus, currentStreak },
      });
    } else {
      const streakRecord = await prisma.studentTriviaStreak.findFirst({
        where: { studentId: req.studentId },
      });
      if (streakRecord) {
        await prisma.studentTriviaStreak.update({
          where: { id: streakRecord.id },
          data: {
            currentStreak: 0,
            lastActiveDate: new Date(),
          },
        });
      }
    }

    return res.json({
      success: true,
      isCorrect,
      correctOption: question.correctOption,
      pointsAwarded,
      currentStreak,
    });
  } catch (error) {
    console.error('[STUDENT] Trivia submission error:', error);
    return res.status(500).json({ success: false, message: 'Failed to process trivia submission.' });
  }
}

/**
 * GET /api/student/gamification/profile
 */
export async function getGamificationProfile(req: Request, res: Response): Promise<Response | void> {
  try {
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      select: { xp: true, firstName: true, lastName: true },
    });

    const streak = await prisma.studentTriviaStreak.findFirst({
      where: { studentId: req.studentId },
    });

    const badges = await prisma.studentBadge.findMany({
      where: { studentId: req.studentId },
      include: { badge: true },
    });

    const recentLedger = await prisma.gamificationLedger.findMany({
      where: { actorType: 'STUDENT', actorId: req.studentId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const periods = await gamificationService.getPeriodKeys(prisma);
    const weeklyPeriodKey = `WEEKLY_${periods.WEEKLY}`;
    const alltimePeriodKey = `ALL_TIME_${periods.ALL_TIME}`;

    const weeklyCache = await prisma.leaderboardCache.findUnique({
      where: {
        entityType_entityId_period_branchId: {
          entityType: 'STUDENT',
          entityId: req.studentId,
          period: weeklyPeriodKey,
          branchId: req.branchId,
        },
      },
    });

    const alltimeCache = await prisma.leaderboardCache.findUnique({
      where: {
        entityType_entityId_period_branchId: {
          entityType: 'STUDENT',
          entityId: req.studentId,
          period: alltimePeriodKey,
          branchId: req.branchId,
        },
      },
    });

    return res.json({
      success: true,
      xp: student?.xp || 0,
      streak: streak
        ? { currentStreak: streak.currentStreak, highestStreak: streak.highestStreak }
        : { currentStreak: 0, highestStreak: 0 },
      badges: badges.map((sb) => sb.badge),
      recentLedger,
      weeklyRank: weeklyCache?.rank || '-',
      alltimeRank: alltimeCache?.rank || '-',
    });
  } catch (error) {
    console.error('[STUDENT] Get gamification profile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve gamification profile.' });
  }
}

/**
 * GET /api/student/gamification/leaderboard
 */
export async function getGamificationLeaderboard(req: Request, res: Response): Promise<Response | void> {
  const { periodType = 'WEEKLY' } = req.query;
  try {
    const periods = await gamificationService.getPeriodKeys(prisma);
    let periodKey = '';
    if (periodType === 'WEEKLY') {
      periodKey = `WEEKLY_${periods.WEEKLY}`;
    } else {
      periodKey = `ALL_TIME_${periods.ALL_TIME}`;
    }

    const cacheEntries = await prisma.leaderboardCache.findMany({
      where: {
        entityType: 'STUDENT',
        period: periodKey,
        branchId: req.branchId,
      },
      orderBy: { points: 'desc' },
      take: 10,
    });

    const studentIds = cacheEntries.map((e) => e.entityId);
    const students = await prisma.student.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, firstName: true, lastName: true },
    });

    const studentMap: Record<number, string> = {};
    students.forEach((s) => {
      studentMap[s.id] = `${s.firstName} ${s.lastName}`;
    });

    const leaderboard = cacheEntries.map((entry, index) => ({
      rank: index + 1,
      studentId: entry.entityId,
      studentName: studentMap[entry.entityId] || `Student #${entry.entityId}`,
      points: entry.points,
    }));

    return res.json({
      success: true,
      leaderboard,
    });
  } catch (error) {
    console.error('[STUDENT] Get leaderboard error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve leaderboard.' });
  }
}
