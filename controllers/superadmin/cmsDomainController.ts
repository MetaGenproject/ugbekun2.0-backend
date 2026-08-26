import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { uploadBase64Image } from '../../lib/cloudinary';
import {
  getOrCreateLandingPage,
  formatLandingPageResponse,
} from '../../lib/schoolCmsService';
import {
  generateDomainVerificationToken,
  verifyDomainDns,
  formatDomainSlug,
  DEFAULT_DNS_TARGET,
} from '../../lib/domainService';

/**
 * GET /api/superadmin/branches/:branchId/landing-page
 */
export async function getBranchLandingPage(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseInt(req.params.branchId as string, 10);
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' });
  }

  try {
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { landingPage: true, systemSetting: true },
    });

    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }

    const landingPage = branch.landingPage || (await getOrCreateLandingPage(prisma, branch.id));
    const responseData = formatLandingPageResponse(branch, landingPage);

    return res.json({ success: true, data: responseData });
  } catch (error: any) {
    console.error('[SUPERADMIN] Fetch landing page error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load landing page.' });
  }
}

/**
 * PUT /api/superadmin/branches/:branchId/landing-page
 */
export async function updateBranchLandingPage(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseInt(req.params.branchId as string, 10);
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' });
  }

  try {
    const body = req.body || {};
    const updated = await prisma.schoolLandingPage.upsert({
      where: { branchId },
      update: {
        heroHeadline: body.heroHeadline,
        heroSubheadline: body.heroSubheadline,
        aboutText: body.aboutText,
        primaryColor: body.primaryColor,
        secondaryColor: body.secondaryColor,
        isEnabled: body.isEnabled !== undefined ? Boolean(body.isEnabled) : undefined,
        showAdmissionCta: body.showAdmissionCta !== undefined ? Boolean(body.showAdmissionCta) : undefined,
        showPortalLoginCta: body.showPortalLoginCta !== undefined ? Boolean(body.showPortalLoginCta) : undefined,
      },
      create: {
        branchId,
        heroHeadline: body.heroHeadline || 'Welcome to Our School',
        heroSubheadline: body.heroSubheadline || '',
        aboutText: body.aboutText || '',
        primaryColor: body.primaryColor || '#0284c7',
        secondaryColor: body.secondaryColor || '#0f172a',
        isEnabled: body.isEnabled !== undefined ? Boolean(body.isEnabled) : true,
      },
    });

    return res.json({ success: true, message: 'Landing page updated successfully.', data: updated });
  } catch (error: any) {
    console.error('[SUPERADMIN] Update landing page error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update landing page.' });
  }
}

/**
 * POST /api/superadmin/branches/:branchId/landing-page/upload-media
 */
export async function uploadLandingPageMedia(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseInt(req.params.branchId as string, 10);
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' });
  }

  try {
    const { imageBase64, category = 'gallery', caption = '' } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ success: false, message: 'Image data is required.' });
    }

    let url = imageBase64;
    if (imageBase64.startsWith('data:image')) {
      const uploadRes = await uploadBase64Image(imageBase64, `school_${branchId}_cms`);
      if (uploadRes) {
        url = uploadRes;
      }
    }

    return res.json({
      success: true,
      data: {
        url,
        category,
        caption,
        id: Date.now(),
      },
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Media upload error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload media.' });
  }
}

/**
 * GET /api/superadmin/domains
 */
export async function getDomains(req: Request, res: Response): Promise<Response | void> {
  try {
    const branches = await prisma.branch.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        code: true,
        subdomain: true,
        customDomain: true,
        domainStatus: true,
        domainVerificationToken: true,
        domainDnsTarget: true,
        sslStatus: true,
        domainVerifiedAt: true,
        systemSetting: {
          select: { schoolName: true, website: true, logoUrl: true },
        },
        landingPage: {
          select: { isEnabled: true, updatedAt: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    const domainList = branches.map((b) => ({
      branchId: b.id,
      name: b.name,
      code: b.code,
      schoolName: b.systemSetting?.schoolName || b.name,
      subdomain: b.subdomain || b.code?.toLowerCase() || `branch-${b.id}`,
      subdomainUrl: `https://${b.subdomain || b.code?.toLowerCase() || `branch-${b.id}`}.ugbekun.edu.ng`,
      customDomain: b.customDomain || null,
      customDomainUrl: b.customDomain ? `https://${b.customDomain}` : null,
      domainStatus: b.domainStatus || 'PENDING_VERIFICATION',
      verificationToken: b.domainVerificationToken || `ugbekun-verify-${b.id}`,
      dnsTarget: b.domainDnsTarget || DEFAULT_DNS_TARGET,
      sslStatus: b.sslStatus || 'PENDING',
      domainVerifiedAt: b.domainVerifiedAt,
      hasLandingPage: Boolean(b.landingPage?.isEnabled),
      landingPageUpdatedAt: b.landingPage?.updatedAt,
    }));

    return res.json({
      success: true,
      count: domainList.length,
      data: domainList,
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Fetch domains error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load domains.' });
  }
}

/**
 * POST /api/superadmin/domains/:branchId/force-activate
 */
export async function forceActivateDomain(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseInt(req.params.branchId as string, 10);
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' });
  }

  try {
    const { customDomain, subdomain } = req.body;

    const updated = await prisma.branch.update({
      where: { id: branchId },
      data: {
        ...(customDomain !== undefined && { customDomain: customDomain ? String(customDomain).trim().toLowerCase() : null }),
        ...(subdomain !== undefined && { subdomain: formatDomainSlug(subdomain) }),
        domainStatus: 'ACTIVE',
        sslStatus: 'ACTIVE',
        domainVerifiedAt: new Date(),
      },
    });

    return res.json({
      success: true,
      message: `Domain for ${updated.name} forcefully activated.`,
      data: {
        branchId: updated.id,
        subdomain: updated.subdomain,
        customDomain: updated.customDomain,
        domainStatus: updated.domainStatus,
        sslStatus: updated.sslStatus,
      },
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Force activate domain error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to activate domain.' });
  }
}

/**
 * POST /api/superadmin/domains/:branchId/verify-dns
 */
export async function verifyBranchDomainDns(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseInt(req.params.branchId as string, 10);
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' });
  }

  try {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }

    if (!branch.customDomain) {
      return res.status(400).json({ success: false, message: 'No custom domain configured for this branch.' });
    }

    const token = branch.domainVerificationToken || generateDomainVerificationToken(branch.id);
    const target = branch.domainDnsTarget || DEFAULT_DNS_TARGET;
    const probe = await verifyDomainDns(branch.customDomain, token, target);

    if (probe.verified) {
      await prisma.branch.update({
        where: { id: branchId },
        data: {
          domainStatus: 'ACTIVE',
          sslStatus: 'ACTIVE',
          domainVerifiedAt: new Date(),
        },
      });
    } else {
      await prisma.branch.update({
        where: { id: branchId },
        data: { domainStatus: 'MISCONFIGURED' },
      });
    }

    return res.json({
      success: true,
      data: {
        branchId: branch.id,
        customDomain: branch.customDomain,
        ...probe,
      },
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Verify DNS error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to run DNS verification.' });
  }
}
