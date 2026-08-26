import { Request, Response } from 'express';
import prisma from '../../lib/prisma';

/**
 * GET /api/parent/child/:studentId/invoices
 */
export async function getChildInvoices(req: Request, res: Response): Promise<Response | void> {
  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        studentId: req.studentId,
        branchId: req.studentBranchId,
      },
      include: {
        items: true,
        payments: {
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const schoolBank = await prisma.schoolBank.findFirst({
      where: {
        branchId: req.studentBranchId,
        isActive: true,
      },
    });

    let totalFeeAmount = 0;
    let totalPaidAmount = 0;

    const formattedInvoices = invoices.map((inv) => {
      const amount = Number(inv.totalAmount || 0);
      const paid = Number(inv.paidAmount || 0);
      const balance = Number(inv.balanceAmount || 0);
      totalFeeAmount += amount;
      totalPaidAmount += paid;

      return {
        id: inv.id,
        invoiceNo: inv.invoiceNo || `INV-${inv.id}`,
        title: 'Term Fee Invoice',
        amount,
        discount: 0,
        fine: 0,
        paidAmount: paid,
        balance,
        status: inv.status || (balance <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid'),
        dueDate: inv.dueDate,
        createdAt: inv.createdAt,
        items: inv.items.map((item) => ({
          id: item.id,
          name: item.description,
          amount: Number(item.amount || 0),
        })),
        payments: inv.payments.map((p) => ({
          id: p.id,
          amount: Number(p.amount || 0),
          paymentMethod: p.method,
          transactionRef: p.reference,
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
    console.error('[PARENT] Get child invoices error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve fee invoices.' });
  }
}
