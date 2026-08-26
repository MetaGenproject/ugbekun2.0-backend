import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { DEFAULT_PLANS, addMonths } from '../../lib/plans';
import { sendGracePeriodExtensionEmail } from '../../lib/emailService';
import { parseBranchId } from './branchController';

export async function ensurePlansSeeded() {
  for (const plan of DEFAULT_PLANS) {
    await prisma.subscriptionPlan.upsert({
      where: { slug: plan.slug },
      update: {
        name: plan.name,
        description: plan.description,
        priceMonthly: plan.priceMonthly,
        durationMonths: plan.durationMonths,
        totalCost: plan.totalCost,
        currency: plan.currency,
        active: true,
      },
      create: {
        slug: plan.slug,
        name: plan.name,
        description: plan.description,
        priceMonthly: plan.priceMonthly,
        durationMonths: plan.durationMonths,
        totalCost: plan.totalCost,
        currency: plan.currency,
        active: true,
      },
    });
  }
}

/**
 * GET /api/superadmin/subscriptions
 */
export async function getSubscriptions(req: Request, res: Response): Promise<Response | void> {
  try {
    await ensurePlansSeeded();

    const [plans, subscriptions] = await Promise.all([
      prisma.subscriptionPlan.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
      prisma.branchSubscription.findMany({
        orderBy: { id: 'desc' },
        include: {
          branch: { select: { id: true, name: true, code: true, email: true, phone: true } },
          plan: true,
        },
      }),
    ]);

    return res.json({ success: true, data: { plans, subscriptions } });
  } catch (error: any) {
    console.error('[SUPERADMIN] Subscriptions list error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load subscriptions.' });
  }
}

/**
 * POST /api/superadmin/branches/:id/renew-subscription
 */
export async function renewSubscription(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseBranchId(req, res);
  if (!branchId) return;

  try {
    const { planId, months } = req.body;
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: Number(planId) } });
    if (!plan) {
      return res.status(400).json({ success: false, message: 'Selected plan not found.' });
    }

    const duration = months ? Number(months) : plan.durationMonths;
    const startDate = new Date();
    const expiryDate = addMonths(startDate, duration);

    const subscription = await prisma.branchSubscription.create({
      data: {
        branchId,
        planId: plan.id,
        startDate,
        expiryDate,
        totalCost: plan.totalCost,
        paymentStatus: 'paid',
        termsAccepted: true,
      },
      include: { plan: true },
    });

    await prisma.branch.update({
      where: { id: branchId },
      data: { active: true },
    });

    return res.json({ success: true, message: 'Subscription renewed successfully.', data: subscription });
  } catch (error: any) {
    console.error('[SUPERADMIN] Renew subscription error:', error);
    return res.status(500).json({ success: false, message: 'Failed to renew subscription.' });
  }
}

/**
 * POST /api/superadmin/branches/:id/extend-subscription
 */
export async function extendSubscription(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseBranchId(req, res);
  if (!branchId) return;

  try {
    const { days = 7, reason } = req.body;
    const extensionDays = Number(days) || 7;

    const latestSub = await prisma.branchSubscription.findFirst({
      where: { branchId },
      orderBy: { id: 'desc' },
    });

    const baseDate = latestSub && latestSub.expiryDate > new Date() ? latestSub.expiryDate : new Date();
    const newExpiry = new Date(baseDate.getTime() + extensionDays * 24 * 60 * 60 * 1000);

    let updatedSub;
    if (latestSub) {
      updatedSub = await prisma.branchSubscription.update({
        where: { id: latestSub.id },
        data: {
          expiryDate: newExpiry,
          paymentStatus: 'paid',
          message: reason ? `Extended: ${reason}` : latestSub.message,
        },
      });
    }

    const branch = await prisma.branch.update({
      where: { id: branchId },
      data: { active: true },
    });

    if (branch.email) {
      sendGracePeriodExtensionEmail({
        adminEmail: branch.email,
        schoolName: branch.name,
        newExpiryDate: newExpiry.toISOString().slice(0, 10),
        days: extensionDays,
      }).catch((err) =>
        console.error('[SUPERADMIN] Grace period email error:', err)
      );
    }

    return res.json({
      success: true,
      message: `Subscription extended by ${extensionDays} days.`,
      data: { newExpiry, subscription: updatedSub },
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Extend subscription error:', error);
    return res.status(500).json({ success: false, message: 'Failed to extend subscription.' });
  }
}
