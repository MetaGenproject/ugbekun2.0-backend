import prisma from './prisma'

export function companionExamWhere(dist: {
  title: string
  classId: number
  subjectId: number
  branchId: number
}) {
  return {
    title: dist.title,
    classId: dist.classId,
    subjectId: dist.subjectId,
    branchId: dist.branchId,
  }
}

export function companionExamKey(title: string, classId: number, subjectId: number) {
  return `${title}::${classId}::${subjectId}`
}

/** The OnlineExam record that stores sittings for a CBT distribution. Never create a second exam to reschedule. */
export async function findCompanionOnlineExam(dist: {
  title: string
  classId: number
  subjectId: number
  branchId: number
  onlineExamId?: number | null
}) {
  if (dist.onlineExamId) {
    const byId = await prisma.onlineExam.findFirst({
      where: { id: dist.onlineExamId, branchId: dist.branchId },
    })
    if (byId) return byId
  }
  return prisma.onlineExam.findFirst({
    where: companionExamWhere(dist),
    orderBy: { id: 'asc' },
  })
}
