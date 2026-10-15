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
      where: { id: dist.onlineExamId, branchId: dist.branchId, classId: dist.classId },
    })
    if (byId) return byId
  }
  return prisma.onlineExam.findFirst({
    where: companionExamWhere(dist),
    orderBy: { id: 'asc' },
  })
}

export interface CascadeDeleteCbtExamResult {
  success: boolean
  deletedDistributions: number
  deletedExams: number
  deletedSubmissions: number
  unlinkedMarks: number
  message?: string
}

/**
 * Senior-level transactional cascading delete for CBT exams.
 * Ensures that deleting a CBT assessment (whether referenced as CbtDistribution or OnlineExam)
 * completely and atomically removes it across:
 * 1. cbt_distributions (Admin & Student direct lists)
 * 2. online_exam (Teacher list, Student tasks, and Parent records)
 * 3. online_exam_submission (Student sitting history & logs)
 * 4. mark register (unlinking cbt_submission_id, cbt_mark to maintain gradebook integrity)
 * 5. Dedicated question_groups (cleaned up if no longer referenced)
 */
export async function cascadeDeleteCbtExam(params: {
  distributionId?: number | null
  onlineExamId?: number | null
  branchId?: number | null
}): Promise<CascadeDeleteCbtExamResult> {
  const branchId = params.branchId ? Number(params.branchId) : undefined
  const inputDistId = params.distributionId ? Number(params.distributionId) : null
  const inputExamId = params.onlineExamId ? Number(params.onlineExamId) : null

  const distIds = new Set<number>()
  const examIds = new Set<number>()
  const groupIds = new Set<number>()

  // 1. Resolve starting from distributionId
  if (inputDistId) {
    const dist = await prisma.cbtDistribution.findUnique({
      where: { id: inputDistId },
      include: { group: true },
    })
    if (dist && (!branchId || dist.branchId === branchId)) {
      distIds.add(dist.id)
      if (dist.groupId) groupIds.add(dist.groupId)
      if (dist.onlineExamId) examIds.add(dist.onlineExamId)

      // Find any companion OnlineExam records with identical title, classId, subjectId, branchId
      const companions = await prisma.onlineExam.findMany({
        where: {
          title: dist.title,
          classId: dist.classId,
          subjectId: dist.subjectId,
          branchId: dist.branchId,
        },
        select: { id: true },
      })
      companions.forEach((c) => examIds.add(c.id))
    } else {
      // Check if the provided ID was actually an OnlineExam ID
      const maybeExam = await prisma.onlineExam.findUnique({
        where: { id: inputDistId },
      })
      if (maybeExam && (!branchId || maybeExam.branchId === branchId)) {
        examIds.add(maybeExam.id)
      }
    }
  }

  // 2. Resolve starting from onlineExamId
  if (inputExamId) {
    const exam = await prisma.onlineExam.findUnique({
      where: { id: inputExamId },
    })
    if (exam && (!branchId || exam.branchId === branchId)) {
      examIds.add(exam.id)

      // Find linked distributions by onlineExamId OR companion key
      const linkedDists = await prisma.cbtDistribution.findMany({
        where: {
          OR: [
            { onlineExamId: exam.id },
            {
              title: exam.title,
              classId: exam.classId,
              subjectId: exam.subjectId,
              branchId: exam.branchId,
            },
          ],
        },
        select: { id: true, groupId: true },
      })
      linkedDists.forEach((d) => {
        distIds.add(d.id)
        if (d.groupId) groupIds.add(d.groupId)
      })
    } else {
      // Check if the provided ID was actually a CbtDistribution ID
      const maybeDist = await prisma.cbtDistribution.findUnique({
        where: { id: inputExamId },
        select: { id: true, groupId: true, onlineExamId: true, branchId: true },
      })
      if (maybeDist && (!branchId || maybeDist.branchId === branchId)) {
        distIds.add(maybeDist.id)
        if (maybeDist.groupId) groupIds.add(maybeDist.groupId)
        if (maybeDist.onlineExamId) examIds.add(maybeDist.onlineExamId)
      }
    }
  }

  // 3. For any gathered examIds, find all related cbtDistributions
  if (examIds.size > 0) {
    const moreDists = await prisma.cbtDistribution.findMany({
      where: { onlineExamId: { in: Array.from(examIds) } },
      select: { id: true, groupId: true },
    })
    moreDists.forEach((d) => {
      distIds.add(d.id)
      if (d.groupId) groupIds.add(d.groupId)
    })
  }

  // 4. For any gathered distIds, find all related onlineExam records
  if (distIds.size > 0) {
    const distList = await prisma.cbtDistribution.findMany({
      where: { id: { in: Array.from(distIds) } },
      select: { onlineExamId: true, title: true, classId: true, subjectId: true, branchId: true },
    })
    for (const d of distList) {
      if (d.onlineExamId) examIds.add(d.onlineExamId)
      const matches = await prisma.onlineExam.findMany({
        where: {
          title: d.title,
          classId: d.classId,
          subjectId: d.subjectId,
          branchId: d.branchId,
        },
        select: { id: true },
      })
      matches.forEach((m) => examIds.add(m.id))
    }
  }

  if (distIds.size === 0 && examIds.size === 0) {
    return {
      success: false,
      deletedDistributions: 0,
      deletedExams: 0,
      deletedSubmissions: 0,
      unlinkedMarks: 0,
      message: 'CBT examination not found or already deleted.',
    }
  }

  const distIdList = Array.from(distIds)
  const examIdList = Array.from(examIds)

  let deletedSubmissionsCount = 0
  let unlinkedMarksCount = 0

  await prisma.$transaction(async (tx) => {
    // A. Submissions and Marks cleanup
    if (examIdList.length > 0) {
      const submissions = await tx.onlineExamSubmission.findMany({
        where: { onlineExamId: { in: examIdList } },
        select: { id: true },
      })
      const subIds = submissions.map((s) => s.id)

      if (subIds.length > 0) {
        const markUpdate = await tx.mark.updateMany({
          where: { cbtSubmissionId: { in: subIds } },
          data: {
            cbtSubmissionId: null,
            cbtMark: null,
            cbtSource: null,
            cbtScale: null,
          },
        })
        unlinkedMarksCount = markUpdate.count

        const subDelete = await tx.onlineExamSubmission.deleteMany({
          where: { id: { in: subIds } },
        })
        deletedSubmissionsCount = subDelete.count
      }
    }

    // B. Delete CbtDistributions
    if (distIdList.length > 0) {
      await tx.cbtDistribution.deleteMany({
        where: { id: { in: distIdList } },
      })
    }

    // C. Delete OnlineExams
    if (examIdList.length > 0) {
      await tx.onlineExam.deleteMany({
        where: { id: { in: examIdList } },
      })
    }

    // D. Clean up orphaned QuestionGroups
    if (groupIds.size > 0) {
      for (const gid of groupIds) {
        const remaining = await tx.cbtDistribution.count({
          where: { groupId: gid },
        })
        if (remaining === 0) {
          await tx.questionGroup.deleteMany({
            where: { id: gid },
          })
        }
      }
    }
  })

  return {
    success: true,
    deletedDistributions: distIdList.length,
    deletedExams: examIdList.length,
    deletedSubmissions: deletedSubmissionsCount,
    unlinkedMarks: unlinkedMarksCount,
    message: 'CBT examination deleted successfully across admin, teacher, and student portals.',
  }
}

/**
 * Transactional cascading deletion for individual Question Bank questions.
 * When a question is removed, this helper updates:
 * 1. QuestionBank record (deleted)
 * 2. QuestionGroups (question ID removed from questionIds array)
 * 3. OnlineExams (question snapshot removed from questions JSON array)
 * 4. Homework (removed from questionBankIds and questions JSON)
 */
export async function cascadeDeleteQuestionBankItem(questionId: number, branchId?: number | null) {
  const whereQ: any = { id: Number(questionId) }
  if (branchId) whereQ.branchId = Number(branchId)

  const existing = await prisma.questionBank.findFirst({ where: whereQ })
  if (!existing) {
    return { success: false, notFound: true, message: 'Question not found in Question Bank.' }
  }

  const effectiveBranchId = existing.branchId

  await prisma.$transaction(async (tx) => {
    // 1. Delete QuestionBank record
    await tx.questionBank.delete({ where: { id: Number(questionId) } })

    // 2. Remove question from QuestionGroups
    const groups = await tx.questionGroup.findMany({
      where: { branchId: effectiveBranchId },
    })
    for (const grp of groups) {
      if (Array.isArray(grp.questionIds)) {
        const original = grp.questionIds as any[]
        const filtered = original.filter(
          (qid) => Number(qid) !== Number(questionId) && String(qid) !== String(questionId)
        )
        if (filtered.length !== original.length) {
          await tx.questionGroup.update({
            where: { id: grp.id },
            data: { questionIds: filtered },
          })
        }
      }
    }

    // 3. Remove question snapshot from active OnlineExams
    const onlineExams = await tx.onlineExam.findMany({
      where: { branchId: effectiveBranchId },
    })
    for (const ex of onlineExams) {
      if (Array.isArray(ex.questions)) {
        const original = ex.questions as any[]
        const filtered = original.filter(
          (q: any) => Number(q?.id) !== Number(questionId) && String(q?.id) !== String(questionId)
        )
        if (filtered.length !== original.length) {
          await tx.onlineExam.update({
            where: { id: ex.id },
            data: { questions: filtered },
          })
        }
      }
    }

    // 4. Remove question from Homework
    const homeworks = await tx.homework.findMany({
      where: { branchId: effectiveBranchId },
    })
    for (const hw of homeworks) {
      let needsUpdate = false
      let newBankIds = hw.questionBankIds
      let newQuestions = hw.questions

      if (Array.isArray(hw.questionBankIds)) {
        const original = hw.questionBankIds as any[]
        const filtered = original.filter(
          (qid) => Number(qid) !== Number(questionId) && String(qid) !== String(questionId)
        )
        if (filtered.length !== original.length) {
          newBankIds = filtered
          needsUpdate = true
        }
      }
      if (Array.isArray(hw.questions)) {
        const original = hw.questions as any[]
        const filtered = original.filter(
          (q: any) => Number(q?.id) !== Number(questionId) && String(q?.id) !== String(questionId)
        )
        if (filtered.length !== original.length) {
          newQuestions = filtered
          needsUpdate = true
        }
      }

      if (needsUpdate) {
        await tx.homework.update({
          where: { id: hw.id },
          data: { questionBankIds: newBankIds as any, questions: newQuestions as any },
        })
      }
    }
  })

  return {
    success: true,
    message: 'Question deleted and removed from question groups and active examination papers.',
  }
}

/**
 * Transactional cascading deletion for Question Groups.
 * Unlinks linked CBT distributions and cleanly deletes the group.
 */
export async function cascadeDeleteQuestionGroup(groupId: number, branchId?: number | null) {
  const whereGrp: any = { id: Number(groupId) }
  if (branchId) whereGrp.branchId = Number(branchId)

  const existing = await prisma.questionGroup.findFirst({ where: whereGrp })
  if (!existing) {
    return { success: false, notFound: true, message: 'Question group not found.' }
  }

  await prisma.$transaction(async (tx) => {
    // Unlink any CbtDistribution records referencing this group
    await tx.cbtDistribution.updateMany({
      where: { groupId: Number(groupId) },
      data: { groupId: null },
    })

    await tx.questionGroup.delete({
      where: { id: Number(groupId) },
    })
  })

  return { success: true, message: 'Question group deleted.' }
}

