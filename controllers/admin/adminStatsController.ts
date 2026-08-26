import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { getBranchStats } from '../../lib/branchStats';

/**
 * GET /api/admin/stats
 * Branch-scoped counts for the logged-in branch admin dashboard.
 */
export async function getStats(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  try {
    const stats = await getBranchStats(prisma, branchId);
    if (!stats) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found for this admin account.',
      });
    }

    return res.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('[ADMIN] Stats error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load branch stats.',
    });
  }
}

export const getAdminStats = getStats;

/**
 * GET /api/admin/gamification/config
 */
export async function getGamificationConfig(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  try {
    let config = await prisma.gamificationConfig.findUnique({
      where: { branchId },
    });

    if (!config) {
      config = {
        weeklyMintLimit: 5000,
        termStartDate: null,
      } as any;
    }

    return res.json({ success: true, config });
  } catch (error) {
    console.error('[ADMIN] Get gamification config error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve gamification config.' });
  }
}

/**
 * POST /api/admin/gamification/config
 */
export async function saveGamificationConfig(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { weeklyMintLimit, termStartDate } = req.body;
  try {
    const config = await prisma.gamificationConfig.upsert({
      where: { branchId },
      update: {
        weeklyMintLimit: Number(weeklyMintLimit),
        termStartDate: termStartDate ? new Date(termStartDate) : null,
      },
      create: {
        branchId,
        weeklyMintLimit: Number(weeklyMintLimit),
        termStartDate: termStartDate ? new Date(termStartDate) : null,
      },
    });

    return res.json({ success: true, message: 'Gamification config successfully saved.', config });
  } catch (error) {
    console.error('[ADMIN] Save gamification config error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save gamification config.' });
  }
}

/**
 * GET /api/admin/reports/staff-activities
 */
export async function getStaffActivitiesReport(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const activities: any[] = [];

    // 1. Fetch Lesson Plans (up to 30)
    const lessonPlans = await prisma.lessonPlan.findMany({
      where: {
        teacher: { branchId },
      },
      take: 30,
      orderBy: { createdAt: 'desc' },
      include: {
        teacher: { select: { name: true } },
        class: { select: { name: true } },
        subject: { select: { name: true } },
      },
    });

    for (const lp of lessonPlans) {
      activities.push({
        id: `lp-${lp.id}`,
        type: 'LESSON_PLAN',
        category: 'Instructional',
        description: `Lesson plan created for Class ${lp.class?.name || ''} - ${lp.subject?.name || ''} on "${lp.coreTopic}"`,
        staffName: lp.teacher?.name || 'Staff',
        staffRole: 'Teacher',
        timestamp: lp.createdAt,
      });
    }

    // 2. Fetch Student Commentaries (up to 30)
    const commentaries = await prisma.studentCommentary.findMany({
      where: { branchId },
      take: 30,
      orderBy: { updatedAt: 'desc' },
      include: {
        student: { select: { firstName: true, lastName: true } },
      },
    });

    for (const comm of commentaries) {
      activities.push({
        id: `comm-${comm.id}`,
        type: 'COMMENTARY',
        category: 'Academic Remarks',
        description: `Holistic report card commentary updated for ${comm.student.firstName} ${comm.student.lastName} (Status: ${comm.status})`,
        staffName: 'Form Teacher',
        staffRole: 'Teacher',
        timestamp: comm.updatedAt || comm.createdAt,
      });
    }

    // 3. Fetch ID Cards (up to 30)
    const idCards = await prisma.idCard.findMany({
      where: { branchId },
      take: 30,
      orderBy: { createdAt: 'desc' },
      include: {
        student: { select: { firstName: true, lastName: true } },
        user: { select: { username: true } },
      },
    });

    for (const card of idCards) {
      const recipient =
        card.entityType === 'student' && card.student
          ? `${card.student.firstName} ${card.student.lastName}`
          : card.user
          ? card.user.username
          : 'Staff';

      activities.push({
        id: `idcard-${card.id}`,
        type: 'IDCARD',
        category: 'Administration',
        description: `Identity card provisioned (Card No: ${card.cardNumber}, Recipient: ${recipient}, Status: ${card.status})`,
        staffName: 'Admin Desk',
        staffRole: 'Branch Admin/Staff',
        timestamp: card.createdAt,
      });
    }

    // 4. Fetch Certificates (up to 30)
    const certs = await prisma.certificate.findMany({
      where: { branchId },
      take: 30,
      orderBy: { createdAt: 'desc' },
      include: {
        student: { select: { firstName: true, lastName: true } },
      },
    });

    for (const cert of certs) {
      activities.push({
        id: `cert-${cert.id}`,
        type: 'CERTIFICATE',
        category: 'Administration',
        description: `Academic Certificate issued (${cert.title} to ${cert.student.firstName} ${cert.student.lastName})`,
        staffName: 'Admin Desk',
        staffRole: 'Branch Admin/Staff',
        timestamp: cert.createdAt,
      });
    }

    // 5. Fetch Invoices (up to 30)
    const invoices = await prisma.invoice.findMany({
      where: { branchId },
      take: 30,
      orderBy: { createdAt: 'desc' },
      include: {
        student: { select: { firstName: true, lastName: true } },
      },
    });

    for (const inv of invoices) {
      activities.push({
        id: `invoice-${inv.id}`,
        type: 'INVOICE',
        category: 'Finance',
        description: `Invoice ${inv.invoiceNo} raised for ${inv.student.firstName} ${inv.student.lastName} (Amount: ₦${inv.totalAmount}, Status: ${inv.status})`,
        staffName: 'Accountant Desk',
        staffRole: 'Accountant/Staff',
        timestamp: inv.createdAt,
      });
    }

    // 6. Fetch Payments (up to 30)
    const payments = await prisma.payment.findMany({
      where: { branchId },
      take: 30,
      orderBy: { createdAt: 'desc' },
      include: {
        invoice: {
          include: {
            student: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    for (const pay of payments) {
      let collectorName = 'Accountant Desk';
      if (pay.receivedBy) {
        const user = await prisma.user.findUnique({
          where: { id: pay.receivedBy },
          select: { username: true },
        });
        if (user) {
          collectorName = user.username;
        }
      }

      const payer =
        pay.invoice && pay.invoice.student
          ? `${pay.invoice.student.firstName} ${pay.invoice.student.lastName}`
          : 'Student';

      activities.push({
        id: `payment-${pay.id}`,
        type: 'PAYMENT',
        category: 'Finance',
        description: `Payment of ₦${pay.amount} received via ${pay.method} for ${payer} (Ref: ${pay.reference || 'N/A'})`,
        staffName: collectorName,
        staffRole: 'Finance Collector',
        timestamp: pay.createdAt,
      });
    }

    // 7. Fetch Attendance Records Grouped (up to 30)
    const attendanceRecords = await prisma.attendance.findMany({
      where: { branchId },
      take: 50,
      orderBy: { createdAt: 'desc' },
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
    });

    const seenAttendance = new Set();
    for (const att of attendanceRecords) {
      const dateStr = new Date(att.attendanceDate).toISOString().split('T')[0];
      const key = `${att.classId}-${att.sectionId}-${dateStr}`;
      if (!seenAttendance.has(key)) {
        seenAttendance.add(key);
        activities.push({
          id: `att-${att.id}`,
          type: 'ATTENDANCE',
          category: 'Instructional',
          description: `Attendance register submitted for Class ${att.class.name} Section ${att.section.name} on date ${dateStr}`,
          staffName: 'Form Teacher',
          staffRole: 'Teacher',
          timestamp: att.createdAt,
        });
      }
    }

    // 8. Fetch Marks Entered/Updated Grouped (up to 30)
    const marksRecords = await prisma.mark.findMany({
      where: { branchId },
      take: 100,
      orderBy: { id: 'desc' },
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
        subject: { select: { name: true } },
        exam: { select: { name: true } },
      },
    });

    const seenMarks = new Set();
    for (const m of marksRecords) {
      const key = `${m.classId}-${m.sectionId}-${m.subjectId}-${m.examId}`;
      if (!seenMarks.has(key)) {
        seenMarks.add(key);
        activities.push({
          id: `mark-${m.id}`,
          type: 'MARKS',
          category: 'Academic Grading',
          description: `Student grades entered/updated for ${m.class.name} Section ${m.section.name} in "${m.subject.name}" (${m.exam.name})`,
          staffName: 'Subject Teacher',
          staffRole: 'Teacher',
          timestamp: new Date(),
        });
      }
    }

    activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return res.json({ success: true, activities: activities.slice(0, 50) });
  } catch (error: any) {
    console.error('[ADMIN] Staff activity report error:', error);
    return res
      .status(500)
      .json({ success: false, message: error.message || 'Failed to compile staff activity report.' });
  }
}

/**
 * GET /api/admin/reports/comprehensive
 * Returns aggregated data for all 6 report categories scoped to the branch
 */
export async function getComprehensiveReport(req: Request, res: Response): Promise<Response | void> {
  const bid = req.branchId;

  try {
    const [officeTxs, payments, enrolls, allClasses, attendanceRecords, marks, libraryResources, libraryIssues, invoices] =
      await Promise.all([
        prisma.officeTransaction.findMany({ where: { branchId: bid } }),
        prisma.payment.findMany({ where: { branchId: bid } }),
        prisma.enroll.findMany({
          where: { branchId: bid },
          include: {
            student: { select: { id: true, firstName: true, lastName: true, gender: true, active: true } },
            class: { select: { id: true, name: true } },
          },
        }),
        prisma.class.findMany({ where: { branchId: bid }, select: { id: true, name: true } }),
        prisma.attendance.findMany({ where: { branchId: bid } }),
        prisma.mark.findMany({
          where: { branchId: bid },
          select: { id: true, classId: true, mark: true, cbtMark: true, absent: true },
        }),
        prisma.libraryResource.findMany({ where: { branchId: bid } }),
        prisma.libraryIssue.findMany({ where: { branchId: bid } }),
        prisma.invoice.findMany({ where: { branchId: bid }, include: { items: true } }),
      ]);

    // 1. Income & Expenses
    const totalFeeIncome = payments.reduce((acc: number, p: any) => acc + Number(p.amount), 0);
    const totalOfficeIncome = officeTxs
      .filter((t: any) => t.type === 'INCOME')
      .reduce((acc: number, t: any) => acc + Number(t.amount), 0);
    const totalExpenses = officeTxs
      .filter((t: any) => t.type === 'EXPENSE')
      .reduce((acc: number, t: any) => acc + Number(t.amount), 0);
    const totalIncome = totalFeeIncome + totalOfficeIncome;
    const netSurplus = totalIncome - totalExpenses;

    const expenseByHead: Record<string, number> = {};
    for (const t of officeTxs.filter((x: any) => x.type === 'EXPENSE')) {
      const head = t.voucherHeadName || 'General';
      expenseByHead[head] = (expenseByHead[head] || 0) + Number(t.amount);
    }

    // 2. Fees
    const totalInvoiced = invoices.reduce((acc: number, inv: any) => acc + Number(inv.totalAmount), 0);
    const totalCollected = invoices.reduce((acc: number, inv: any) => acc + Number(inv.paidAmount), 0);
    const totalOutstanding = invoices.reduce((acc: number, inv: any) => acc + Number(inv.balanceAmount), 0);
    const collectionRate = totalInvoiced > 0 ? ((totalCollected / totalInvoiced) * 100).toFixed(1) : '0.0';

    const feeTypeMap: Record<string, number> = {};
    for (const inv of invoices) {
      for (const item of inv.items) {
        feeTypeMap[item.description] = (feeTypeMap[item.description] || 0) + Number(item.amount);
      }
    }

    const classFeeMap: Record<string, any> = {};
    for (const e of enrolls) {
      const cName = e.class?.name || 'Unknown';
      if (!classFeeMap[cName]) classFeeMap[cName] = { invoiced: 0, collected: 0, outstanding: 0, count: 0 };
      classFeeMap[cName].count += 1;
    }

    // 3. Students
    const totalStudents = new Set(enrolls.map((e: any) => e.studentId)).size;
    const activeStudents = enrolls.filter((e: any) => e.student?.active).length;
    const maleCount = enrolls.filter((e: any) => (e.student?.gender || '').toLowerCase() === 'male').length;
    const femaleCount = enrolls.filter((e: any) => (e.student?.gender || '').toLowerCase() === 'female').length;

    const classByClassStudents = allClasses
      .map((c: any) => {
        const classEnrolls = enrolls.filter((e: any) => e.classId === c.id);
        const activeInClass = classEnrolls.filter((e: any) => e.student?.active).length;
        return {
          className: c.name,
          total: classEnrolls.length,
          active: activeInClass,
          male: classEnrolls.filter((e: any) => (e.student?.gender || '').toLowerCase() === 'male').length,
          female: classEnrolls.filter((e: any) => (e.student?.gender || '').toLowerCase() === 'female').length,
        };
      })
      .sort((a: any, b: any) => b.total - a.total);

    // 4. Attendance
    const totalAttendanceRecords = attendanceRecords.length;
    const presentCount = attendanceRecords.filter((a: any) => a.status === 'Present').length;
    const absentCount = attendanceRecords.filter((a: any) => a.status === 'Absent').length;
    const lateCount = attendanceRecords.filter((a: any) => a.status === 'Late').length;
    const attendanceRate =
      totalAttendanceRecords > 0 ? ((presentCount / totalAttendanceRecords) * 100).toFixed(1) : '0.0';

    const classAttendanceMap: Record<string, any> = {};
    for (const a of attendanceRecords) {
      const c = allClasses.find((cl: any) => cl.id === a.classId);
      const key = c ? c.name : 'Unknown';
      if (!classAttendanceMap[key]) classAttendanceMap[key] = { total: 0, present: 0 };
      classAttendanceMap[key].total += 1;
      if (a.status === 'Present') classAttendanceMap[key].present += 1;
    }
    const classByClassAttendance = Object.entries(classAttendanceMap)
      .map(([className, d]: [string, any]) => ({
        className,
        total: d.total,
        present: d.present,
        rate: d.total > 0 ? ((d.present / d.total) * 100).toFixed(1) : '0.0',
      }))
      .sort((a: any, b: any) => parseFloat(b.rate) - parseFloat(a.rate));

    // 5. Examinations
    const marksWithValues = marks.filter((m: any) => m.mark && !isNaN(parseFloat(m.mark)));
    const totalMarksRecorded = marksWithValues.length;
    const allScores = marksWithValues.map((m: any) => parseFloat(m.mark));
    const avgScore =
      allScores.length > 0 ? (allScores.reduce((a: number, b: number) => a + b, 0) / allScores.length).toFixed(1) : '0.0';

    let gradeA = 0,
      gradeB = 0,
      gradeC = 0,
      gradeD = 0,
      gradeF = 0;
    for (const score of allScores) {
      if (score >= 70) gradeA++;
      else if (score >= 60) gradeB++;
      else if (score >= 50) gradeC++;
      else if (score >= 40) gradeD++;
      else gradeF++;
    }

    const classMarkMap: Record<string, any> = {};
    for (const m of marksWithValues) {
      const c = allClasses.find((cl: any) => cl.id === m.classId);
      const key = c ? c.name : 'Unknown';
      if (!classMarkMap[key]) classMarkMap[key] = { total: 0, sum: 0 };
      classMarkMap[key].total += 1;
      classMarkMap[key].sum += parseFloat(m.mark);
    }
    const classByClassExam = Object.entries(classMarkMap)
      .map(([className, d]: [string, any]) => ({
        className,
        total: d.total,
        average: d.total > 0 ? (d.sum / d.total).toFixed(1) : '0.0',
      }))
      .sort((a: any, b: any) => parseFloat(b.average) - parseFloat(a.average));

    // 6. Inventory
    const totalResources = libraryResources.length;
    const physicalBooks = libraryResources.filter((r: any) => r.type === 'BOOK').length;
    const onlineEbooks = libraryResources.filter((r: any) => r.type === 'EBOOK').length;
    const studyVideos = libraryResources.filter((r: any) => r.type === 'VIDEO').length;
    const totalIssuances = libraryIssues.length;
    const returnedIssues = libraryIssues.filter((i: any) => i.status === 'RETURNED').length;
    const activeIssuances = libraryIssues.filter((i: any) => i.status === 'ISSUED').length;
    const returnRate = totalIssuances > 0 ? ((returnedIssues / totalIssuances) * 100).toFixed(1) : '0.0';

    return res.json({
      success: true,
      data: {
        incomeExpenses: {
          totalFeeIncome,
          totalOfficeIncome,
          totalIncome,
          totalExpenses,
          netSurplus,
          expenseByHead: Object.entries(expenseByHead).map(([category, amount]) => ({ category, amount })),
          recentTransactions: officeTxs.slice(0, 10),
        },
        fees: {
          totalInvoiced,
          totalCollected,
          totalOutstanding,
          collectionRate,
          feeTypeBreakdown: Object.entries(feeTypeMap).map(([feeType, totalAmount]) => ({ feeType, totalAmount })),
          classByClassFees: classByClassStudents.map((c: any) => ({
            className: c.className,
            studentCount: c.total,
          })),
          invoiceStatusCount: {
            paid: invoices.filter((i: any) => i.status === 'paid').length,
            partial: invoices.filter((i: any) => i.status === 'partial').length,
            unpaid: invoices.filter((i: any) => i.status === 'unpaid').length,
          },
        },
        students: {
          totalStudents,
          activeStudents,
          inactiveStudents: totalStudents - activeStudents,
          maleCount,
          femaleCount,
          classByClass: classByClassStudents,
          totalClasses: allClasses.length,
        },
        attendance: {
          totalRecords: totalAttendanceRecords,
          presentCount,
          absentCount,
          lateCount,
          attendanceRate,
          classByClass: classByClassAttendance,
        },
        examinations: {
          totalMarksRecorded,
          avgScore,
          gradeDistribution: { A: gradeA, B: gradeB, C: gradeC, D: gradeD, F: gradeF },
          classByClass: classByClassExam,
        },
        inventory: {
          totalResources,
          physicalBooks,
          onlineEbooks,
          studyVideos,
          totalIssuances,
          activeIssuances,
          returnedIssues,
          returnRate,
        },
      },
    });
  } catch (error: any) {
    console.error('[REPORTS] Comprehensive report error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate reports.' });
  }
}

export const updateGamificationConfig = saveGamificationConfig;
export const getComprehensiveReports = getComprehensiveReport;
export const getStaffActivity = getStaffActivitiesReport;

