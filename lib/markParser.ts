/**
 * Utility to reliably extract scores from both legacy JSON mark distributions
 * (e.g. '{"1":"15","2":"10","5":"5","6":"47"}') and modern numeric string marks (e.g. '77').
 */

export interface ParsedScore {
  total: number;
  testScore: number;
  examScore: number;
  components: Record<string, number>;
  hasValidScore: boolean;
}

export function parseMarkScore(
  rawMark: string | null | undefined,
  cbtMark?: string | null | undefined
): ParsedScore {
  let total = 0;
  let testScore = 0;
  let examScore = 0;
  const components: Record<string, number> = {};
  let hasValidScore = false;

  if (rawMark !== null && rawMark !== undefined && String(rawMark).trim() !== '') {
    const trimmed = String(rawMark).trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
          const entries = Object.entries(parsed).map(([k, v]) => ({
            id: k,
            val: parseFloat(v as string) || 0,
          }));

          if (entries.length > 0) {
            hasValidScore = true;
            entries.forEach((e) => {
              components[e.id] = e.val;
            });
            total = entries.reduce((sum, e) => sum + e.val, 0);

            // In Nigerian school systems:
            // Continuous Assessment (Tests/Projects) precedes the terminal Examination.
            // If multiple components, the last/largest component is typically the Exam,
            // and the earlier components constitute the CA/test score.
            if (entries.length > 1) {
              const last = entries[entries.length - 1];
              examScore = last.val;
              testScore = total - examScore;
            } else {
              examScore = entries[0].val;
            }
          }
        }
      } catch {
        const num = parseFloat(trimmed);
        if (!isNaN(num)) {
          total = num;
          examScore = num;
          hasValidScore = true;
        }
      }
    } else {
      const num = parseFloat(trimmed);
      if (!isNaN(num)) {
        total = num;
        examScore = num;
        hasValidScore = true;
      }
    }
  }

  // If separate CBT mark is recorded and valid, integrate it
  if (cbtMark !== null && cbtMark !== undefined && String(cbtMark).trim() !== '') {
    const cbt = parseFloat(String(cbtMark).trim());
    if (!isNaN(cbt) && cbt > 0) {
      testScore += cbt;
      total += cbt;
      hasValidScore = true;
    }
  }

  return {
    total: Math.round(total * 100) / 100,
    testScore: Math.round(testScore * 100) / 100,
    examScore: Math.round(examScore * 100) / 100,
    components,
    hasValidScore,
  };
}

export function extractTotalScore(
  rawMark: string | null | undefined,
  cbtMark?: string | null | undefined
): number {
  return parseMarkScore(rawMark, cbtMark).total;
}
