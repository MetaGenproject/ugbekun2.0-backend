import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { resolveTenantByHost, normalizeHostname } from '../lib/domainService';
import { getOrCreateLandingPage, formatLandingPageResponse } from '../lib/schoolCmsService';

const router = express.Router();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * Helper to resolve branch from query or headers
 */
async function resolveBranchContext(req: Request) {
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

  // 5. Fallback: Return primary branch (e.g. Branch 32 or first active branch)
  const fallback = await prisma.branch.findFirst({
    where: { active: true },
    orderBy: { id: 'asc' },
    include: { landingPage: true, systemSetting: true }
  });

  return fallback;
}

/**
 * GET /api/public/tenant/homepage
 * Public unauthenticated endpoint providing full School Landing Page content for custom domains
 */
router.get('/homepage', async (req: Request, res: Response) => {
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
});

/**
 * GET /api/public/tenant/branding
 * Lightweight branding assets for white-label login & navigation
 */
router.get('/branding', async (req: Request, res: Response) => {
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
});

/**
 * GET /api/public/tenant/resolve-domain
 * Ingress verification hook for reverse proxies (Caddy on-demand TLS)
 */
router.get('/resolve-domain', async (req: Request, res: Response) => {
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
});

export default router;
module.exports = router;
