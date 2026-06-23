/**
 * Dynamic Access Control helpers for Compound Teacher roles (Subject and Form/Class teacher).
 */

/**
 * Checks if the teacher is assigned to teach a specific subject in a class & section.
 * Used for Score Entry (Marks), Assignments Curation, and Online Tests.
 */
async function isSubjectTeacher(prisma, teacherId, classId, sectionId, subjectId) {
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
async function isFormTeacher(prisma, teacherId, classId, sectionId) {
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
async function hasClassAccess(prisma, teacherId, classId, sectionId) {
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

module.exports = {
  isSubjectTeacher,
  isFormTeacher,
  hasClassAccess
};
