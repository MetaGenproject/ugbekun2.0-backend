import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma';
import { uploadBase64Image } from '../../lib/cloudinary';
import {
  DEFAULT_PLANS,
  resolvePlanSlug,
  addMonths,
  formatPlanDate,
} from '../../lib/plans';

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

export async function ensurePlansSeeded(): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    await prisma.subscriptionPlan.upsert({
      where: { slug: plan.slug },
      update: {
        name: plan.name,
        description: plan.description,
        priceMonthly: plan.priceMonthly,
        durationMonths: plan.durationMonths,
        totalCost: plan.totalCost,
        active: true,
      },
      create: {
        slug: plan.slug,
        name: plan.name,
        description: plan.description,
        priceMonthly: plan.priceMonthly,
        durationMonths: plan.durationMonths,
        totalCost: plan.totalCost,
        active: true,
      },
    });
  }
}

export function generateBranchCode(schoolName: string): string {
  const initials =
    schoolName
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 4) || 'SCH';
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${initials}${suffix}`;
}

export async function saveLogoBase64(logoBase64?: string | null, logoFileName?: string | null): Promise<string | null> {
  if (!logoBase64) return null;
  try {
    const match = String(logoBase64).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    const mime = match ? match[1] : 'image/png';
    const data = match ? match[2] : logoBase64;

    return await uploadBase64Image({
      base64: data,
      mime,
      folder: 'ugbekun2/schools/logos',
      tags: ['ugbekun2', 'school-logo'],
    });
  } catch (err: any) {
    console.warn('[ONBOARDING] Logo upload warning (continuing registration):', err.message);
    return null;
  }
}

export async function saveSignatureBase64(signatureBase64?: string | null, signatureFileName?: string | null): Promise<string | null> {
  if (!signatureBase64) return null;
  try {
    const match = String(signatureBase64).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    const mime = match ? match[1] : 'image/png';
    const data = match ? match[2] : signatureBase64;

    return await uploadBase64Image({
      base64: data,
      mime,
      folder: 'ugbekun2/schools/signatures',
      tags: ['ugbekun2', 'school-signature'],
    });
  } catch (err: any) {
    console.warn('[ONBOARDING] Signature upload warning (continuing registration):', err.message);
    return null;
  }
}

/**
 * GET /api/onboarding/plans
 */
export async function getPlans(req: Request, res: Response): Promise<Response | void> {
  try {
    await ensurePlansSeeded();
    const plans = await prisma.subscriptionPlan.findMany({
      where: { active: true },
      orderBy: { id: 'asc' },
    });
    return res.json({ success: true, plans });
  } catch (error) {
    console.error('[ONBOARDING] List plans error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load subscription plans.' });
  }
}

/**
 * GET /api/onboarding/plans/:slug/summary
 */
export async function getPlanSummary(req: Request, res: Response): Promise<Response | void> {
  try {
    await ensurePlansSeeded();
    const slug = resolvePlanSlug(req.params.slug as string);
    const plan = await prisma.subscriptionPlan.findUnique({ where: { slug } });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found.' });
    }

    const startDate = new Date();
    const expiryDate = addMonths(startDate, plan.durationMonths);

    return res.json({
      success: true,
      summary: {
        planName: plan.name,
        planSlug: plan.slug,
        startDate: startDate.toISOString(),
        expiryDate: expiryDate.toISOString(),
        startDateFormatted: formatPlanDate(startDate),
        expiryDateFormatted: formatPlanDate(expiryDate),
        totalCost: Number(plan.totalCost),
        currency: plan.currency,
        durationMonths: plan.durationMonths,
      },
    });
  } catch (error) {
    console.error('[ONBOARDING] Plan summary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load plan summary.' });
  }
}

/**
 * POST /api/onboarding/register
 */
export async function registerSchool(req: Request, res: Response): Promise<Response | void> {
  try {
    await ensurePlansSeeded();

    const body = req.body || {};
    const planSlug = resolvePlanSlug(body.planSlug || body.plan);
    const schoolName = (body.schoolName || body.name || body.school_name || '').trim();
    const schoolAddress = (body.schoolAddress || body.address || body.school_address || '').trim();
    const adminName = (body.adminName || body.directorName || 'School Administrator').trim();
    const gender = (body.gender || 'not_specified').trim();
    const contactNumber = (body.contactNumber || body.phone || body.mobileNo || body.telephone || '').trim();
    const contactEmail = (body.contactEmail || body.email || '').trim();
    const username = (body.username || body.adminUsername || '').trim().replace(/\s+/g, '');
    const password = body.password || '';
    const confirmPassword = body.confirmPassword || body.retypePassword || '';
    const motto = (body.motto || '').trim();
    const state = (body.state || '').trim();
    const lga = (body.lga || body.city || '').trim();
    const schoolType = (body.schoolType || '').trim();
    const schoolCategory = (body.schoolCategory || 'combined_k12').trim().toLowerCase();
    const yearEstablished = (body.yearEstablished || '').trim();
    const totalStudents = (body.totalStudents || '').trim();
    const message = (body.message || '').trim();
    const termsAccepted = body.termsAccepted === true || body.termsAccepted === 'true' || body.termsAccepted === 1;

    const required: Array<[string, string]> = [
      ['School Name', schoolName],
      ['School Address', schoolAddress],
      ['Contact Number', contactNumber],
      ['Contact Email', contactEmail],
      ['Admin Username', username],
      ['Password', password],
    ];

    for (const [fieldName, val] of required) {
      if (!val) {
        return res.status(400).json({ success: false, message: `${fieldName} is required.` });
      }
    }

    if (!termsAccepted) {
      return res.status(400).json({ success: false, message: 'You must accept the Terms & Conditions.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(contactEmail)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid contact email address.' });
    }

    const plan = await prisma.subscriptionPlan.findUnique({ where: { slug: planSlug } });
    if (!plan) {
      return res.status(400).json({ success: false, message: 'Invalid subscription plan selected.' });
    }

    if (plan.slug === 'enterprise') {
      return res.status(400).json({
        success: false,
        message: 'Enterprise plans require sales contact. Please use Contact Sales.',
      });
    }

    const existingUser = await prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
    });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Admin username already exists. Please choose a different username.',
      });
    }

    const existingBranch = await prisma.branch.findFirst({
      where: {
        name: { equals: schoolName, mode: 'insensitive' },
        email: { equals: contactEmail, mode: 'insensitive' },
        active: true,
      },
    });
    if (existingBranch) {
      return res.status(400).json({
        success: false,
        message: `A school with the name "${schoolName}" and email "${contactEmail}" already exists. Please log in or use another email.`,
      });
    }

    let logoPath: string | null = null;
    if (body.logoBase64) {
      logoPath = await saveLogoBase64(body.logoBase64, body.logoFileName);
    }

    let signaturePath: string | null = null;
    if (body.signatureBase64) {
      signaturePath = await saveSignatureBase64(body.signatureBase64, body.signatureFileName);
    }

    const startDate = new Date();
    const expiryDate = addMonths(startDate, plan.durationMonths);
    const hashedPassword = await bcrypt.hash(password, 10);

    let branchCode = generateBranchCode(schoolName);
    let codeAttempts = 0;
    while (codeAttempts < 5) {
      const existing = await prisma.branch.findUnique({ where: { code: branchCode } });
      if (!existing) break;
      branchCode = generateBranchCode(schoolName);
      codeAttempts += 1;
    }

    const defaultSubdomain = branchCode.toLowerCase();

    // Atomic full-school provisioning transaction
    const result = await prisma.$transaction(async (tx: any) => {
      // 1. Create School Branch
      const branch = await tx.branch.create({
        data: {
          name: schoolName,
          code: branchCode,
          address: schoolAddress,
          city: lga || null,
          state: state || null,
          phone: contactNumber,
          email: contactEmail,
          logo: logoPath,
          adminName,
          adminGender: gender,
          subdomain: defaultSubdomain,
          active: true,
        },
      });

      // 2. Create System Settings
      await tx.systemSetting.create({
        data: {
          branchId: branch.id,
          schoolName,
          tagline: motto || 'Excellence in Knowledge & Character',
          address: schoolAddress,
          phone: contactNumber,
          email: contactEmail,
          currencySymbol: '₦',
          academicSession: '2025/2026',
          currentTerm: 'First Term',
          logoUrl: logoPath || undefined,
          principalSignatureUrl: signaturePath || undefined,
          regNoPrefix: branchCode.slice(0, 4),
        },
      });

      // 3. Create Public Landing Page CMS
      await tx.schoolLandingPage.create({
        data: {
          branchId: branch.id,
          heroHeadline: `Welcome to ${schoolName}`,
          heroSubheadline: motto || 'Empowering minds, building character, and inspiring academic greatness.',
          aboutText: `${schoolName} is dedicated to nurturing future leaders through holistic education, modern facilities, and an inspiring academic curriculum.`,
          primaryColor: '#0284c7',
          secondaryColor: '#0f172a',
          isEnabled: true,
          showAdmissionCta: true,
          showPortalLoginCta: true,
        },
      });

      // 4. Create Admin User (Role 2 - Branch Admin)
      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' } });
      const nextUserId = maxUser ? maxUser.id + 1 : 1;

      const user = await tx.user.create({
        data: {
          id: nextUserId,
          username,
          password: hashedPassword,
          role: 2,
          legacyUserId: branch.id,
          active: true,
        },
      });

      // 5. Create Active Branch Subscription
      const subscription = await tx.branchSubscription.create({
        data: {
          branchId: branch.id,
          planId: plan.id,
          startDate,
          expiryDate,
          totalCost: plan.totalCost,
          paymentStatus: 'paid',
          message: message || (motto ? `Motto: ${motto} | State: ${state} | Type: ${schoolType}` : null),
          termsAccepted: true,
        },
        include: { plan: true },
      });

      // 6. Automatically seed standard classes, sections, and subjects for the branch
      const lowerCat = `${schoolCategory} ${schoolType}`.toLowerCase();
      let presetClasses: Array<{ name: string; isEcd: boolean }> = [];
      if (lowerCat.includes('nursery') && !lowerCat.includes('secondary') && !lowerCat.includes('combined')) {
        presetClasses = [
          { name: 'Nursery 1', isEcd: true },
          { name: 'Nursery 2', isEcd: true },
          { name: 'Primary 1', isEcd: false },
          { name: 'Primary 2', isEcd: false },
          { name: 'Primary 3', isEcd: false },
          { name: 'Primary 4', isEcd: false },
          { name: 'Primary 5', isEcd: false },
          { name: 'Primary 6', isEcd: false },
        ];
      } else if (lowerCat.includes('secondary') && !lowerCat.includes('primary') && !lowerCat.includes('combined')) {
        presetClasses = [
          { name: 'JSS 1', isEcd: false },
          { name: 'JSS 2', isEcd: false },
          { name: 'JSS 3', isEcd: false },
          { name: 'SSS 1', isEcd: false },
          { name: 'SSS 2', isEcd: false },
          { name: 'SSS 3', isEcd: false },
        ];
      } else {
        presetClasses = [
          { name: 'Nursery 1', isEcd: true },
          { name: 'Nursery 2', isEcd: true },
          { name: 'Primary 1', isEcd: false },
          { name: 'Primary 2', isEcd: false },
          { name: 'Primary 3', isEcd: false },
          { name: 'Primary 4', isEcd: false },
          { name: 'Primary 5', isEcd: false },
          { name: 'Primary 6', isEcd: false },
          { name: 'JSS 1', isEcd: false },
          { name: 'JSS 2', isEcd: false },
          { name: 'JSS 3', isEcd: false },
          { name: 'SSS 1', isEcd: false },
          { name: 'SSS 2', isEcd: false },
          { name: 'SSS 3', isEcd: false },
        ];
      }

      const defaultSections = ['A (Gold)', 'B (Silver)'];
      const sectionMap: Record<string, number> = {};
      for (const secName of defaultSections) {
        const sec = await tx.section.create({
          data: { name: secName, capacity: '40', branchId: branch.id },
        });
        sectionMap[secName] = sec.id;
      }

      for (const item of presetClasses) {
        const cls = await tx.class.create({
          data: {
            name: item.name,
            nameNumeric: item.name.replace(/\D/g, '') || '1',
            isEcd: item.isEcd,
            branchId: branch.id,
          },
        });

        for (const secName of defaultSections) {
          const secId = sectionMap[secName];
          if (secId) {
            await tx.sectionsAllocation.create({
              data: { classId: cls.id, sectionId: secId },
            });
          }
        }
      }

      // Seed core subjects
      const defaultCoreSubjects = [
        { name: 'Mathematics', subjectCode: 'MTH', type: 'theory' },
        { name: 'English Language', subjectCode: 'ENG', type: 'theory' },
        { name: 'Basic Science & Technology', subjectCode: 'BST', type: 'practical' },
        { name: 'Social Studies & Civic Education', subjectCode: 'SOC', type: 'theory' },
        { name: 'ICT / Computer Studies', subjectCode: 'ICT', type: 'practical' },
        { name: 'Agricultural Science', subjectCode: 'AGR', type: 'practical' },
      ];

      for (const subj of defaultCoreSubjects) {
        await tx.subject.create({
          data: {
            name: subj.name,
            subjectCode: subj.subjectCode,
            subjectType: subj.type,
            subjectAuthor: 'National Curriculum',
            branchId: branch.id,
          },
        });
      }

      return { branch, user, subscription };
    }, { maxWait: 15000, timeout: 30000 });

    // Generate immediate JWT token
    const tokenPayload = {
      sub: result.user.id,
      username: result.user.username,
      role: result.user.role,
      roleName: 'admin',
      legacyUserId: result.branch.id,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as any);

    return res.status(201).json({
      success: true,
      message: 'School account created and workspace provisioned successfully.',
      token,
      user: {
        id: result.user.id,
        username: result.user.username,
        role: result.user.role,
        roleName: 'admin',
        legacyUserId: result.branch.id,
        branch: {
          id: result.branch.id,
          name: result.branch.name,
          code: result.branch.code,
          logo: result.branch.logo,
        },
      },
      data: {
        branchId: result.branch.id,
        branchCode: result.branch.code,
        adminUserId: result.user.id,
        subscriptionId: result.subscription.id,
        paymentStatus: result.subscription.paymentStatus,
        planSummary: {
          planName: plan.name,
          startDate: formatPlanDate(startDate),
          expiryDate: formatPlanDate(expiryDate),
          totalCost: Number(plan.totalCost),
          currency: plan.currency,
        },
      },
    });
  } catch (error: any) {
    console.error('[ONBOARDING] Register error:', error);
    const msg = error.message?.includes('logo') ? error.message : (error.message || 'Registration failed. Please try again.');
    return res.status(500).json({ success: false, message: msg });
  }
}
