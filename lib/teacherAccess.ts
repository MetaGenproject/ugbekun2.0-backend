/**
 * Dynamic Access Control helpers for Compound Teacher roles (Subject and Form/Class teacher).
 */

/**
 * Checks if the teacher is assigned to teach a specific subject in a class & section.
 * Used for Score Entry (Marks), Assignments Curation, and Online Tests.
 */
export async function isSubjectTeacher(
  prisma: any,
  teacherId: number | string | undefined | null,
  classId: number | string | undefined | null,
  sectionId: number | string | undefined | null,
  subjectId: number | string | undefined | null
): Promise<boolean> {
  if (!teacherId || !classId || !sectionId || !subjectId) return false;
  
  const assignment = await prisma.subjectAssign.findFirst({
    where: {
      teacherId: Number(teacherId),
      classId: Number(classId),
      sectionId: Number(sectionId),
      subjectId: Number(subjectId),
    },
    select: { id: true }
  });
  return !!assignment;
}

/**
 * Checks if the teacher is assigned as the Form / Class Teacher for a class & section.
 * Used for whole-class Attendance registers, Holistic Commentary, and Report Card Compilation.
 */
export async function isFormTeacher(
  prisma: any,
  teacherId: number | string | undefined | null,
  classId: number | string | undefined | null,
  sectionId: number | string | undefined | null
): Promise<boolean> {
  if (!teacherId || !classId || !sectionId) return false;

  const allocation = await prisma.teacherAllocation.findFirst({
    where: {
      teacherId: Number(teacherId),
      classId: Number(classId),
      sectionId: Number(sectionId),
    },
    select: { id: true }
  });
  return !!allocation;
}

/**
 * Checks if the teacher has any class relationship (either Subject Teacher or Form Teacher)
 * for a specific class & section. Used for Roster Inspection.
 */
export async function hasClassAccess(
  prisma: any,
  teacherId: number | string | undefined | null,
  classId: number | string | undefined | null,
  sectionId: number | string | undefined | null
): Promise<boolean> {
  if (!teacherId || !classId || !sectionId) return false;

  // 1. Check if Form Teacher
  const isForm = await isFormTeacher(prisma, teacherId, classId, sectionId);
  if (isForm) return true;

  // 2. Check if Subject Teacher (for any subject in this class & section)
  const assignment = await prisma.subjectAssign.findFirst({
    where: {
      teacherId: Number(teacherId),
      classId: Number(classId),
      sectionId: Number(sectionId),
    },
    select: { id: true }
  });
  return !!assignment;
}

export async function canTeacherUseClassSubject(
  prisma: any,
  teacherId: number | string | undefined | null,
  classId: number | string | undefined | null,
  subjectId: number | string | undefined | null
): Promise<boolean> {
  if (!teacherId || !classId || !subjectId) return false;

  const assignment = await prisma.subjectAssign.findFirst({
    where: {
      teacherId: Number(teacherId),
      classId: Number(classId),
      subjectId: Number(subjectId),
    },
    select: { id: true },
  });
  if (assignment) return true;

  const form = await prisma.teacherAllocation.findFirst({
    where: {
      teacherId: Number(teacherId),
      classId: Number(classId),
    },
    select: { id: true },
  });
  return !!form;
}

export async function getTeacherClassSubjectScope(
  prisma: any,
  teacherId: number | string | undefined | null
): Promise<Array<{ classId: number; subjectId: number }>> {
  if (!teacherId) return [];
  const assigns = await prisma.subjectAssign.findMany({
    where: { teacherId: Number(teacherId) },
    select: { classId: true, subjectId: true },
  });
  const seen = new Set<string>();
  return assigns.filter((row: { classId: number; subjectId: number }) => {
    const key = `${row.classId}:${row.subjectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function teacherScopedContentOr(
  prisma: any,
  teacherId: number | string | undefined | null
): Promise<any[]> {
  const pairs = await getTeacherClassSubjectScope(prisma, teacherId);
  const formRows = teacherId
    ? await prisma.teacherAllocation.findMany({
        where: { teacherId: Number(teacherId) },
        select: { classId: true },
      })
    : [];
  const formClassIds = Array.from(new Set(formRows.map((row: { classId: number }) => row.classId)));
  const or: any[] = [
    ...pairs.map((row) => ({ classId: row.classId, subjectId: row.subjectId })),
    ...formClassIds.map((classId) => ({ classId })),
  ];
  return or.length ? or : [{ id: -1 }];
}

export async function assertTeacherQuestionAccess(
  prisma: any,
  teacherId: number | string | undefined | null,
  item: { classId?: number | null; subjectId?: number | null; createdById?: number | null; branchId?: number | null } | null,
  branchId?: number
): Promise<boolean> {
  if (!teacherId || !item) return false;
  if (branchId && item.branchId && item.branchId !== branchId) return false;
  if (item.classId && item.subjectId) {
    return canTeacherUseClassSubject(prisma, teacherId, item.classId, item.subjectId);
  }
  if (item.classId) {
    const form = await prisma.teacherAllocation.findFirst({
      where: { teacherId: Number(teacherId), classId: Number(item.classId) },
      select: { id: true },
    });
    return !!form;
  }
  return item.createdById === Number(teacherId);
}

export default {
  isSubjectTeacher,
  isFormTeacher,
  hasClassAccess,
  canTeacherUseClassSubject,
  getTeacherClassSubjectScope,
  teacherScopedContentOr,
  assertTeacherQuestionAccess,
};
