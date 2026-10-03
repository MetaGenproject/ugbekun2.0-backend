import { prisma } from '../lib/prisma';

async function repair() {
  console.log('=== STARTING PROMOTION & ENROLLMENT DATA REPAIR ===');

  const repairs = [
    // Branch 21 - Promoted from Basic 3 (107) to Basic 4 (108)
    { enrollId: 4922, studentId: 566, fromClassId: 107, name: 'Adoti Farhan' },
    { enrollId: 4923, studentId: 570, fromClassId: 107, name: 'Okonkwo Miracle' },
    { enrollId: 4925, studentId: 573, fromClassId: 107, name: 'Olonade Semilore' },
    { enrollId: 4927, studentId: 580, fromClassId: 107, name: 'Sanyingbe Victoria' },
    { enrollId: 4928, studentId: 640, fromClassId: 107, name: 'Omoyonma Joshua' },
    { enrollId: 5872, studentId: 3281, fromClassId: 107, name: 'MOLOLUWA ADEDOYIN' },

    // Branch 21 - Promoted from Basic 4 (108) to Basic 5 (109)
    { enrollId: 4937, studentId: 583, fromClassId: 108, name: 'Okorie Favour' },

    // Branch 40 - Promoted from JSS 2 (342) to JSS 3 (343)
    { enrollId: 7341, studentId: 4378, fromClassId: 342, name: 'Sabastine Chiamaka Emmanuella' },
    { enrollId: 7342, studentId: 4379, fromClassId: 342, name: 'Emmanuel Ifechukwu Dominic' },

    // Branch 40 - Promoted from JSS 1 (341) to JSS 2 (342)
    { enrollId: 7276, studentId: 4313, fromClassId: 341, name: 'Mirabel Ogechukwu' },
    { enrollId: 7277, studentId: 4314, fromClassId: 341, name: 'Marvel Jonah' },
    { enrollId: 7278, studentId: 4315, fromClassId: 341, name: 'Miracle Dominic' },
    { enrollId: 7279, studentId: 4316, fromClassId: 341, name: 'Ebube Okwe' },
    { enrollId: 7280, studentId: 4317, fromClassId: 341, name: 'Miracle Ogechukwu' },
    { enrollId: 7281, studentId: 4318, fromClassId: 341, name: 'Ifechukwu Christabel Ike' },
    { enrollId: 7282, studentId: 4319, fromClassId: 341, name: 'Elisha Ayakno' },
  ];

  for (const item of repairs) {
    const existing = await prisma.enroll.findUnique({ where: { id: item.enrollId } });
    if (existing) {
      console.log(`Reverting enroll ${item.enrollId} for ${item.name} (${item.studentId}) from class ${existing.classId} -> ${item.fromClassId}`);
      await prisma.enroll.update({
        where: { id: item.enrollId },
        data: {
          classId: item.fromClassId,
          updatedAt: new Date(),
        },
      });
    } else {
      console.warn(`Enrollment ${item.enrollId} not found!`);
    }
  }

  console.log('\n=== VERIFYING BASIC 4 (108) ENROLLMENTS (BRANCH 21) ===');
  const b4All = await prisma.enroll.findMany({
    where: { branchId: 21, classId: 108 },
    include: { student: { select: { firstName: true, lastName: true } } },
    orderBy: { id: 'asc' },
  });

  const b4Active = b4All.filter(e => e.isAlumni === 0);
  console.log(`Basic 4 total enrollments: ${b4All.length}`);
  console.log(`Basic 4 active (non-alumni) enrollments: ${b4Active.length}`);
  for (const e of b4Active) {
    console.log(`  - enrollId: ${e.id}, studentId: ${e.studentId} (${e.student?.firstName} ${e.student?.lastName}), session: ${e.sessionId}`);
  }

  console.log('\n=== VERIFYING BASIC 3 (107) ENROLLMENTS (BRANCH 21) ===');
  const b3All = await prisma.enroll.findMany({
    where: { branchId: 21, classId: 107 },
    include: { student: { select: { firstName: true, lastName: true } } },
    orderBy: { id: 'asc' },
  });
  console.log(`Basic 3 total enrollments: ${b3All.length}`);

  console.log('\n=== VERIFYING JSS 2 (342) ENROLLMENTS (BRANCH 40) ===');
  const jss2Active = await prisma.enroll.findMany({
    where: { branchId: 40, classId: 342, isAlumni: 0 },
    include: { student: { select: { firstName: true, lastName: true } } },
  });
  console.log(`JSS 2 active enrollments: ${jss2Active.length}`);
  for (const e of jss2Active) {
    console.log(`  - enrollId: ${e.id}, studentId: ${e.studentId} (${e.student?.firstName} ${e.student?.lastName}), session: ${e.sessionId}`);
  }

  console.log('\n=== VERIFYING JSS 3 (343) ENROLLMENTS (BRANCH 40) ===');
  const jss3Active = await prisma.enroll.findMany({
    where: { branchId: 40, classId: 343, isAlumni: 0 },
    include: { student: { select: { firstName: true, lastName: true } } },
  });
  console.log(`JSS 3 active enrollments: ${jss3Active.length}`);
  for (const e of jss3Active) {
    console.log(`  - enrollId: ${e.id}, studentId: ${e.studentId} (${e.student?.firstName} ${e.student?.lastName}), session: ${e.sessionId}`);
  }

  console.log('\nData repair completed successfully!');
}

repair()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
