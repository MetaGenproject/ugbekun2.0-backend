/**
 * Dynamic Access Control helpers for Compound Teacher roles (Subject and Form/Class teacher).
 * Follows Ugbekun 2.0 Class Teacher & Subject Teacher Assignment System specification.
 */

/**
 * Checks if the teacher is specifically assigned as a Subject Teacher
 * for a subject in a class & section.
 */
export async function isSubjectTeacher(
  prisma: any,
  teacherId: number | string | undefined | null,
  classId: number | string | undefined | null,
  sectionId?: number | string | undefined | null,
  subjectId?: number | string | undefined | null,
  req?: any
): Promise<boolean> {
  if (req && (req.isAdmin || req.userRole === 1 || req.userRole === 2)) return true;
  if (!teacherId || !classId) return false;

  // Class Teachers automatically have access to subjects in their assigned class
  const isForm = await isFormTeacher(prisma, teacherId, classId, sectionId, req);
  if (isForm) return true;
  
  const where: any = {
    teacherId: Number(teacherId),
    classId: Number(classId),
  };
  if (sectionId) where.sectionId = Number(sectionId);
  if (subjectId) where.subjectId = Number(subjectId);

  const assignment = await prisma.subjectAssign.findFirst({
    where,
    select: { id: true }
  });
  return !!assignment;
}

/**
 * Checks if the teacher is assigned as the Form / Class Teacher for a class & section.
 * Class Teachers automatically have access to all students and all subjects offered by that class.
 */
export async function isFormTeacher(
  prisma: any,
  teacherId: number | string | undefined | null,
  classId: number | string | undefined | null,
  sectionId?: number | string | undefined | null,
  req?: any
): Promise<boolean> {
  if (req && (req.isAdmin || req.userRole === 1 || req.userRole === 2)) return true;
  if (!teacherId || !classId) return false;

  const where: any = {
    teacherId: Number(teacherId),
    classId: Number(classId),
  };
  if (sectionId) where.sectionId = Number(sectionId);

  const allocation = await prisma.teacherAllocation.findFirst({
    where,
    select: { id: true }
  });
  return !!allocation;
}

/**
 * Checks if the teacher has any class relationship (either Class Teacher or Subject Teacher)
 * for a specific class & section. Used for Roster Inspection, Class Directory, etc.
 */
export async function hasClassAccess(
  prisma: any,
  teacherId: number | string | undefined | null,
  classId: number | string | undefined | null,
  sectionId?: number | string | undefined | null,
  req?: any
): Promise<boolean> {
  if (req && (req.isAdmin || req.userRole === 1 || req.userRole === 2)) return true;
  if (!teacherId || !classId) return false;

  // 1. Check if Class Teacher (Form Teacher)
  const isForm = await isFormTeacher(prisma, teacherId, classId, sectionId, req);
  if (isForm) return true;

  // 2. Check if Subject Teacher (for any subject in this class & section)
  const where: any = {
    teacherId: Number(teacherId),
    classId: Number(classId),
  };
  if (sectionId) where.sectionId = Number(sectionId);

  const assignment = await prisma.subjectAssign.findFirst({
    where,
    select: { id: true }
  });
  return !!assignment;
}

/**
 * Checks if a teacher is authorized to access, grade, or enter scores for a specific subject in a class.
 * RULE:
 * 1. Admin -> Full access.
 * 2. Class Teacher -> Automatically authorized for ALL subjects offered by that class.
 * 3. Subject Teacher -> Authorized ONLY for subjects specifically assigned to them in that class.
 * 4. Otherwise -> Denied.
 */
export async function canTeacherAccessSubject(
  prisma: any,
  teacherId: number | string | undefined | null,
  classId: number | string | undefined | null,
  sectionId: number | string | undefined | null,
  subjectId: number | string | undefined | null,
  sessionId?: number | string | undefined | null,
  req?: any
): Promise<boolean> {
  if (req && (req.isAdmin || req.userRole === 1 || req.userRole === 2)) return true;
  if (!teacherId || !classId || !subjectId) return false;

  const tId = Number(teacherId);
  const cId = Number(classId);
  const subId = Number(subjectId);
  const secId = sectionId ? Number(sectionId) : null;

  // 1. Check if Class Teacher of this class
  const isClassTeacher = await isFormTeacher(prisma, tId, cId, secId || undefined, req);
  if (isClassTeacher) {
    // Confirm this subject is actually allocated to / offered by this class
    const offeredWhere: any = {
      classId: cId,
      subjectId: subId,
    };
    if (secId) {
      offeredWhere.OR = [
        { sectionId: secId },
        { sectionId: null },
        { sectionId: 0 },
      ];
    }

    const offered = await prisma.subjectAssign.findFirst({
      where: offeredWhere,
      select: { id: true },
    });
    if (offered) return true;
  }

  // 2. Check if specifically assigned as Subject Teacher for this subject & class
  const subjAssignWhere: any = {
    teacherId: tId,
    classId: cId,
    subjectId: subId,
  };
  if (secId) subjAssignWhere.sectionId = secId;

  const directAssignment = await prisma.subjectAssign.findFirst({
    where: subjAssignWhere,
    select: { id: true },
  });
  if (directAssignment) return true;

  return false;
}

export async function canTeacherUseClassSubject(
  prisma: any,
  teacherId: number | string | undefined | null,
  classId: number | string | undefined | null,
  subjectId: number | string | undefined | null
): Promise<boolean> {
  return canTeacherAccessSubject(prisma, teacherId, classId, null, subjectId);
}

/**
 * Returns comprehensive overview of teacher's roles and scopes:
 * - Classes where teacher is Class Teacher (with all subjects offered)
 * - Classes and subjects where teacher is Subject Teacher
 */
export async function getTeacherAcademicRoles(
  prisma: any,
  teacherId: number | string | undefined | null,
  branchId?: number | null,
  sessionId?: number | null
) {
  if (!teacherId) {
    return {
      isClassTeacher: false,
      isSubjectTeacher: false,
      classTeacherClasses: [],
      subjectTeacherSubjects: [],
    };
  }

  const tId = Number(teacherId);

  // 1. Fetch Class Teacher Allocations
  const formAllocations = await prisma.teacherAllocation.findMany({
    where: {
      teacherId: tId,
      ...(branchId ? { branchId } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
    include: {
      class: { select: { id: true, name: true, isEcd: true } },
      section: { select: { id: true, name: true } },
    },
  });

  // For each class teacher allocation, fetch all subjects offered by that class
  const classTeacherClasses = await Promise.all(
    formAllocations.map(async (fa: any) => {
      const offeredSubjects = await prisma.subjectAssign.findMany({
        where: {
          classId: fa.classId,
          sectionId: fa.sectionId,
          ...(branchId ? { branchId } : {}),
        },
        include: {
          subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } },
          teacher: { select: { id: true, name: true } },
        },
      });

      const studentCount = await prisma.enroll.count({
        where: {
          classId: fa.classId,
          sectionId: fa.sectionId,
          isAlumni: 0,
          ...(branchId ? { branchId } : {}),
        },
      });

      return {
        allocationId: fa.id,
        classId: fa.classId,
        className: fa.class?.name || 'Class',
        sectionId: fa.sectionId,
        sectionName: fa.section?.name || 'Section',
        studentCount,
        subjectsOffered: offeredSubjects.map((os: any) => ({
          assignmentId: os.id,
          subjectId: os.subject?.id || os.subjectId,
          subjectName: os.subject?.name || 'Subject',
          subjectCode: os.subject?.subjectCode || 'N/A',
          subjectType: os.subject?.subjectType || 'Mandatory',
          assignedTeacherId: os.teacherId,
          assignedTeacherName: os.teacher?.name || 'Covered by Class Teacher',
        })),
      };
    })
  );

  // Pairs of (classId, sectionId) where this teacher is already Class Teacher
  const classTeacherClassSectionPairs = new Set(
    formAllocations.map((fa: any) => `${fa.classId}:${fa.sectionId || 0}`)
  );

  // 2. Fetch Direct Subject Teacher Assignments
  const rawSubjectAssignments = await prisma.subjectAssign.findMany({
    where: {
      teacherId: tId,
      ...(branchId ? { branchId } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
    include: {
      class: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } },
    },
  });

  // Only exclude subject assignments where they are already the Class Teacher for that exact class & section
  const subjectAssignments = rawSubjectAssignments.filter((sa: any) => {
    const pairKey = `${sa.classId}:${sa.sectionId || 0}`;
    return !classTeacherClassSectionPairs.has(pairKey);
  });

  // Group by Subject for "My Teaching" view (Step 8 & 10)
  const subjectMap = new Map<number, {
    subjectId: number;
    subjectName: string;
    subjectCode: string;
    classes: Array<{
      assignmentId: number;
      classId: number;
      className: string;
      sectionId: number;
      sectionName: string;
      studentCount: number;
    }>;
  }>();

  for (const sa of subjectAssignments) {
    const sId = sa.subjectId;
    if (!subjectMap.has(sId)) {
      subjectMap.set(sId, {
        subjectId: sId,
        subjectName: sa.subject?.name || 'Subject',
        subjectCode: sa.subject?.subjectCode || 'N/A',
        classes: [],
      });
    }

    const studentCount = await prisma.enroll.count({
      where: {
        classId: sa.classId,
        sectionId: sa.sectionId,
        isAlumni: 0,
        ...(branchId ? { branchId } : {}),
      },
    });

    subjectMap.get(sId)!.classes.push({
      assignmentId: sa.id,
      classId: sa.classId,
      className: sa.class?.name || 'Class',
      sectionId: sa.sectionId,
      sectionName: sa.section?.name || 'Section',
      studentCount,
    });
  }

  const subjectTeacherSubjects = Array.from(subjectMap.values());

  return {
    isClassTeacher: classTeacherClasses.length > 0,
    isSubjectTeacher: subjectTeacherSubjects.length > 0,
    classTeacherClasses,
    subjectTeacherSubjects,
  };
}

export async function getTeacherClassSubjectScope(
  prisma: any,
  teacherId: number | string | undefined | null
): Promise<Array<{ classId: number; subjectId: number }>> {
  if (!teacherId) return [];
  const tId = Number(teacherId);

  // 1. Direct subject assignments
  const assigns = await prisma.subjectAssign.findMany({
    where: { teacherId: tId },
    select: { classId: true, subjectId: true },
  });

  // 2. Class teacher subjects
  const formRows = await prisma.teacherAllocation.findMany({
    where: { teacherId: tId },
    select: { classId: true, sectionId: true },
  });

  const formSubjects = formRows.length > 0
    ? await prisma.subjectAssign.findMany({
        where: {
          OR: formRows.map((r: any) => ({ classId: r.classId, sectionId: r.sectionId })),
        },
        select: { classId: true, subjectId: true },
      })
    : [];

  const allPairs = [...assigns, ...formSubjects];
  const seen = new Set<string>();
  return allPairs.filter((row: { classId: number; subjectId: number }) => {
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
    return canTeacherAccessSubject(prisma, teacherId, item.classId, null, item.subjectId);
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
  canTeacherAccessSubject,
  canTeacherUseClassSubject,
  getTeacherAcademicRoles,
  getTeacherClassSubjectScope,
  teacherScopedContentOr,
  assertTeacherQuestionAccess,
};
