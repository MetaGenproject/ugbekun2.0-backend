import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { recordPayment } from '../../lib/accountingService';
import { initializeOnlinePayment, publicPaymentConfig, verifyOnlinePayment } from '../../lib/paymentGateway';

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
      paymentGateway: publicPaymentConfig(),
    });
  } catch (error) {
    console.error('[PARENT] Get child invoices error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve fee invoices.' });
  }
}

async function parentEmail(req: Request) {
  const parent = await prisma.parent.findFirst({
    where: {
      OR: [{ id: Number(req.parentId) }, { userId: Number(req.userId) }],
    },
    select: { email: true },
  });
  const user = await prisma.user.findFirst({
    where: { id: Number(req.userId) },
    select: { username: true },
  }).catch(() => null);
  return parent?.email || (user?.username?.includes('@') ? user.username : '') || 'fees@ugbekun.com';
}

/**
 * POST /api/parent/child/:studentId/invoices/:invoiceId/pay
 */
export async function initializeChildInvoicePayment(req: Request, res: Response): Promise<Response | void> {
  try {
    const invoiceId = Number(req.params.invoiceId);
    const invoice = await prisma.invoice.findFirst({
      where: {
        id: invoiceId,
        studentId: req.studentId,
        branchId: req.studentBranchId,
      },
    });
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    const balance = Number(invoice.balanceAmount || 0);
    if (balance <= 0) return res.status(400).json({ success: false, message: 'This invoice is already paid.' });

    const email = await parentEmail(req);
    const checkout = await initializeOnlinePayment({
      email,
      amount: balance,
      invoiceId: invoice.id,
      studentId: Number(req.studentId),
      branchId: Number(req.studentBranchId),
    });
    return res.json({ success: true, ...checkout });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message || 'Unable to start online payment.' });
  }
}

/**
 * POST /api/parent/payments/verify
 */
export async function verifyChildInvoicePayment(req: Request, res: Response): Promise<Response | void> {
  try {
    const reference = String(req.body?.reference || '').trim();
    if (!reference) return res.status(400).json({ success: false, message: 'Payment reference is required.' });

    const verified = await verifyOnlinePayment(reference);
    const invoiceId = Number(verified.metadata.invoiceId || req.body?.invoiceId);
    if (!invoiceId) return res.status(400).json({ success: false, message: 'Invoice metadata missing from payment.' });

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId },
      include: { student: { select: { parentId: true } } },
    });
    if (!invoice || invoice.student.parentId !== req.parentId) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const existing = await prisma.payment.findFirst({
      where: { reference, invoiceId: invoice.id },
    });
    if (existing) {
      return res.json({ success: true, message: 'Payment already recorded.', alreadyRecorded: true });
    }

    await recordPayment(prisma, {
      invoiceId: invoice.id,
      amount: verified.amount,
      method: verified.provider,
      reference,
      receivedBy: Number(req.userId) || undefined,
      notes: `Verified ${verified.provider} payment`,
      branchId: invoice.branchId,
    });

    return res.json({ success: true, message: 'Payment verified and recorded.' });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message || 'Unable to verify payment.' });
  }
}
