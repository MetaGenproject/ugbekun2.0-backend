import { Request, Response } from 'express';
import prisma from '../../lib/prisma';

/**
 * GET /api/student/invoices
 */
export async function getInvoices(req: Request, res: Response): Promise<Response | void> {
  try {
    const [invoices, schoolBank] = await Promise.all([
      prisma.invoice.findMany({
        where: { studentId: req.studentId, branchId: req.branchId },
        include: {
          items: true,
          payments: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.schoolBank.findUnique({
        where: { branchId: req.branchId },
      }),
    ]);

    let totalFeeAmount = 0;
    let totalPaidAmount = 0;

    const formattedInvoices = invoices.map((inv) => {
      const amount = Number(inv.totalAmount || 0);
      const paid = inv.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const balance = Math.max(0, amount - paid);

      totalFeeAmount += amount;
      totalPaidAmount += paid;

      let status = 'UNPAID';
      if (balance === 0 && amount > 0) status = 'PAID';
      else if (paid > 0) status = 'PARTIAL';

      return {
        id: inv.id,
        invoiceNo: inv.invoiceNo || `INV-${inv.id}`,
        title: 'Term School Fee Invoice',
        amount,
        discount: 0,
        fine: 0,
        paidAmount: paid,
        balance,
        status,
        dueDate: inv.dueDate,
        createdAt: inv.createdAt,
        items: inv.items.map((it) => ({ id: it.id, name: it.description, amount: Number(it.amount || 0) })),
        payments: inv.payments.map((p) => ({
          id: p.id,
          amount: Number(p.amount || 0),
          paymentMethod: p.method || 'Bank Transfer',
          paidAt: p.createdAt,
        })),
      };
    });

    const totalBalance = Math.max(0, totalFeeAmount - totalPaidAmount);

    return res.json({
      success: true,
      invoices: formattedInvoices,
      schoolBank: schoolBank
        ? {
            bankName: schoolBank.bankName,
            accountName: schoolBank.accountName,
            accountNumber: schoolBank.accountNumber,
            branchName: schoolBank.branchName,
            sortCode: schoolBank.sortCode,
          }
        : null,
      totalFeeAmount,
      totalPaidAmount,
      totalBalance,
    });
  } catch (error) {
    console.error('[STUDENT] Invoices fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch invoices.' });
  }
}
