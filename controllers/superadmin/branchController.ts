import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { uploadBase64Image } from '../../lib/cloudinary';
import { getBranchStatsMap } from '../../lib/branchStats';
import { BRANCH_SELECT, branchesToCsv, buildBranchesPdf } from '../../lib/branchExport';
import { deleteBranchCascade } from '../../lib/branchDelete';
import { addMonths } from '../../lib/plans';
import { ensurePlansSeeded } from './subscriptionController';

export function generateTempPassword(): string {
  const bytes = crypto.randomBytes(12).toString('base64url');
  return `Temp-${bytes}!9`;
}

export function generateBranchCode(seed: any): string {
  const cleaned = String(seed || '')
    .trim()
    .replace(/[^a-zA-Z0-9\s]/g, '');
  const initials = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${initials || 'SCH'}${suffix}`;
}

export async function loadBranchesWithStats(branchId?: number) {
  const branches = await prisma.branch.findMany({
    where: branchId ? { id: branchId } : undefined,
    orderBy: { name: 'asc' },
    select: BRANCH_SELECT,
  });

  if (branchId && !branches.length) return null;

  const statsByBranch = await getBranchStatsMap(prisma, branches);
  return branches.map((branch) => {
    const stats = statsByBranch.get(branch.id) || {
      students: 0,
      parents: 0,
      teachers: 0,
      staff: 0,
    };

    return {
      ...branch,
      students: stats.students,
      parents: stats.parents,
      teachers: stats.teachers,
      staff: stats.staff,
    };
  });
}

export function parseBranchId(req: Request, res: Response): number | null {
  const branchId = Number(req.params.id);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    res.status(400).json({ success: false, message: 'Invalid branch id.' });
    return null;
  }
  return branchId;
}

export async function saveLogoBase64(logoBase64: any, logoFileName: any, folder: any) {
  if (!logoBase64) return null;

  const match = String(logoBase64).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  const mime = match ? match[1] : 'image/png';
  const data = match ? match[2] : logoBase64;

  return await uploadBase64Image({
    base64: data,
    mime,
    folder: `ugbekun2/branches/${String(folder || 'branch').slice(0, 64)}/logos`,
    tags: ['ugbekun2', 'branch-logo'],
  });
}

/**
 * GET /api/superadmin/stats
 */
export async function getStats(req: Request, res: Response): Promise<Response | void> {
  try {
    const [branches, activeBranches, students, teachers, parents, users] = await Promise.all([
      prisma.branch.count(),
      prisma.branch.count({ where: { active: true } }),
      prisma.student.count(),
      prisma.teacher.count(),
      prisma.parent.count(),
      prisma.user.count(),
    ]);

    return res.json({
      success: true,
      data: {
        branches,
        activeBranches,
        students,
        teachers,
        parents,
        users,
      },
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Stats error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load platform stats.',
    });
  }
}

/**
 * GET /api/superadmin/branches
 */
export async function getBranches(req: Request, res: Response): Promise<Response | void> {
  try {
    const data = await loadBranchesWithStats();
    return res.json({ success: true, data });
  } catch (error: any) {
    console.error('[SUPERADMIN] Branch list error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load branch list.',
    });
  }
}

/**
 * GET /api/superadmin/branches/export.csv
 */
export async function exportBranchesCsv(req: Request, res: Response): Promise<Response | void> {
  try {
    const branches = await loadBranchesWithStats();
    const csv = branchesToCsv(branches);
    const filename = `ugbekun-branches-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(`\uFEFF${csv}`);
  } catch (error: any) {
    console.error('[SUPERADMIN] Branch CSV export error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to export branches as CSV.',
    });
  }
}

/**
 * GET /api/superadmin/branches/export.pdf
 */
export async function exportBranchesPdf(req: Request, res: Response): Promise<Response | void> {
  try {
    const branches = await loadBranchesWithStats();
    const pdf = await buildBranchesPdf(branches);
    const filename = `ugbekun-branches-${new Date().toISOString().slice(0, 10)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdf);
  } catch (error: any) {
    console.error('[SUPERADMIN] Branch PDF export error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to export branches as PDF.',
    });
  }
}

/**
 * GET /api/superadmin/branches/:id
 */
export async function getBranchById(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseBranchId(req, res);
  if (!branchId) return;

  try {
    const rows = await loadBranchesWithStats(branchId);
    if (!rows?.length) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (error: any) {
    console.error('[SUPERADMIN] Branch detail error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load branch details.',
    });
  }
}

/**
 * PUT /api/superadmin/branches/:id
 */
export async function updateBranch(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseBranchId(req, res);
  if (!branchId) return;

  try {
    const existing = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }

    const body = req.body || {};
    const name = (body.name || body.schoolName || '').trim();
    const code = body.code != null ? String(body.code).trim() : undefined;
    const adminName = body.adminName != null ? String(body.adminName).trim() : undefined;
    const email = body.email != null ? String(body.email).trim().toLowerCase() : undefined;
    const phone = body.phone != null ? String(body.phone).trim() : undefined;
    const city = body.city != null ? String(body.city).trim() : undefined;
    const state = body.state != null ? String(body.state).trim() : undefined;
    const address = body.address != null ? String(body.address).trim() : undefined;
    const active = body.active != null ? Boolean(body.active) : undefined;

    if (!name) {
      return res.status(400).json({ success: false, message: 'School name is required.' });
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email.' });
    }

    if (code) {
      const codeConflict = await prisma.branch.findFirst({
        where: { code, NOT: { id: branchId } },
        select: { id: true },
      });
      if (codeConflict) {
        return res.status(400).json({ success: false, message: 'Branch code already in use.' });
      }
    }

    const updated = await prisma.branch.update({
      where: { id: branchId },
      data: {
        name,
        ...(code !== undefined ? { code: code || null } : {}),
        ...(adminName !== undefined ? { adminName: adminName || null } : {}),
        ...(email !== undefined ? { email: email || null } : {}),
        ...(phone !== undefined ? { phone: phone || null } : {}),
        ...(city !== undefined ? { city: city || null } : {}),
        ...(state !== undefined ? { state: state || null } : {}),
        ...(address !== undefined ? { address: address || null } : {}),
        ...(active !== undefined ? { active } : {}),
      },
      select: BRANCH_SELECT,
    });

    const statsMap = await getBranchStatsMap(prisma, [updated]);
    const stats = statsMap.get(updated.id) || { students: 0, parents: 0, teachers: 0, staff: 0 };

    return res.json({
      success: true,
      message: 'Branch updated successfully.',
      data: { ...updated, ...stats },
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Branch update error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to update branch.',
    });
  }
}

/**
 * DELETE /api/superadmin/branches/:id
 */
export async function deleteBranch(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseBranchId(req, res);
  if (!branchId) return;

  try {
    const existing = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, name: true },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }

    await prisma.$transaction((tx) => deleteBranchCascade(tx, branchId));

    return res.json({
      success: true,
      message: `Branch "${existing.name}" deleted successfully.`,
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Branch delete error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to delete branch.',
    });
  }
}

/**
 * POST /api/superadmin/branches
 */
export async function createBranch(req: Request, res: Response): Promise<Response | void> {
  try {
    await ensurePlansSeeded();

    const body = req.body || {};
    const branchName = (body.branchName || '').trim();
    const schoolName = (body.schoolName || '').trim();
    const adminName = (body.adminName || '').trim();
    const email = (body.email || '').trim().toLowerCase();
    const mobileNo = (body.mobileNo || '').trim();
    const city = (body.city || '').trim();
    const state = (body.state || '').trim();
    const address = (body.address || '').trim();
    const planId = body.planId ? Number(body.planId) : null;
    const status = String(body.status || 'inactive').toLowerCase();
    const statusActive = status === 'active';

    const required = [
      ['branchName', branchName],
      ['schoolName', schoolName],
      ['adminName', adminName],
      ['email', email],
      ['mobileNo', mobileNo],
      ['city', city],
      ['state', state],
      ['address', address],
    ];

    for (const [k, v] of required) {
      if (!v) {
        return res.status(400).json({ success: false, message: `${k} is required.` });
      }
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email.' });
    }

    if (!planId) {
      return res.status(400).json({ success: false, message: 'Please select a subscription plan.' });
    }

    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) {
      return res.status(400).json({ success: false, message: 'Selected plan not found.' });
    }

    let code = (body.code || '').trim();
    if (!code) {
      code = generateBranchCode(branchName || schoolName);
    }

    let codeAttempts = 0;
    while (codeAttempts < 5) {
      const conflict = await prisma.branch.findUnique({ where: { code } });
      if (!conflict) break;
      code = generateBranchCode(branchName || schoolName);
      codeAttempts += 1;
    }

    const emailPrefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
    let baseUsername = (body.adminUsername || `${emailPrefix}_admin`).trim().toLowerCase();
    if (!baseUsername) baseUsername = `admin_${code.toLowerCase()}`;

    let username = baseUsername;
    let uAttempts = 0;
    while (uAttempts < 5) {
      const userConflict = await prisma.user.findFirst({ where: { username } });
      if (!userConflict) break;
      username = `${baseUsername}_${Math.floor(100 + Math.random() * 900)}`;
      uAttempts += 1;
    }

    const initialPassword = body.adminPassword ? String(body.adminPassword).trim() : generateTempPassword();
    const hashedPassword = await bcrypt.hash(initialPassword, 10);
    const logoUrl = await saveLogoBase64(body.logoBase64, body.logoFileName, code);

    const startDate = new Date();
    const expiryDate = addMonths(startDate, plan.durationMonths);

    const result = await prisma.$transaction(async (tx: any) => {
      const branch = await tx.branch.create({
        data: {
          name: branchName,
          code,
          adminName,
          email,
          phone: mobileNo,
          city,
          state,
          address,
          active: statusActive,
          logo: logoUrl,
        },
      });

      await tx.systemSetting.create({
        data: {
          branchId: branch.id,
          schoolName,
          address,
          phone: mobileNo,
          email,
          currencySymbol: '₦',
          academicSession: '2025/2026',
          currentTerm: 'First Term',
          logoUrl: logoUrl || undefined,
        },
      });

      await tx.schoolLandingPage.create({
        data: {
          branchId: branch.id,
          heroHeadline: `Welcome to ${schoolName}`,
          heroSubheadline: 'Empowering minds, building character, and inspiring greatness.',
          aboutText: `${schoolName} is dedicated to nurturing future leaders through holistic education and modern facilities.`,
          primaryColor: '#0284c7',
          secondaryColor: '#0f172a',
          isEnabled: true,
          showAdmissionCta: true,
          showPortalLoginCta: true,
        },
      });

      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' } });
      const nextUserId = maxUser ? maxUser.id + 1 : 1;

      const adminUser = await tx.user.create({
        data: {
          id: nextUserId,
          username,
          password: hashedPassword,
          role: 2,
          legacyUserId: branch.id,
          active: true,
        },
      });

      const subscription = await tx.branchSubscription.create({
        data: {
          branchId: branch.id,
          planId: plan.id,
          startDate,
          expiryDate,
          totalCost: plan.totalCost,
          paymentStatus: statusActive ? 'paid' : 'pending',
          termsAccepted: true,
        },
        include: { plan: true },
      });

      return { branch, adminUser, subscription };
    }, { maxWait: 15000, timeout: 30000 });

    return res.status(201).json({
      success: true,
      message: 'Branch created successfully.',
      data: {
        branch: result.branch,
        credentials: {
          username: result.adminUser.username,
          temporaryPassword: initialPassword,
          loginUrl: '/auth/login',
        },
        subscription: result.subscription,
      },
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Create branch error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to create branch.',
    });
  }
}
