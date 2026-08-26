import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { generatePayslipPdf } from '../../lib/pdfService';

/**
 * GET /api/admin/hr/payroll/components
 */
export async function getPayrollComponents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const components = await prisma.payrollComponent.findMany({
      where: { branchId },
      orderBy: { staffName: 'asc' },
    });

    return res.json({ success: true, components });
  } catch (error) {
    console.error('[ADMIN] Fetch payroll components error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch payroll components.' });
  }
}

/**
 * POST /api/admin/hr/payroll/components
 */
export async function savePayrollComponents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { components, staffId, staffType, staffName, staffRole, baseSalary, housingAllowance, transportAllowance, medicalAllowance, taxDeduction, pensionDeduction, otherDeductions, bankName, accountNumber } = req.body;

    if (Array.isArray(components)) {
      await prisma.payrollComponent.deleteMany({ where: { branchId } });

      const created = await Promise.all(
        components.map((c: any) =>
          prisma.payrollComponent.create({
            data: {
              staffId: Number(c.staffId || c.teacherId || 1),
              staffType: c.staffType || 'TEACHER',
              staffName: c.staffName || c.name || 'Staff Member',
              staffRole: c.staffRole || c.role || 'Teacher',
              baseSalary: Number(c.baseSalary || 0),
              housingAllowance: Number(c.housingAllowance || 0),
              transportAllowance: Number(c.transportAllowance || 0),
              medicalAllowance: Number(c.medicalAllowance || 0),
              taxDeduction: Number(c.taxDeduction || 0),
              pensionDeduction: Number(c.pensionDeduction || 0),
              otherDeductions: Number(c.otherDeductions || 0),
              bankName: c.bankName || null,
              accountNumber: c.accountNumber || null,
              branchId,
            },
          })
        )
      );

      return res.json({ success: true, message: 'Payroll components updated.', components: created });
    }

    if (!staffId && !staffName) {
      return res.status(400).json({ success: false, message: 'Staff ID or components array is required.' });
    }

    const targetStaffId = Number(staffId);
    let finalStaffName = staffName;
    let finalStaffRole = staffRole || 'Teacher';
    if (!finalStaffName && targetStaffId) {
      const teacher = await prisma.teacher.findUnique({ where: { id: targetStaffId } });
      if (teacher) {
        finalStaffName = teacher.name;
        finalStaffRole = (teacher as any).designation || teacher.department || finalStaffRole;
      }
    }

    const component = await prisma.payrollComponent.upsert({
      where: { id: req.body.id || -1 },
      create: {
        staffId: targetStaffId || 1,
        staffType: staffType || 'TEACHER',
        staffName: finalStaffName || 'Staff Member',
        staffRole: finalStaffRole,
        baseSalary: Number(baseSalary || 0),
        housingAllowance: Number(housingAllowance || 0),
        transportAllowance: Number(transportAllowance || 0),
        medicalAllowance: Number(medicalAllowance || 0),
        taxDeduction: Number(taxDeduction || 0),
        pensionDeduction: Number(pensionDeduction || 0),
        otherDeductions: Number(otherDeductions || 0),
        bankName: bankName || null,
        accountNumber: accountNumber || null,
        branchId,
      },
      update: {
        baseSalary: Number(baseSalary || 0),
        housingAllowance: Number(housingAllowance || 0),
        transportAllowance: Number(transportAllowance || 0),
        medicalAllowance: Number(medicalAllowance || 0),
        taxDeduction: Number(taxDeduction || 0),
        pensionDeduction: Number(pensionDeduction || 0),
        otherDeductions: Number(otherDeductions || 0),
        bankName: bankName || null,
        accountNumber: accountNumber || null,
      },
    });

    return res.json({ success: true, message: 'Payroll component saved.', component });
  } catch (error) {
    console.error('[ADMIN] Save payroll components error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save payroll components.' });
  }
}

export { savePayrollComponents as createPayrollComponent };

/**
 * GET /api/admin/hr/payroll/runs
 */
export async function getPayrollRuns(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const runs = await prisma.payrollRun.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
      include: {
        payslips: true,
      },
    });

    return res.json({ success: true, runs });
  } catch (error) {
    console.error('[ADMIN] Fetch payroll runs error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch payroll runs.' });
  }
}

/**
 * POST /api/admin/hr/payroll/runs
 */
export async function createPayrollRun(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { monthYear, month, year, items } = req.body;
    const finalMonthYear = monthYear || (month && year ? `${month} ${year}` : new Date().toLocaleString('default', { month: 'long', year: 'numeric' }));

    const staffItems = Array.isArray(items) ? items : [];

    const totalGross = staffItems.reduce((acc, curr) => acc + (Number(curr.baseSalary || curr.grossPay) || 0) + (Number(curr.totalAllowances) || 0), 0);
    const totalDeductions = staffItems.reduce((acc, curr) => acc + (Number(curr.totalDeductions || curr.deductions) || 0), 0);
    const totalNet = staffItems.reduce((acc, curr) => acc + (Number(curr.netSalary || curr.netPay) || (Number(curr.baseSalary || curr.grossPay) || 0) - (Number(curr.totalDeductions || curr.deductions) || 0)), 0);

    const newRun = await prisma.payrollRun.create({
      data: {
        branchId,
        monthYear: finalMonthYear,
        totalGross,
        totalDeductions,
        totalNet,
        staffCount: staffItems.length,
        status: 'DRAFT',
        payslips: {
          create: staffItems.map((it: any) => ({
            staffId: Number(it.staffId || it.teacherId || 1),
            staffName: it.staffName || it.name || 'Staff Member',
            staffRole: it.staffRole || it.role || 'Teacher',
            baseSalary: Number(it.baseSalary || 0),
            totalAllowances: Number(it.totalAllowances || 0),
            totalDeductions: Number(it.totalDeductions || 0),
            netSalary: Number(it.netSalary || (Number(it.baseSalary || 0) - Number(it.totalDeductions || 0))),
            paymentMethod: it.paymentMethod || 'Bank Transfer',
            status: 'PENDING',
            branchId,
          })),
        },
      },
      include: {
        payslips: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Payroll run generated successfully in DRAFT mode.',
      run: newRun,
    });
  } catch (error) {
    console.error('[ADMIN] Create payroll run error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create payroll run.' });
  }
}

/**
 * PUT /api/admin/hr/payroll/runs/:id/status
 */
export async function updatePayrollRunStatus(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);
    const { status } = req.body;

    if (!status || !['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID'].includes(String(status).toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Invalid status.' });
    }

    const run = await prisma.payrollRun.findFirst({
      where: { id, branchId },
    });

    if (!run) {
      return res.status(404).json({ success: false, message: 'Payroll run not found.' });
    }

    const statusUpper = String(status).toUpperCase();

    const updated = await prisma.$transaction(async (tx) => {
      const uRun = await tx.payrollRun.update({
        where: { id },
        data: {
          status: statusUpper,
          paidAt: statusUpper === 'PAID' ? new Date() : run.paidAt,
          approvedAt: statusUpper === 'APPROVED' ? new Date() : run.approvedAt,
        },
      });

      if (statusUpper === 'PAID') {
        await tx.payslip.updateMany({
          where: { payrollRunId: id },
          data: { status: 'PAID' },
        });
      }

      return uRun;
    });

    return res.json({
      success: true,
      message: `Payroll run marked as ${statusUpper}.`,
      run: updated,
    });
  } catch (error) {
    console.error('[ADMIN] Update payroll status error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update payroll run status.' });
  }
}

/**
 * GET /api/admin/hr/payroll/items/:id/payslip.pdf
 */
export async function getPayslipPdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const itemId = Number(req.params.id);

    const payslip = await prisma.payslip.findFirst({
      where: { id: itemId, branchId },
      include: {
        payrollRun: true,
      },
    });

    if (!payslip) {
      return res.status(404).json({ success: false, message: 'Payslip record not found.' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { systemSetting: true },
    });

    const pdfBuffer = await generatePayslipPdf({
      schoolName: branch?.systemSetting?.schoolName || branch?.name || 'School Name',
      schoolAddress: branch?.systemSetting?.address || branch?.address || '',
      schoolPhone: branch?.systemSetting?.phone || branch?.phone || '',
      schoolLogo: branch?.systemSetting?.logoUrl || branch?.logo || null,
      staffName: payslip.staffName,
      staffRole: payslip.staffRole,
      staffDepartment: 'Academic / Staff',
      bankName: 'Bank Transfer',
      accountNumber: 'N/A',
      accountName: payslip.staffName,
      monthYear: payslip.payrollRun.monthYear,
      basicSalary: Number(payslip.baseSalary),
      grossPay: Number(payslip.baseSalary) + Number(payslip.totalAllowances),
      deductions: Number(payslip.totalDeductions),
      netPay: Number(payslip.netSalary),
      allowances: { Allowances: Number(payslip.totalAllowances) },
      deductionsBreakdown: { Deductions: Number(payslip.totalDeductions) },
      currency: branch?.systemSetting?.currencySymbol || '₦',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslip-${payslip.staffName.replace(/\s+/g, '_')}-${payslip.payrollRun.monthYear.replace(/\s+/g, '_')}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Generate payslip PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate payslip PDF.' });
  }
}

/**
 * GET /api/admin/hr/salary-advances
 */
export async function getSalaryAdvances(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const advances = await prisma.salaryAdvance.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      success: true,
      advances: advances.map((a) => ({
        id: a.id,
        staffId: a.staffId,
        staffName: a.staffName,
        staffRole: a.staffRole,
        amount: Number(a.requestedAmount),
        repaymentMonths: a.repaymentMonths,
        monthlyDeduction: Number(a.monthlyDeduction),
        reason: a.reason,
        status: a.status,
        createdAt: a.createdAt,
        reviewedAt: a.reviewedAt,
      })),
    });
  } catch (error) {
    console.error('[ADMIN] Fetch salary advances error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch salary advances.' });
  }
}

/**
 * POST /api/admin/hr/salary-advances
 */
export async function createSalaryAdvance(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { staffId, teacherId, staffName, staffRole, amount, requestedAmount, repaymentMonths, reason } = req.body;
    const targetStaffId = Number(staffId || teacherId);
    const amt = Number(amount || requestedAmount);
    const months = Number(repaymentMonths || 1);
    if (!targetStaffId || !amt) {
      return res.status(400).json({ success: false, message: 'Staff ID and amount are required.' });
    }

    let finalStaffName = staffName;
    let finalStaffRole = staffRole || 'Teacher';
    if (!finalStaffName && targetStaffId) {
      const teacher = await prisma.teacher.findUnique({ where: { id: targetStaffId } });
      if (teacher) {
        finalStaffName = teacher.name;
        finalStaffRole = (teacher as any).designation || teacher.department || finalStaffRole;
      }
    }

    const monthlyDeduction = months > 0 ? Math.round(amt / months) : amt;

    const advance = await prisma.salaryAdvance.create({
      data: {
        branchId,
        staffId: targetStaffId,
        staffName: finalStaffName || 'Staff Member',
        staffRole: finalStaffRole,
        requestedAmount: amt,
        repaymentMonths: months,
        monthlyDeduction,
        reason: reason ? String(reason).trim() : 'Salary advance request',
        status: 'PENDING',
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Salary advance request created successfully.',
      advance,
    });
  } catch (error) {
    console.error('[ADMIN] Create salary advance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create salary advance.' });
  }
}

/**
 * POST /api/admin/hr/salary-advances/:id/review
 */
export async function reviewSalaryAdvance(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);
    const { status, reviewerNotes } = req.body;

    if (!status || !['APPROVED', 'REJECTED', 'REPAID'].includes(String(status).toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Status must be APPROVED, REJECTED, or REPAID.' });
    }

    const advance = await prisma.salaryAdvance.findFirst({
      where: { id, branchId },
    });

    if (!advance) {
      return res.status(404).json({ success: false, message: 'Salary advance request not found.' });
    }

    const statusUpper = String(status).toUpperCase();

    const updated = await prisma.salaryAdvance.update({
      where: { id },
      data: {
        status: statusUpper,
        reviewerNotes: reviewerNotes ? String(reviewerNotes) : null,
        reviewedAt: new Date(),
      },
    });

    return res.json({
      success: true,
      message: `Salary advance request ${statusUpper.toLowerCase()} successfully.`,
      advance: updated,
    });
  } catch (error) {
    console.error('[ADMIN] Review salary advance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to review salary advance.' });
  }
}

/**
 * GET /api/admin/hr/conduct
 */
export async function getStaffConduct(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const logs = await prisma.staffConduct.findMany({
      where: { branchId },
      orderBy: { incidentDate: 'desc' },
    });

    return res.json({ success: true, logs });
  } catch (error) {
    console.error('[ADMIN] Fetch staff conduct error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch staff conduct logs.' });
  }
}

/**
 * POST /api/admin/hr/conduct
 */
export async function createStaffConduct(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { staffId, teacherId, staffName, staffRole, type, title, description, incidentDate, actionTaken, issuedBy } = req.body;
    const targetStaffId = Number(staffId || teacherId);

    if (!targetStaffId || !title) {
      return res.status(400).json({ success: false, message: 'Staff and title are required.' });
    }

    let finalStaffName = staffName;
    let finalStaffRole = staffRole || 'Teacher';
    if (!finalStaffName && targetStaffId) {
      const teacher = await prisma.teacher.findUnique({ where: { id: targetStaffId } });
      if (teacher) {
        finalStaffName = teacher.name;
        finalStaffRole = (teacher as any).designation || teacher.department || finalStaffRole;
      }
    }

    const log = await prisma.staffConduct.create({
      data: {
        branchId,
        staffId: targetStaffId,
        staffName: finalStaffName || 'Staff Member',
        staffRole: finalStaffRole,
        type: String(type || 'WARNING').toUpperCase(),
        title: String(title).trim(),
        description: description ? String(description).trim() : '',
        incidentDate: incidentDate ? new Date(incidentDate) : new Date(),
        actionTaken: actionTaken ? String(actionTaken).trim() : null,
        issuedBy: issuedBy || 'School Admin',
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Staff conduct entry logged successfully.',
      log,
    });
  } catch (error) {
    console.error('[ADMIN] Create conduct log error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create conduct log.' });
  }
}

/**
 * DELETE /api/admin/hr/conduct/:id
 */
export async function deleteStaffConduct(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);
    await prisma.staffConduct.deleteMany({
      where: { id, branchId },
    });

    return res.json({ success: true, message: 'Conduct log deleted successfully.' });
  } catch (error) {
    console.error('[ADMIN] Delete conduct log error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete conduct log.' });
  }
}
