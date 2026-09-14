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

  const any = await prisma.exam.findFirst({
    where: { branchId },
    orderBy: { id: 'desc' },
  })
  return any?.id ?? null
}

export async function resolveStudentSectionId(params: {
  studentId: number
  classId: number
  branchId: number
  sessionId: number
  preferredSectionId?: number | null
}): Promise<number | null> {
  if (params.preferredSectionId) return Number(params.preferredSectionId)
  const enroll = await prisma.enroll.findFirst({
    where: {
      studentId: params.studentId,
      classId: params.classId,
      branchId: params.branchId,
      sessionId: params.sessionId,
    },
    select: { sectionId: true },
  })
  return enroll?.sectionId ?? null
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
      data,
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
      mark: null,
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
