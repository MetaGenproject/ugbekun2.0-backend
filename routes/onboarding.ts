import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { uploadBase64Image } from '../lib/cloudinary';
import {
  DEFAULT_PLANS,
  resolvePlanSlug,
  addMonths,
  formatPlanDate,
} from '../lib/plans';

const router = express.Router();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

async function ensurePlansSeeded() {
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

function generateBranchCode(schoolName: string): string {
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

async function saveLogoBase64(logoBase64?: string | null, logoFileName?: string | null): Promise<string | null> {
  if (!logoBase64) return null;
  const match = String(logoBase64).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  const mime = match ? match[1] : 'image/png';
  const data = match ? match[2] : logoBase64;

  return await uploadBase64Image({
    base64: data,
    mime,
    folder: 'ugbekun2/schools/logos',
    tags: ['ugbekun2', 'school-logo'],
  });
}

/**
 * GET /api/onboarding/plans
 */
router.get('/plans', async (req: Request, res: Response) => {
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
});

/**
 * GET /api/onboarding/plans/:slug/summary
 */
router.get('/plans/:slug/summary', async (req: Request, res: Response) => {
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
});

/**
 * POST /api/onboarding/register
 * Registers a new school, provisions the school branch, admin account,
 * academic building blocks, and returns an immediate JWT login session.
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    await ensurePlansSeeded();

    const body = req.body || {};
    const planSlug = resolvePlanSlug(body.planSlug || body.plan);
    const schoolName = (body.schoolName || '').trim();
    const schoolAddress = (body.schoolAddress || '').trim();
    const adminName = (body.adminName || body.directorName || 'School Administrator').trim();
    const gender = (body.gender || 'not_specified').trim();
    const contactNumber = (body.contactNumber || '').trim();
    const contactEmail = (body.contactEmail || '').trim();
    const username = (body.username || '').trim().replace(/\s+/g, '');
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

    let logoPath: string | null = null;
    if (body.logoBase64) {
      logoPath = await saveLogoBase64(body.logoBase64, body.logoFileName);
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
          role: 2, // Branch Admin
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
          paymentStatus: 'paid', // Active access immediately
          message: message || (motto ? `Motto: ${motto} | State: ${state} | Type: ${schoolType}` : null),
          termsAccepted: true,
        },
        include: { plan: true },
      });

      // 6. Pre-seed Default Sections
      const sectionA = await tx.section.create({
        data: { name: 'Section A (Gold)', capacity: '40', branchId: branch.id },
      });
      const sectionB = await tx.section.create({
        data: { name: 'Section B (Silver)', capacity: '40', branchId: branch.id },
      });

      // 7. Pre-seed Default Standard Classes
      const defaultClassesList = [
        { name: 'Nursery 1', isEcd: true, numeric: '1' },
        { name: 'Nursery 2', isEcd: true, numeric: '2' },
        { name: 'Kindergarten 1', isEcd: true, numeric: '1' },
        { name: 'Kindergarten 2', isEcd: true, numeric: '2' },
        { name: 'Primary 1', isEcd: false, numeric: '1' },
        { name: 'Primary 2', isEcd: false, numeric: '2' },
        { name: 'Primary 3', isEcd: false, numeric: '3' },
        { name: 'Primary 4', isEcd: false, numeric: '4' },
        { name: 'Primary 5', isEcd: false, numeric: '5' },
        { name: 'Primary 6', isEcd: false, numeric: '6' },
        { name: 'JSS 1', isEcd: false, numeric: '1' },
        { name: 'JSS 2', isEcd: false, numeric: '2' },
        { name: 'JSS 3', isEcd: false, numeric: '3' },
        { name: 'SSS 1', isEcd: false, numeric: '1' },
        { name: 'SSS 2', isEcd: false, numeric: '2' },
        { name: 'SSS 3', isEcd: false, numeric: '3' },
      ];

      for (const clsData of defaultClassesList) {
        const createdClass = await tx.class.create({
          data: {
            name: clsData.name,
            nameNumeric: clsData.numeric,
            isEcd: clsData.isEcd,
            branchId: branch.id,
          },
        });

        // Link to Section A
        await tx.sectionsAllocation.create({
          data: {
            classId: createdClass.id,
            sectionId: sectionA.id,
          },
        });
      }

      // 8. Pre-seed Default Core Subjects (Batch insert)
      const defaultSubjectsList = [
        { name: 'Mathematics', code: 'MTH 101', type: 'Core', author: 'NERDC' },
        { name: 'English Language', code: 'ENG 101', type: 'Core', author: 'NERDC' },
        { name: 'Basic Science & Technology', code: 'BST 101', type: 'Core', author: 'NERDC' },
        { name: 'Social Studies & Civic Education', code: 'SOC 101', type: 'Core', author: 'NERDC' },
        { name: 'Computer Studies / ICT', code: 'ICT 101', type: 'Core', author: 'NERDC' },
        { name: 'Agricultural Science', code: 'AGR 101', type: 'Core', author: 'NERDC' },
        { name: 'Physical & Health Education', code: 'PHE 101', type: 'Core', author: 'NERDC' },
        { name: 'Cultural & Creative Arts', code: 'CCA 101', type: 'Core', author: 'NERDC' },
        { name: 'Business Studies', code: 'BUS 101', type: 'Elective', author: 'NERDC' },
        { name: 'Physics', code: 'PHY 301', type: 'Elective', author: 'NERDC' },
        { name: 'Chemistry', code: 'CHM 301', type: 'Elective', author: 'NERDC' },
        { name: 'Biology', code: 'BIO 301', type: 'Elective', author: 'NERDC' },
        { name: 'Financial Accounting', code: 'ACC 301', type: 'Elective', author: 'NERDC' },
        { name: 'Literature in English', code: 'LIT 301', type: 'Elective', author: 'NERDC' },
      ];

      await tx.subject.createMany({
        data: defaultSubjectsList.map((s) => ({
          name: s.name,
          subjectCode: s.code,
          subjectType: s.type,
          subjectAuthor: s.author,
          branchId: branch.id,
        })),
      });

      // 9. Pre-seed Default Fee Types (Batch insert)
      const defaultFeeTypes = [
        { name: 'Tuition Fee', code: 'TUI', amount: 50000, frequency: 'per_term' },
        { name: 'Admission / Registration Fee', code: 'ADM', amount: 15000, frequency: 'one_time' },
        { name: 'Development Levy', code: 'DEV', amount: 10000, frequency: 'per_term' },
        { name: 'Uniform & Textbooks', code: 'UNI', amount: 25000, frequency: 'one_time' },
      ];

      await tx.feeType.createMany({
        data: defaultFeeTypes.map((fee) => ({
          name: fee.name,
          code: fee.code,
          amount: fee.amount,
          currency: 'NGN',
          frequency: fee.frequency,
          active: true,
          branchId: branch.id,
        })),
      });

      // 10. Pre-seed Default Leave Categories (Batch insert)
      const defaultLeaves = [
        { name: 'Annual Leave', daysPerYear: 21, isPaid: true, description: 'Statutory yearly holiday leave' },
        { name: 'Sick Leave', daysPerYear: 10, isPaid: true, description: 'Medical recovery leave' },
        { name: 'Casual Leave', daysPerYear: 5, isPaid: true, description: 'Short compassionate emergency leave' },
        { name: 'Maternity / Paternity Leave', daysPerYear: 90, isPaid: true, description: 'Parental leave' },
      ];

      await tx.leaveCategory.createMany({
        data: defaultLeaves.map((l) => ({
          name: l.name,
          daysPerYear: l.daysPerYear,
          isPaid: l.isPaid,
          description: l.description,
          active: true,
          branchId: branch.id,
        })),
      });

      return { branch, user, subscription };
    }, { maxWait: 15000, timeout: 30000 });

    // Generate immediate JWT token for zero-friction instant login
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
});

export default router;
