export interface GradeRange {
  grade: string;
  minScore: number;
  maxScore: number;
  gradePoint: number;
  remark: string;
  color: string; // e.g. "emerald", "blue", "cyan", "amber", "orange", "rose"
}

export interface GradingScaleData {
  id: number;
  name: string;
  code: string;
  description?: string | null;
  isDefault: boolean;
  branchId: number;
  ranges: GradeRange[];
}

export const FALLBACK_PRIMARY_RANGES: GradeRange[] = [
  { grade: 'A', minScore: 70, maxScore: 100, gradePoint: 5.0, remark: 'Distinction / Excellent', color: 'emerald' },
  { grade: 'B', minScore: 60, maxScore: 69, gradePoint: 4.0, remark: 'Very Good', color: 'blue' },
  { grade: 'C', minScore: 50, maxScore: 59, gradePoint: 3.0, remark: 'Credit / Good', color: 'amber' },
  { grade: 'D', minScore: 40, maxScore: 49, gradePoint: 2.0, remark: 'Fair / Pass', color: 'orange' },
  { grade: 'F', minScore: 0, maxScore: 39, gradePoint: 0.0, remark: 'Needs Improvement / Fail', color: 'rose' },
];

/**
 * Validates grade ranges for continuity and non-overlapping coverage
 */
export function validateGradeRanges(ranges: GradeRange[]): { valid: boolean; error?: string } {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return { valid: false, error: 'At least one grade range is required.' };
  }

  // Validate individual entries
  for (const r of ranges) {
    if (!r.grade || typeof r.grade !== 'string' || !r.grade.trim()) {
      return { valid: false, error: 'Every grade range must have a valid grade letter/code (e.g. A, A1, B).' };
    }
    if (typeof r.minScore !== 'number' || isNaN(r.minScore) || r.minScore < 0) {
      return { valid: false, error: `Invalid min score for grade ${r.grade}. Must be 0 or higher.` };
    }
    if (typeof r.maxScore !== 'number' || isNaN(r.maxScore) || r.maxScore > 100) {
      return { valid: false, error: `Invalid max score for grade ${r.grade}. Must be 100 or lower.` };
    }
    if (r.minScore > r.maxScore) {
      return { valid: false, error: `Min score cannot be greater than max score for grade ${r.grade}.` };
    }
  }

  // Sort by minScore ascending
  const sorted = [...ranges].sort((a, b) => a.minScore - b.minScore);

  // Check for overlaps
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (current.maxScore >= next.minScore) {
      return {
        valid: false,
        error: `Score overlap detected between grade ${current.grade} (${current.minScore}–${current.maxScore}) and grade ${next.grade} (${next.minScore}–${next.maxScore}).`,
      };
    }
  }

  return { valid: true };
}

/**
 * Calculates grade and remark from score using specified ranges
 */
export function calculateGradeFromRanges(
  score: number | null | undefined,
  ranges: GradeRange[] = FALLBACK_PRIMARY_RANGES
): { grade: string; remark: string; gradePoint: number; color: string } {
  if (score === null || score === undefined || isNaN(Number(score))) {
    return { grade: '-', remark: 'Ungraded', gradePoint: 0, color: 'slate' };
  }

  const rounded = Math.round(Number(score));
  const activeRanges = Array.isArray(ranges) && ranges.length > 0 ? ranges : FALLBACK_PRIMARY_RANGES;

  const match = activeRanges.find((r) => rounded >= r.minScore && rounded <= r.maxScore);
  if (match) {
    return {
      grade: match.grade,
      remark: match.remark || 'Graded',
      gradePoint: Number(match.gradePoint) || 0,
      color: match.color || 'slate',
    };
  }

  // If score is over 100 or negative, clamp to highest or lowest
  if (rounded > 100 && activeRanges.length > 0) {
    const highest = [...activeRanges].sort((a, b) => b.maxScore - a.maxScore)[0];
    return {
      grade: highest.grade,
      remark: highest.remark,
      gradePoint: Number(highest.gradePoint) || 0,
      color: highest.color || 'emerald',
    };
  }

  return { grade: 'F', remark: 'Fail', gradePoint: 0, color: 'rose' };
}

/**
 * Resolves the appropriate grading scale for a class, falling back to branch default
 */
export async function resolveGradingScale(
  prisma: any,
  branchId: number,
  classId?: number | null
): Promise<GradingScaleData> {
  try {
    if (classId) {
      const cls = await prisma.class.findFirst({
        where: { id: Number(classId), branchId },
        include: { gradingScale: true },
      });

      if (cls?.gradingScale) {
        let parsedRanges: GradeRange[] = [];
        try {
          parsedRanges = typeof cls.gradingScale.ranges === 'string'
            ? JSON.parse(cls.gradingScale.ranges)
            : cls.gradingScale.ranges;
        } catch {
          parsedRanges = FALLBACK_PRIMARY_RANGES;
        }

        return {
          id: cls.gradingScale.id,
          name: cls.gradingScale.name,
          code: cls.gradingScale.code,
          description: cls.gradingScale.description,
          isDefault: cls.gradingScale.isDefault,
          branchId: cls.gradingScale.branchId,
          ranges: Array.isArray(parsedRanges) && parsedRanges.length > 0 ? parsedRanges : FALLBACK_PRIMARY_RANGES,
        };
      }
    }

    // Default branch scale
    const defaultScale = await prisma.gradingScale.findFirst({
      where: { branchId, isDefault: true },
      orderBy: { id: 'asc' },
    });

    if (defaultScale) {
      let parsedRanges: GradeRange[] = [];
      try {
        parsedRanges = typeof defaultScale.ranges === 'string'
          ? JSON.parse(defaultScale.ranges)
          : defaultScale.ranges;
      } catch {
        parsedRanges = FALLBACK_PRIMARY_RANGES;
      }

      return {
        id: defaultScale.id,
        name: defaultScale.name,
        code: defaultScale.code,
        description: defaultScale.description,
        isDefault: defaultScale.isDefault,
        branchId: defaultScale.branchId,
        ranges: Array.isArray(parsedRanges) && parsedRanges.length > 0 ? parsedRanges : FALLBACK_PRIMARY_RANGES,
      };
    }

    // Any branch scale
    const anyScale = await prisma.gradingScale.findFirst({
      where: { branchId },
      orderBy: { id: 'asc' },
    });

    if (anyScale) {
      let parsedRanges: GradeRange[] = [];
      try {
        parsedRanges = typeof anyScale.ranges === 'string'
          ? JSON.parse(anyScale.ranges)
          : anyScale.ranges;
      } catch {
        parsedRanges = FALLBACK_PRIMARY_RANGES;
      }

      return {
        id: anyScale.id,
        name: anyScale.name,
        code: anyScale.code,
        description: anyScale.description,
        isDefault: anyScale.isDefault,
        branchId: anyScale.branchId,
        ranges: Array.isArray(parsedRanges) && parsedRanges.length > 0 ? parsedRanges : FALLBACK_PRIMARY_RANGES,
      };
    }
  } catch (err) {
    console.error('[GRADING SERVICE] Resolve error:', err);
  }

  // System fallback
  return {
    id: 0,
    name: 'Standard 5-Point Scale (System Fallback)',
    code: 'SYS-DEFAULT',
    description: 'System default grade scale',
    isDefault: true,
    branchId,
    ranges: FALLBACK_PRIMARY_RANGES,
  };
}
