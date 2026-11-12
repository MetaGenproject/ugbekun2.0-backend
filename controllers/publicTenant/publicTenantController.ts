import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma';
import { resolveTenantByHost, normalizeHostname, isPlatformHost } from '../../lib/domainService';
import { getOrCreateLandingPage, formatLandingPageResponse } from '../../lib/schoolCmsService';
import { cacheGetOrSet } from '../../lib/cacheService';
import { resolveDisplaySchoolName } from '../../lib/schoolDisplayName';

/**
 * Helper to resolve branch from query or headers (Cached)
 */
export async function resolveBranchContext(req: Request) {
  const queryDomain = (req.query.domain || req.query.host) as string | undefined;
  const querySubdomain = req.query.subdomain as string | undefined;
  const queryBranchId = req.query.branchId ? parseInt(req.query.branchId as string, 10) : null;
  const headerHost = (req.headers['x-tenant-host'] || req.headers['x-tenant-domain'] || req.headers.host) as string | undefined;

  // Central platform hosts (e.g. app.ugbekun.com, ugbekun.com, localhost) are not tenant branches
  if (!queryBranchId && !queryDomain && !querySubdomain && isPlatformHost(headerHost)) {
    return null;
  }

  const cacheKey = `tenant:resolve:${queryBranchId || queryDomain || querySubdomain || headerHost || 'default'}`;

  return cacheGetOrSet(cacheKey, 300, async () => {
    return _resolveBranchContextUncached(req);
  });
}

async function _resolveBranchContextUncached(req: Request) {
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
    const nonWww = normalized.startsWith('www.') ? normalized.slice(4) : normalized;
    const branch = await prisma.branch.findFirst({
      where: {
        OR: [
          { customDomain: normalized },
          { customDomain: nonWww },
          { customDomain: `www.${nonWww}` },
          { subdomain: nonWww },
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

  // 4. Resolve by incoming host header (exclude central SaaS platform domains)
  if (headerHost && !isPlatformHost(headerHost)) {
    const tenantRes = await resolveTenantByHost(prisma, headerHost);
    if (tenantRes?.branch) return tenantRes.branch;
  }

  // 5. Fallback: Only return primary branch if explicitly targeted via queryBranchId
  // NEVER fall back to a random school branch (Branch 5) for unmapped external hosts!
  if (queryBranchId) {
    const fallback = await prisma.branch.findFirst({
      where: { active: true },
      orderBy: { id: 'asc' },
      include: { landingPage: true, systemSetting: true }
    });
    return fallback;
  }

  return null;
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

    // Always fetch latest landing page for the branch directly from the database so changes take effect immediately
    const landingPage = (await prisma.schoolLandingPage.findUnique({
      where: { branchId: branch.id },
    })) || (await getOrCreateLandingPage(prisma, branch.id));

    const responseData = formatLandingPageResponse(branch, landingPage);

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

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

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (!branch) {
      return res.json({
        success: true,
        data: {
          isCustomDomain: false,
          branchId: 0,
          branchName: 'Ugbekun Admin Portal',
          schoolName: 'Ugbekun Admin Portal',
          tagline: 'SaaS Platform Management & Control Center',
          logoUrl: null,
          primaryColor: '#0b1739',
          secondaryColor: '#e11d48'
        }
      });
    }

    // Always fetch fresh landing page for colors
    const landingPage = await prisma.schoolLandingPage.findUnique({
      where: { branchId: branch.id },
      select: { primaryColor: true, secondaryColor: true }
    });

    const name = branch.systemSetting?.schoolName || branch.name;
    const logo = branch.systemSetting?.logoUrl || (branch as any).logo || (branch as any).systemLogo || null;
    const primaryColor = landingPage?.primaryColor || branch.landingPage?.primaryColor || (branch as any).idCardPrimaryColor || '#003da5';
    const secondaryColor = landingPage?.secondaryColor || branch.landingPage?.secondaryColor || (branch as any).idCardSecondaryColor || '#009ca6';

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
    let branch: any = null;

    // 1. Direct query by Branch ID if explicitly provided in query params (?branchId=...)
    const queryBranchId = req.query.branchId ? parseInt(req.query.branchId as string, 10) : null;
    if (queryBranchId && !isNaN(queryBranchId)) {
      branch = await prisma.branch.findUnique({
        where: { id: queryBranchId },
        include: { landingPage: true, systemSetting: true }
      });
    }

    // 2. Check Bearer token FIRST if present, to prioritize logged-in user's enrolled branch
    if (!branch) {
      const authHeader = req.headers?.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice('Bearer '.length);
        try {
          const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod');
          if (decoded.role === 1) {
            // Superadmin is the platform master administrator, not a branch tenant
            return res.json({
              success: true,
              data: {
                branchId: 0,
                branchCode: 'UGB',
                branchName: 'Ugbekun Admin Portal',
                schoolName: 'Ugbekun Admin Portal',
                tagline: 'SaaS Platform Management & Control Center',
                address: '',
                phone: '',
                email: 'admin@ugbekun.com',
                whatsappNo: null,
                website: 'https://ugbekun.com',
                facebookUrl: null,
                instagramUrl: null,
                twitterUrl: null,
                linkedinUrl: null,
                youtubeUrl: null,
                logoUrl: null,
                principalSignatureUrl: null,
                primaryColor: '#0b1739',
                secondaryColor: '#e11d48',
                idCardTheme: 'EMERALD_MODERN',
                academicSession: '2025/2026',
                currentTerm: 'Active Session',
                currencySymbol: '₦',
              },
            });
          }

          let branchId: number | null = decoded.branchId ? Number(decoded.branchId) : null;
          const userSubId = Number(decoded.sub || decoded.id);

          if (!branchId && decoded.role === 7) {
            let studentRecord = await prisma.student.findUnique({
              where: { userId: userSubId },
              select: { branchId: true },
            });
            if (!studentRecord && decoded.legacyUserId) {
              studentRecord = await prisma.student.findFirst({
                where: { id: Number(decoded.legacyUserId), OR: [{ userId: null }, { userId: userSubId }] },
                select: { branchId: true },
              });
            }
            branchId = studentRecord?.branchId || null;
          } else if (!branchId && decoded.role === 6) {
            let parentRecord = await prisma.parent.findUnique({
              where: { userId: userSubId },
              select: { id: true, branchId: true },
            });
            if (!parentRecord && decoded.legacyUserId) {
              parentRecord = await prisma.parent.findFirst({
                where: { id: Number(decoded.legacyUserId), OR: [{ userId: null }, { userId: userSubId }] },
                select: { id: true, branchId: true },
              });
            }
            const childRecord = parentRecord
              ? await prisma.student.findFirst({
                  where: { parentId: parentRecord.id, active: true },
                  select: { branchId: true },
                  orderBy: { id: 'asc' },
                })
              : null;
            branchId = childRecord?.branchId || parentRecord?.branchId || null;
          } else if (!branchId && decoded.role === 3) {
            let teacherRecord = await prisma.teacher.findFirst({
              where: { userId: userSubId },
              select: { branchId: true },
            });
            if (!teacherRecord && decoded.legacyUserId) {
              teacherRecord = await prisma.teacher.findFirst({
                where: { id: Number(decoded.legacyUserId), OR: [{ userId: null }, { userId: userSubId }] },
                select: { branchId: true },
              });
            }
            branchId = teacherRecord?.branchId || null;
          } else if (!branchId && (decoded.role === 2 || decoded.role === 9)) {
            const adminUser = await prisma.user.findFirst({
              where: { OR: [{ id: decoded.sub || decoded.id }, { legacyUserId: decoded.legacyUserId || decoded.sub }] },
              select: { teacher: { select: { branchId: true } } },
            });
            branchId = adminUser?.teacher?.branchId || null;
          } else if (!branchId && decoded.legacyUserId) {
            branchId = Number(decoded.legacyUserId);
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

    // 3. If no branch resolved from query or token, resolve from subdomain/host context
    if (!branch) {
      branch = await resolveBranchContext(req);
    }

    if (!branch) {
      return res.json({
        success: true,
        data: {
          branchId: 0,
          branchCode: 'UGB',
          branchName: 'Ugbekun Admin Portal',
          schoolName: 'Ugbekun Admin Portal',
          tagline: 'SaaS Platform Management & Control Center',
          address: '',
          phone: '',
          email: 'admin@ugbekun.com',
          whatsappNo: null,
          website: 'https://ugbekun.com',
          facebookUrl: null,
          instagramUrl: null,
          twitterUrl: null,
          linkedinUrl: null,
          youtubeUrl: null,
          logoUrl: null,
          principalSignatureUrl: null,
          primaryColor: '#0b1739',
          secondaryColor: '#e11d48',
          idCardTheme: 'EMERALD_MODERN',
          academicSession: '2025/2026',
          currentTerm: 'Active Session',
          currencySymbol: '₦',
        },
      });
    }

    const settings = branch?.systemSetting;
    return res.json({
      success: true,
      data: {
        branchId: branch?.id || 1,
        branchCode: branch?.code || 'UG',
        branchName: branch?.name || 'School Dashboard',
        schoolName: resolveDisplaySchoolName(settings?.schoolName, branch?.name),
        tagline: settings?.tagline || branch?.landingPage?.heroSubtitle || 'Nurturing Excellence, Raising Leaders',
        address: settings?.address || branch?.address || '',
        phone: settings?.phone || branch?.phone || '',
        email: settings?.email || branch?.email || '',
        whatsappNo: settings?.whatsappNo || null,
        website: settings?.website || null,
        facebookUrl: settings?.facebookUrl || null,
        instagramUrl: settings?.instagramUrl || null,
        twitterUrl: settings?.twitterUrl || null,
        linkedinUrl: settings?.linkedinUrl || null,
        youtubeUrl: settings?.youtubeUrl || null,
        logoUrl: settings?.logoUrl || (branch as any)?.logo || null,
        principalSignatureUrl: settings?.principalSignatureUrl || null,
        primaryColor: settings?.primaryColor || '#0f172a',
        secondaryColor: settings?.secondaryColor || '#0284c7',
        idCardTheme: settings?.idCardTheme || 'EMERALD_MODERN',
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
        branchId: 0,
        branchCode: 'UGB',
        branchName: 'Ugbekun Admin Portal',
        schoolName: 'Ugbekun Admin Portal',
        tagline: 'SaaS Platform Management & Control Center',
        address: '',
        phone: '',
        email: 'admin@ugbekun.com',
        whatsappNo: null,
        website: 'https://ugbekun.com',
        facebookUrl: null,
        instagramUrl: null,
        twitterUrl: null,
        linkedinUrl: null,
        youtubeUrl: null,
        logoUrl: null,
        principalSignatureUrl: null,
        primaryColor: '#0b1739',
        secondaryColor: '#e11d48',
        idCardTheme: 'EMERALD_MODERN',
        academicSession: '2025/2026',
        currentTerm: 'Active Session',
        currencySymbol: '₦',
      },
    });
  }
}

