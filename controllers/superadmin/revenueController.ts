import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import {
  getMultiBranchRevenueAnalytics,
  exportRevenueReportCsv,
  exportRevenueReportPdf,
} from '../../lib/revenueAnalyticsService';

/**
 * GET /api/superadmin/analytics
 */
export async function getAnalytics(req: Request, res: Response): Promise<Response | void> {
  try {
    const data = await getMultiBranchRevenueAnalytics(prisma, { period: 'all' });
    return res.json({ success: true, data });
  } catch (error: any) {
    console.error('[SUPERADMIN] Analytics error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load platform analytics.' });
  }
}

/**
 * GET /api/superadmin/revenue-analytics
 */
export async function getRevenueAnalytics(req: Request, res: Response): Promise<Response | void> {
  try {
    const data = await getMultiBranchRevenueAnalytics(prisma, { period: 'all' });
    return res.json({ success: true, data });
  } catch (error: any) {
    console.error('[SUPERADMIN] Revenue analytics error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load revenue analytics.' });
  }
}

/**
 * GET /api/superadmin/revenue-analytics/export/csv
 */
export async function exportRevenueCsv(req: Request, res: Response): Promise<Response | void> {
  try {
    const data = await getMultiBranchRevenueAnalytics(prisma, { period: 'all' });
    const csv = exportRevenueReportCsv(data);
    const filename = `ugbekun-revenue-analytics-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(`\uFEFF${csv}`);
  } catch (error: any) {
    console.error('[SUPERADMIN] Revenue CSV export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to export revenue analytics as CSV.' });
  }
}

/**
 * GET /api/superadmin/revenue-analytics/export/pdf
 */
export async function exportRevenuePdf(req: Request, res: Response): Promise<Response | void> {
  try {
    const data = await getMultiBranchRevenueAnalytics(prisma, { period: 'all' });
    const pdf = await exportRevenueReportPdf(data);
    const filename = `ugbekun-revenue-analytics-${new Date().toISOString().slice(0, 10)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdf);
  } catch (error: any) {
    console.error('[SUPERADMIN] Revenue PDF export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to export revenue analytics as PDF.' });
  }
}
