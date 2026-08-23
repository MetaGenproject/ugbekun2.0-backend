import { Prisma } from '@prisma/client';

export async function deleteBranchCascade(
  tx: Prisma.TransactionClient,
  branchId: number
): Promise<void> {
  await (tx as any).teacherAllocation.deleteMany({ where: { branchId } });
  await (tx as any).teacherNote.deleteMany({ where: { branchId } });
  await (tx as any).frontCmsTeacher.deleteMany({ where: { branchId } });
  await (tx as any).onlineAdmission.deleteMany({ where: { branchId } });
  await (tx as any).frontCmsAdmission.deleteMany({ where: { branchId } });
  await (tx as any).onlineAdmissionField.deleteMany({ where: { branchId } });
  await (tx as any).studentAdmissionField.deleteMany({ where: { branchId } });
  await (tx as any).student.deleteMany({ where: { branchId } });
  await (tx as any).parent.deleteMany({ where: { branchId } });
  await (tx as any).teacher.deleteMany({ where: { branchId } });
  await (tx as any).branchSubscription.deleteMany({ where: { branchId } });
  await (tx as any).user.updateMany({
    where: { role: 2, legacyUserId: branchId },
    data: { active: false },
  });
  // Avoid returning all branch columns (some DBs may lack newer columns like
  // `systemLogo`). Request only the `id` to prevent Prisma from selecting
  // missing columns during the DELETE RETURNING step.
  await (tx as any).branch.delete({ where: { id: branchId }, select: { id: true } });
}

export default { deleteBranchCascade };
