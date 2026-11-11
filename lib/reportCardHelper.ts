import prismaDefault from './prisma';

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
}

/**
 * Parses the teacher signature configuration stored in SystemSetting.defaultTeacherSignatureUrl.
 * Supports:
 * 1. JSON: { general?: string | null, byClass?: Record<classId, string | 'DISABLED' | null> }
 * 2. Legacy string: "https://.../teacher_sig.png" (treated as general)
 */
export function parseTeacherSignatureConfig(raw?: string | null): TeacherSignatureConfig {
  if (!raw || typeof raw !== 'string') {
    return { general: null, byClass: {} };
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return {
          general: parsed.general || null,
          byClass: parsed.byClass && typeof parsed.byClass === 'object' ? parsed.byClass : {},
        };
      }
    } catch {
      // fallback
    }
  }
  return { general: trimmed || null, byClass: {} };
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
    const settings = await prisma.systemSetting.findUnique({
      where: { branchId },
      select: { autoPublishReportCards: true },
    });

    const shouldAutoPublish = settings?.autoPublishReportCards ?? true;

    if (shouldAutoPublish) {
      const existingPub = await prisma.classReportCardPublication.findFirst({
        where: {
          classId,
          sessionId,
          OR: [{ branchId }, { branchId: null }],
        },
      });

      if (existingPub) {
        await prisma.classReportCardPublication.update({
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
      } else {
        await prisma.classReportCardPublication.create({
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
      }
    }

    // Ensure impacted students have initial commentary records synthesized if none exist yet
    if (studentIds && studentIds.length > 0) {
      const uniqueStudentIds = Array.from(new Set(studentIds.filter((id) => Number.isFinite(id) && id > 0)));
      if (uniqueStudentIds.length === 0) return;

      const [students, marks, existingCommentaries] = await Promise.all([
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
        const cbtScore = parseFloat(String(m.cbtMark || '0')) || 0;
        const total = Math.min(100, manualSum + cbtScore);
        if (total > 0) {
          const list = scoresByStudent.get(m.studentId) || [];
          list.push(total);
          scoresByStudent.set(m.studentId, list);
        }
      }

      for (const stId of uniqueStudentIds) {
        const existing = commentaryMap.get(stId);
        // If human-edited commentary already exists with both teacher & principal comments, preserve it
        if (existing?.isEditedByHuman && existing.remark && existing.reviewNotes) {
          continue;
        }

        const totals = scoresByStudent.get(stId) || [];
        const avg =
          totals.length > 0
            ? totals.reduce((a, b) => a + b, 0) / totals.length
            : 0;
        const defaults = buildDefaultRemarksForAverage(avg, studentMap.get(stId) || 'Student');

        await prisma.studentCommentary.upsert({
          where: {
            studentId_sessionId: {
              studentId: stId,
              sessionId,
            },
          },
          update: {
            ...(!existing?.remark ? { remark: defaults.teacherComment } : {}),
            ...(!existing?.reviewNotes ? { reviewNotes: defaults.principalComment } : {}),
          },
          create: {
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
          },
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[REPORT CARD SYNC] Error syncing report card on score save:', err);
  }
}
