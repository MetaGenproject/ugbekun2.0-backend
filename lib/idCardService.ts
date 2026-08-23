import crypto from 'crypto';

/**
 * Generates a unique, sequential card number for a branch.
 * Format: IDC/<BRANCH_CODE>/<YEAR>/<SEQUENCE> (e.g., IDC/MTGA/2026/0001)
 */
export async function generateCardNumber(prisma: any, branchId: number, entityType?: string): Promise<string> {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { code: true },
  });

  const branchCode = (branch?.code || 'GEN').toUpperCase();
  const year = new Date().getFullYear();
  const prefix = `IDC/${branchCode}/${year}/`;

  const highestCard = await prisma.idCard.findFirst({
    where: {
      cardNumber: {
        startsWith: prefix,
      },
    },
    orderBy: {
      cardNumber: 'desc',
    },
    select: {
      cardNumber: true,
    },
  });

  let nextSequence = 1;
  if (highestCard?.cardNumber) {
    const parts = highestCard.cardNumber.split('/');
    const lastPart = parts[parts.length - 1];
    const currentSequence = parseInt(lastPart, 10);
    if (!isNaN(currentSequence)) {
      nextSequence = currentSequence + 1;
    }
  }

  const paddedSequence = String(nextSequence).padStart(4, '0');
  return `${prefix}${paddedSequence}`;
}

/**
 * Generates a unique, sequential certificate number for a branch.
 * Format: CERT/<BRANCH_CODE>/<YEAR>/<SEQUENCE> (e.g., CERT/MTGA/2026/0001)
 */
export async function generateCertificateNumber(prisma: any, branchId: number): Promise<string> {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { code: true },
  });

  const branchCode = (branch?.code || 'GEN').toUpperCase();
  const year = new Date().getFullYear();
  const prefix = `CERT/${branchCode}/${year}/`;

  const highestCert = await prisma.certificate.findFirst({
    where: {
      certificateNo: {
        startsWith: prefix,
      },
    },
    orderBy: {
      certificateNo: 'desc',
    },
    select: {
      certificateNo: true,
    },
  });

  let nextSequence = 1;
  if (highestCert?.certificateNo) {
    const parts = highestCert.certificateNo.split('/');
    const lastPart = parts[parts.length - 1];
    const currentSequence = parseInt(lastPart, 10);
    if (!isNaN(currentSequence)) {
      nextSequence = currentSequence + 1;
    }
  }

  const paddedSequence = String(nextSequence).padStart(4, '0');
  return `${prefix}${paddedSequence}`;
}

/**
 * Provisions a student ID card.
 */
export async function provisionStudentIdCard(
  prisma: any,
  { studentId, branchId, sessionId }: { studentId: number; branchId: number; sessionId?: number | null }
) {
  // Check if student exists
  const student = await prisma.student.findUnique({
    where: { id: studentId },
  });
  if (!student) throw new Error('Student not found');

  // Expire or deactivate any previous active card for this student
  await prisma.idCard.updateMany({
    where: {
      studentId,
      status: 'active',
    },
    data: {
      status: 'expired',
      expiresAt: new Date(),
    },
  });

  const verifyToken = crypto.randomUUID();
  const cardNumber = await generateCardNumber(prisma, branchId, 'student');

  const card = await prisma.idCard.create({
    data: {
      entityType: 'student',
      cardNumber,
      verifyToken,
      status: 'active',
      studentId,
      branchId,
      sessionId,
    },
  });

  // Also update student record's idCardToken and idCardStatus fields for compatibility
  await prisma.student.update({
    where: { id: studentId },
    data: {
      idCardToken: verifyToken,
      idCardStatus: 'active',
    },
  });

  return card;
}

/**
 * Provisions a staff/teacher ID card.
 */
export async function provisionStaffIdCard(
  prisma: any,
  { userId, branchId, sessionId }: { userId: number; branchId: number; sessionId?: number | null }
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!user) throw new Error('User profile not found');

  // Deactivate previous active card for this user
  await prisma.idCard.updateMany({
    where: {
      userId,
      status: 'active',
    },
    data: {
      status: 'expired',
      expiresAt: new Date(),
    },
  });

  const verifyToken = crypto.randomUUID();
  const cardNumber = await generateCardNumber(prisma, branchId, 'staff');

  return prisma.idCard.create({
    data: {
      entityType: 'staff',
      cardNumber,
      verifyToken,
      status: 'active',
      userId,
      branchId,
      sessionId,
    },
  });
}

/**
 * Provisions an academic certificate.
 */
export async function provisionCertificate(
  prisma: any,
  {
    studentId,
    certificateType,
    title,
    description,
    branchId,
    sessionId,
  }: {
    studentId: number;
    certificateType: string;
    title: string;
    description?: string | null;
    branchId: number;
    sessionId?: number | null;
  }
) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
  });
  if (!student) throw new Error('Student not found');

  const verifyToken = crypto.randomUUID();
  const certificateNo = await generateCertificateNumber(prisma, branchId);

  return prisma.certificate.create({
    data: {
      studentId,
      certificateType,
      verifyToken,
      certificateNo,
      title,
      description,
      branchId,
      sessionId,
    },
  });
}

/**
 * Revokes an ID card.
 */
export async function revokeIdCard(prisma: any, cardId: number, reason?: string) {
  const card = await prisma.idCard.update({
    where: { id: cardId },
    data: {
      status: 'revoked',
      revokedAt: new Date(),
      revokedReason: reason,
    },
  });

  // If it was a student ID card, also update the compatibility field
  if (card.studentId) {
    await prisma.student.update({
      where: { id: card.studentId },
      data: {
        idCardStatus: 'revoked',
      },
    });
  }

  return card;
}

/**
 * Bulk provisions ID cards for all active students in a class/section.
 */
export async function batchProvisionStudentIdCards(
  prisma: any,
  {
    classId,
    sectionId,
    branchId,
    sessionId,
  }: { classId: number; sectionId: number; branchId: number; sessionId?: number | null }
) {
  // Fetch active students in class/section
  const enrolls = await prisma.enroll.findMany({
    where: {
      classId,
      sectionId,
      branchId,
      sessionId,
      student: {
        active: true,
      },
    },
    select: {
      studentId: true,
    },
  });

  const results = [];
  for (const enroll of enrolls) {
    try {
      const card = await provisionStudentIdCard(prisma, {
        studentId: enroll.studentId,
        branchId,
        sessionId,
      });
      results.push({ studentId: enroll.studentId, success: true, cardId: card.id });
    } catch (err: any) {
      results.push({ studentId: enroll.studentId, success: false, error: err.message });
    }
  }

  return results;
}

export default {
  provisionStudentIdCard,
  provisionStaffIdCard,
  provisionCertificate,
  revokeIdCard,
  batchProvisionStudentIdCards,
};
