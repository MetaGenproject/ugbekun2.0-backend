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
import { cacheDelPattern } from '../../lib/cacheService';

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
    const responseData = formatLandingPageResponse(branch, landingPage, branch.systemSetting);

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
    const {
      isEnabled,
      heroHeadline,
      heroSubheadline,
      heroBanners,
      welcomeTitle,
      welcomeMessage,
      welcomeAuthor,
      welcomePhoto,
      aboutText,
      photoGallery,
      academicPrograms,
      announcements,
      primaryColor,
      secondaryColor,
      showAdmissionCta,
      showPortalLoginCta,
      showGallery,
      showAnnouncements,
      facebookUrl,
      instagramUrl,
      youtubeUrl,
      twitterUrl,
    } = req.body || {};

    const updatedLandingPage = await prisma.schoolLandingPage.upsert({
      where: { branchId },
      update: {
        ...(isEnabled !== undefined && { isEnabled: Boolean(isEnabled) }),
        ...(heroHeadline !== undefined && { heroHeadline: String(heroHeadline).trim() }),
        ...(heroSubheadline !== undefined && { heroSubheadline: String(heroSubheadline).trim() }),
        ...(heroBanners !== undefined && { heroBanners }),
        ...(welcomeTitle !== undefined && { welcomeTitle }),
        ...(welcomeMessage !== undefined && { welcomeMessage }),
        ...(welcomeAuthor !== undefined && { welcomeAuthor }),
        ...(welcomePhoto !== undefined && { welcomePhoto }),
        ...(aboutText !== undefined && { aboutText }),
        ...(photoGallery !== undefined && { photoGallery }),
        ...(academicPrograms !== undefined && { academicPrograms }),
        ...(announcements !== undefined && { announcements }),
        ...(primaryColor !== undefined && { primaryColor }),
        ...(secondaryColor !== undefined && { secondaryColor }),
        ...(showAdmissionCta !== undefined && { showAdmissionCta: Boolean(showAdmissionCta) }),
        ...(showPortalLoginCta !== undefined && { showPortalLoginCta: Boolean(showPortalLoginCta) }),
        ...(showGallery !== undefined && { showGallery: Boolean(showGallery) }),
        ...(showAnnouncements !== undefined && { showAnnouncements: Boolean(showAnnouncements) }),
        ...(facebookUrl !== undefined && { facebookUrl }),
        ...(instagramUrl !== undefined && { instagramUrl }),
        ...(youtubeUrl !== undefined && { youtubeUrl }),
        ...(twitterUrl !== undefined && { twitterUrl }),
      },
      create: {
        branchId,
        isEnabled: isEnabled !== undefined ? Boolean(isEnabled) : true,
        heroHeadline: heroHeadline || 'Welcome to Our School',
        heroSubheadline: heroSubheadline || '',
        heroBanners: heroBanners || [],
        welcomeTitle: welcomeTitle || 'Welcome from the Principal',
        welcomeMessage: welcomeMessage || '',
        welcomeAuthor: welcomeAuthor || '',
        welcomePhoto: welcomePhoto || null,
        aboutText: aboutText || '',
        photoGallery: photoGallery || [],
        academicPrograms: academicPrograms || [],
        announcements: announcements || [],
        primaryColor: primaryColor || '#0284c7',
        secondaryColor: secondaryColor || '#0f172a',
        showAdmissionCta: showAdmissionCta !== undefined ? Boolean(showAdmissionCta) : true,
        showPortalLoginCta: showPortalLoginCta !== undefined ? Boolean(showPortalLoginCta) : true,
        showGallery: showGallery !== undefined ? Boolean(showGallery) : true,
        showAnnouncements: showAnnouncements !== undefined ? Boolean(showAnnouncements) : true,
        facebookUrl: facebookUrl || '',
        instagramUrl: instagramUrl || '',
        youtubeUrl: youtubeUrl || '',
        twitterUrl: twitterUrl || '',
      },
    });

    // Invalidate cached tenant resolution so public domain immediately reflects updates
    await cacheDelPattern('tenant:resolve:*');

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { systemSetting: true },
    });

    const responseData = formatLandingPageResponse(branch, updatedLandingPage, branch?.systemSetting);

    return res.json({
      success: true,
      message: 'Landing page updated successfully.',
      data: responseData,
    });
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
