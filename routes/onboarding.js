const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const { uploadBase64Image } = require('../lib/cloudinary')
const {
  DEFAULT_PLANS,
  resolvePlanSlug,
  addMonths,
  formatPlanDate,
} = require('../lib/plans');

const router = express.Router();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

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

function generateBranchCode(schoolName) {
  const initials = schoolName
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

async function saveLogoBase64(logoBase64, logoFileName) {
  if (!logoBase64) return null
  const match = String(logoBase64).match(/^data:(image\/[a-z+]+);base64,(.+)$/i)
  const mime = match ? match[1] : 'image/png'
  const data = match ? match[2] : logoBase64

  // Store the hosted Cloudinary URL in the `branches.logo` column
  return await uploadBase64Image({
    base64: data,
    mime,
    folder: 'ugbekun2/schools/logos',
    tags: ['ugbekun2', 'school-logo'],
  })
}

/**
 * GET /api/onboarding/plans
 */
router.get('/plans', async (req, res) => {
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
 * Returns plan summary with computed start/expiry dates (for the subscribe form header).
 */
router.get('/plans/:slug/summary', async (req, res) => {
  try {
    await ensurePlansSeeded();
    const slug = resolvePlanSlug(req.params.slug);
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
 * Multipart or JSON body — registers a new school (branch), admin user, and subscription.
 *
 * Fields: planSlug, schoolName, schoolAddress, adminName, gender, contactNumber,
 *         contactEmail, username, password, message, termsAccepted, recaptchaToken?
 * File: schoolLogo (optional)
 */
router.post('/register', async (req, res) => {
  try {
    await ensurePlansSeeded();

    const body = req.body || {};
    const planSlug = resolvePlanSlug(body.planSlug || body.plan);
    const schoolName = (body.schoolName || '').trim();
    const schoolAddress = (body.schoolAddress || '').trim();
    const adminName = (body.adminName || '').trim();
    const gender = (body.gender || '').trim();
    const contactNumber = (body.contactNumber || '').trim();
    const contactEmail = (body.contactEmail || '').trim();
    const username = (body.username || '').trim();
    const password = body.password || '';
    const confirmPassword = body.confirmPassword || body.retypePassword || '';
    const message = (body.message || '').trim();
    const termsAccepted = body.termsAccepted === true || body.termsAccepted === 'true';

    const required = [
      ['schoolName', schoolName],
      ['schoolAddress', schoolAddress],
      ['adminName', adminName],
      ['gender', gender],
      ['contactNumber', contactNumber],
      ['contactEmail', contactEmail],
      ['username', username],
      ['password', password],
    ];

    for (const [field, value] of required) {
      if (!value) {
        return res.status(400).json({ success: false, message: `${field} is required.` });
      }
    }

    if (!termsAccepted) {
      return res.status(400).json({ success: false, message: 'You must accept the Terms & Conditions.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(contactEmail)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid contact email.' });
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
        message: 'Admin username already exists. Please choose another.',
      });
    }

    let logoPath = null;
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

    const result = await prisma.$transaction(async (tx) => {
      const branch = await tx.branch.create({
        data: {
          name: schoolName,
          code: branchCode,
          address: schoolAddress,
          phone: contactNumber,
          email: contactEmail,
          logo: logoPath,
          adminName,
          adminGender: gender,
          active: true,
        },
      });

      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' } });
      const nextUserId = maxUser ? maxUser.id + 1 : 1;

      const user = await tx.user.create({
        data: {
          id: nextUserId,
          username,
          password: hashedPassword,
          role: 2, // Branch Admin — matches legacy login_credential role=2
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
          paymentStatus: 'pending',
          message: message || null,
          termsAccepted: true,
        },
        include: { plan: true },
      });

      return { branch, user, subscription };
    });

    return res.status(201).json({
      success: true,
      message: 'School registered successfully. Proceed to payment.',
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
  } catch (error) {
    console.error('[ONBOARDING] Register error:', error);
    const msg = error.message?.includes('logo') ? error.message : 'Registration failed. Please try again.';
    return res.status(500).json({ success: false, message: msg });
  }
});

module.exports = router;
