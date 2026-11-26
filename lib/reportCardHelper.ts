import { Prisma } from '@prisma/client';
import prismaDefault from './prisma';
import { ResolvedClassMatrix, mapStudentMarkToMatrix } from './markParser';
import { calculateGradeFromRanges } from './gradingService';

export interface ClassPositionPolicy {
  showPosition: boolean;
  rankingType: 'full' | 'topn' | 'hidden';
  rankingLimit: number;
}

export interface SchoolReportBranding {
  schoolName: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  currencySymbol: string;
  academicSession: string;
  currentTerm: string;
  resumptionDate: string;
  nextTermFees: string;
  principalName: string;
  principalSignatureUrl: string | null;
  defaultTeacherSignatureUrl: string | null;
  classTeacherName: string;
  classTeacherSignatureUrl: string | null;
  autoPublishReportCards: boolean;
  branchCode: string;
  showPosition: boolean;
  rankingType: 'full' | 'topn' | 'hidden';
  rankingLimit: number;
  positionByClass: Record<string, ClassPositionPolicy>;
}

export interface ResolveBrandingOptions {
  classId?: number;
  sectionId?: number | null;
  sessionId?: number;
  examResumptionDate?: Date | string | null;
  customNextTermFees?: string | null;
}

export interface TeacherSignatureConfig {
  general?: string | null;
  byClass?: Record<string, string | null>;
  defaultShowPosition?: boolean;
  positionByClass?: Record<string, ClassPositionPolicy>;
}

/**
 * Parses the teacher signature and class position configuration stored in SystemSetting.defaultTeacherSignatureUrl.
 * Supports:
 * 1. JSON: { general?: string | null, byClass?: Record<classId, string | 'DISABLED' | null>, defaultShowPosition?: boolean, positionByClass?: Record<classId, ClassPositionPolicy> }
 * 2. Legacy string: "https://.../teacher_sig.png" (treated as general)
 */
export function parseTeacherSignatureConfig(raw?: string | null): TeacherSignatureConfig {
  if (!raw || typeof raw !== 'string') {
    return { general: null, byClass: {}, defaultShowPosition: true, positionByClass: {} };
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return {
          general: parsed.general || null,
          byClass: parsed.byClass && typeof parsed.byClass === 'object' ? parsed.byClass : {},
          defaultShowPosition:
            typeof parsed.defaultShowPosition === 'boolean' ? parsed.defaultShowPosition : true,
          positionByClass:
            parsed.positionByClass && typeof parsed.positionByClass === 'object'
              ? parsed.positionByClass
              : {},
        };
      }
    } catch {
      // fallback
    }
  }
  return { general: trimmed || null, byClass: {}, defaultShowPosition: true, positionByClass: {} };
}

export function serializeTeacherSignatureConfig(config: TeacherSignatureConfig): string | null {
  const hasByClass = Object.keys(config.byClass || {}).length > 0;
  const hasPositionByClass = Object.keys(config.positionByClass || {}).length > 0;
  const hasCustomDefaultPos = config.defaultShowPosition === false;

  if (hasByClass || hasPositionByClass || hasCustomDefaultPos) {
    return JSON.stringify({
      general: config.general || null,
      byClass: config.byClass || {},
      defaultShowPosition: config.defaultShowPosition !== false,
      positionByClass: config.positionByClass || {},
    });
  }
  return config.general || null;
}

export function resolveClassPositionPolicy(
  config: TeacherSignatureConfig,
  classId?: number | null
): ClassPositionPolicy {
  const defaultShow = config.defaultShowPosition !== false;
  if (classId) {
    const entry = config.positionByClass?.[String(classId)];
    if (entry && typeof entry === 'object') {
      const showPosition = Boolean(entry.showPosition);
      const rankingType: 'full' | 'topn' | 'hidden' = !showPosition
        ? 'hidden'
        : entry.rankingType === 'topn'
          ? 'topn'
          : 'full';
      const rankingLimit = Number(entry.rankingLimit) > 0 ? Number(entry.rankingLimit) : 3;
      return { showPosition, rankingType, rankingLimit };
    }
  }
  return {
    showPosition: defaultShow,
    rankingType: defaultShow ? 'full' : 'hidden',
    rankingLimit: 3,
  };
}

/**
 * Formats an ISO date string (e.g. "2026-09-14") into a readable date if valid,
 * or returns the raw string when the admin typed a freeform phrase (e.g. "Monday, 14th Sept 2026").
 */
export function formatResumptionDateLabel(raw?: string | Date | null): string {
  if (!raw) return 'To Be Announced';
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return 'To Be Announced';
    return raw.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return 'To Be Announced';
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
    }
  }
  return trimmed;
}

/**
 * Helper to format fee string cleanly with currency symbol
 */
export function formatFeeString(raw: string, currencySymbol: string = '₦'): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const cleaned = trimmed.replace(/,/g, '').replace(/^[^\d]+/, '');
  const numericOnly = Number(cleaned);
  if (!Number.isNaN(numericOnly) && numericOnly > 0 && /^[\d,]+(\.\d+)?$/.test(trimmed.replace(/^[^\d\s]+/, '').trim())) {
    const hasSymbol = /^[^\d\s]/.test(trimmed);
    if (!hasSymbol) {
      return `${currencySymbol}${numericOnly.toLocaleString()}`;
    }
  }
  return trimmed;
}

/**
 * Resolves Next Term Fees for a class/branch:
 * 1. Explicit `SystemSetting.nextTermFees` if configured by the school admin under School Settings
 *    - Supports JSON format with per-class mappings and class fee groups:
 *      {
 *        default?: string,
 *        byClass?: Record<string, string>,
 *        groups?: Array<{ id: string; name?: string; amount: string; classIds: number[] }>
 *      }
 *    - Or simple string fallback for backward compatibility
 * 2. Sum of active `FeeAssignment` records for the class/branch
 * 3. Fallback `''` (blank if not set)
 */
export async function resolveNextTermPaymentLabel(
  prisma: typeof prismaDefault,
  branchId: number,
  sessionId: number,
  classId?: number,
  systemNextTermFees?: string | null,
  currencySymbol: string = '₦'
): Promise<string> {
  if (systemNextTermFees && String(systemNextTermFees).trim().length > 0) {
    const raw = String(systemNextTermFees).trim();

    // Check if JSON containing class mappings
    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          // 1. Direct match on classId in byClass or classes
          if (classId) {
            const classKey = String(classId);
            const classFee = parsed.byClass?.[classKey] || parsed.classes?.[classKey] || parsed[classKey];
            if (classFee && String(classFee).trim().length > 0) {
              return formatFeeString(String(classFee), currencySymbol);
            }

            // 2. Search groups for classId
            if (Array.isArray(parsed.groups)) {
              const matchedGroup = parsed.groups.find(
                (g: any) => Array.isArray(g.classIds) && g.classIds.map(Number).includes(Number(classId))
              );
              if (matchedGroup?.amount && String(matchedGroup.amount).trim().length > 0) {
                return formatFeeString(String(matchedGroup.amount), currencySymbol);
              }
            }
          }

          // 3. Fallback to default in JSON
          if (parsed.default && String(parsed.default).trim().length > 0) {
            return formatFeeString(String(parsed.default), currencySymbol);
          }

          return '';
        }
      } catch {
        // Fall back to plain string
      }
    }

    return formatFeeString(raw, currencySymbol);
  }

  try {
    const assignments = await prisma.feeAssignment.findMany({
      where: {
        branchId,
        sessionId,
        active: true,
        isOptional: false,
        ...(classId ? { OR: [{ classId }, { classId: null }] } : {}),
      },
      include: { feeType: true },
    });

    if (assignments.length > 0) {
      const total = assignments.reduce((sum, a) => sum + Number(a.feeType?.amount || 0), 0);
      if (total > 0) {
        return `${currencySymbol}${total.toLocaleString()}`;
      }
    }
  } catch {
    // ignore and fall through
  }

  return '';
}

/**
 * Resolves the complete school branding, contact info, colors, resumption date,
 * next term payment, and teacher/principal signatures for report cards.
 */
export async function resolveSchoolReportBranding(
  prisma: typeof prismaDefault,
  branchId: number,
  options: ResolveBrandingOptions = {}
): Promise<SchoolReportBranding> {
  const [branch, settings, landingPage, globalSettings] = await Promise.all([
    prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        id: true,
        name: true,
        code: true,
        address: true,
        phone: true,
        email: true,
        logo: true,
        reportCardLogo: true,
        idCardPrimaryColor: true,
        idCardSecondaryColor: true,
      },
    }),
    prisma.systemSetting.findUnique({
      where: { branchId },
    }),
    prisma.schoolLandingPage.findUnique({
      where: { branchId },
      select: { primaryColor: true, secondaryColor: true },
    }).catch(() => null),
    prisma.globalSettings.findFirst().catch(() => null),
  ]);

  const sessionId = options.sessionId || globalSettings?.sessionId || 5;

  const teacherSigConfig = parseTeacherSignatureConfig(settings?.defaultTeacherSignatureUrl);
  const generalTeacherSignature = teacherSigConfig.general || null;

  // Resolve Class / Form Teacher if classId is provided
  let classTeacherName = 'Class Teacher';
  let classTeacherSignatureUrl: string | null = null;
  let isClassTeacherUnavailable = false;

  if (options.classId) {
    const classKey = String(options.classId);
    const classOverride = teacherSigConfig.byClass?.[classKey];

    if (classOverride === 'DISABLED' || classOverride === 'UNAVAILABLE' || classOverride === 'NONE' || classOverride === null) {
      // Admin explicitly marked that teacher signature is removed / unavailable for this class
      isClassTeacherUnavailable = true;
      classTeacherSignatureUrl = null;
    } else if (typeof classOverride === 'string' && classOverride.trim().length > 0) {
      // Admin uploaded a custom signature for this specific class
      classTeacherSignatureUrl = classOverride.trim();
    } else {
      // No custom class override; check allocated teacher profile, then fallback to general
      const allocation = await prisma.teacherAllocation.findFirst({
        where: {
          branchId,
          classId: options.classId,
          ...(options.sectionId ? { sectionId: options.sectionId } : {}),
        },
        include: {
          teacher: {
            select: { id: true, name: true, signatureUrl: true },
          },
        },
        orderBy: { id: 'desc' },
      }).catch(() => null);

      if (allocation?.teacher) {
        classTeacherName = allocation.teacher.name || 'Class Teacher';
        classTeacherSignatureUrl = allocation.teacher.signatureUrl || generalTeacherSignature;
      } else {
        // Fallback: check any teacher allocated to this class in this branch
        const anyAllocation = await prisma.teacherAllocation.findFirst({
          where: { branchId, classId: options.classId },
          include: {
            teacher: { select: { id: true, name: true, signatureUrl: true } },
          },
        }).catch(() => null);
        if (anyAllocation?.teacher) {
          classTeacherName = anyAllocation.teacher.name || 'Class Teacher';
          classTeacherSignatureUrl = anyAllocation.teacher.signatureUrl || generalTeacherSignature;
        } else {
          classTeacherSignatureUrl = generalTeacherSignature;
        }
      }
    }
  } else {
    classTeacherSignatureUrl = generalTeacherSignature;
  }

  const genericNames = ['ugbekun international academy', 'school dashboard', 'ugbekun'];
  const resolvedSchoolName =
    settings?.schoolName && !genericNames.includes(settings.schoolName.toLowerCase())
      ? settings.schoolName
      : branch?.name || settings?.schoolName || 'Ugbekun Academy';

  const logoUrl =
    settings?.logoUrl ||
    branch?.reportCardLogo ||
    branch?.logo ||
    null;

  const primaryColor =
    settings?.primaryColor ||
    branch?.idCardPrimaryColor ||
    landingPage?.primaryColor ||
    '#1e3a8a';

  const secondaryColor =
    settings?.secondaryColor ||
    branch?.idCardSecondaryColor ||
    landingPage?.secondaryColor ||
    '#0284c7';

  const currencySymbol = settings?.currencySymbol || '₦';

  const resumptionDate = formatResumptionDateLabel(
    settings?.resumptionDate || options.examResumptionDate || null
  );

  const nextTermFees =
    options.customNextTermFees ||
    (await resolveNextTermPaymentLabel(
      prisma,
      branchId,
      sessionId,
      options.classId,
      settings?.nextTermFees,
      currencySymbol
    ));

  const posPolicy = resolveClassPositionPolicy(teacherSigConfig, options.classId);

  return {
    schoolName: resolvedSchoolName,
    tagline: settings?.tagline || 'Excellence in Knowledge & Character',
    address: settings?.address || branch?.address || '',
    phone: settings?.phone || branch?.phone || '',
    email: settings?.email || branch?.email || '',
    website: settings?.website || '',
    logoUrl,
    primaryColor,
    secondaryColor,
    currencySymbol,
    academicSession: settings?.academicSession || '2025/2026',
    currentTerm: settings?.currentTerm || 'First Term',
    resumptionDate,
    nextTermFees,
    principalName: settings?.principalName || 'The Principal',
    principalSignatureUrl: settings?.principalSignatureUrl || null,
    defaultTeacherSignatureUrl: isClassTeacherUnavailable ? null : generalTeacherSignature,
    classTeacherName,
    classTeacherSignatureUrl: isClassTeacherUnavailable ? null : (classTeacherSignatureUrl || generalTeacherSignature || null),
    autoPublishReportCards: settings?.autoPublishReportCards ?? true,
    branchCode: branch?.code || settings?.regNoPrefix || 'SCH',
    showPosition: posPolicy.showPosition,
    rankingType: posPolicy.rankingType,
    rankingLimit: posPolicy.rankingLimit,
    positionByClass: teacherSigConfig.positionByClass || {},
  };
}

/**
 * Computes attendance summary (present, absent, late, totalDays) per student
 */
export async function computeStudentAttendanceMap(
  prisma: typeof prismaDefault,
  params: {
    branchId?: number | null;
    sessionId: number;
    classId?: number;
    sectionId?: number | null;
    studentIds: number[];
  }
): Promise<Map<number, { present: number; absent: number; late: number; totalDays: number }>> {
  const result = new Map<number, { present: number; absent: number; late: number; totalDays: number }>();
  if (!params.studentIds || params.studentIds.length === 0) return result;

  for (const id of params.studentIds) {
    result.set(id, { present: 0, absent: 0, late: 0, totalDays: 0 });
  }

  try {
    const records = await prisma.attendance.findMany({
      where: {
        ...(params.branchId ? { branchId: params.branchId } : {}),
        sessionId: params.sessionId,
        studentId: { in: params.studentIds },
        ...(params.classId ? { classId: params.classId } : {}),
        ...(params.sectionId ? { sectionId: params.sectionId } : {}),
      },
      select: {
        studentId: true,
        status: true,
      },
    });

    for (const r of records) {
      const entry = result.get(r.studentId) || { present: 0, absent: 0, late: 0, totalDays: 0 };
      const st = String(r.status || '').toUpperCase();
      entry.totalDays += 1;
      if (st === 'PRESENT' || st === 'P') {
        entry.present += 1;
      } else if (st === 'LATE' || st === 'L') {
        entry.late += 1;
        entry.present += 1; // Late counts toward days present in school
      } else if (st === 'ABSENT' || st === 'A') {
        entry.absent += 1;
      }
      result.set(r.studentId, entry);
    }
  } catch {
    // ignore attendance lookup errors
  }

  return result;
}

/**
 * Generates default Teacher & Principal remarks based on average score
 */
export function buildDefaultRemarksForAverage(avgScore: number, studentName: string): {
  teacherComment: string;
  principalComment: string;
} {
  const firstName = (studentName || 'The student').split(' ')[0];
  if (avgScore >= 75) {
    return {
      teacherComment: `An outstanding academic performance by ${firstName}. Demonstrates exceptional mastery and diligence across subjects. Keep it up!`,
      principalComment: `Excellent result! ${firstName} is a shining example of academic excellence. Keep soaring higher.`,
    };
  }
  if (avgScore >= 60) {
    return {
      teacherComment: `A very good performance by ${firstName}. Shows strong understanding and steady participation in class activities.`,
      principalComment: `A commendable result. With continued focus, ${firstName} can achieve distinction next term.`,
    };
  }
  if (avgScore >= 50) {
    return {
      teacherComment: `A creditable effort by ${firstName}, though there is room for greater consistency and deeper study habits.`,
      principalComment: `Satisfactory performance. More dedication is encouraged next term for higher grades.`,
    };
  }
  if (avgScore >= 40) {
    return {
      teacherComment: `A fair attempt by ${firstName}. Needs closer attention to classwork and regular revision at home.`,
      principalComment: `Fair result. ${firstName} must work harder and utilize extra study support next term.`,
    };
  }
  return {
    teacherComment: `${firstName} requires intensive academic support and closer supervision to improve foundational comprehension.`,
    principalComment: `Below expectation. Parents and teachers should collaborate closely to support ${firstName}'s progress next term.`,
  };
}

export interface BulkMarkSaveItem {
  studentId: number;
  mark: string | null;
  absent: string | null;
}

/**
 * Bulk-upserts student marks for a subject using 1 read + batched createMany/UNNEST update,
 * eliminating N+1 per-student findFirst + update/create round trips.
 */
export async function bulkSaveMarksBatch(
  db: typeof prismaDefault,
  params: {
    findWhere: Prisma.MarkWhereInput;
    branchId: number | null;
    classId: number;
    sectionId: number;
    subjectId: number;
    examId: number;
    sessionId: number;
    items: BulkMarkSaveItem[];
    updateExamAndSession?: boolean;
  }
): Promise<number> {
  const deduped = new Map<number, BulkMarkSaveItem>();
  for (const item of params.items) {
    if (!item.studentId || !Number.isFinite(item.studentId)) continue;
    deduped.set(item.studentId, item);
  }
  const uniqueItems = Array.from(deduped.values());
  if (uniqueItems.length === 0) return 0;

  const studentIds = uniqueItems.map((i) => i.studentId);
  const existingRows = await db.mark.findMany({
    where: {
      ...params.findWhere,
      studentId: { in: studentIds },
    },
    select: { id: true, studentId: true },
    orderBy: { id: 'asc' },
  });

  const existingIdByStudent = new Map<number, number>();
  for (const row of existingRows) {
    if (!existingIdByStudent.has(row.studentId)) {
      existingIdByStudent.set(row.studentId, row.id);
    }
  }

  const toCreate: Prisma.MarkCreateManyInput[] = [];
  const updateIds: number[] = [];
  const updateMarks: (string | null)[] = [];
  const updateAbsents: (string | null)[] = [];

  for (const item of uniqueItems) {
    const existingId = existingIdByStudent.get(item.studentId);
    if (existingId) {
      updateIds.push(existingId);
      updateMarks.push(item.mark);
      updateAbsents.push(item.absent);
    } else {
      toCreate.push({
        branchId: params.branchId,
        classId: params.classId,
        sectionId: params.sectionId,
        subjectId: params.subjectId,
        studentId: item.studentId,
        examId: params.examId,
        sessionId: params.sessionId,
        mark: item.mark,
        absent: item.absent,
      });
    }
  }

  const tasks: Promise<unknown>[] = [];
  if (toCreate.length > 0) {
    tasks.push(db.mark.createMany({ data: toCreate }));
  }
  if (updateIds.length > 0) {
    if (params.updateExamAndSession) {
      tasks.push(
        db.$executeRaw`
          UPDATE mark AS m
          SET
            mark = v.mark,
            absent = v.absent,
            session_id = ${params.sessionId},
            exam_id = ${params.examId}
          FROM UNNEST(${updateIds}::int4[], ${updateMarks}::text[], ${updateAbsents}::text[]) AS v(id, mark, absent)
          WHERE m.id = v.id
        `
      );
    } else {
      tasks.push(
        db.$executeRaw`
          UPDATE mark AS m
          SET
            mark = v.mark,
            absent = v.absent
          FROM UNNEST(${updateIds}::int4[], ${updateMarks}::text[], ${updateAbsents}::text[]) AS v(id, mark, absent)
          WHERE m.id = v.id
        `
      );
    }
  }

  await Promise.all(tasks);
  return uniqueItems.length;
}

export interface BulkSubjectCommentItem {
  studentId: number;
  comment: string;
  rating: number;
}

/**
 * Bulk-upserts subject developmental comment assessments using 1 lookup + createMany/UNNEST update.
 */
export async function bulkSaveSubjectCommentsBatch(
  db: typeof prismaDefault,
  params: {
    branchId: number;
    classId: number;
    subjectId: number;
    termId: number;
    sessionId: number;
    items: BulkSubjectCommentItem[];
    validateStudentBranch?: boolean;
  }
): Promise<number[]> {
  const deduped = new Map<number, BulkSubjectCommentItem>();
  for (const item of params.items) {
    if (!item.studentId || !Number.isFinite(item.studentId)) continue;
    deduped.set(item.studentId, item);
  }
  const candidateIds = Array.from(deduped.keys());
  if (candidateIds.length === 0) return [];

  let validIds = candidateIds;
  if (params.validateStudentBranch) {
    const validStudents = await db.student.findMany({
      where: { id: { in: candidateIds }, branchId: params.branchId },
      select: { id: true },
    });
    const validSet = new Set(validStudents.map((s) => s.id));
    validIds = candidateIds.filter((id) => validSet.has(id));
    if (validIds.length === 0) return [];
  }

  const existingRows = await db.subjectCommentAssessment.findMany({
    where: {
      subjectId: params.subjectId,
      termId: params.termId,
      sessionId: params.sessionId,
      studentId: { in: validIds },
    },
    select: { id: true, studentId: true },
  });
  const existingByStudent = new Map(existingRows.map((r) => [r.studentId, r.id]));

  const toCreate: Prisma.SubjectCommentAssessmentCreateManyInput[] = [];
  const updateIds: number[] = [];
  const updateComments: string[] = [];
  const updateRatings: number[] = [];

  for (const studentId of validIds) {
    const item = deduped.get(studentId)!;
    const existingId = existingByStudent.get(studentId);
    if (existingId) {
      updateIds.push(existingId);
      updateComments.push(item.comment);
      updateRatings.push(item.rating);
    } else {
      toCreate.push({
        studentId,
        subjectId: params.subjectId,
        classId: params.classId,
        termId: params.termId,
        sessionId: params.sessionId,
        branchId: params.branchId,
        comment: item.comment,
        rating: item.rating,
      });
    }
  }

  const tasks: Promise<unknown>[] = [];
  if (toCreate.length > 0) {
    tasks.push(db.subjectCommentAssessment.createMany({ data: toCreate, skipDuplicates: true }));
  }
  if (updateIds.length > 0) {
    tasks.push(
      db.$executeRaw`
        UPDATE subject_comment_assessments AS s
        SET
          comment = v.comment,
          rating = v.rating,
          class_id = ${params.classId},
          updated_at = NOW()
        FROM UNNEST(${updateIds}::int4[], ${updateComments}::text[], ${updateRatings}::int4[]) AS v(id, comment, rating)
        WHERE s.id = v.id
      `
    );
  }

  await Promise.all(tasks);
  return validIds;
}

/**
 * Immediate Report Card Compilation Hook:
 * Invoked immediately after teachers or admins save scores so report cards
 * are compiled, ranked, and take effect immediately across all portals.
 */
export async function syncReportCardOnScoreSave(
  prisma: typeof prismaDefault,
  params: {
    branchId: number;
    classId: number;
    sectionId?: number | null;
    sessionId: number;
    studentIds?: number[];
    publishedBy?: number;
  }
): Promise<void> {
  const { branchId, classId, sectionId, sessionId, studentIds, publishedBy } = params;
  if (!branchId || !classId || !sessionId) return;

  try {
    const [settings, existingPub] = await Promise.all([
      prisma.systemSetting.findUnique({
        where: { branchId },
        select: { autoPublishReportCards: true },
      }),
      prisma.classReportCardPublication.findFirst({
        where: {
          classId,
          sessionId,
          OR: [{ branchId }, { branchId: null }],
        },
        select: {
          id: true,
          branchId: true,
          isPublished: true,
          releaseCa1: true,
          releaseCa2: true,
          releaseCombinedCa: true,
          releaseExam: true,
          releaseFull: true,
        },
      }),
    ]);

    const shouldAutoPublish = settings?.autoPublishReportCards ?? true;

    const pubWritePromise: Promise<unknown> = (() => {
      if (!shouldAutoPublish) return Promise.resolve();
      const alreadyFullyPublished =
        existingPub &&
        existingPub.branchId === branchId &&
        existingPub.isPublished &&
        existingPub.releaseCa1 &&
        existingPub.releaseCa2 &&
        existingPub.releaseCombinedCa &&
        existingPub.releaseExam &&
        existingPub.releaseFull;

      if (alreadyFullyPublished) return Promise.resolve();

      if (existingPub) {
        return prisma.classReportCardPublication.update({
          where: { id: existingPub.id },
          data: {
            branchId,
            isPublished: true,
            releaseCa1: true,
            releaseCa2: true,
            releaseCombinedCa: true,
            releaseExam: true,
            releaseFull: true,
            publishedAt: new Date(),
            ...(publishedBy ? { publishedBy } : {}),
          },
        });
      }
      return prisma.classReportCardPublication.create({
        data: {
          branchId,
          classId,
          sessionId,
          isPublished: true,
          releaseCa1: true,
          releaseCa2: true,
          releaseCombinedCa: true,
          releaseExam: true,
          releaseFull: true,
          publishedAt: new Date(),
          publishedBy: publishedBy || null,
        },
      });
    })();

    // Ensure impacted students have initial commentary records synthesized if none exist yet
    if (studentIds && studentIds.length > 0) {
      const uniqueStudentIds = Array.from(new Set(studentIds.filter((id) => Number.isFinite(id) && id > 0)));
      if (uniqueStudentIds.length === 0) {
        await pubWritePromise;
        return;
      }

      const [, students, marks, existingCommentaries] = await Promise.all([
        pubWritePromise,
        prisma.student.findMany({
          where: { id: { in: uniqueStudentIds } },
          select: { id: true, firstName: true, lastName: true },
        }),
        prisma.mark.findMany({
          where: {
            branchId,
            classId,
            sessionId,
            studentId: { in: uniqueStudentIds },
          },
          select: {
            studentId: true,
            mark: true,
            cbtMark: true,
          },
        }),
        prisma.studentCommentary.findMany({
          where: {
            studentId: { in: uniqueStudentIds },
            sessionId,
          },
          select: {
            id: true,
            studentId: true,
            remark: true,
            reviewNotes: true,
            isEditedByHuman: true,
          },
        }),
      ]);

      const studentMap = new Map(
        students.map((s) => [s.id, `${s.firstName || ''} ${s.lastName || ''}`.trim()])
      );
      const commentaryMap = new Map(existingCommentaries.map((c) => [c.studentId, c]));

      const scoresByStudent = new Map<number, number[]>();
      for (const m of marks) {
        let manualSum = 0;
        if (m.mark) {
          try {
            const parsed = JSON.parse(m.mark);
            if (typeof parsed === 'object' && parsed !== null) {
              manualSum = (Object.values(parsed) as any[]).reduce<number>(
                (acc: number, val: any) => acc + (parseFloat(String(val)) || 0),
                0
              );
            } else {
              manualSum = parseFloat(String(m.mark)) || 0;
            }
          } catch {
            manualSum = parseFloat(String(m.mark)) || 0;
          }
        }
        const total = Math.min(100, manualSum);
        if (total > 0) {
          const list = scoresByStudent.get(m.studentId) || [];
          list.push(total);
          scoresByStudent.set(m.studentId, list);
        }
      }

      const toCreate: Prisma.StudentCommentaryCreateManyInput[] = [];
      const updateIds: number[] = [];
      const updateRemarks: string[] = [];
      const updateReviewNotes: string[] = [];

      for (const stId of uniqueStudentIds) {
        const existing = commentaryMap.get(stId);
        // If human-edited commentary already exists with both teacher & principal comments, preserve it
        if (existing?.isEditedByHuman && existing.remark && existing.reviewNotes) {
          continue;
        }
        if (existing && existing.remark && existing.reviewNotes) {
          continue;
        }

        const totals = scoresByStudent.get(stId) || [];
        const avg =
          totals.length > 0
            ? totals.reduce((a, b) => a + b, 0) / totals.length
            : 0;
        const defaults = buildDefaultRemarksForAverage(avg, studentMap.get(stId) || 'Student');

        if (!existing) {
          toCreate.push({
            studentId: stId,
            classId,
            sectionId: sectionId || 1,
            sessionId,
            branchId,
            remark: defaults.teacherComment,
            reviewNotes: defaults.principalComment,
            status: 'APPROVED',
            isAiGenerated: false,
            isEditedByHuman: false,
          });
        } else {
          updateIds.push(existing.id);
          updateRemarks.push(existing.remark || defaults.teacherComment);
          updateReviewNotes.push(existing.reviewNotes || defaults.principalComment);
        }
      }

      const writeTasks: Promise<unknown>[] = [];
      if (toCreate.length > 0) {
        writeTasks.push(
          prisma.studentCommentary
            .createMany({ data: toCreate, skipDuplicates: true })
            .catch(() => {})
        );
      }
      if (updateIds.length > 0) {
        writeTasks.push(
          prisma.$executeRaw`
            UPDATE student_commentary AS sc
            SET
              remark = v.remark,
              review_notes = v.review_notes,
              updated_at = NOW()
            FROM UNNEST(${updateIds}::int4[], ${updateRemarks}::text[], ${updateReviewNotes}::text[]) AS v(id, remark, review_notes)
            WHERE sc.id = v.id
          `.catch(() => {})
        );
      }
      if (writeTasks.length > 0) {
        await Promise.all(writeTasks);
      }
    } else {
      await pubWritePromise;
    }
  } catch (err) {
    console.error('[REPORT CARD SYNC] Error syncing report card on score save:', err);
  }
}

export interface AssignedSubjectInfo {
  subjectId: number;
  subjectName: string;
  subjectCode: string;
}

/**
 * Resolves the canonical deduplicated list of subjects assigned to a class/section
 * under Academics (SubjectAssign) for the given session, falling back to the
 * latest session's assignments if the target session has none.
 */
export async function resolveAssignedClassSubjects(
  db: any,
  params: {
    classId: number;
    sectionId?: number | null;
    sessionId?: number | null;
    branchId?: number | null;
  }
): Promise<AssignedSubjectInfo[]> {
  const { classId, sectionId, sessionId, branchId } = params;
  const baseWhere: any = {
    classId,
    ...(branchId ? { branchId } : {}),
    ...(sectionId ? { sectionId } : {}),
  };

  let assigns = await db.subjectAssign.findMany({
    where: {
      ...baseWhere,
      ...(sessionId ? { sessionId } : {}),
    },
    include: {
      subject: { select: { id: true, name: true, subjectCode: true } },
    },
  });

  if (assigns.length === 0 && sessionId) {
    const latestAssign = await db.subjectAssign.findFirst({
      where: baseWhere,
      orderBy: { sessionId: 'desc' },
      select: { sessionId: true },
    });
    if (latestAssign?.sessionId) {
      assigns = await db.subjectAssign.findMany({
        where: { ...baseWhere, sessionId: latestAssign.sessionId },
        include: {
          subject: { select: { id: true, name: true, subjectCode: true } },
        },
      });
    }
  }

  const bySubjectId = new Map<number, AssignedSubjectInfo>();
  for (const a of assigns) {
    if (!a.subjectId || bySubjectId.has(a.subjectId)) continue;
    bySubjectId.set(a.subjectId, {
      subjectId: a.subjectId,
      subjectName: a.subject?.name || 'Subject',
      subjectCode: a.subject?.subjectCode || 'N/A',
    });
  }

  return Array.from(bySubjectId.values()).sort((a, b) =>
    a.subjectName.localeCompare(b.subjectName)
  );
}

/**
 * Builds canonical report card rows for a single student by left-joining
 * consolidated marks onto the class's assigned subjects.
 */
export function buildReportCardRowsForStudent(params: {
  assignedSubjects: AssignedSubjectInfo[];
  studentMarks: any[];
  dbMatrix: ResolvedClassMatrix;
  activeStage: string;
  activeMaxMarks: number;
  isCombinedCaScope: boolean;
  classSubjectTotals: Record<string, { sum: number; count: number }>;
  gradingRanges?: any[];
}): {
  rows: any[];
  sum: number;
  count: number;
  totalMarks: number;
  maxMarksSum: number;
} {
  const {
    assignedSubjects,
    studentMarks,
    dbMatrix,
    activeStage,
    activeMaxMarks,
    isCombinedCaScope,
    classSubjectTotals,
    gradingRanges,
  } = params;

  const markBySubjectId = new Map<number, any>();
  for (const m of studentMarks) {
    const subId = Number(m.subject?.id || m.subjectId);
    if (subId && !markBySubjectId.has(subId)) {
      markBySubjectId.set(subId, m);
    }
  }

  const rows: any[] = [];
  let sum = 0;
  let count = 0;
  let totalMarks = 0;
  let maxMarksSum = 0;

  const subjectsToRender: Array<{ subjectId: number; subjectName: string; subjectCode: string; markRecord?: any }> =
    assignedSubjects.length > 0
      ? assignedSubjects.map((s) => ({
          ...s,
          markRecord: markBySubjectId.get(s.subjectId),
        }))
      : studentMarks.map((m) => ({
          subjectId: Number(m.subject?.id || m.subjectId),
          subjectName: m.subject?.name || 'Subject',
          subjectCode: m.subject?.subjectCode || 'N/A',
          markRecord: m,
        }));

  for (const item of subjectsToRender) {
    const m = item.markRecord;
    if (!m) continue;

    const isAbsent = m.absent === '1' || m.absent === 'true';
    const mapped = mapStudentMarkToMatrix(m, dbMatrix, activeStage);
    if (!mapped.hasValidScore && !isAbsent) {
      continue;
    }

    const rowMaxMarks = mapped.effectiveMaxMarks || activeMaxMarks;
    const cAvgObj = classSubjectTotals[String(item.subjectId)];
    const scoreForStage = mapped.stageTotal;
    const classAvg =
      cAvgObj && cAvgObj.count > 0
        ? Number((cAvgObj.sum / cAvgObj.count).toFixed(1))
        : mapped.hasValidScore
          ? scoreForStage
          : 0;
    const gradeRes = gradingRanges
      ? calculateGradeFromRanges(mapped.normalizedPercentage, gradingRanges)
      : { grade: '-', remark: '-' };

    rows.push({
      id: m.id,
      examName: m.exam?.name || 'Evaluation',
      subjectName: item.subjectName,
      subjectCode: item.subjectCode,
      cbtMark: mapped.caTotal > 0 ? String(mapped.caTotal) : null,
      theoryMark: isCombinedCaScope ? null : (mapped.examTotal > 0 ? String(mapped.examTotal) : null),
      mark: mapped.hasValidScore ? String(scoreForStage) : null,
      stageScore: scoreForStage,
      maxMarks: rowMaxMarks,
      componentScores: mapped.componentScores,
      grade: mapped.hasValidScore ? gradeRes.grade : '-',
      remark: mapped.hasValidScore ? gradeRes.remark : '-',
      classAverage: classAvg,
      absent: isAbsent,
    });

    if (mapped.hasValidScore) {
      sum += scoreForStage;
      count += 1;
      totalMarks += scoreForStage;
      maxMarksSum += rowMaxMarks;
    }
  }

  return { rows, sum, count, totalMarks, maxMarksSum };
}

export const ACADEMIC_TERMS_CATALOG = [
  { id: 1, label: 'First Term' },
  { id: 2, label: 'Second Term' },
  { id: 3, label: 'Third Term' },
] as const;

export function resolveTermIdFromInput(rawTermId: unknown, fallbackLabel?: string | null): number {
  const num = Number(rawTermId);
  if (num === 1 || num === 2 || num === 3) return num;
  const compact = String(fallbackLabel || '').trim().toLowerCase().replace(/\s+/g, '');
  if (compact.includes('second') || compact.includes('2nd')) return 2;
  if (compact.includes('third') || compact.includes('3rd')) return 3;
  return 1;
}

export function termLabelForId(termId: number): string {
  return ACADEMIC_TERMS_CATALOG.find((t) => t.id === termId)?.label || 'First Term';
}

export function examMatchesTerm(
  exam: { termId?: number | null; name?: string | null } | null | undefined,
  targetTermId: number
): boolean {
  if (!exam) return false;
  if (exam.termId === 1 || exam.termId === 2 || exam.termId === 3) {
    return exam.termId === targetTermId;
  }
  const name = String(exam.name || '').toLowerCase();
  if (/\b(2nd|second)\b/i.test(name)) return targetTermId === 2;
  if (/\b(3rd|third)\b/i.test(name)) return targetTermId === 3;
  if (/\b(1st|first)\b/i.test(name)) return targetTermId === 1;
  return targetTermId === 1;
}

export interface StudentReportClassOption {
  sessionId: number;
  classId: number;
  sectionId: number | null;
  className: string;
  sectionName: string;
  isEcd: boolean;
}

export interface StudentReportOptionsPayload {
  sessions: Array<{ id: number; label: string; isCurrent: boolean }>;
  classes: StudentReportClassOption[];
  terms: Array<{ id: number; label: string }>;
  currentSessionId: number | null;
  currentClassId: number | null;
  currentTermId: number;
  currentTermLabel: string;
}

/**
 * Fetches enrolled and mark-recorded sessions, classes, and terms for a student
 * so both Student and Parent portals share identical filter options and scoping.
 */
export async function fetchStudentReportOptions(
  prisma: typeof prismaDefault,
  studentId: number,
  branchId?: number | null,
  currentSessionId?: number | null
): Promise<StudentReportOptionsPayload> {
  const [enrolls, markScopeRows, branchSetting] = await Promise.all([
    prisma.enroll.findMany({
      where: { studentId, ...(branchId ? { branchId } : {}) },
      orderBy: [{ sessionId: 'desc' }, { id: 'desc' }],
      select: {
        sessionId: true,
        classId: true,
        sectionId: true,
        class: { select: { id: true, name: true, isEcd: true } },
        section: { select: { id: true, name: true } },
      },
    }),
    prisma.mark.findMany({
      where: { studentId, ...(branchId ? { branchId } : {}) },
      distinct: ['sessionId', 'classId', 'sectionId'],
      select: {
        sessionId: true,
        classId: true,
        sectionId: true,
        class: { select: { id: true, name: true, isEcd: true } },
        section: { select: { id: true, name: true } },
      },
    }),
    branchId
      ? prisma.systemSetting.findUnique({ where: { branchId }, select: { currentTerm: true } })
      : Promise.resolve(null),
  ]);

  const sessionIdsSet = new Set<number>();
  if (currentSessionId) sessionIdsSet.add(currentSessionId);
  enrolls.forEach((e) => sessionIdsSet.add(e.sessionId));
  markScopeRows.forEach((m) => sessionIdsSet.add(m.sessionId));

  const schoolYears =
    sessionIdsSet.size > 0
      ? await prisma.schoolYear.findMany({
          where: { id: { in: Array.from(sessionIdsSet) } },
          orderBy: { id: 'desc' },
          select: { id: true, schoolYear: true },
        })
      : [];

  const sessions = schoolYears.map((sy) => ({
    id: sy.id,
    label: sy.schoolYear,
    isCurrent: sy.id === currentSessionId,
  }));

  const classScopeMap = new Map<string, StudentReportClassOption>();
  for (const row of [...enrolls, ...markScopeRows]) {
    const key = `${row.sessionId}:${row.classId}`;
    if (!classScopeMap.has(key) && row.class) {
      classScopeMap.set(key, {
        sessionId: row.sessionId,
        classId: row.classId,
        sectionId: row.sectionId ?? null,
        className: row.class.name,
        sectionName: row.section?.name || '',
        isEcd: Boolean(row.class.isEcd),
      });
    }
  }

  const currentTermLabel = branchSetting?.currentTerm || 'First Term';
  const currentTermId = resolveTermIdFromInput(undefined, currentTermLabel);

  return {
    sessions,
    classes: Array.from(classScopeMap.values()),
    terms: ACADEMIC_TERMS_CATALOG.map((t) => ({ id: t.id, label: t.label })),
    currentSessionId: currentSessionId || sessions[0]?.id || null,
    currentClassId: enrolls[0]?.classId || null,
    currentTermId,
    currentTermLabel,
  };
}

export interface ResolvedReportFilterScope {
  options: StudentReportOptionsPayload;
  activeSessionId: number | undefined;
  targetClassId: number | undefined;
  targetSectionId: number | undefined;
  targetTermId: number;
  targetTermLabel: string;
  isAuthorizedSession: boolean;
  isAuthorizedClass: boolean;
}

/**
 * Resolves and validates optional sessionId, classId, and termId query parameters
 * strictly against the target student's enrolled/mark-recorded options (IDOR safe).
 */
export async function resolveStudentReportFilterScope(
  prisma: typeof prismaDefault,
  params: {
    studentId: number;
    branchId?: number | null;
    fallbackSessionId?: number | null;
    fallbackClassId?: number | null;
    fallbackSectionId?: number | null;
    query?: Record<string, any>;
  }
): Promise<ResolvedReportFilterScope> {
  const { studentId, branchId, fallbackSessionId, fallbackClassId, fallbackSectionId, query } = params;
  const reqSessionId = query?.sessionId ? Number(query.sessionId) : null;
  const reqClassId = query?.classId ? Number(query.classId) : null;
  const reqTermId = query?.termId ? Number(query.termId) : null;

  const options = await fetchStudentReportOptions(prisma, studentId, branchId, fallbackSessionId);

  const isAuthorizedSession =
    !reqSessionId ||
    options.sessions.length === 0 ||
    options.sessions.some((s) => s.id === reqSessionId);

  const activeSessionId = reqSessionId || fallbackSessionId || options.currentSessionId || undefined;

  const matchedClassOption =
    options.classes.find(
      (c) =>
        (reqClassId ? c.classId === reqClassId : true) &&
        (activeSessionId ? c.sessionId === activeSessionId : true)
    ) ||
    (reqClassId ? options.classes.find((c) => c.classId === reqClassId) : undefined);

  const isAuthorizedClass = !reqClassId || Boolean(matchedClassOption);
  const targetClassId = reqClassId || matchedClassOption?.classId || fallbackClassId || undefined;
  const targetSectionId = matchedClassOption?.sectionId || fallbackSectionId || undefined;
  const targetTermId = resolveTermIdFromInput(reqTermId, options.currentTermLabel);
  const targetTermLabel = termLabelForId(targetTermId);

  return {
    options,
    activeSessionId,
    targetClassId,
    targetSectionId,
    targetTermId,
    targetTermLabel,
    isAuthorizedSession,
    isAuthorizedClass,
  };
}

/**
 * Resolves the canonical ClassReportCardPublication gating state for a student/child
 * identically across Student and Parent portals, handling section-specific vs school-wide
 * publications and most-recently-published rows cleanly.
 */
export async function resolveClassPublicationForStudent(
  prisma: typeof prismaDefault,
  params: {
    classId?: number;
    sectionId?: number;
    sessionId?: number;
    termId?: number;
    branchId?: number | null;
    autoPublishReportCards?: boolean;
  }
): Promise<{
  classPub: any | null;
  hasExplicitPub: boolean;
  isPublished: boolean;
  releaseCa1: boolean;
  releaseCa2: boolean;
  releaseCombinedCa: boolean;
  releaseExam: boolean;
  releaseFull: boolean;
}> {
  const { classId, sectionId, sessionId, termId, branchId, autoPublishReportCards = true } = params;
  if (!classId || !sessionId) {
    const autoPub = Boolean(autoPublishReportCards);
    return {
      classPub: null,
      hasExplicitPub: false,
      isPublished: autoPub,
      releaseCa1: autoPub,
      releaseCa2: autoPub,
      releaseCombinedCa: autoPub,
      releaseExam: autoPub,
      releaseFull: autoPub,
    };
  }

  const sectionFilter = sectionId
    ? { OR: [{ sectionId }, { sectionId: null }] }
    : {};
  const branchFilter = branchId
    ? { OR: [{ branchId }, { branchId: null }] }
    : {};

  const isRowActivelyPublished = (pub: {
    isPublished?: boolean | null;
    releaseCa1?: boolean | null;
    releaseCa2?: boolean | null;
    releaseCombinedCa?: boolean | null;
    releaseExam?: boolean | null;
    releaseFull?: boolean | null;
  } | null | undefined) =>
    Boolean(
      pub &&
        pub.isPublished &&
        (pub.releaseCa1 || pub.releaseCa2 || pub.releaseCombinedCa || pub.releaseExam || pub.releaseFull)
    );

  // 1. Check publications matching this term, newest first
  const termRows = await prisma.classReportCardPublication.findMany({
    where: {
      classId,
      sessionId,
      ...(termId ? { termId } : {}),
      ...sectionFilter,
      ...branchFilter,
    },
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
  });

  let selectedPub =
    (sectionId ? termRows.find((r) => r.sectionId === sectionId && isRowActivelyPublished(r)) : undefined) ||
    termRows.find((r) => isRowActivelyPublished(r)) ||
    null;

  // 2. Fallback to any published record for this class & session (e.g., published under a sibling termId or legacy row)
  if (!selectedPub) {
    const sessionPublishedRows = await prisma.classReportCardPublication.findMany({
      where: {
        classId,
        sessionId,
        ...sectionFilter,
        ...branchFilter,
        isPublished: true,
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    });
    selectedPub =
      (sectionId
        ? sessionPublishedRows.find((r) => r.sectionId === sectionId && isRowActivelyPublished(r))
        : undefined) ||
      sessionPublishedRows.find((r) => isRowActivelyPublished(r)) ||
      null;
  }

  // 3. Respect explicit unpublished gating if no published record matched
  if (!selectedPub && termRows.length > 0) {
    selectedPub = termRows[0];
  }

  const hasExplicitPub = Boolean(selectedPub);
  const isPublished = hasExplicitPub ? isRowActivelyPublished(selectedPub) : Boolean(autoPublishReportCards);

  return {
    classPub: selectedPub,
    hasExplicitPub,
    isPublished,
    releaseCa1: hasExplicitPub ? Boolean(selectedPub?.releaseCa1) : isPublished,
    releaseCa2: hasExplicitPub ? Boolean(selectedPub?.releaseCa2) : isPublished,
    releaseCombinedCa: hasExplicitPub ? Boolean(selectedPub?.releaseCombinedCa) : isPublished,
    releaseExam: hasExplicitPub ? Boolean(selectedPub?.releaseExam) : isPublished,
    releaseFull: hasExplicitPub ? Boolean(selectedPub?.releaseFull) : isPublished,
  };
}
