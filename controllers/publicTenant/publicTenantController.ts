import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma';
import { resolveTenantByHost, normalizeHostname } from '../../lib/domainService';
import { getOrCreateLandingPage, formatLandingPageResponse } from '../../lib/schoolCmsService';

/**
 * Helper to resolve branch from query or headers
 */
export async function resolveBranchContext(req: Request) {
  const queryDomain = (req.query.domain || req.query.host) as string | undefined;
  const querySubdomain = req.query.subdomain as string | undefined;
  const queryBranchId = req.query.branchId ? parseInt(req.query.branchId as string, 10) : null;
  const headerHost = (req.headers['x-tenant-host'] || req.headers['x-tenant-domain'] || req.headers.host) as string | undefined;

  // 1. Direct query by Branch ID
  if (queryBranchId && !isNaN(queryBranchId)) {
    const branch = await prisma.branch.findUnique({
      where: { id: queryBranchId },
      include: { landingPage: true, systemSetting: true }
    });
    if (branch) return branch;
  }

  // 2. Direct query by custom domain
  if (queryDomain) {
    const normalized = normalizeHostname(queryDomain);
    const branch = await prisma.branch.findFirst({
      where: {
        OR: [
          { customDomain: normalized },
          { customDomain: `www.${normalized}` },
          { subdomain: normalized }
        ],
        active: true
      },
      include: { landingPage: true, systemSetting: true }
    });
    if (branch) return branch;
  }

  // 3. Direct query by subdomain slug / branch code
  if (querySubdomain) {
    const sub = String(querySubdomain).trim().toLowerCase();
    const branch = await prisma.branch.findFirst({
      where: {
        OR: [
          { subdomain: sub },
          { code: sub.toUpperCase() },
          { code: sub }
        ],
        active: true
      },
      include: { landingPage: true, systemSetting: true }
    });
    if (branch) return branch;
  }

  // 4. Resolve by incoming host header
  if (headerHost) {
    const tenantRes = await resolveTenantByHost(prisma, headerHost);
    if (tenantRes?.branch) return tenantRes.branch;
  }

  // 5. Fallback: Return primary branch
  const fallback = await prisma.branch.findFirst({
    where: { active: true },
    orderBy: { id: 'asc' },
    include: { landingPage: true, systemSetting: true }
  });

  return fallback;
}

/**
 * GET /api/public/tenant/homepage
 */
export async function getHomepage(req: Request, res: Response): Promise<Response | void> {
  try {
    const branch = await resolveBranchContext(req);

    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'No school branch found for this domain.'
      });
    }

    const landingPage = branch.landingPage || (await getOrCreateLandingPage(prisma, branch.id));
    const responseData = formatLandingPageResponse(branch, landingPage);

    return res.json({
      success: true,
      data: responseData
    });
  } catch (error: any) {
    console.error('[PUBLIC TENANT] Homepage error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load school homepage.'
    });
  }
}

/**
 * GET /api/public/tenant/branding
 */
export async function getBranding(req: Request, res: Response): Promise<Response | void> {
  try {
    const branch = await resolveBranchContext(req);

    if (!branch) {
      return res.json({
        success: true,
        data: {
          isCustomDomain: false,
          schoolName: 'Ugbekun Educational Platform',
          tagline: 'Smart Institutional Management',
          logoUrl: null,
          primaryColor: '#003da5',
          secondaryColor: '#009ca6'
        }
      });
    }

    const name = branch.systemSetting?.schoolName || branch.name;
    const logo = branch.systemSetting?.logoUrl || (branch as any).logo || (branch as any).systemLogo || null;
    const primaryColor = branch.landingPage?.primaryColor || (branch as any).idCardPrimaryColor || '#003da5';
    const secondaryColor = branch.landingPage?.secondaryColor || (branch as any).idCardSecondaryColor || '#009ca6';

    return res.json({
      success: true,
      data: {
        isCustomDomain: Boolean(branch.customDomain || branch.subdomain),
        branchId: branch.id,
        branchCode: branch.code,
        branchName: branch.name,
        schoolName: name,
        tagline: branch.systemSetting?.tagline || 'Excellence in Knowledge & Character',
        logoUrl: logo,
        primaryColor,
        secondaryColor,
        subdomain: branch.subdomain || null,
        customDomain: branch.customDomain || null,
        domainStatus: branch.domainStatus || 'ACTIVE'
      }
    });
  } catch (error: any) {
    console.error('[PUBLIC TENANT] Branding error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load branding.'
    });
  }
}

/**
 * GET /api/public/tenant/resolve-domain
 */
export async function resolveDomain(req: Request, res: Response): Promise<Response | void> {
  try {
    const host = (req.query.domain || req.query.host) as string;
    if (!host) {
      return res.status(400).send('Domain parameter missing');
    }

    const resolved = await resolveTenantByHost(prisma, host);
    if (resolved?.branch) {
      return res.status(200).send('OK');
    }

    return res.status(404).send('Domain Not Found');
  } catch (err: any) {
    return res.status(500).send(err.message || 'Resolution error');
  }
}

/**
 * GET /api/public/tenant/schools
 */
export async function listPublicSchools(req: Request, res: Response): Promise<Response | void> {
  try {
    const search = ((req.query.search || req.query.q || '') as string).trim().toLowerCase();

    const branches = await prisma.branch.findMany({
      where: {
        active: true,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } },
                { city: { contains: search, mode: 'insensitive' } },
                { state: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        code: true,
        city: true,
        state: true,
        subdomain: true,
        customDomain: true,
        systemSetting: {
          select: {
            schoolName: true,
            logoUrl: true,
            address: true,
          },
        },
      },
      orderBy: { name: 'asc' },
      take: 50,
    });

    const colors = [
      'bg-emerald-600 text-white',
      'bg-blue-800 text-white',
      'bg-rose-700 text-white',
      'bg-sky-700 text-white',
      'bg-purple-700 text-white',
      'bg-amber-600 text-white',
    ];

    const formatted = branches.map((b: any, index: number) => {
      const displayName = b.systemSetting?.schoolName || b.name || `School Branch ${b.id}`;
      const location = [b.city, b.state].filter(Boolean).join(', ') || b.systemSetting?.address || 'Nigeria';
      const firstLetter = (displayName.charAt(0) || 'S').toUpperCase();

      return {
        id: b.id,
        code: b.code,
        name: displayName,
        location,
        letter: firstLetter,
        color: colors[index % colors.length],
        subdomain: b.subdomain,
        customDomain: b.customDomain,
        logoUrl: b.systemSetting?.logoUrl || null,
      };
    });

    return res.json({
      success: true,
      data: formatted,
    });
  } catch (error: any) {
    console.error('[PUBLIC TENANT] List schools error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to list schools.',
    });
  }
}

/**
 * GET /api/public/tenant/school-info
 */
export async function getPublicSchoolInfo(req: Request, res: Response): Promise<Response | void> {
  try {
    let branch = await resolveBranchContext(req);

    // If no branch resolved from domain/query, check Bearer token if present
    if (!branch) {
      const authHeader = req.headers?.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice('Bearer '.length);
        try {
          const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod');
          let branchId = decoded.legacyUserId ? Number(decoded.legacyUserId) : null;
          if (!branchId && decoded.role === 3) {
            const teacherRecord = await prisma.teacher.findFirst({
              where: { OR: [{ userId: decoded.sub || decoded.id }, { id: decoded.sub || decoded.id }] },
              select: { branchId: true },
            });
            branchId = teacherRecord?.branchId || null;
          } else if (!branchId && decoded.role === 7) {
            const studentRecord = await prisma.student.findUnique({
              where: { userId: decoded.sub || decoded.id },
              select: { branchId: true },
            });
            branchId = studentRecord?.branchId || null;
          } else if (!branchId && decoded.role === 6) {
            const parentRecord = await prisma.parent.findUnique({
              where: { userId: decoded.sub || decoded.id },
              select: { branchId: true },
            });
            branchId = parentRecord?.branchId || null;
          }
          if (branchId) {
            branch = await prisma.branch.findUnique({
              where: { id: branchId },
              include: { systemSetting: true, landingPage: true },
            });
          }
        } catch {
          // ignore token decode failure
        }
      }
    }

    const settings = branch?.systemSetting;
    return res.json({
      success: true,
      data: {
        branchId: branch?.id || 1,
        branchCode: branch?.code || 'UG',
        branchName: branch?.name || 'School Dashboard',
        schoolName: settings?.schoolName || branch?.name || 'School Dashboard',
        tagline: settings?.tagline || branch?.landingPage?.heroSubtitle || 'Nurturing Excellence, Raising Leaders',
        logoUrl: settings?.logoUrl || (branch as any)?.logo || null,
        academicSession: settings?.academicSession || '2025/2026',
        currentTerm: settings?.currentTerm || 'First Term',
        currencySymbol: settings?.currencySymbol || '₦',
      },
    });
  } catch (error: any) {
    console.error('[PUBLIC TENANT] School info error:', error);
    return res.json({
      success: true,
      data: {
        branchId: 1,
        branchCode: 'UG',
        branchName: 'School Dashboard',
        schoolName: 'School Dashboard',
        tagline: 'Nurturing Excellence, Raising Leaders',
        logoUrl: null,
        academicSession: '2025/2026',
        currentTerm: 'First Term',
        currencySymbol: '₦',
      },
    });
  }
}

