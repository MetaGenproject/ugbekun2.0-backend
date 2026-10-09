import prisma from './prisma'

export const DEFAULT_CBT_SCALE = 40

export type CbtMarkSource = 'CBT_AUTO' | 'CBT_SYNC' | 'ADMIN_OVERRIDE'

export function scaleCbtPercentage(percentage: number, maxScoreBase = DEFAULT_CBT_SCALE): number {
  const pct = Number(percentage)
  const base = Number(maxScoreBase) || DEFAULT_CBT_SCALE
  if (!Number.isFinite(pct) || !Number.isFinite(base)) return 0
  const clamped = Math.max(0, Math.min(100, pct))
  return Math.round((clamped / 100) * base * 10) / 10
}

export function parseCbtScore(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export async function resolveActiveSessionId(fallback = 5): Promise<number> {
  const globalSetting = await prisma.globalSettings.findFirst()
  return globalSetting?.sessionId || fallback
}

export async function resolveTermExamId(
  branchId: number,
  sessionId: number,
  preferredExamId?: number | null
): Promise<number | null> {
  if (preferredExamId) {
    const preferred = await prisma.exam.findFirst({
      where: {
        id: Number(preferredExamId),
        OR: [{ branchId }, { branchId: null }],
      },
    })
    if (preferred) return preferred.id
  }

  const bySession = await prisma.exam.findFirst({
    where: { branchId, sessionId },
    orderBy: { id: 'desc' },
  })
  if (bySession) return bySession.id

  const anyBranchExam = await prisma.exam.findFirst({
    where: { branchId },
    orderBy: { id: 'desc' },
  })
  if (anyBranchExam) return anyBranchExam.id

  const globalAny = await prisma.exam.findFirst({
    orderBy: { id: 'desc' },
  })
  if (globalAny) return globalAny.id

  // Auto-create a default exam record if completely missing
  try {
    const created = await prisma.exam.create({
      data: {
        name: 'Standard CBT Assessment',
        branchId,
        sessionId,
        typeId: 1,
        remark: 'Automated CBT Assessment',
        markDistribution: JSON.stringify([{ id: 1, mark: 100 }]),
        status: 1,
        publishResult: 1,
      },
    })
    return created.id
  } catch {
    return null
  }
}

export async function resolveStudentSectionId(params: {
  studentId: number
  classId: number
  branchId: number
  sessionId: number
  preferredSectionId?: number | null
}): Promise<number | null> {
  if (params.preferredSectionId) return Number(params.preferredSectionId)
  
  // 1. Try enroll in this session and class
  let enroll = await prisma.enroll.findFirst({
    where: {
      studentId: params.studentId,
      classId: params.classId,
      ...(params.branchId ? { branchId: params.branchId } : {}),
      sessionId: params.sessionId,
    },
    select: { sectionId: true },
  })
  if (enroll?.sectionId) return enroll.sectionId

  // 2. Try enroll in this class across any session (latest first)
  enroll = await prisma.enroll.findFirst({
    where: {
      studentId: params.studentId,
      classId: params.classId,
    },
    orderBy: { id: 'desc' },
    select: { sectionId: true },
  })
  if (enroll?.sectionId) return enroll.sectionId

  // 3. Try any enroll for this student (latest first)
  enroll = await prisma.enroll.findFirst({
    where: {
      studentId: params.studentId,
    },
    orderBy: { id: 'desc' },
    select: { sectionId: true },
  })
  if (enroll?.sectionId) return enroll.sectionId

  // 4. Try any section belonging to this class
  const classSec = await prisma.section.findFirst({
    where: {
      classes: {
        some: { classId: params.classId },
      },
    },
    select: { id: true },
  })
  if (classSec?.id) return classSec.id

  // 5. Try any section in this branch
  const anySec = await prisma.section.findFirst({
    where: { branchId: params.branchId },
    select: { id: true },
  })
  return anySec?.id ?? null
}

export async function upsertAcademicCbtMark(params: {
  studentId: number
  classId: number
  sectionId: number
  subjectId: number
  branchId: number
  sessionId: number
  examId: number
  cbtMark: string | number
  source: CbtMarkSource
  submissionId?: number | null
  scale?: number
  overwriteOverride?: boolean
  tx?: any
}): Promise<{ mark: any; skipped: boolean; created: boolean; reason?: string }> {
  const db = params.tx || prisma
  const nextCbt = String(params.cbtMark)
  const scale = params.scale ?? DEFAULT_CBT_SCALE

  const existing = await db.mark.findFirst({
    where: {
      studentId: params.studentId,
      subjectId: params.subjectId,
      classId: params.classId,
      examId: params.examId,
      sessionId: params.sessionId,
      branchId: params.branchId,
    },
  })

  if (
    existing?.cbtSource === 'ADMIN_OVERRIDE' &&
    params.source !== 'ADMIN_OVERRIDE' &&
    !params.overwriteOverride
  ) {
    return { mark: existing, skipped: true, created: false, reason: 'admin_override' }
  }

  const data = {
    cbtMark: nextCbt,
    cbtSource: params.source,
    cbtSubmissionId: params.submissionId ?? existing?.cbtSubmissionId ?? null,
    cbtScale: scale,
    sectionId: params.sectionId || existing?.sectionId,
  }

  if (existing) {
    const mark = await db.mark.update({
      where: { id: existing.id },
      data: {
        ...data,
        mark: existing.mark || '{"CA1":"","CA2":"","EXAM":""}',
      },
    })
    return { mark, skipped: false, created: false }
  }

  const mark = await db.mark.create({
    data: {
      studentId: params.studentId,
      subjectId: params.subjectId,
      classId: params.classId,
      sectionId: params.sectionId,
      examId: params.examId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      mark: '{"CA1":"","CA2":"","EXAM":""}',
      absent: '0',
      ...data,
    },
  })
  return { mark, skipped: false, created: true }
}

export async function recordCbtPercentageOnMarksheet(params: {
  studentId: number
  classId: number
  subjectId: number
  branchId: number
  percentage: number
  source: CbtMarkSource
  sectionId?: number | null
  sessionId?: number | null
  examId?: number | null
  submissionId?: number | null
  scale?: number
  overwriteOverride?: boolean
  tx?: any
}): Promise<{ mark: any | null; skipped: boolean; reason?: string }> {
  const sessionId = params.sessionId || (await resolveActiveSessionId())
  const examId = await resolveTermExamId(params.branchId, sessionId, params.examId)
  if (!examId) {
    return { mark: null, skipped: true, reason: 'no_term_exam' }
  }

  const sectionId = await resolveStudentSectionId({
    studentId: params.studentId,
    classId: params.classId,
    branchId: params.branchId,
    sessionId,
    preferredSectionId: params.sectionId,
  })
  if (!sectionId) {
    return { mark: null, skipped: true, reason: 'no_section' }
  }

  const scale = params.scale ?? DEFAULT_CBT_SCALE
  const scaled = scaleCbtPercentage(params.percentage, scale)
  return upsertAcademicCbtMark({
    studentId: params.studentId,
    classId: params.classId,
    sectionId,
    subjectId: params.subjectId,
    branchId: params.branchId,
    sessionId,
    examId,
    cbtMark: scaled,
    source: params.source,
    submissionId: params.submissionId,
    scale,
    overwriteOverride: params.overwriteOverride,
    tx: params.tx,
  })
}
