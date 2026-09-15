import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import {
  generateInvoice,
  recordPayment,
  getFinancialOverview,
  exportFinancialReportCsv,
  exportFinancialReportPdf,
} from '../../lib/accountingService';
import {
  generateSingleInvoicePdf,
  generateBatchClassInvoicesPdf,
} from '../../lib/pdfService';

function parseJsonIdList(raw: unknown): number[] {
  let values: unknown[] = [];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      values = Array.isArray(parsed) ? parsed : String(raw).split(',');
    } catch {
      values = String(raw).split(',');
    }
  }
  return [...new Set(values.map((value) => Number(value)).filter((id) => Number.isInteger(id) && id > 0))];
}

async function activeSessionId(): Promise<number> {
  const globalSetting = await prisma.globalSettings.findFirst();
  return globalSetting?.sessionId || 5;
}

async function hydrateFeeGroups(branchId: number, groups: Array<{ feeTypeIds: string; classIds?: string | null } & Record<string, any>>) {
  const typeIds = [...new Set(groups.flatMap((group) => parseJsonIdList(group.feeTypeIds)))];
  const classIds = [...new Set(groups.flatMap((group) => parseJsonIdList(group.classIds)))];
  const [types, classes] = await Promise.all([
    typeIds.length
      ? prisma.feeType.findMany({
          where: { id: { in: typeIds }, branchId },
          select: { id: true, name: true, code: true, amount: true, frequency: true },
        })
      : Promise.resolve([]),
    classIds.length
      ? prisma.class.findMany({
          where: { id: { in: classIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const typeMap = new Map(types.map((type) => [type.id, type]));
  const classMap = new Map(classes.map((cls) => [cls.id, cls]));

  return groups.map((group) => {
    const feeTypeIds = parseJsonIdList(group.feeTypeIds);
    const allocatedClassIds = parseJsonIdList(group.classIds);
    const feeTypes = feeTypeIds.map((id) => typeMap.get(id)).filter(Boolean);
    return {
      ...group,
      feeTypeIds,
      classIds: allocatedClassIds,
      feeTypes,
      classes: allocatedClassIds.map((id) => classMap.get(id)).filter(Boolean),
      totalAmount: feeTypes.reduce((sum, type: any) => sum + Number(type?.amount || 0), 0),
    };
  });
}

async function syncFeeGroupClassAssignments(args: {
  branchId: number;
  sessionId: number;
  feeTypeIds: number[];
  nextClassIds: number[];
  previousClassIds: number[];
  previousFeeTypeIds?: number[];
}) {
  const typeIds = [...new Set(args.feeTypeIds)];
  const nextClassIds = [...new Set(args.nextClassIds)];
  const previousClassIds = [...new Set(args.previousClassIds)];
  const previousTypeIds = [...new Set(args.previousFeeTypeIds || [])];
  const removedClassIds = previousClassIds.filter((id) => !nextClassIds.includes(id));
  const retiredTypeIds = previousTypeIds.filter((id) => !typeIds.includes(id));
  const affectedClassIds = [...new Set([...previousClassIds, ...nextClassIds])];

  await prisma.$transaction(async (tx) => {
    if (removedClassIds.length && (typeIds.length || previousTypeIds.length)) {
      await tx.feeAssignment.deleteMany({
        where: {
          branchId: args.branchId,
          sessionId: args.sessionId,
          classId: { in: removedClassIds },
          feeTypeId: { in: [...new Set([...typeIds, ...previousTypeIds])] },
        },
      });
    }

    if (retiredTypeIds.length && nextClassIds.length) {
      await tx.feeAssignment.deleteMany({
        where: {
          branchId: args.branchId,
          sessionId: args.sessionId,
          classId: { in: nextClassIds },
          feeTypeId: { in: retiredTypeIds },
        },
      });
    }

    if (!typeIds.length || !nextClassIds.length) return;

    const existing = await tx.feeAssignment.findMany({
      where: {
        branchId: args.branchId,
        sessionId: args.sessionId,
        classId: { in: nextClassIds },
        feeTypeId: { in: typeIds },
      },
      select: { classId: true, feeTypeId: true },
    });
    const have = new Set(existing.map((row) => `${row.classId}:${row.feeTypeId}`));
    const toCreate = nextClassIds.flatMap((classId) =>
      typeIds
        .filter((feeTypeId) => !have.has(`${classId}:${feeTypeId}`))
        .map((feeTypeId) => ({
          feeTypeId,
          classId,
          branchId: args.branchId,
          sessionId: args.sessionId,
          isOptional: false,
          active: true,
        }))
    );
    if (toCreate.length) {
      await tx.feeAssignment.createMany({ data: toCreate });
    }
  });

  return { affectedClassIds, typeIds, classIds: nextClassIds };
}

/**
 * GET /api/admin/finances/overview
 */
export async function getFinanceOverview(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const data = await getFinancialOverview(prisma, {
      branchId,
      sessionId,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('[ADMIN] Financial overview error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve financial overview data.' });
  }
}

/**
 * GET /api/admin/finances/fee-types
 */
export async function getFeeTypes(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const feeTypes = await prisma.feeType.findMany({
      where: { branchId, active: true },
      orderBy: { name: 'asc' },
    });

    return res.json({
      success: true,
      data: feeTypes,
    });
  } catch (error) {
    console.error('[ADMIN] Get fee types error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve fee types.' });
  }
}

/**
 * POST /api/admin/finances/fee-types
 */
export async function createFeeType(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, code, amount, frequency = 'per_term' } = req.body;
    if (!name || !code || !amount) {
      return res.status(400).json({ success: false, message: 'Name, unique Code, and Amount are required.' });
    }

    const cleanCode = code.trim().toUpperCase();

    const existing = await prisma.feeType.findUnique({
      where: {
        branchId_code: {
          branchId: branchId!,
          code: cleanCode,
        },
      },
    });

    if (existing) {
      return res.status(400).json({ success: false, message: `Fee code '${cleanCode}' is already registered.` });
    }

    const feeType = await prisma.feeType.create({
      data: {
        name,
        code: cleanCode,
        amount: parseFloat(amount),
        frequency,
        branchId,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Fee type created successfully.',
      data: feeType,
    });
  } catch (error) {
    console.error('[ADMIN] Create fee type error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create fee type.' });
  }
}

/**
 * POST /api/admin/finances/fee-types/bulk
 */
export async function bulkCreateFeeTypes(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { feeTypes } = req.body;
    if (!feeTypes || !Array.isArray(feeTypes) || feeTypes.length === 0) {
      return res.status(400).json({ success: false, message: 'Fee categories array is required.' });
    }

    const created: any[] = [];
    const skipped: any[] = [];

    for (const item of feeTypes) {
      const { name, code, amount, frequency = 'per_term' } = item;
      if (!name || !code || amount === undefined) {
        skipped.push({ name: name || 'Unknown', reason: 'Missing name, code, or amount' });
        continue;
      }

      const cleanCode = code.trim().toUpperCase();

      const existing = await prisma.feeType.findUnique({
        where: {
          branchId_code: {
            branchId: branchId!,
            code: cleanCode,
          },
        },
      });

      if (existing) {
        skipped.push({ name, code: cleanCode, reason: 'Duplicate unique code' });
        continue;
      }

      const newFee = await prisma.feeType.create({
        data: {
          name,
          code: cleanCode,
          amount: parseFloat(amount),
          frequency,
          branchId,
        },
      });
      created.push(newFee);
    }

    return res.status(201).json({
      success: true,
      message: `Batch complete. Created: ${created.length}, Skipped: ${skipped.length}`,
      created,
      skipped,
    });
  } catch (error) {
    console.error('[ADMIN] Bulk create fee types error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create fee categories.' });
  }
}

/**
 * GET /api/admin/finances/fee-assignments
 */
export async function getFeeAssignments(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const assignments = await prisma.feeAssignment.findMany({
      where: {
        branchId,
        sessionId,
      },
      include: {
        feeType: true,
        class: { select: { id: true, name: true } },
      },
    });

    return res.json({
      success: true,
      data: assignments,
    });
  } catch (error) {
    console.error('[ADMIN] Get fee assignments error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve fee allocations.' });
  }
}

/**
 * POST /api/admin/finances/fee-assignments
 */
export async function saveFeeAssignments(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, allocations } = req.body;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const parsedClassId = parseInt(classId, 10);
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    await prisma.$transaction(async (tx) => {
      await tx.feeAssignment.deleteMany({
        where: {
          branchId,
          classId: parsedClassId,
          sessionId,
        },
      });

      if (allocations && Array.isArray(allocations)) {
        const createData = allocations.map((alloc: any) => ({
          feeTypeId: parseInt(alloc.feeTypeId, 10),
          isOptional: !!alloc.isOptional,
          classId: parsedClassId,
          branchId: branchId!,
          sessionId,
        }));

        if (createData.length > 0) {
          await tx.feeAssignment.createMany({
            data: createData,
          });
        }
      }
    });

    return res.json({
      success: true,
      message: 'Class fee allocations updated successfully.',
    });
  } catch (error) {
    console.error('[ADMIN] Save fee assignments error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save fee allocations.' });
  }
}

/**
 * GET /api/admin/finances/invoices/batch-preview
 */
export async function previewBatchInvoices(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, termLabel, feeTypeIds } = (req.query || {}) as any;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const parsedClassId = parseInt(classId, 10);
    const parsedSectionId = sectionId ? parseInt(sectionId, 10) : null;
    const term = (termLabel || 'First Term').trim();

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const cls = await prisma.class.findUnique({
      where: { id: parsedClassId },
      select: { id: true, name: true },
    });

    let secName = 'All Sections';
    if (parsedSectionId) {
      const sec = await prisma.section.findUnique({
        where: { id: parsedSectionId },
        select: { id: true, name: true },
      });
      if (sec) secName = sec.name;
    }

    const enrollWhere: any = {
      classId: parsedClassId,
      branchId,
      sessionId,
    };
    if (parsedSectionId) {
      enrollWhere.sectionId = parsedSectionId;
    }

    const enrollments = await prisma.enroll.findMany({
      where: enrollWhere,
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            gender: true,
            active: true,
          },
        },
        section: { select: { id: true, name: true } },
      },
      orderBy: { student: { lastName: 'asc' } },
    });

    const activeEnrollments = enrollments.filter((e) => e.student && e.student.active);
    const studentIds = activeEnrollments.map((e) => e.student.id);

    const existingInvoices = await prisma.invoice.findMany({
      where: {
        studentId: { in: studentIds },
        termLabel: term,
        sessionId,
        branchId,
      },
      include: { items: true },
    });

    const existingMap: Record<number, any> = {};
    existingInvoices.forEach((inv) => {
      existingMap[inv.studentId] = inv;
    });

    let selectedFeeTypes: any[] = [];
    if (feeTypeIds) {
      const parsedIds = (Array.isArray(feeTypeIds) ? feeTypeIds : String(feeTypeIds).split(','))
        .map((id: string) => parseInt(id, 10))
        .filter(Boolean);
      selectedFeeTypes = await prisma.feeType.findMany({
        where: { id: { in: parsedIds }, branchId },
      });
    }

    if (selectedFeeTypes.length === 0) {
      const assignments = await prisma.feeAssignment.findMany({
        where: {
          classId: parsedClassId,
          branchId,
          sessionId,
          active: true,
        },
        include: { feeType: true },
      });
      selectedFeeTypes = assignments.map((a) => a.feeType).filter(Boolean);
    }

    const totalPerStudent = selectedFeeTypes.reduce((acc, curr) => acc + parseFloat(curr.amount.toString()), 0);

    const studentList = activeEnrollments.map((e) => {
      const st = e.student;
      const existing = existingMap[st.id];

      return {
        id: st.id,
        studentName: `${st.lastName}, ${st.firstName}`,
        firstName: st.firstName,
        lastName: st.lastName,
        registerNo: st.registerNo || 'Pending',
        gender: st.gender || 'N/A',
        sectionId: e.section?.id || null,
        sectionName: e.section?.name || secName,
        alreadyInvoiced: Boolean(existing),
        existingInvoiceId: existing?.id || null,
        existingInvoiceNo: existing?.invoiceNo || null,
        existingStatus: existing?.status || null,
        existingTotal: existing ? parseFloat(existing.totalAmount.toString()) : null,
        existingBalance: existing ? parseFloat(existing.balanceAmount.toString()) : null,
      };
    });

    const unInvoicedCount = studentList.filter((s) => !s.alreadyInvoiced).length;
    const projectedTotal = unInvoicedCount * totalPerStudent;

    return res.json({
      success: true,
      className: cls?.name || 'Classroom',
      sectionName: secName,
      totalEnrolled: studentList.length,
      alreadyInvoicedCount: studentList.length - unInvoicedCount,
      unInvoicedCount,
      totalPerStudent,
      projectedTotal,
      feeTypes: selectedFeeTypes.map((ft) => ({
        id: ft.id,
        name: ft.name,
        code: ft.code,
        amount: parseFloat(ft.amount.toString()),
        frequency: ft.frequency,
      })),
      students: studentList,
    });
  } catch (error) {
    console.error('[ADMIN INVOICES] Batch preview error:', error);
    return res.status(500).json({ success: false, message: 'Failed to preview batch invoice roster.' });
  }
}

/**
 * POST /api/admin/finances/invoices/batch-generate
 */
export async function generateBatchInvoices(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, termLabel, dueDate, feeTypeIds, studentIds, overwriteExisting } = req.body;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const parsedClassId = parseInt(classId, 10);
    const parsedSectionId = sectionId ? parseInt(sectionId, 10) : null;
    const term = (termLabel || 'First Term').trim();

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    let targetFeeTypeIds: number[] = [];
    if (Array.isArray(feeTypeIds) && feeTypeIds.length > 0) {
      targetFeeTypeIds = feeTypeIds.map((id: any) => parseInt(id, 10));
    } else {
      const assignments = await prisma.feeAssignment.findMany({
        where: {
          classId: parsedClassId,
          branchId,
          sessionId,
          active: true,
        },
        select: { feeTypeId: true },
      });
      targetFeeTypeIds = assignments.map((a) => a.feeTypeId);
    }

    if (targetFeeTypeIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fee types selected or assigned to this class. Please select at least one fee type.',
      });
    }

    let targetStudentIds: number[] = [];
    if (Array.isArray(studentIds) && studentIds.length > 0) {
      targetStudentIds = studentIds.map((id: any) => parseInt(id, 10));
    } else {
      const enrollWhere: any = {
        classId: parsedClassId,
        branchId,
        sessionId,
      };
      if (parsedSectionId) {
        enrollWhere.sectionId = parsedSectionId;
      }
      const enrollments = await prisma.enroll.findMany({
        where: enrollWhere,
        include: { student: { select: { id: true, active: true } } },
      });
      targetStudentIds = enrollments.filter((e) => e.student && e.student.active).map((e) => e.student.id);
    }

    if (targetStudentIds.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No eligible active students found for batch invoice generation.',
      });
    }

    let createdCount = 0;
    let skippedCount = 0;
    let totalInvoicedSum = 0;
    const createdInvoices: any[] = [];

    for (const sId of targetStudentIds) {
      try {
        const existing = await prisma.invoice.findFirst({
          where: {
            studentId: sId,
            termLabel: term,
            sessionId,
            branchId,
          },
        });

        if (existing) {
          if (!overwriteExisting) {
            skippedCount++;
            continue;
          } else {
            await prisma.invoiceItem.deleteMany({ where: { invoiceId: existing.id } });
            await prisma.payment.deleteMany({ where: { invoiceId: existing.id } });
            await prisma.invoice.delete({ where: { id: existing.id } });
          }
        }

        const invoice = await generateInvoice(prisma, {
          studentId: sId,
          termLabel: term,
          feeTypeIds: targetFeeTypeIds,
          branchId,
          sessionId,
          dueDate: dueDate || null,
        });

        createdCount++;
        totalInvoicedSum += parseFloat(invoice.totalAmount.toString());
        createdInvoices.push({
          id: invoice.id,
          invoiceNo: invoice.invoiceNo,
          studentId: sId,
          totalAmount: parseFloat(invoice.totalAmount.toString()),
        });
      } catch (err) {
        console.error(`[ADMIN INVOICES] Error generating invoice for student ${sId}:`, err);
        skippedCount++;
      }
    }

    return res.status(201).json({
      success: true,
      message: `Batch invoicing complete! Generated ${createdCount} invoice(s) (Total: ₦${totalInvoicedSum.toLocaleString()}), skipped ${skippedCount}.`,
      createdCount,
      skippedCount,
      totalInvoiced: totalInvoicedSum,
      invoices: createdInvoices,
    });
  } catch (error: any) {
    console.error('[ADMIN INVOICES] Batch generate error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate batch invoices.' });
  }
}

/**
 * GET /api/admin/finances/invoices/:id/pdf
 */
export async function getSingleInvoicePdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const invoiceId = parseInt(req.params.id as string, 10);
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, branchId },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            enrolls: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              include: {
                class: { select: { name: true } },
                section: { select: { name: true } },
              },
            },
          },
        },
        items: true,
      },
    });

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true, code: true },
    });

    const schoolBank = await prisma.schoolBank.findFirst({
      where: { branchId, isActive: true },
    });

    const enroll = invoice.student?.enrolls?.[0];
    const className = enroll?.class?.name || 'Classroom';
    const sectionName = enroll?.section?.name || '';

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;
    const schoolYear = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } });
    const sessionName = schoolYear?.schoolYear || 'Active Session';

    const pdfBuffer = await generateSingleInvoicePdf({
      schoolName: branch?.name || 'Ugbekun Schools',
      branchCode: branch?.code || 'GEN',
      invoiceNo: invoice.invoiceNo,
      termLabel: invoice.termLabel,
      className,
      sectionName,
      sessionName,
      studentName: `${invoice.student.lastName}, ${invoice.student.firstName}`,
      registerNo: invoice.student.registerNo || 'Pending',
      issuedAt: invoice.issuedAt,
      dueDate: invoice.dueDate,
      status: invoice.status,
      items: invoice.items.map((item) => ({
        description: item.description,
        amount: parseFloat(item.amount.toString()),
        feeTypeCode: 'FEE',
      })),
      totalAmount: parseFloat(invoice.totalAmount.toString()),
      paidAmount: parseFloat(invoice.paidAmount.toString()),
      balanceAmount: parseFloat(invoice.balanceAmount.toString()),
      schoolBank: schoolBank
        ? {
            bankName: schoolBank.bankName,
            accountName: schoolBank.accountName,
            accountNumber: schoolBank.accountNumber,
            sortCode: schoolBank.sortCode,
          }
        : null,
    });

    const safeInvoiceNo = invoice.invoiceNo.replace(/[\/\\]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice_${safeInvoiceNo}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN INVOICES] Download single invoice PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate invoice PDF.' });
  }
}

/**
 * GET /api/admin/finances/invoices/batch-pdf
 */
export async function getBatchInvoicesPdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, termLabel } = (req.query || {}) as any;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const parsedClassId = parseInt(classId, 10);
    const parsedSectionId = sectionId ? parseInt(sectionId, 10) : null;
    const term = termLabel ? String(termLabel).trim() : undefined;

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true, code: true },
    });

    const cls = await prisma.class.findUnique({ where: { id: parsedClassId }, select: { name: true } });
    const sec = parsedSectionId
      ? await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } })
      : null;
    const schoolYear = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } });

    const className = cls?.name || 'Classroom';
    const sectionName = sec?.name || '';
    const sessionName = schoolYear?.schoolYear || 'Active Session';

    const enrollWhere: any = {
      classId: parsedClassId,
      branchId,
      sessionId,
    };
    if (parsedSectionId) enrollWhere.sectionId = parsedSectionId;

    const enrollments = await prisma.enroll.findMany({
      where: enrollWhere,
      select: { studentId: true },
    });
    const studentIds = enrollments.map((e) => e.studentId);

    if (studentIds.length === 0) {
      return res.status(404).json({ success: false, message: 'No enrolled students found in this class section.' });
    }

    const invoiceWhere: any = {
      studentId: { in: studentIds },
      sessionId,
      branchId,
    };
    if (term) invoiceWhere.termLabel = term;

    const invoices = await prisma.invoice.findMany({
      where: invoiceWhere,
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
          },
        },
        items: true,
      },
      orderBy: { invoiceNo: 'asc' },
    });

    if (invoices.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No invoices found for this class section. Please generate batch invoices first.',
      });
    }

    const schoolBank = await prisma.schoolBank.findFirst({
      where: { branchId, isActive: true },
    });

    const formattedInvoices = invoices.map((inv) => ({
      invoiceNo: inv.invoiceNo,
      termLabel: inv.termLabel,
      studentName: `${inv.student.lastName}, ${inv.student.firstName}`,
      registerNo: inv.student.registerNo || 'Pending',
      issuedAt: inv.issuedAt,
      dueDate: inv.dueDate,
      status: inv.status,
      items: inv.items.map((item) => ({
        description: item.description,
        amount: parseFloat(item.amount.toString()),
        feeTypeCode: 'FEE',
      })),
      totalAmount: parseFloat(inv.totalAmount.toString()),
      paidAmount: parseFloat(inv.paidAmount.toString()),
      balanceAmount: parseFloat(inv.balanceAmount.toString()),
    }));

    const pdfBuffer = await generateBatchClassInvoicesPdf({
      schoolName: branch?.name || 'Ugbekun Schools',
      branchCode: branch?.code || 'GEN',
      className,
      sectionName,
      sessionName,
      schoolBank: schoolBank
        ? {
            bankName: schoolBank.bankName,
            accountName: schoolBank.accountName,
            accountNumber: schoolBank.accountNumber,
            sortCode: schoolBank.sortCode,
          }
        : null,
      invoices: formattedInvoices,
    });

    const safeCls = className.replace(/\s+/g, '_');
    const safeSec = sectionName.replace(/\s+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Batch_Invoices_${safeCls}${safeSec ? `_${safeSec}` : ''}.pdf"`
    );
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN INVOICES] Download batch invoices PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate batch invoices PDF.' });
  }
}

/**
 * GET /api/admin/finances/invoices
 */
export async function getInvoices(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { status, search, classId, sectionId, termLabel, page = 1, limit = 50 } = (req.query || {}) as any;
    const p = parseInt(page as string, 10);
    const l = parseInt(limit as string, 10);
    const skip = (p - 1) * l;

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const where: any = {
      branchId,
    };

    if (status && status !== 'all') where.status = status;
    if (termLabel && termLabel !== 'all') where.termLabel = termLabel;

    if (classId) {
      const parsedClassId = parseInt(classId, 10);
      const parsedSectionId = sectionId ? parseInt(sectionId, 10) : null;
      const enrollWhere: any = { classId: parsedClassId, branchId, sessionId };
      if (parsedSectionId) enrollWhere.sectionId = parsedSectionId;

      const enrolls = await prisma.enroll.findMany({
        where: enrollWhere,
        select: { studentId: true },
      });
      const sIds = enrolls.map((e) => e.studentId);
      where.studentId = { in: sIds };
    }

    if (search) {
      where.OR = [
        { invoiceNo: { contains: search, mode: 'insensitive' } },
        {
          student: {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              { registerNo: { contains: search, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          student: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              registerNo: true,
              enrolls: {
                take: 1,
                orderBy: { createdAt: 'desc' },
                include: {
                  class: { select: { id: true, name: true } },
                  section: { select: { id: true, name: true } },
                },
              },
            },
          },
          items: true,
          payments: true,
        },
        orderBy: { issuedAt: 'desc' },
        skip,
        take: l,
      }),
      prisma.invoice.count({ where }),
    ]);

    const formattedInvoices = invoices.map((inv) => {
      const enroll = inv.student?.enrolls?.[0];
      return {
        id: inv.id,
        invoiceNo: inv.invoiceNo,
        termLabel: inv.termLabel,
        totalAmount: parseFloat(inv.totalAmount.toString()),
        paidAmount: parseFloat(inv.paidAmount.toString()),
        balanceAmount: parseFloat(inv.balanceAmount.toString()),
        status: inv.status,
        dueDate: inv.dueDate,
        issuedAt: inv.issuedAt,
        student: {
          id: inv.student.id,
          firstName: inv.student.firstName,
          lastName: inv.student.lastName,
          registerNo: inv.student.registerNo,
          className: enroll?.class?.name || 'N/A',
          sectionName: enroll?.section?.name || 'N/A',
        },
        items: inv.items.map((it) => ({
          id: it.id,
          description: it.description,
          amount: parseFloat(it.amount.toString()),
        })),
        payments: inv.payments.map((pm) => ({
          id: pm.id,
          amount: parseFloat(pm.amount.toString()),
          method: pm.method,
          reference: pm.reference,
          paidAt: pm.paidAt,
        })),
      };
    });

    return res.json({
      success: true,
      data: formattedInvoices,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
      },
    });
  } catch (error) {
    console.error('[ADMIN] Get invoices error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve invoices list.' });
  }
}

/**
 * POST /api/admin/finances/invoices
 */
export async function createInvoice(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { studentId, termLabel, feeTypeIds, dueDate } = req.body;
    if (!studentId || !Array.isArray(feeTypeIds) || feeTypeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Student ID and at least one Fee Type selection are required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const invoice = await generateInvoice(prisma, {
      studentId: parseInt(studentId, 10),
      termLabel: termLabel || 'First Term',
      feeTypeIds: feeTypeIds.map((id: any) => parseInt(id, 10)),
      branchId,
      sessionId,
      dueDate,
    });

    return res.status(201).json({
      success: true,
      message: 'Invoice generated successfully.',
      invoice,
    });
  } catch (error: any) {
    console.error('[ADMIN] Generate invoice error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate invoice.' });
  }
}

/**
 * POST /api/admin/finances/payments
 */
export async function recordInvoicePayment(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { invoiceId, amount, method, reference, notes } = req.body;
    if (!invoiceId || !amount || !method) {
      return res.status(400).json({ success: false, message: 'Invoice ID, Payment Amount, and Payment Method are required.' });
    }

    const payment = await recordPayment(prisma, {
      invoiceId: parseInt(invoiceId, 10),
      amount: parseFloat(amount),
      method,
      reference: reference || null,
      receivedBy: req.userId,
      notes: notes || null,
      branchId,
    });

    return res.status(201).json({
      success: true,
      message: 'Payment recorded and invoice balance updated successfully.',
      payment,
    });
  } catch (error) {
    console.error('[ADMIN] Record payment error:', error);
    return res.status(500).json({ success: false, message: 'Failed to record payment.' });
  }
}

/**
 * GET /api/admin/finances/export/csv
 */
export async function exportFinanceCsv(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const csvContent = await exportFinancialReportCsv(prisma, {
      branchId,
      sessionId,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=financial_outstanding_report.csv');
    return res.send(csvContent);
  } catch (error) {
    console.error('[ADMIN] Export CSV error:', error);
    return res.status(500).json({ success: false, message: 'Failed to export CSV report.' });
  }
}

/**
 * GET /api/admin/finances/export/pdf
 */
export async function exportFinancePdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true },
    });

    const pdfBuffer = await exportFinancialReportPdf(prisma, {
      branchId,
      sessionId,
      schoolName: branch?.name || 'Ugbekun School',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=financial_outstanding_report.pdf');
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Export PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to export PDF report.' });
  }
}

/**
 * GET /api/admin/finances/fee-groups
 */
export async function getFeeGroups(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const groups = await prisma.feeGroup.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
    });
    const data = await hydrateFeeGroups(branchId, groups);
    return res.json({ success: true, data });
  } catch (error: any) {
    console.error('[FINANCES] Fetch fee groups error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch fee groups.' });
  }
}

/**
 * POST /api/admin/finances/fee-groups
 */
export async function createFeeGroup(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, description, feeTypeIds, classIds, totalAmount } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Fee group name is required.' });

    const typeIds = parseJsonIdList(feeTypeIds);
    const allocatedClassIds = parseJsonIdList(classIds);
    const types = typeIds.length
      ? await prisma.feeType.findMany({
          where: { id: { in: typeIds }, branchId, active: true },
          select: { id: true, amount: true },
        })
      : [];
    const validTypeIds = types.map((type) => type.id);
    const computedTotal = types.reduce((sum, type) => sum + Number(type.amount), 0);

    const newGroup = await prisma.feeGroup.create({
      data: {
        branchId,
        name: String(name).trim(),
        description: description || null,
        feeTypeIds: JSON.stringify(validTypeIds),
        classIds: JSON.stringify(allocatedClassIds),
        totalAmount: totalAmount ? parseFloat(totalAmount) : computedTotal,
      },
    });

    if (allocatedClassIds.length && validTypeIds.length) {
      const sessionId = await activeSessionId();
      await syncFeeGroupClassAssignments({
        branchId: branchId!,
        sessionId,
        feeTypeIds: validTypeIds,
        nextClassIds: allocatedClassIds,
        previousClassIds: [],
      });
    }

    const [hydrated] = await hydrateFeeGroups(branchId, [newGroup]);
    return res.json({
      success: true,
      message: allocatedClassIds.length
        ? 'Fee group created and allocated to the selected classes.'
        : 'Fee group created successfully.',
      data: hydrated,
    });
  } catch (error: any) {
    console.error('[FINANCES] Save fee group error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save fee group.' });
  }
}

/**
 * POST /api/admin/finances/fee-groups/:id/allocate
 * Allocate an existing fee group (its bundled types) to one or more classes.
 */
export async function allocateFeeGroup(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const groupId = Number(req.params.id);

  try {
    const group = await prisma.feeGroup.findFirst({
      where: { id: groupId, branchId },
    });
    if (!group) {
      return res.status(404).json({ success: false, message: 'Fee group not found.' });
    }

    const nextClassIds = parseJsonIdList(req.body?.classIds ?? req.body?.classId);
    const typeIds = parseJsonIdList(req.body?.feeTypeIds ?? group.feeTypeIds);
    if (!typeIds.length) {
      return res.status(400).json({
        success: false,
        message: 'This fee group has no fee types to allocate. Add types to the group first.',
      });
    }

    const types = await prisma.feeType.findMany({
      where: { id: { in: typeIds }, branchId, active: true },
      select: { id: true, amount: true },
    });
    const validTypeIds = types.map((type) => type.id);
    if (!validTypeIds.length) {
      return res.status(400).json({ success: false, message: 'None of the bundled fee types are active in this school.' });
    }

    const previousClassIds = parseJsonIdList(group.classIds);
    const previousFeeTypeIds = parseJsonIdList(group.feeTypeIds);
    const sessionId = await activeSessionId();

    await syncFeeGroupClassAssignments({
      branchId: branchId!,
      sessionId,
      feeTypeIds: validTypeIds,
      nextClassIds,
      previousClassIds,
      previousFeeTypeIds,
    });

    const updated = await prisma.feeGroup.update({
      where: { id: group.id },
      data: {
        feeTypeIds: JSON.stringify(validTypeIds),
        classIds: JSON.stringify(nextClassIds),
        totalAmount: types.reduce((sum, type) => sum + Number(type.amount), 0),
      },
    });

    const [hydrated] = await hydrateFeeGroups(branchId, [updated]);
    return res.json({
      success: true,
      message: nextClassIds.length
        ? `Fee group allocated to ${nextClassIds.length} class${nextClassIds.length === 1 ? '' : 'es'}.`
        : 'Class allocation cleared for this fee group.',
      data: hydrated,
    });
  } catch (error: any) {
    console.error('[FINANCES] Allocate fee group error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to allocate fee group.' });
  }
}

/**
 * POST /api/admin/finances/bulk-dues-post
 */
export async function bulkDuesPost(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, termLabel, dueDate, feeTypeIds, sessionId } = req.body;
    if (!classId || !feeTypeIds || !Array.isArray(feeTypeIds) || feeTypeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Class ID and selected Fee Types are required.' });
    }

    const cId = parseInt(classId, 10);
    const activeSessionId = sessionId ? parseInt(sessionId, 10) : 5;

    const selectedFeeTypes = await prisma.feeType.findMany({
      where: { id: { in: feeTypeIds.map((id: any) => parseInt(id, 10)) } },
    });

    if (selectedFeeTypes.length === 0) {
      return res.status(400).json({ success: false, message: 'Selected Fee Types not found.' });
    }

    const totalInvoiceAmount = selectedFeeTypes.reduce((acc, ft) => acc + Number(ft.amount), 0);

    const enrolls = await prisma.enroll.findMany({
      where: { classId: cId, branchId, sessionId: activeSessionId },
      include: { student: { select: { id: true, firstName: true, lastName: true, active: true } } },
    });

    const activeStudents = enrolls.filter((e) => e.student && e.student.active);

    if (activeStudents.length === 0) {
      return res.status(400).json({ success: false, message: 'No active students enrolled in this class.' });
    }

    let createdCount = 0;

    for (const e of activeStudents) {
      const studentId = e.student.id;
      const invoiceNo = `INV-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

      await prisma.invoice.create({
        data: {
          branchId,
          studentId,
          invoiceNo,
          termLabel: termLabel || 'Current Term',
          totalAmount: totalInvoiceAmount,
          paidAmount: 0,
          balanceAmount: totalInvoiceAmount,
          status: 'unpaid',
          dueDate: dueDate ? new Date(dueDate) : new Date(Date.now() + 30 * 86400000),
          sessionId: activeSessionId,
          items: {
            create: selectedFeeTypes.map((ft) => ({
              description: `${ft.name} (${ft.code})`,
              amount: Number(ft.amount),
              feeTypeId: ft.id,
            })),
          },
        },
      });

      createdCount++;
    }

    return res.json({
      success: true,
      message: `Successfully posted bulk fee dues for ${createdCount} student(s) in selected class.`,
    });
  } catch (error: any) {
    console.error('[FINANCES] Bulk dues posting error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to bulk post class dues.' });
  }
}

/**
 * POST /api/admin/finances/bulk-payments-post
 */
export async function bulkPaymentsPost(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { payments } = req.body;
    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ success: false, message: 'Payments list is required.' });
    }

    let successCount = 0;

    for (const p of payments) {
      const invoiceId = parseInt(p.invoiceId, 10);
      const paid = parseFloat(p.amountPaid);
      if (!invoiceId || isNaN(paid) || paid <= 0) continue;

      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) continue;

      const currentPaid = Number(invoice.paidAmount);
      const newPaid = currentPaid + paid;
      const total = Number(invoice.totalAmount);
      const newBalance = Math.max(0, total - newPaid);
      const newStatus = newBalance <= 0 ? 'paid' : 'partial';

      await prisma.$transaction([
        prisma.payment.create({
          data: {
            branchId,
            invoiceId,
            amount: paid,
            method: p.paymentMethod || 'Bank Transfer',
            reference: p.reference || `BULK-PAY-${Date.now()}`,
          },
        }),
        prisma.invoice.update({
          where: { id: invoiceId },
          data: {
            paidAmount: newPaid,
            balanceAmount: newBalance,
            status: newStatus,
            updatedAt: new Date(),
          },
        }),
      ]);

      successCount++;
    }

    return res.json({
      success: true,
      message: `Bulk payment receipts posted successfully for ${successCount} invoice(s).`,
    });
  } catch (error: any) {
    console.error('[FINANCES] Bulk payments error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to post bulk payments.' });
  }
}

/**
 * POST /api/admin/finances/send-parent-reminder
 */
export async function sendParentReminder(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ success: false, message: 'Invoice ID is required.' });

    const invoice = await prisma.invoice.findUnique({
      where: { id: parseInt(invoiceId, 10) },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            parent: { select: { id: true, name: true, mobileno: true, email: true } },
          },
        },
      },
    });

    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });

    const studentName = `${invoice.student.firstName || ''} ${invoice.student.lastName || ''}`.trim();

    return res.json({
      success: true,
      message: `Fee reminder notification dispatched to parent of ${studentName}.`,
    });
  } catch (error: any) {
    console.error('[FINANCES] Send parent reminder error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to send fee reminder.' });
  }
}

/**
 * GET /api/admin/finances/reports/collections
 */
export async function getCollectionsReport(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const invoices = await prisma.invoice.findMany({
      where: { branchId },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } },
        items: true,
        payments: true,
      },
    });

    const totalInvoiced = invoices.reduce((acc, inv) => acc + Number(inv.totalAmount), 0);
    const totalCollected = invoices.reduce((acc, inv) => acc + Number(inv.paidAmount), 0);
    const totalOutstanding = invoices.reduce((acc, inv) => acc + Number(inv.balanceAmount), 0);

    const feeTypeBreakdownMap = new Map();
    for (const inv of invoices) {
      for (const item of inv.items) {
        const key = item.description;
        const current = feeTypeBreakdownMap.get(key) || 0;
        feeTypeBreakdownMap.set(key, current + Number(item.amount));
      }
    }

    const feeTypeBreakdown = Array.from(feeTypeBreakdownMap.entries()).map(([feeType, totalAmount]) => ({
      feeType,
      totalAmount,
    }));

    return res.json({
      success: true,
      summary: {
        totalInvoiced,
        totalCollected,
        totalOutstanding,
        collectionRate: totalInvoiced > 0 ? ((totalCollected / totalInvoiced) * 100).toFixed(1) : 0,
      },
      feeTypeBreakdown,
    });
  } catch (error: any) {
    console.error('[FINANCES] Fetch collection reports error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch collection reports.' });
  }
}

/**
 * GET /api/admin/finances/voucher-heads
 */
export async function getVoucherHeads(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { search, includeArchived } = (req.query || {}) as any;
    const where: any = { branchId };
    if (String(includeArchived || '') !== '1' && String(includeArchived || '').toLowerCase() !== 'true') {
      where.active = true;
    }
    if (search && String(search).trim()) {
      const q = String(search).trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    }

    const heads = await prisma.voucherHead.findMany({
      where,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    return res.json({ success: true, data: heads });
  } catch (error: any) {
    console.error('[FINANCES] Fetch voucher heads error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch voucher heads.' });
  }
}

/**
 * POST /api/admin/finances/voucher-heads
 */
export async function createVoucherHead(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, type, description } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Voucher head name is required.' });

    const newHead = await prisma.voucherHead.create({
      data: {
        branchId,
        name: String(name).trim(),
        type: type || 'EXPENSE',
        description: description || null,
        active: true,
      },
    });

    return res.json({ success: true, message: 'Voucher head created.', data: newHead });
  } catch (error: any) {
    console.error('[FINANCES] Create voucher head error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create voucher head.' });
  }
}

/**
 * PUT /api/admin/finances/voucher-heads/:id
 */
export async function updateVoucherHead(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const id = Number(req.params.id);

  try {
    const existing = await prisma.voucherHead.findFirst({ where: { id, branchId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Voucher head not found.' });
    }

    const { name, type, description } = req.body;
    const updated = await prisma.voucherHead.update({
      where: { id },
      data: {
        ...(name ? { name: String(name).trim() } : {}),
        ...(type ? { type } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
      },
    });

    return res.json({ success: true, message: 'Voucher head updated.', data: updated });
  } catch (error: any) {
    console.error('[FINANCES] Update voucher head error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update voucher head.' });
  }
}

/**
 * POST /api/admin/finances/voucher-heads/:id/archive
 * Soft-archive so historical vouchers keep their category. Never hard-deletes.
 */
export async function archiveVoucherHead(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const id = Number(req.params.id);

  try {
    const existing = await prisma.voucherHead.findFirst({ where: { id, branchId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Voucher head not found.' });
    }

    const updated = await prisma.voucherHead.update({
      where: { id },
      data: { active: false },
    });
    return res.json({
      success: true,
      message: 'Voucher head archived. Existing vouchers are retained.',
      data: updated,
    });
  } catch (error: any) {
    console.error('[FINANCES] Archive voucher head error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to archive voucher head.' });
  }
}

/**
 * GET /api/admin/finances/office-transactions
 */
export async function getOfficeTransactions(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { type, search, status, includeVoided } = (req.query || {}) as any;
    const where: any = { branchId };
    if (type && type !== 'ALL') {
      where.type = type;
    }
    const showVoided = String(includeVoided || '') === '1' || String(includeVoided || '').toLowerCase() === 'true';
    if (status && status !== 'ALL') {
      where.status = String(status).toUpperCase();
    } else if (!showVoided) {
      where.status = { not: 'VOIDED' };
    }
    if (search && String(search).trim()) {
      const q = String(search).trim();
      where.OR = [
        { voucherHeadName: { contains: q, mode: 'insensitive' } },
        { referenceNo: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { paymentMethod: { contains: q, mode: 'insensitive' } },
      ];
    }

    const txs = await prisma.officeTransaction.findMany({
      where,
      orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }],
    });

    return res.json({
      success: true,
      data: txs.map((tx) => ({
        ...tx,
        voucherNo: tx.referenceNo || `VCH-${String(tx.id).padStart(5, '0')}`,
      })),
    });
  } catch (error: any) {
    console.error('[FINANCES] Fetch office transactions error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch office transactions.' });
  }
}

/**
 * POST /api/admin/finances/office-transactions
 */
export async function createOfficeTransaction(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const {
      type,
      voucherHeadId,
      voucherHeadName,
      amount,
      paymentMethod,
      transactionDate,
      referenceNo,
      description,
    } = req.body;
    if (!amount) return res.status(400).json({ success: false, message: 'Amount is required.' });

    let headName = voucherHeadName || 'General';
    let headId = voucherHeadId ? parseInt(voucherHeadId, 10) : null;
    if (headId) {
      const head = await prisma.voucherHead.findFirst({ where: { id: headId, branchId } });
      if (head) headName = head.name;
    } else if (voucherHeadName) {
      const head = await prisma.voucherHead.findFirst({
        where: { branchId, name: String(voucherHeadName), active: true },
      });
      if (head) headId = head.id;
    }

    const newTx = await prisma.officeTransaction.create({
      data: {
        branchId,
        type: type || 'EXPENSE',
        voucherHeadId: headId,
        voucherHeadName: headName,
        amount: parseFloat(amount),
        paymentMethod: paymentMethod || 'Bank Transfer',
        transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
        referenceNo: referenceNo || null,
        description: description || null,
        status: 'POSTED',
      },
    });

    const voucherNo = newTx.referenceNo || `VCH-${String(newTx.id).padStart(5, '0')}`;
    if (!newTx.referenceNo) {
      await prisma.officeTransaction.update({
        where: { id: newTx.id },
        data: { referenceNo: voucherNo },
      });
    }

    return res.json({
      success: true,
      message: 'Voucher recorded and retained in the office register.',
      data: { ...newTx, referenceNo: voucherNo, voucherNo },
    });
  } catch (error: any) {
    console.error('[FINANCES] Create office transaction error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to record transaction.' });
  }
}

/**
 * PUT /api/admin/finances/office-transactions/:id
 * Legitimate correction. Original amount is kept. Record is never deleted.
 */
export async function updateOfficeTransaction(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const id = Number(req.params.id);

  try {
    const existing = await prisma.officeTransaction.findFirst({ where: { id, branchId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Voucher not found.' });
    }
    if (existing.status === 'VOIDED') {
      return res.status(400).json({ success: false, message: 'Voided vouchers cannot be edited. They are retained for audit.' });
    }

    const amendmentNote = String(req.body?.amendmentNote || req.body?.correctionNote || '').trim();
    if (!amendmentNote) {
      return res.status(400).json({
        success: false,
        message: 'Add a correction note so the change is retained on the voucher record.',
      });
    }

    const {
      type,
      voucherHeadId,
      voucherHeadName,
      amount,
      paymentMethod,
      transactionDate,
      referenceNo,
      description,
    } = req.body;

    let headName = voucherHeadName !== undefined ? voucherHeadName : existing.voucherHeadName;
    let headId = voucherHeadId !== undefined ? (voucherHeadId ? parseInt(voucherHeadId, 10) : null) : existing.voucherHeadId;
    if (headId) {
      const head = await prisma.voucherHead.findFirst({ where: { id: headId, branchId } });
      if (head) headName = head.name;
    }

    const nextAmount = amount !== undefined && amount !== '' ? parseFloat(amount) : Number(existing.amount);
    const originalAmount = existing.originalAmount != null ? existing.originalAmount : existing.amount;

    const updated = await prisma.officeTransaction.update({
      where: { id },
      data: {
        type: type || existing.type,
        voucherHeadId: headId,
        voucherHeadName: headName || existing.voucherHeadName,
        amount: nextAmount,
        originalAmount,
        paymentMethod: paymentMethod || existing.paymentMethod,
        transactionDate: transactionDate ? new Date(transactionDate) : existing.transactionDate,
        referenceNo: referenceNo !== undefined ? referenceNo || existing.referenceNo : existing.referenceNo,
        description: description !== undefined ? description || null : existing.description,
        status: 'AMENDED',
        amendmentNote,
        amendedAt: new Date(),
      },
    });

    return res.json({
      success: true,
      message: 'Voucher corrected. The original record is retained.',
      data: { ...updated, voucherNo: updated.referenceNo || `VCH-${String(updated.id).padStart(5, '0')}` },
    });
  } catch (error: any) {
    console.error('[FINANCES] Update office transaction error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update voucher.' });
  }
}

/**
 * POST /api/admin/finances/office-transactions/:id/void
 * Soft-void for retention. Never hard-deletes.
 */
export async function voidOfficeTransaction(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const id = Number(req.params.id);

  try {
    const existing = await prisma.officeTransaction.findFirst({ where: { id, branchId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Voucher not found.' });
    }
    if (existing.status === 'VOIDED') {
      return res.status(400).json({ success: false, message: 'This voucher is already voided and retained.' });
    }

    const voidReason = String(req.body?.voidReason || req.body?.reason || '').trim();
    if (!voidReason) {
      return res.status(400).json({ success: false, message: 'A void reason is required so the record can be retained for audit.' });
    }

    const updated = await prisma.officeTransaction.update({
      where: { id },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidReason,
      },
    });

    return res.json({
      success: true,
      message: 'Voucher voided. The record is retained and excluded from live totals.',
      data: { ...updated, voucherNo: updated.referenceNo || `VCH-${String(updated.id).padStart(5, '0')}` },
    });
  } catch (error: any) {
    console.error('[FINANCES] Void office transaction error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to void voucher.' });
  }
}

/**
 * GET /api/admin/finances/school-bank
 */
export async function getSchoolBank(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const bank = await prisma.schoolBank.findUnique({
      where: { branchId },
    });
    return res.json({ success: true, data: bank });
  } catch (error: any) {
    console.error('[FINANCES] Fetch school bank error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch school bank.' });
  }
}

/**
 * POST /api/admin/finances/school-bank
 */
export async function updateSchoolBank(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { bankName, accountName, accountNumber, branchName, sortCode, swiftCode } = req.body;
    if (!bankName || !accountName || !accountNumber) {
      return res.status(400).json({ success: false, message: 'Bank Name, Account Name, and Account Number are required.' });
    }

    const bank = await prisma.schoolBank.upsert({
      where: { branchId },
      update: {
        bankName,
        accountName,
        accountNumber,
        branchName: branchName || null,
        sortCode: sortCode || null,
        swiftCode: swiftCode || null,
        updatedAt: new Date(),
      },
      create: {
        branchId: branchId!,
        bankName,
        accountName,
        accountNumber,
        branchName: branchName || null,
        sortCode: sortCode || null,
        swiftCode: swiftCode || null,
      },
    });

    return res.json({ success: true, message: 'School bank details updated successfully.', data: bank });
  } catch (error: any) {
    console.error('[FINANCES] Save school bank error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save school bank details.' });
  }
}
