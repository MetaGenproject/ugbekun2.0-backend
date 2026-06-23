async function deleteBranchCascade(tx, branchId) {
  await tx.teacherAllocation.deleteMany({ where: { branchId } })
  await tx.teacherNote.deleteMany({ where: { branchId } })
  await tx.frontCmsTeacher.deleteMany({ where: { branchId } })
  await tx.onlineAdmission.deleteMany({ where: { branchId } })
  await tx.frontCmsAdmission.deleteMany({ where: { branchId } })
  await tx.onlineAdmissionField.deleteMany({ where: { branchId } })
  await tx.studentAdmissionField.deleteMany({ where: { branchId } })
  await tx.student.deleteMany({ where: { branchId } })
  await tx.parent.deleteMany({ where: { branchId } })
  await tx.teacher.deleteMany({ where: { branchId } })
  await tx.branchSubscription.deleteMany({ where: { branchId } })
  await tx.user.updateMany({
    where: { role: 2, legacyUserId: branchId },
    data: { active: false },
  })
  // Avoid returning all branch columns (some DBs may lack newer columns like
  // `systemLogo`). Request only the `id` to prevent Prisma from selecting
  // missing columns during the DELETE RETURNING step.
  await tx.branch.delete({ where: { id: branchId }, select: { id: true } })
}

module.exports = { deleteBranchCascade }
