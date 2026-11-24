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

function normalizeCustomDomainInput(raw: any): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed) return null;
  const noProto = trimmed.replace(/^https?:\/\//i, '');
  const hostOnly = noProto.split('/')[0].split(':')[0].trim();
  const nonWww = hostOnly.startsWith('www.') ? hostOnly.slice(4) : hostOnly;
  return nonWww || null;
}

function formatSuperadminDomainRecord(b: any) {
  const effectiveSub = b.subdomain || b.code?.toLowerCase() || `branch-${b.id}`;
  return {
    branchId: b.id,
    name: b.name,
    code: b.code,
    schoolName: b.systemSetting?.schoolName || b.name,
    subdomain: b.subdomain || null,
    suggestedSubdomain: effectiveSub,
    subdomainUrl: `https://${effectiveSub}.ugbekun.edu.ng`,
    customDomain: b.customDomain || null,
    customDomainUrl: b.customDomain ? `https://${b.customDomain}` : null,
    domainStatus: b.domainStatus || 'PENDING_VERIFICATION',
    verificationToken: b.domainVerificationToken || `ugbekun-verify-${b.id}`,
    dnsTarget: b.domainDnsTarget || DEFAULT_DNS_TARGET,
    sslStatus: b.sslStatus || 'PENDING',
    domainVerifiedAt: b.domainVerifiedAt,
    hasLandingPage: Boolean(b.landingPage?.isEnabled),
    landingPageUpdatedAt: b.landingPage?.updatedAt,
  };
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

    const domainList = branches.map(formatSuperadminDomainRecord);

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
 * PUT /api/superadmin/domains/:branchId
 * Save or update subdomain & custom domain for a branch (SuperAdmin).
 */
export async function updateBranchDomain(req: Request, res: Response): Promise<Response | void> {
  const branchId = parseInt(req.params.branchId as string, 10);
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' });
  }

  try {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }

    const { customDomain, subdomain } = req.body;
    const updateData: Record<string, any> = {};

    if (subdomain !== undefined) {
      const cleanSub = formatDomainSlug(subdomain);
      if (cleanSub) {
        const dupSub = await prisma.branch.findFirst({
          where: { subdomain: cleanSub, NOT: { id: branchId } },
          select: { id: true, name: true },
        });
        if (dupSub) {
          return res.status(409).json({
            success: false,
            message: `Subdomain "${cleanSub}" is already assigned to ${dupSub.name}.`,
          });
        }
        updateData.subdomain = cleanSub;
      } else {
        updateData.subdomain = null;
      }
    }

    if (customDomain !== undefined) {
      const cleanDom = normalizeCustomDomainInput(customDomain);
      if (cleanDom) {
        const dupDom = await prisma.branch.findFirst({
          where: {
            OR: [{ customDomain: cleanDom }, { customDomain: `www.${cleanDom}` }],
            NOT: { id: branchId },
          },
          select: { id: true, name: true },
        });
        if (dupDom) {
          return res.status(409).json({
            success: false,
            message: `Custom domain "${cleanDom}" is already linked to ${dupDom.name}.`,
          });
        }
        updateData.customDomain = cleanDom;
        if (cleanDom !== branch.customDomain) {
          updateData.domainStatus = 'PENDING_VERIFICATION';
          updateData.sslStatus = 'PENDING';
          updateData.domainVerifiedAt = null;
        }
      } else {
        updateData.customDomain = null;
        updateData.domainStatus = 'PENDING_VERIFICATION';
        updateData.sslStatus = 'PENDING';
        updateData.domainVerifiedAt = null;
      }
    }

    if (!branch.domainVerificationToken) {
      updateData.domainVerificationToken = generateDomainVerificationToken(branch.id);
    }
    if (!branch.domainDnsTarget) {
      updateData.domainDnsTarget = DEFAULT_DNS_TARGET;
    }

    const updated = await prisma.branch.update({
      where: { id: branchId },
      data: updateData,
      include: {
        systemSetting: { select: { schoolName: true, website: true, logoUrl: true } },
        landingPage: { select: { isEnabled: true, updatedAt: true } },
      },
    });

    await cacheDelPattern('tenant:resolve:*');

    return res.json({
      success: true,
      message: `Domain settings saved for ${updated.name}.`,
      data: formatSuperadminDomainRecord(updated),
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Update domain error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update domain settings.' });
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
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }

    const { customDomain, subdomain } = req.body;
    const cleanDom = customDomain !== undefined ? normalizeCustomDomainInput(customDomain) : branch.customDomain;
    const cleanSub = subdomain !== undefined ? (formatDomainSlug(subdomain) || null) : branch.subdomain;

    if (cleanDom) {
      const dupDom = await prisma.branch.findFirst({
        where: {
          OR: [{ customDomain: cleanDom }, { customDomain: `www.${cleanDom}` }],
          NOT: { id: branchId },
        },
        select: { id: true, name: true },
      });
      if (dupDom) {
        return res.status(409).json({
          success: false,
          message: `Custom domain "${cleanDom}" is already linked to ${dupDom.name}.`,
        });
      }
    }

    if (cleanSub) {
      const dupSub = await prisma.branch.findFirst({
        where: { subdomain: cleanSub, NOT: { id: branchId } },
        select: { id: true, name: true },
      });
      if (dupSub) {
        return res.status(409).json({
          success: false,
          message: `Subdomain "${cleanSub}" is already assigned to ${dupSub.name}.`,
        });
      }
    }

    const updated = await prisma.branch.update({
      where: { id: branchId },
      data: {
        ...(customDomain !== undefined && { customDomain: cleanDom }),
        ...(subdomain !== undefined && { subdomain: cleanSub }),
        domainVerificationToken: branch.domainVerificationToken || generateDomainVerificationToken(branch.id),
        domainDnsTarget: branch.domainDnsTarget || DEFAULT_DNS_TARGET,
        domainStatus: 'ACTIVE',
        sslStatus: 'ACTIVE',
        domainVerifiedAt: new Date(),
      },
      include: {
        systemSetting: { select: { schoolName: true, website: true, logoUrl: true } },
        landingPage: { select: { isEnabled: true, updatedAt: true } },
      },
    });

    await cacheDelPattern('tenant:resolve:*');

    return res.json({
      success: true,
      message: `Domain for ${updated.name} activated.`,
      data: formatSuperadminDomainRecord(updated),
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
    let branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }

    const bodyCustomDomain = req.body?.customDomain !== undefined ? normalizeCustomDomainInput(req.body.customDomain) : undefined;
    const bodySubdomain = req.body?.subdomain !== undefined ? (formatDomainSlug(req.body.subdomain) || null) : undefined;

    if (bodyCustomDomain !== undefined || bodySubdomain !== undefined) {
      if (bodyCustomDomain) {
        const dupDom = await prisma.branch.findFirst({
          where: {
            OR: [{ customDomain: bodyCustomDomain }, { customDomain: `www.${bodyCustomDomain}` }],
            NOT: { id: branchId },
          },
          select: { id: true, name: true },
        });
        if (dupDom) {
          return res.status(409).json({
            success: false,
            message: `Custom domain "${bodyCustomDomain}" is already linked to ${dupDom.name}.`,
          });
        }
      }
      branch = await prisma.branch.update({
        where: { id: branchId },
        data: {
          ...(bodyCustomDomain !== undefined && { customDomain: bodyCustomDomain }),
          ...(bodySubdomain !== undefined && { subdomain: bodySubdomain }),
          domainVerificationToken: branch.domainVerificationToken || generateDomainVerificationToken(branch.id),
          domainDnsTarget: branch.domainDnsTarget || DEFAULT_DNS_TARGET,
        },
      });
    }

    if (!branch.customDomain) {
      return res.status(400).json({ success: false, message: 'No custom domain configured for this branch.' });
    }

    const token = branch.domainVerificationToken || generateDomainVerificationToken(branch.id);
    const target = branch.domainDnsTarget || DEFAULT_DNS_TARGET;
    const probe = await verifyDomainDns(branch.customDomain, token, target);

    const updated = await prisma.branch.update({
      where: { id: branchId },
      data: probe.verified
        ? {
            domainStatus: 'ACTIVE',
            sslStatus: 'ACTIVE',
            domainVerifiedAt: new Date(),
            domainVerificationToken: token,
            domainDnsTarget: target,
          }
        : {
            domainStatus: 'MISCONFIGURED',
            domainVerificationToken: token,
            domainDnsTarget: target,
          },
      include: {
        systemSetting: { select: { schoolName: true, website: true, logoUrl: true } },
        landingPage: { select: { isEnabled: true, updatedAt: true } },
      },
    });

    await cacheDelPattern('tenant:resolve:*');

    return res.json({
      success: true,
      data: {
        ...formatSuperadminDomainRecord(updated),
        ...probe,
      },
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Verify DNS error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to run DNS verification.' });
  }
}
