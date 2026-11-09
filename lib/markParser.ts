/**
 * Utility to reliably extract scores from both legacy JSON mark distributions
 * (e.g. '{"1":"15","2":"10","5":"5","6":"47"}'), modern keyed JSON marks
 * (e.g. '{"CA1":15,"CA2":18,"PRACTICAL":8,"EXAM":45}' or '{"CA":35,"EXAM":50}'),
 * and numeric string marks, strictly aligned with the database EvaluationMatrix.
 */

export type MatrixComponentCategory = 'CA' | 'PRACTICAL' | 'EXAM';

export interface ResolvedMatrixColumn {
  key: string;
  code: string;
  name: string;
  label: string;
  maxMarks: number;
  passMarks: number;
  displayOrder: number;
  category: MatrixComponentCategory;
}

export interface ResolvedClassMatrix {
  id: number;
  name: string;
  code: string;
  generalHeading: string;
  description?: string;
  totalMarks: number;
  isDefault: boolean;
  columns: ResolvedMatrixColumn[];
  caColumns: ResolvedMatrixColumn[];
  examColumns: ResolvedMatrixColumn[];
  practicalColumns: ResolvedMatrixColumn[];
  fullMaxMarks: number;
  caMaxMarks: number;
  examMaxMarks: number;
}

export interface ParsedScore {
  total: number;
  testScore: number;
  examScore: number;
  practicalScore: number;
  components: Record<string, number>;
  hasValidScore: boolean;
}

export interface MatrixMappedScore {
  componentScores: Record<string, number | null>;
  numericComponents: Record<string, number>;
  activeColumns: ResolvedMatrixColumn[];
  stageTotal: number;
  fullTotal: number;
  caTotal: number;
  examTotal: number;
  practicalTotal: number;
  activeMaxMarks: number;
  fullMaxMarks: number;
  caMaxMarks: number;
  normalizedPercentage: number;
  hasValidScore: boolean;
}

/**
 * Normalizes a component key/code/name for fuzzy key matching
 * (e.g. "CA 1" -> "CA1", "c.a. 2" -> "CA2", "Practical / Lab" -> "PRACTICALLAB")
 */
export function normalizeComponentToken(str: string | null | undefined): string {
  if (!str) return '';
  return String(str)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Classifies a matrix column/component into 'CA', 'PRACTICAL', or 'EXAM'
 * using DB examCategory/category metadata first, then semantic token matching.
 */
export function classifyMatrixComponent(comp: {
  code?: string | null;
  key?: string | null;
  name?: string | null;
  label?: string | null;
  category?: string | null;
  examCategory?: string | null;
}): MatrixComponentCategory {
  const explicitCat = String(comp.category || comp.examCategory || '')
    .trim()
    .toUpperCase();
  if (explicitCat === 'EXAM' || explicitCat === 'EXAMINATION' || explicitCat === 'TERMINAL') {
    return 'EXAM';
  }
  if (explicitCat === 'PRACTICAL' || explicitCat === 'LAB' || explicitCat === 'PROJECT') {
    return 'PRACTICAL';
  }
  if (explicitCat === 'CA' || explicitCat === 'TEST' || explicitCat === 'CBT') {
    return 'CA';
  }

  const combined = `${comp.code || ''} ${comp.key || ''} ${comp.label || ''} ${comp.name || ''}`
    .trim()
    .toLowerCase();

  // Check if it is explicitly a Practical component
  if (/\b(pract|practical|practicals|lab|laboratory)\b/i.test(combined)) {
    return 'PRACTICAL';
  }

  // Check if it is a Continuous Assessment / CBT / Test component (even if named "CBT Exam 1")
  const isCaPattern =
    /\b(ca|c\.a|ca1|ca2|ca3|ca4|cbt[\s_-]*1|cbt[\s_-]*2|test|continuous|mid[\s_-]*term|assignment|homework|quiz|project)\b/i.test(
      combined
    );

  // Check if it is the Terminal Examination
  const isExamPattern = /\b(exam|examination|terminal|theory)\b/i.test(combined);

  if (isExamPattern && !isCaPattern) {
    return 'EXAM';
  }

  return 'CA';
}

/**
 * Key-aware score parser that extracts component scores without misclassifying
 * single CA entries (e.g. {"CA1": 18}) as exam scores.
 */
export function parseMarkScore(
  rawMark: string | null | undefined,
  cbtMark?: string | null | undefined
): ParsedScore {
  let total = 0;
  let testScore = 0;
  let examScore = 0;
  let practicalScore = 0;
  const components: Record<string, number> = {};
  let hasValidScore = false;
  let parsedFromJsonComponents = false;

  if (rawMark !== null && rawMark !== undefined && String(rawMark).trim() !== '') {
    const trimmed = String(rawMark).trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
          const entries = Object.entries(parsed)
            .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
            .map(([k, v]) => ({
              id: k,
              val: parseFloat(String(v)) || 0,
            }));

          if (entries.length > 0) {
            hasValidScore = true;
            parsedFromJsonComponents = true;
            entries.forEach((e) => {
              components[e.id] = e.val;
            });
            total = entries.reduce((sum, e) => sum + e.val, 0);

            // Determine whether keys are named component codes (e.g. "CA1", "CA", "PRACTICAL", "EXAM")
            // vs purely numeric legacy distribution IDs (e.g. "1", "2", "6")
            const hasNamedKeys = entries.some((e) => /[a-zA-Z]/.test(e.id));

            if (hasNamedKeys) {
              entries.forEach((e) => {
                const cat = classifyMatrixComponent({ code: e.id, name: e.id });
                if (cat === 'EXAM') {
                  examScore += e.val;
                } else if (cat === 'PRACTICAL') {
                  practicalScore += e.val;
                  testScore += e.val;
                } else {
                  testScore += e.val;
                }
              });
            } else {
              // Legacy numeric distribution IDs fallback
              if (entries.length > 1) {
                const last = entries[entries.length - 1];
                examScore = last.val;
                testScore = total - examScore;
              } else {
                examScore = entries[0].val;
              }
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

  // Only add standalone cbtMark when rawMark did not already contain JSON component marks
  // (Prevents double-counting when CBT Auto-Fill writes into both componentMarks JSON and cbtMark)
  if (!parsedFromJsonComponents && cbtMark !== null && cbtMark !== undefined && String(cbtMark).trim() !== '') {
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
    practicalScore: Math.round(practicalScore * 100) / 100,
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

/**
 * Converts a raw Prisma EvaluationMatrix (with optional EvaluationMatrixColumn[] and components JSON)
 * into a normalized ResolvedClassMatrix with 100% database-driven columns and maxMarks.
 */
export function buildResolvedMatrixFromDbRecord(matrixRecord: any): ResolvedClassMatrix {
  const columns: ResolvedMatrixColumn[] = [];

  const dbCols = Array.isArray(matrixRecord?.columns) ? matrixRecord.columns : [];
  let jsonComps: any[] = [];
  if (matrixRecord?.components) {
    try {
      jsonComps =
        typeof matrixRecord.components === 'string'
          ? JSON.parse(matrixRecord.components)
          : Array.isArray(matrixRecord.components)
            ? matrixRecord.components
            : [];
    } catch {
      jsonComps = [];
    }
  }

  if (dbCols.length > 0) {
    dbCols.forEach((col: any, idx: number) => {
      const rawKey = String(col.columnKey || col.code || `COL_${idx + 1}`).trim();
      const rawLabel = String(col.columnLabel || col.name || rawKey).trim();
      const maxMarks = Number(col.maxMarks) || 0;
      const passMarks = Number(col.passMarks) || 0;

      // Check feedItems for linked Exam Master category if available
      let feedCategory: string | null = null;
      if (Array.isArray(col.feedItems) && col.feedItems.length > 0) {
        const examItem = col.feedItems.find((fi: any) => fi.examMaster?.examCategory);
        if (examItem?.examMaster?.examCategory) {
          feedCategory = examItem.examMaster.examCategory;
        }
      }

      // Also cross-check JSON component with same code/name for explicit category if any
      const matchingJson = jsonComps.find(
        (jc: any) =>
          normalizeComponentToken(jc.code || jc.key) === normalizeComponentToken(rawKey) ||
          normalizeComponentToken(jc.name) === normalizeComponentToken(rawLabel)
      );

      const category = classifyMatrixComponent({
        code: rawKey,
        name: rawLabel,
        label: rawLabel,
        category: matchingJson?.category || col.category,
        examCategory: feedCategory,
      });

      columns.push({
        key: rawKey,
        code: rawKey.toUpperCase(),
        name: rawLabel,
        label: rawLabel,
        maxMarks,
        passMarks,
        displayOrder: col.displayOrder !== undefined ? Number(col.displayOrder) : idx + 1,
        category,
      });
    });
  } else if (jsonComps.length > 0) {
    jsonComps.forEach((c: any, idx: number) => {
      const rawCode = String(c.code || c.key || c.columnKey || c.name || `COL_${idx + 1}`).trim();
      const rawName = String(c.name || c.columnLabel || c.label || rawCode).trim();
      const maxMarks = Number(c.maxMarks) || 0;
      const passMarks = Number(c.passMarks) || 0;
      const category = classifyMatrixComponent({
        code: rawCode,
        key: c.key,
        name: rawName,
        label: c.label,
        category: c.category,
        examCategory: c.examCategory,
      });

      columns.push({
        key: String(c.key || rawCode).trim(),
        code: rawCode.toUpperCase(),
        name: rawName,
        label: String(c.label || c.columnLabel || rawCode).trim(),
        maxMarks,
        passMarks,
        displayOrder: c.displayOrder !== undefined ? Number(c.displayOrder) : idx + 1,
        category,
      });
    });
  }

  // Sort columns by displayOrder
  columns.sort((a, b) => a.displayOrder - b.displayOrder);

  const caColumns = columns.filter((c) => c.category !== 'EXAM');
  const examColumns = columns.filter((c) => c.category === 'EXAM');
  const practicalColumns = columns.filter((c) => c.category === 'PRACTICAL');

  const sumColumnsMax = columns.reduce((sum, c) => sum + (Number(c.maxMarks) || 0), 0);
  const fullMaxMarks =
    sumColumnsMax > 0
      ? sumColumnsMax
      : matrixRecord?.totalMarks !== undefined && Number(matrixRecord.totalMarks) > 0
        ? Number(matrixRecord.totalMarks)
        : 0;

  const caMaxMarks = caColumns.reduce((sum, c) => sum + (Number(c.maxMarks) || 0), 0);
  const examMaxMarks = examColumns.reduce((sum, c) => sum + (Number(c.maxMarks) || 0), 0);

  return {
    id: Number(matrixRecord?.id) || 0,
    name: String(matrixRecord?.name || 'Evaluation Matrix').trim(),
    code: String(matrixRecord?.code || 'MATRIX').trim(),
    generalHeading:
      matrixRecord?.generalHeading && String(matrixRecord.generalHeading).trim()
        ? String(matrixRecord.generalHeading).trim()
        : 'Termly Report',
    description: matrixRecord?.description ? String(matrixRecord.description).trim() : '',
    totalMarks: fullMaxMarks,
    isDefault: Boolean(matrixRecord?.isDefault),
    columns,
    caColumns,
    examColumns,
    practicalColumns,
    fullMaxMarks,
    caMaxMarks,
    examMaxMarks,
  };
}

/**
 * Resolves the active EvaluationMatrix for a given class and branch directly from the database.
 * Priority:
 *  1. Explicit matrixId (if provided)
 *  2. Class's assigned evaluationMatrixId in the database
 *  3. Branch's default EvaluationMatrix (isDefault: true) in the database
 *  4. Any EvaluationMatrix configured for the branch in the database
 *  5. ExamMarkDistribution records for the branch in the database (if no EvaluationMatrix record exists yet)
 */
export async function resolveClassEvaluationMatrix(
  prisma: any,
  branchId?: number | null,
  classId?: number | null,
  explicitMatrixId?: number | null
): Promise<ResolvedClassMatrix> {
  const matrixInclude = {
    columns: {
      orderBy: { displayOrder: 'asc' as const },
      include: {
        feedItems: {
          include: {
            examMaster: {
              select: { id: true, name: true, examCategory: true, cbtTotalMarks: true },
            },
          },
        },
      },
    },
  };

  let matrixRecord: any = null;

  if (explicitMatrixId && !isNaN(Number(explicitMatrixId)) && Number(explicitMatrixId) > 0) {
    matrixRecord = await prisma.evaluationMatrix.findFirst({
      where: {
        id: Number(explicitMatrixId),
        ...(branchId ? { branchId: Number(branchId) } : {}),
      },
      include: matrixInclude,
    });
  }

  let resolvedBranchId = branchId ? Number(branchId) : undefined;

  if (!matrixRecord && classId && !isNaN(Number(classId))) {
    const cls = await prisma.class.findUnique({
      where: { id: Number(classId) },
      include: {
        evaluationMatrix: {
          include: matrixInclude,
        },
      },
    });
    if (cls) {
      if (!resolvedBranchId && cls.branchId) {
        resolvedBranchId = Number(cls.branchId);
      }
      if (cls.evaluationMatrix) {
        matrixRecord = cls.evaluationMatrix;
      }
    }
  }

  if (!matrixRecord && resolvedBranchId) {
    matrixRecord = await prisma.evaluationMatrix.findFirst({
      where: { branchId: resolvedBranchId, isDefault: true },
      include: matrixInclude,
      orderBy: { id: 'desc' },
    });
  }

  if (!matrixRecord && resolvedBranchId) {
    matrixRecord = await prisma.evaluationMatrix.findFirst({
      where: { branchId: resolvedBranchId },
      include: matrixInclude,
      orderBy: [{ isDefault: 'desc' }, { id: 'desc' }],
    });
  }

  if (!matrixRecord) {
    matrixRecord = await prisma.evaluationMatrix.findFirst({
      include: matrixInclude,
      orderBy: [{ isDefault: 'desc' }, { id: 'desc' }],
    });
  }

  if (matrixRecord) {
    const resolved = buildResolvedMatrixFromDbRecord(matrixRecord);
    if (resolved.columns.length > 0) {
      return resolved;
    }
  }

  // Fallback to ExamMarkDistribution table in DB if school only populated exam_mark_distribution
  const dists = await prisma.examMarkDistribution.findMany({
    where: resolvedBranchId ? { branchId: resolvedBranchId } : {},
    orderBy: { id: 'asc' },
  });
  if (dists.length > 0) {
    const distComponents = dists.map((d: any, idx: number) => ({
      key: String(d.id),
      code: String(d.name || `COL_${idx + 1}`).trim().toUpperCase(),
      name: String(d.name || `Assessment ${idx + 1}`).trim(),
      label: String(d.name || `Assessment ${idx + 1}`).trim(),
      maxMarks: Number((d as any).maxMarks || (d as any).marks || 0),
      displayOrder: idx + 1,
    }));
    return buildResolvedMatrixFromDbRecord({
      id: 0,
      name: 'Database Mark Distribution',
      code: 'DB-DIST',
      generalHeading: 'Termly Report',
      totalMarks: distComponents.reduce((s: number, c: any) => s + c.maxMarks, 0),
      isDefault: true,
      components: distComponents,
    });
  }

  return buildResolvedMatrixFromDbRecord(matrixRecord || { components: [] });
}

/**
 * Returns the active columns and active total maxMarks for a given stage
 * strictly derived from the resolved database EvaluationMatrix.
 */
export function resolveActiveMatrixColumnsForStage(
  dbMatrix: ResolvedClassMatrix,
  stage?: string | null
): {
  activeStage: string;
  activeColumns: ResolvedMatrixColumn[];
  activeMaxMarks: number;
  isCaOnlyStage: boolean;
} {
  const normStage = String(stage || 'FULL').trim().toUpperCase();

  if (!normStage || normStage === 'FULL' || normStage === 'ALL' || normStage === 'TERMINAL') {
    return {
      activeStage: 'FULL',
      activeColumns: dbMatrix.columns,
      activeMaxMarks: dbMatrix.fullMaxMarks,
      isCaOnlyStage: false,
    };
  }

  if (normStage === 'COMBINED_CA' || normStage === 'CA_ONLY' || normStage === 'CA' || normStage === 'MID_TERM') {
    // Check if the user selected "CA" and there is a single column literally named "CA", or multiple CA columns
    const activeColumns = dbMatrix.caColumns.length > 0 ? dbMatrix.caColumns : dbMatrix.columns;
    const activeMaxMarks = activeColumns.reduce((sum, c) => sum + (Number(c.maxMarks) || 0), 0);
    return {
      activeStage: 'COMBINED_CA',
      activeColumns,
      activeMaxMarks,
      isCaOnlyStage: true,
    };
  }

  if (normStage === 'EXAM' || normStage === 'EXAM_ONLY') {
    const activeColumns = dbMatrix.examColumns.length > 0 ? dbMatrix.examColumns : dbMatrix.columns;
    const activeMaxMarks = activeColumns.reduce((sum, c) => sum + (Number(c.maxMarks) || 0), 0);
    return {
      activeStage: 'EXAM',
      activeColumns,
      activeMaxMarks,
      isCaOnlyStage: false,
    };
  }

  // Match specific column from the database matrix (e.g. 'CA1', 'CA2', 'PRACTICAL', or custom admin code)
  const targetToken = normalizeComponentToken(normStage);
  const matchedCol = dbMatrix.columns.find(
    (c) =>
      normalizeComponentToken(c.code) === targetToken ||
      normalizeComponentToken(c.key) === targetToken ||
      normalizeComponentToken(c.name) === targetToken ||
      normalizeComponentToken(c.label) === targetToken
  );

  if (matchedCol) {
    return {
      activeStage: matchedCol.code,
      activeColumns: [matchedCol],
      activeMaxMarks: Number(matchedCol.maxMarks) || 0,
      isCaOnlyStage: matchedCol.category !== 'EXAM',
    };
  }

  // Positional fallback for CA1 / CA2 when DB columns have custom names like "1st Test", "2nd Test"
  if (targetToken === 'CA1' && dbMatrix.caColumns.length >= 1) {
    const col = dbMatrix.caColumns[0];
    return {
      activeStage: 'CA1',
      activeColumns: [col],
      activeMaxMarks: Number(col.maxMarks) || 0,
      isCaOnlyStage: true,
    };
  }
  if (targetToken === 'CA2' && dbMatrix.caColumns.length >= 2) {
    const col = dbMatrix.caColumns[1];
    return {
      activeStage: 'CA2',
      activeColumns: [col],
      activeMaxMarks: Number(col.maxMarks) || 0,
      isCaOnlyStage: true,
    };
  }
  if (targetToken === 'CA2' && dbMatrix.caColumns.length === 1) {
    // Class only conducts 1 test in its DB matrix! Return that single CA column
    const col = dbMatrix.caColumns[0];
    return {
      activeStage: col.code,
      activeColumns: [col],
      activeMaxMarks: Number(col.maxMarks) || 0,
      isCaOnlyStage: true,
    };
  }

  return {
    activeStage: normStage,
    activeColumns: dbMatrix.columns,
    activeMaxMarks: dbMatrix.fullMaxMarks,
    isCaOnlyStage: false,
  };
}

/**
 * Maps a student's raw Mark record (and optional StudentComponentScore rows)
 * strictly onto the class's database EvaluationMatrix columns and computes
 * stage-accurate totals and normalized percentage.
 */
export function mapStudentMarkToMatrix(
  markRecord: { mark?: string | null; cbtMark?: string | null; absent?: string | boolean | null } | null | undefined,
  dbMatrix: ResolvedClassMatrix,
  stage?: string | null,
  extraComponentScores?: Array<{ slotOrName: string; score: number }>
): MatrixMappedScore {
  const { activeColumns, activeMaxMarks } = resolveActiveMatrixColumnsForStage(dbMatrix, stage);

  const componentScores: Record<string, number | null> = {};
  const numericComponents: Record<string, number> = {};
  dbMatrix.columns.forEach((col) => {
    componentScores[col.code] = null;
    componentScores[col.key] = null;
  });

  let hasValidScore = false;
  let rawJsonEntries: Array<{ rawKey: string; normKey: string; val: number }> = [];
  let plainNumericValue: number | null = null;

  const rawMark = markRecord?.mark;
  if (rawMark !== null && rawMark !== undefined && String(rawMark).trim() !== '') {
    const trimmed = String(rawMark).trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsedObj = JSON.parse(trimmed);
        if (typeof parsedObj === 'object' && parsedObj !== null) {
          Object.entries(parsedObj).forEach(([k, v]) => {
            if (v !== null && v !== undefined && String(v).trim() !== '') {
              const num = parseFloat(String(v));
              if (!isNaN(num)) {
                rawJsonEntries.push({
                  rawKey: k,
                  normKey: normalizeComponentToken(k),
                  val: num,
                });
                hasValidScore = true;
              }
            }
          });
        }
      } catch {
        const num = parseFloat(trimmed);
        if (!isNaN(num)) {
          plainNumericValue = num;
          hasValidScore = true;
        }
      }
    } else {
      const num = parseFloat(trimmed);
      if (!isNaN(num)) {
        plainNumericValue = num;
        hasValidScore = true;
      }
    }
  }

  // Merge extraComponentScores (from StudentComponentScore table if present)
  if (Array.isArray(extraComponentScores) && extraComponentScores.length > 0) {
    extraComponentScores.forEach((ecs) => {
      if (ecs.score !== null && ecs.score !== undefined && !isNaN(Number(ecs.score))) {
        rawJsonEntries.push({
          rawKey: ecs.slotOrName,
          normKey: normalizeComponentToken(ecs.slotOrName),
          val: Number(ecs.score),
        });
        hasValidScore = true;
      }
    });
  }

  // Map rawJsonEntries to the exact DB matrix columns
  if (rawJsonEntries.length > 0) {
    const allNumericKeys = rawJsonEntries.every((e) => /^\d+$/.test(e.rawKey.trim()));

    const usedEntryIndices = new Set<number>();

    // Pass 1: Exact match on code, key, name, or label
    dbMatrix.columns.forEach((col) => {
      const colTokens = new Set(
        [col.code, col.key, col.name, col.label].map((t) => normalizeComponentToken(t)).filter(Boolean)
      );

      const matchIdx = rawJsonEntries.findIndex(
        (e, idx) => !usedEntryIndices.has(idx) && colTokens.has(e.normKey)
      );

      if (matchIdx !== -1) {
        usedEntryIndices.add(matchIdx);
        const val = rawJsonEntries[matchIdx].val;
        componentScores[col.code] = val;
        componentScores[col.key] = val;
        numericComponents[col.code] = val;
        numericComponents[col.key] = val;
      }
    });

    // Pass 2: Semantic alias matching for unmatched entries (e.g. teacher saved under "CA1" when class matrix has single "CA", or vice versa)
    rawJsonEntries.forEach((entry, idx) => {
      if (usedEntryIndices.has(idx)) return;

      const entryCat = classifyMatrixComponent({ code: entry.rawKey, name: entry.rawKey });

      // Check if there is an unfilled column of the same category
      const candidateCols = dbMatrix.columns.filter(
        (col) => col.category === entryCat && componentScores[col.code] === null
      );

      if (candidateCols.length === 1) {
        const targetCol = candidateCols[0];
        usedEntryIndices.add(idx);
        componentScores[targetCol.code] = entry.val;
        componentScores[targetCol.key] = entry.val;
        numericComponents[targetCol.code] = entry.val;
        numericComponents[targetCol.key] = entry.val;
      } else if (candidateCols.length > 1) {
        // Check ordinal number (e.g., '1' in 'CA1' / 'TEST1' -> 1st CA column, '2' in 'CA2' / 'TEST2' -> 2nd CA column)
        const numMatch = entry.normKey.match(/(\d+)$/);
        if (numMatch) {
          const ord = parseInt(numMatch[1], 10) - 1;
          if (ord >= 0 && ord < candidateCols.length) {
            const targetCol = candidateCols[ord];
            usedEntryIndices.add(idx);
            componentScores[targetCol.code] = entry.val;
            componentScores[targetCol.key] = entry.val;
            numericComponents[targetCol.code] = entry.val;
            numericComponents[targetCol.key] = entry.val;
          }
        }
      } else if (entryCat === 'CA' && dbMatrix.caColumns.length === 1) {
        // If class matrix has only 1 CA column (e.g. CA over 40) and legacy data had CA1 + CA2, accumulate into that single CA column
        const singleCaCol = dbMatrix.caColumns[0];
        usedEntryIndices.add(idx);
        const prev = Number(componentScores[singleCaCol.code] || 0);
        const nextVal = Math.min(singleCaCol.maxMarks || Infinity, prev + entry.val);
        componentScores[singleCaCol.code] = nextVal;
        componentScores[singleCaCol.key] = nextVal;
        numericComponents[singleCaCol.code] = nextVal;
        numericComponents[singleCaCol.key] = nextVal;
      }
    });

    // Pass 3: If all keys were purely numeric legacy IDs (e.g. "1", "2", "6") and still unmatched, map by order
    if (allNumericKeys) {
      rawJsonEntries.forEach((entry, idx) => {
        if (usedEntryIndices.has(idx)) return;
        const targetCol =
          idx === rawJsonEntries.length - 1 && rawJsonEntries.length > 1 && dbMatrix.examColumns.length > 0
            ? dbMatrix.examColumns[0]
            : dbMatrix.columns[idx];
        if (targetCol && componentScores[targetCol.code] === null) {
          usedEntryIndices.add(idx);
          componentScores[targetCol.code] = entry.val;
          componentScores[targetCol.key] = entry.val;
          numericComponents[targetCol.code] = entry.val;
          numericComponents[targetCol.key] = entry.val;
        }
      });
    }
  } else if (plainNumericValue !== null) {
    // Plain numeric string fallback
    const targetCol =
      dbMatrix.columns.length === 1
        ? dbMatrix.columns[0]
        : dbMatrix.examColumns[0] || dbMatrix.columns[dbMatrix.columns.length - 1];
    if (targetCol) {
      componentScores[targetCol.code] = plainNumericValue;
      componentScores[targetCol.key] = plainNumericValue;
      numericComponents[targetCol.code] = plainNumericValue;
      numericComponents[targetCol.key] = plainNumericValue;
    }
  }

  // Fallback for standalone cbtMark when no CA column was populated from JSON
  const cbtRaw = markRecord?.cbtMark;
  if (cbtRaw !== null && cbtRaw !== undefined && String(cbtRaw).trim() !== '') {
    const cbtVal = parseFloat(String(cbtRaw).trim());
    if (!isNaN(cbtVal) && cbtVal > 0) {
      const anyCaPopulated = dbMatrix.caColumns.some((c) => componentScores[c.code] !== null);
      if (!anyCaPopulated && dbMatrix.caColumns.length > 0) {
        const firstCa = dbMatrix.caColumns[0];
        componentScores[firstCa.code] = cbtVal;
        componentScores[firstCa.key] = cbtVal;
        numericComponents[firstCa.code] = cbtVal;
        numericComponents[firstCa.key] = cbtVal;
        hasValidScore = true;
      }
    }
  }

  let fullTotal = 0;
  let caTotal = 0;
  let examTotal = 0;
  let practicalTotal = 0;

  dbMatrix.columns.forEach((col) => {
    const val = componentScores[col.code];
    if (val !== null && val !== undefined && !isNaN(Number(val))) {
      const n = Number(val);
      fullTotal += n;
      if (col.category === 'EXAM') {
        examTotal += n;
      } else {
        caTotal += n;
        if (col.category === 'PRACTICAL') {
          practicalTotal += n;
        }
      }
    }
  });

  let stageTotal = 0;
  activeColumns.forEach((col) => {
    const val = componentScores[col.code];
    if (val !== null && val !== undefined && !isNaN(Number(val))) {
      stageTotal += Number(val);
    }
  });

  fullTotal = Math.round(fullTotal * 100) / 100;
  caTotal = Math.round(caTotal * 100) / 100;
  examTotal = Math.round(examTotal * 100) / 100;
  practicalTotal = Math.round(practicalTotal * 100) / 100;
  stageTotal = Math.round(stageTotal * 100) / 100;

  const normalizedPercentage =
    activeMaxMarks > 0 && hasValidScore ? Math.round(((stageTotal / activeMaxMarks) * 100) * 100) / 100 : 0;

  return {
    componentScores,
    numericComponents,
    activeColumns,
    stageTotal,
    fullTotal,
    caTotal,
    examTotal,
    practicalTotal,
    activeMaxMarks,
    fullMaxMarks: dbMatrix.fullMaxMarks,
    caMaxMarks: dbMatrix.caMaxMarks,
    normalizedPercentage,
    hasValidScore,
  };
}
