const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

let globalPrisma = null;

function getPrismaInstance() {
  if (!globalPrisma) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    globalPrisma = new PrismaClient({ adapter });
  }
  return globalPrisma;
}

/**
 * Calculates risk levels and composite drift vector for a student.
 * @param {number} studentId 
 * @param {any} prismaClient Optional custom prisma client 
 */
async function calculateStudentAttritionRisk(studentId, prismaClient) {
  const prisma = prismaClient || getPrismaInstance();

  // 1. Fetch Student details with active enrollment
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      enrolls: {
        orderBy: { id: 'desc' },
        take: 1
      }
    }
  });

  if (!student) {
    throw new Error(`Student with ID ${studentId} not found.`);
  }

  const branchId = student.branchId || (student.enrolls[0]?.branchId) || 1;
  const sessionId = student.enrolls[0]?.sessionId || 1;

  // ───────────────────────────────────────────────────────────────────────────
  // A. Micro-Attendance Dip (R_att)
  // ───────────────────────────────────────────────────────────────────────────
  const allAttendances = await prisma.attendance.findMany({
    where: { studentId },
    select: { status: true, attendanceDate: true }
  });

  let R_att = 0.0;
  if (allAttendances.length > 0) {
    const mapStatus = (status) => {
      const s = status.toLowerCase();
      if (s === 'present') return 1.0;
      if (s === 'late') return 0.5;
      return 0.0; // Absent or other
    };

    const overallSum = allAttendances.reduce((acc, curr) => acc + mapStatus(curr.status), 0);
    const A_all = overallSum / allAttendances.length;

    // Filter last 14 days
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

    const recentAttendances = allAttendances.filter(att => new Date(att.attendanceDate) >= fourteenDaysAgo);

    if (recentAttendances.length > 0) {
      const recentSum = recentAttendances.reduce((acc, curr) => acc + mapStatus(curr.status), 0);
      const A_14 = recentSum / recentAttendances.length;

      // Drop in attendance
      R_att = Math.max(0, Math.min(1, (A_all - A_14) / 0.15));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // B. Continuous Assessment Velocity Decline (R_acad)
  // ───────────────────────────────────────────────────────────────────────────
  // Fetch Homework Submissions
  const hwSubmissions = await prisma.homeworkSubmission.findMany({
    where: { studentId, score: { not: null } },
    select: { score: true, createdAt: true }
  });

  // Fetch Online Exam Submissions
  const examSubmissions = await prisma.onlineExamSubmission.findMany({
    where: { studentId, totalMark: { not: null } },
    select: { totalMark: true, createdAt: true }
  });

  // Merge & sort by date desc
  const allGraded = [
    ...hwSubmissions.map(s => ({ score: s.score, date: new Date(s.createdAt) })),
    ...examSubmissions.map(s => ({ score: s.totalMark, date: new Date(s.createdAt) }))
  ].sort((a, b) => b.date - a.date);

  let R_acad = 0.0;
  if (allGraded.length > 0) {
    const baseAverage = allGraded.reduce((acc, curr) => acc + curr.score, 0) / allGraded.length;
    const recentSubmissions = allGraded.slice(0, 3);
    const recentAverage = recentSubmissions.reduce((acc, curr) => acc + curr.score, 0) / recentSubmissions.length;

    // Decline velocity
    R_acad = Math.max(0, Math.min(1, (baseAverage - recentAverage) / 25.0));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C. Household Fee Delinquency Backlog (R_fin)
  // ───────────────────────────────────────────────────────────────────────────
  const invoices = await prisma.invoice.findMany({
    where: { studentId },
    select: { totalAmount: true, balanceAmount: true, dueDate: true, status: true }
  });

  let R_fin = 0.0;
  if (invoices.length > 0) {
    const totalOutstanding = invoices.reduce((acc, curr) => acc + Number(curr.balanceAmount), 0);
    const totalFees = invoices.reduce((acc, curr) => acc + Number(curr.totalAmount), 0) || 50000;

    if (totalOutstanding > 0) {
      const unpaidInvoices = invoices.filter(inv => inv.status !== 'paid' && inv.status !== 'waived' && inv.dueDate);
      let maxOverdueDays = 0;
      const now = Date.now();

      unpaidInvoices.forEach(inv => {
        const dueTime = new Date(inv.dueDate).getTime();
        if (now > dueTime) {
          const overdue = Math.floor((now - dueTime) / (1000 * 60 * 60 * 24));
          if (overdue > maxOverdueDays) {
            maxOverdueDays = overdue;
          }
        }
      });

      const balanceRatio = Math.min(1, totalOutstanding / totalFees);
      const delayRatio = Math.min(1, maxOverdueDays / 45);
      R_fin = 0.5 * balanceRatio + 0.5 * delayRatio;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // D. Negative Narrative Commentary Spike (R_sent)
  // ───────────────────────────────────────────────────────────────────────────
  const commentaries = await prisma.studentCommentary.findMany({
    where: { studentId },
    select: { remark: true }
  });

  let R_sent = 0.0;
  if (commentaries.length > 0) {
    const negativeKeywords = [
      'struggle', 'failing', 'difficult', 'absent', 'poor', 'weak', 
      'distracted', 'unfocused', 'decline', 'below average', 
      'inattentive', 'behavioral', 'disruptive', 'careless', 'unsatisfactory'
    ];

    let negativeCount = 0;
    commentaries.forEach(c => {
      const text = (c.remark || '').toLowerCase();
      negativeKeywords.forEach(kw => {
        const regex = new RegExp(`\\b${kw}\\b`, 'g');
        const matches = text.match(regex);
        if (matches) {
          negativeCount += matches.length;
        }
      });
    });

    if (negativeCount >= 3) R_sent = 1.0;
    else if (negativeCount === 2) R_sent = 0.6;
    else if (negativeCount === 1) R_sent = 0.3;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // E. Composite Drift Vector (Ds)
  // ───────────────────────────────────────────────────────────────────────────
  const w_att = 0.25;
  const w_acad = 0.35;
  const w_fin = 0.20;
  const w_sent = 0.20;

  const compositeDrift = (w_att * R_att) + (w_acad * R_acad) + (w_fin * R_fin) + (w_sent * R_sent);

  let riskLevel = 'LOW';
  if (compositeDrift >= 0.70) {
    riskLevel = 'HIGH';
  } else if (compositeDrift >= 0.40) {
    riskLevel = 'MEDIUM';
  }

  // Calculate dynamic XP deduction: round((Ds - 0.70) * 1000)
  // Scaling bounds: -50 XP to -300 XP
  let xpDeduction = 0;
  if (compositeDrift >= 0.70) {
    const rawVal = Math.round((compositeDrift - 0.70) * 1000);
    xpDeduction = -Math.max(50, Math.min(300, rawVal));
  }

  return {
    studentId,
    branchId,
    sessionId,
    attendanceScore: R_att,
    academicScore: R_acad,
    financialScore: R_fin,
    sentimentScore: R_sent,
    compositeDrift,
    riskLevel,
    xpDeduction,
    isIsolated: compositeDrift >= 0.70
  };
}

module.exports = {
  calculateStudentAttritionRisk
};
