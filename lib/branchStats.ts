import { PrismaClient } from '@prisma/client';

export const STAFF_ROLES = [4, 8, 9, 12, 13];

export function extractCodePrefix(code?: string | null): string {
  if (!code) return '';
  const match = String(code).match(/^([A-Za-z]+)/);
  return match ? match[1] : '';
}

export function staffMatchesBranch(username: string | null | undefined, branch: { code?: string | null; name?: string | null }): boolean {
  const normalized = String(username || '').trim();
  if (!normalized) return false;

  const lowerUsername = normalized.toLowerCase();
  const prefix = extractCodePrefix(branch.code);
  if (prefix && lowerUsername.startsWith(`${prefix.toLowerCase()}/`)) {
    return true;
  }

  const branchName = String(branch.name || '').trim();
  if (!branchName) return false;

  const lowerBranchName = branchName.toLowerCase();
  if (lowerUsername === lowerBranchName) return true;

  const branchSlug = lowerBranchName.split(/\s+/)[0];
  if (branchSlug && (lowerUsername === branchSlug || lowerBranchName.includes(lowerUsername))) {
    return true;
  }

  return false;
}

export async function countStaffForBranch(
  prisma: any,
  branch: { code?: string | null; name?: string | null },
  staffUsers?: Array<{ username: string }>
): Promise<number> {
  const users =
    staffUsers ||
    (await prisma.user.findMany({
      where: { role: { in: STAFF_ROLES }, active: true },
      select: { username: true },
    }));

  return users.filter((user: { username: string }) => staffMatchesBranch(user.username, branch)).length;
}

export async function getBranchStats(
  prisma: any,
  branchId: number,
  options: { activeOnly?: boolean; staffUsers?: Array<{ username: string }> } = {}
) {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { id: true, name: true, code: true, active: true, systemSetting: true },
  });

  if (!branch) return null;

  const activeOnly = options.activeOnly !== false;
  const entityWhere = activeOnly ? { branchId, active: true } : { branchId };

  const [
    students,
    parents,
    teachers,
    staff,
    classesCount,
    subjectsCount,
    admissionsCount,
    invoiceAgg,
    paymentAgg,
  ] = await Promise.all([
    prisma.student.count({ where: entityWhere }).catch(() => 0),
    prisma.parent.count({ where: entityWhere }).catch(() => 0),
    prisma.teacher.count({ where: entityWhere }).catch(() => 0),
    countStaffForBranch(prisma, branch, options.staffUsers).catch(() => 0),
    prisma.class.count({ where: { branchId } }).catch(() => 0),
    prisma.subject.count({ where: { branchId } }).catch(() => 0),
    prisma.onlineAdmission ? prisma.onlineAdmission.count().catch(() => 0) : Promise.resolve(0),
    prisma.invoice
      ? prisma.invoice
          .aggregate({
            where: { branchId },
            _sum: { netAmount: true, paidAmount: true, dueAmount: true },
          })
          .catch(() => null)
      : Promise.resolve(null),
    prisma.payment
      ? prisma.payment
          .aggregate({
            where: { invoice: { branchId } },
            _sum: { amount: true },
          })
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const feeCollected = paymentAgg?._sum?.amount || invoiceAgg?._sum?.paidAmount || 0;
  const feeOutstanding = invoiceAgg?._sum?.dueAmount || 0;
  const feeExpected = invoiceAgg?._sum?.netAmount || feeCollected + feeOutstanding;

  const name = branch.systemSetting?.schoolName || branch.name;

  return {
    branchId: branch.id,
    branchName: name,
    branchCode: branch.code,
    students,
    parents,
    teachers,
    staff,
    classes: classesCount || 0,
    subjects: subjectsCount || 0,
    admissions: admissionsCount || 0,
    feeCollected,
    feeOutstanding,
    feeExpected,
    settings: branch.systemSetting || null,
  };
}

export async function getBranchStatsMap(prisma: any, branches: Array<{ id: number; code?: string | null; name?: string | null }>) {
  const staffUsers = await prisma.user.findMany({
    where: { role: { in: STAFF_ROLES }, active: true },
    select: { username: true },
  });

  const [studentGroups, parentGroups, teacherGroups] = await Promise.all([
    prisma.student.groupBy({
      by: ['branchId'],
      where: { branchId: { not: null }, active: true },
      _count: { id: true },
    }),
    prisma.parent.groupBy({
      by: ['branchId'],
      where: { branchId: { not: null }, active: true },
      _count: { id: true },
    }),
    prisma.teacher.groupBy({
      by: ['branchId'],
      where: { branchId: { not: null }, active: true },
      _count: { id: true },
    }),
  ]);

  const studentsByBranch = new Map(studentGroups.map((row: any) => [row.branchId, row._count.id]));
  const parentsByBranch = new Map(parentGroups.map((row: any) => [row.branchId, row._count.id]));
  const teachersByBranch = new Map(teacherGroups.map((row: any) => [row.branchId, row._count.id]));

  const statsByBranch = new Map();

  for (const branch of branches) {
    statsByBranch.set(branch.id, {
      students: studentsByBranch.get(branch.id) || 0,
      parents: parentsByBranch.get(branch.id) || 0,
      teachers: teachersByBranch.get(branch.id) || 0,
      staff: staffUsers.filter((user: any) => staffMatchesBranch(user.username, branch)).length,
    });
  }

  return statsByBranch;
}

export const STAFF_ROLE_LABELS: Record<number, string> = {
  4: 'Accountant',
  8: 'Receptionist',
  9: 'Proprietor',
  12: 'Librarian',
  13: 'Staff',
};

export async function listStaffForBranch(prisma: any, branchId: number) {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { id: true, name: true, code: true },
  });

  if (!branch) return [];

  const users = await prisma.user.findMany({
    where: { role: { in: STAFF_ROLES } },
    select: { id: true, username: true, role: true, photo: true, lastLogin: true, active: true },
    orderBy: { username: 'asc' },
  });

  return users
    .filter((user: any) => staffMatchesBranch(user.username, branch))
    .map((user: any) => ({
      id: user.id,
      username: user.username,
      role: user.role,
      roleLabel: STAFF_ROLE_LABELS[user.role] || 'Staff',
      photo: user.photo || null,
      lastLogin: user.lastLogin,
      active: user.active,
    }));
}

export default {
  STAFF_ROLES,
  STAFF_ROLE_LABELS,
  extractCodePrefix,
  staffMatchesBranch,
  getBranchStats,
  getBranchStatsMap,
  listStaffForBranch,
};
