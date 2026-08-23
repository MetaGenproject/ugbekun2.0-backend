import express, { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { uploadBase64Image } from '../lib/cloudinary';
import { getBranchStatsMap } from '../lib/branchStats';
import { BRANCH_SELECT, branchesToCsv, buildBranchesPdf } from '../lib/branchExport';
import { deleteBranchCascade } from '../lib/branchDelete';
import { sendGracePeriodExtensionEmail } from '../lib/emailService';

import {
  DEFAULT_PLANS,
  addMonths,
} from '../lib/plans';
import {
  getMultiBranchRevenueAnalytics,
  exportRevenueReportCsv,
  exportRevenueReportPdf,
} from '../lib/revenueAnalyticsService';
import {
  getOrCreateLandingPage,
  formatLandingPageResponse,
} from '../lib/schoolCmsService';
import {
  generateDomainVerificationToken,
  verifyDomainDns,
  formatDomainSlug,
  DEFAULT_DNS_TARGET,
} from '../lib/domainService';

const router = express.Router()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma: any = new PrismaClient({ adapter })

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod'

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
        currency: plan.currency,
        active: true,
      },
      create: {
        slug: plan.slug,
        name: plan.name,
        description: plan.description,
        priceMonthly: plan.priceMonthly,
        durationMonths: plan.durationMonths,
        totalCost: plan.totalCost,
        currency: plan.currency,
        active: true,
      },
    })
  }
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  return authHeader.slice('Bearer '.length)
}

function assertSuperadmin(req: any, res: any) {
  const token = getBearerToken(req)
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' })
    return null
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET)
    if (!decoded || decoded.role !== 1) {
      res.status(403).json({ success: false, message: 'Forbidden.' })
      return null
    }
    return decoded
  } catch {
    res.status(401).json({ success: false, message: 'Token is invalid or expired.' })
    return null
  }
}

function generateTempPassword() {
  // 16+ chars with letters/digits/symbols; good enough for a temporary credential.
  const bytes = crypto.randomBytes(12).toString('base64url')
  return `Temp-${bytes}!9`
}

function generateBranchCode(seed) {
  const cleaned = String(seed || '')
    .trim()
    .replace(/[^a-zA-Z0-9\s]/g, '')
  const initials = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

  const suffix = Math.floor(1000 + Math.random() * 9000)
  return `${initials || 'SCH'}${suffix}`
}

async function loadBranchesWithStats(branchId?: number) {
  const branches = await prisma.branch.findMany({
    where: branchId ? { id: branchId } : undefined,
    orderBy: { name: 'asc' },
    select: BRANCH_SELECT,
  })

  if (branchId && !branches.length) return null

  const statsByBranch = await getBranchStatsMap(prisma, branches)
  return branches.map((branch) => {
    const stats = statsByBranch.get(branch.id) || {
      students: 0,
      parents: 0,
      teachers: 0,
      staff: 0,
    }

    return {
      ...branch,
      students: stats.students,
      parents: stats.parents,
      teachers: stats.teachers,
      staff: stats.staff,
    }
  })
}

function parseBranchId(req, res) {
  const branchId = Number(req.params.id)
  if (!Number.isInteger(branchId) || branchId <= 0) {
    res.status(400).json({ success: false, message: 'Invalid branch id.' })
    return null
  }
  return branchId
}

async function saveLogoBase64(logoBase64, logoFileName, folder) {
  if (!logoBase64) return null

  const match = String(logoBase64).match(/^data:(image\/[a-z+]+);base64,(.+)$/i)
  const mime = match ? match[1] : 'image/png'
  const data = match ? match[2] : logoBase64

  return await uploadBase64Image({
    base64: data,
    mime,
    folder: `ugbekun2/branches/${String(folder || 'branch').slice(0, 64)}/logos`,
    tags: ['ugbekun2', 'branch-logo'],
  })
}

/**
 * GET /api/superadmin/stats
 * Platform-wide counts for the superadmin dashboard.
 */
router.get('/stats', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    const [branches, activeBranches, students, teachers, parents, users] = await Promise.all([
      prisma.branch.count(),
      prisma.branch.count({ where: { active: true } }),
      prisma.student.count(),
      prisma.teacher.count(),
      prisma.parent.count(),
      prisma.user.count(),
    ])

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
    })
  } catch (error) {
    console.error('[SUPERADMIN] Stats error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load platform stats.',
    })
  }
})

/**
 * GET /api/superadmin/branches
 * Returns all tenant school branches for the superadmin dashboard.
 */
router.get('/branches', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    const data = await loadBranchesWithStats()
    return res.json({ success: true, data })
  } catch (error) {
    console.error('[SUPERADMIN] Branch list error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load branch list.',
    })
  }
})

/**
 * GET /api/superadmin/branches/export.csv
 * Export all branch details as CSV.
 */
router.get('/branches/export.csv', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    const branches = await loadBranchesWithStats()
    const csv = branchesToCsv(branches)
    const filename = `ugbekun-branches-${new Date().toISOString().slice(0, 10)}.csv`

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.send(`\uFEFF${csv}`)
  } catch (error) {
    console.error('[SUPERADMIN] Branch CSV export error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to export branches as CSV.',
    })
  }
})

/**
 * GET /api/superadmin/branches/export.pdf
 * Export all branch details as PDF.
 */
router.get('/branches/export.pdf', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    const branches = await loadBranchesWithStats()
    const pdf = await buildBranchesPdf(branches)
    const filename = `ugbekun-branches-${new Date().toISOString().slice(0, 10)}.pdf`

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.send(pdf)
  } catch (error) {
    console.error('[SUPERADMIN] Branch PDF export error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to export branches as PDF.',
    })
  }
})

/**
 * GET /api/superadmin/branches/:id
 * Fetch a single branch with live stats.
 */
router.get('/branches/:id', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  const branchId = parseBranchId(req, res)
  if (!branchId) return

  try {
    const rows = await loadBranchesWithStats(branchId)
    if (!rows?.length) {
      return res.status(404).json({ success: false, message: 'Branch not found.' })
    }
    return res.json({ success: true, data: rows[0] })
  } catch (error) {
    console.error('[SUPERADMIN] Branch detail error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load branch details.',
    })
  }
})

/**
 * PUT /api/superadmin/branches/:id
 * Update branch details.
 */
router.put('/branches/:id', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  const branchId = parseBranchId(req, res)
  if (!branchId) return

  try {
    const existing = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true },
    })
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Branch not found.' })
    }

    const body = req.body || {}
    const name = (body.name || body.schoolName || '').trim()
    const code = body.code != null ? String(body.code).trim() : undefined
    const adminName = body.adminName != null ? String(body.adminName).trim() : undefined
    const email = body.email != null ? String(body.email).trim().toLowerCase() : undefined
    const phone = body.phone != null ? String(body.phone).trim() : undefined
    const city = body.city != null ? String(body.city).trim() : undefined
    const state = body.state != null ? String(body.state).trim() : undefined
    const address = body.address != null ? String(body.address).trim() : undefined
    const active = body.active != null ? Boolean(body.active) : undefined

    if (!name) {
      return res.status(400).json({ success: false, message: 'School name is required.' })
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email.' })
    }

    if (code) {
      const codeConflict = await prisma.branch.findFirst({
        where: { code, NOT: { id: branchId } },
        select: { id: true },
      })
      if (codeConflict) {
        return res.status(400).json({ success: false, message: 'Branch code already in use.' })
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
    })

    const statsMap = await getBranchStatsMap(prisma, [updated])
    const stats = statsMap.get(updated.id) || { students: 0, parents: 0, teachers: 0, staff: 0 }

    return res.json({
      success: true,
      message: 'Branch updated successfully.',
      data: { ...updated, ...stats },
    })
  } catch (error) {
    console.error('[SUPERADMIN] Branch update error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to update branch.',
    })
  }
})

/**
 * DELETE /api/superadmin/branches/:id
 * Permanently remove a branch and its tenant-scoped records.
 */
router.delete('/branches/:id', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  const branchId = parseBranchId(req, res)
  if (!branchId) return

  try {
    const existing = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, name: true },
    })
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Branch not found.' })
    }

    await prisma.$transaction((tx) => deleteBranchCascade(tx, branchId))

    return res.json({
      success: true,
      message: `Branch "${existing.name}" deleted successfully.`,
    })
  } catch (error) {
    console.error('[SUPERADMIN] Branch delete error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to delete branch.',
    })
  }
})

/**
 * POST /api/superadmin/branches
 * Superadmin adds a new tenant school (Branch) + branch admin user + subscription record.
 */
router.post('/branches', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    await ensurePlansSeeded()

    const body = req.body || {}
    const branchName = (body.branchName || '').trim()
    const schoolName = (body.schoolName || '').trim()
    const adminName = (body.adminName || '').trim()
    const email = (body.email || '').trim().toLowerCase()
    const mobileNo = (body.mobileNo || '').trim()
    const city = (body.city || '').trim()
    const state = (body.state || '').trim()
    const address = (body.address || '').trim()

    const planId = body.planId ? Number(body.planId) : null
    const status = String(body.status || 'inactive').toLowerCase() // active | inactive

    const statusActive = status === 'active'

    const required = [
      ['branchName', branchName],
      ['schoolName', schoolName],
      ['adminName', adminName],
      ['email', email],
      ['mobileNo', mobileNo],
      ['city', city],
      ['state', state],
      ['address', address],
      ['planId', planId],
    ]
    for (const [field, value] of required) {
      if (!value && value !== 0) {
        return res.status(400).json({ success: false, message: `${field} is required.` })
      }
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email.' })
    }

    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } })
    if (!plan || !plan.active) {
      return res.status(400).json({ success: false, message: 'Invalid plan selected.' })
    }

    const existingAdminUser = await prisma.user.findFirst({
      where: { username: { equals: email, mode: 'insensitive' } },
    })
    if (existingAdminUser) {
      return res.status(400).json({ success: false, message: 'Admin email/username already exists.' })
    }

    const folder = String(branchName || schoolName || 'school').slice(0, 24)
    const branchCodeBase = generateBranchCode(branchName || schoolName)

    // Save logos to Cloudinary (optional but the form asks for them)
    const systemLogoPath = await saveLogoBase64(body.systemLogoBase64, body.systemLogoFileName, folder)
    const textLogoPath = await saveLogoBase64(body.textLogoBase64, body.textLogoFileName, folder)
    const printingLogoPath = await saveLogoBase64(body.printingLogoBase64, body.printingLogoFileName, folder)
    const reportCardLogoPath = await saveLogoBase64(body.reportCardLogoBase64, body.reportCardLogoFileName, folder)

    const startDate = new Date()
    const expiryDate = addMonths(startDate, plan.durationMonths)
    const paymentStatus = statusActive ? 'paid' : 'pending'

    const result = await prisma.$transaction(async (tx) => {
      // Ensure unique tenant code
      let branchCode = branchCodeBase
      for (let i = 0; i < 5; i++) {
        // Only select `id` so Prisma doesn't try to read optional/missing columns
        // like `branches.systemLogo` in older DBs.
        const exists = await tx.branch.findUnique({
          where: { code: branchCode },
          select: { id: true },
        })
        if (!exists) break
        branchCode = generateBranchCode(branchName || schoolName)
      }

      const branch = await tx.branch.create({
        data: {
          name: schoolName,
          code: branchCode,
          address,
          city,
          state,
          phone: mobileNo,
          email,
          // Keep legacy `logo` populated; additional per-surface logo columns
          // can be stored once the DB has those columns.
          logo: systemLogoPath,
          adminName,
          active: statusActive,
        },
        // Only return what this endpoint uses.
        // This prevents Prisma from trying to read missing optional columns
        // during the create RETURNING step (e.g. `branches.systemLogo`).
        select: { id: true, code: true },
      })

      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' } })
      const nextUserId = maxUser ? maxUser.id + 1 : 1

      const tempPassword = generateTempPassword()
      const hashedPassword = await bcrypt.hash(tempPassword, 10)

      const user = await tx.user.create({
        data: {
          id: nextUserId,
          username: email,
          password: hashedPassword,
          role: 2, // Branch admin
          legacyUserId: branch.id,
          active: statusActive,
        },
      })

      const subscription = await tx.branchSubscription.create({
        data: {
          branchId: branch.id,
          planId: plan.id,
          startDate,
          expiryDate,
          totalCost: plan.totalCost,
          paymentStatus,
          message: null,
          termsAccepted: true,
        },
        include: { plan: true },
      })

      return { branch, user, subscription, tempPassword }
    })

    return res.status(201).json({
      success: true,
      message: 'School added successfully.',
      data: {
        branchId: result.branch.id,
        branchCode: result.branch.code,
        adminUserId: result.user.id,
        subscriptionId: result.subscription.id,
        currency: result.subscription.plan.currency,
        tempPassword: result.tempPassword,
      },
    })
  } catch (error) {
    console.error('[SUPERADMIN] Add branch error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to add school/branch.',
    })
  }
})

/**
 * GET /api/superadmin/sessions
 * Fetch all academic sessions.
 */
router.get('/sessions', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    const sessions = await prisma.schoolYear.findMany({
      orderBy: { schoolYear: 'desc' },
    })
    // Also fetch currently active sessionId from global settings (if exists)
    const settings = await prisma.globalSettings.findFirst({
      select: { sessionId: true },
    })
    return res.json({
      success: true,
      data: {
        sessions,
        activeSessionId: settings ? settings.sessionId : null,
      },
    })
  } catch (error) {
    console.error('[SUPERADMIN] GET sessions error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to fetch academic sessions.',
    })
  }
})

/**
 * POST /api/superadmin/sessions
 * Create a new academic session.
 */
router.post('/sessions', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    const { schoolYear } = req.body || {}
    if (!schoolYear || !/^\d{4}-\d{4}$/.test(schoolYear.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Session name is required and must match YYYY-YYYY format.',
      })
    }

    const normalizedYear = schoolYear.trim()

    const existing = await prisma.schoolYear.findFirst({
      where: { schoolYear: normalizedYear },
    })
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Academic session already exists.',
      })
    }

    // Find max ID in schoolyear
    const maxSession = await prisma.schoolYear.findFirst({ orderBy: { id: 'desc' } })
    const nextId = maxSession ? maxSession.id + 1 : 1

    const newSession = await prisma.schoolYear.create({
      data: {
        id: nextId,
        schoolYear: normalizedYear,
        createdBy: 1, // Superadmin legacy ID
      },
    })

    return res.status(201).json({
      success: true,
      message: 'Academic session created successfully.',
      data: newSession,
    })
  } catch (error) {
    console.error('[SUPERADMIN] POST sessions error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to create academic session.',
    })
  }
})

/**
 * PUT /api/superadmin/sessions/active
 * Set globally active academic session.
 */
router.put('/sessions/active', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    const { sessionId } = req.body || {}
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'Session ID is required.' })
    }

    const id = Number(sessionId)
    const sessionExists = await prisma.schoolYear.findUnique({
      where: { id },
    })
    if (!sessionExists) {
      return res.status(404).json({ success: false, message: 'Academic session not found.' })
    }

    // Check if global settings row exists
    const settings = await prisma.globalSettings.findFirst()
    if (settings) {
      await prisma.globalSettings.update({
        where: { id: settings.id },
        data: { sessionId: id },
      })
    } else {
      await prisma.globalSettings.create({
        data: {
          id: 1,
          instituteName: 'Ugbekun School Management System',
          sessionId: id,
        },
      })
    }

    return res.json({
      success: true,
      message: `Globally active session set to ${sessionExists.schoolYear}.`,
    })
  } catch (error) {
    console.error('[SUPERADMIN] PUT active session error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to update active session.',
    })
  }
})

/**
 * GET /api/superadmin/subscriptions
 * Fetch subscription plan options and active subscription status per branch.
 */
router.get('/subscriptions', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    // Fetch all subscription plans
    const plans = await prisma.subscriptionPlan.findMany({
      where: { active: true },
      orderBy: { id: 'asc' },
    })

    // Fetch all branches with their subscriptions
    const branches = await prisma.branch.findMany({
      select: {
        id: true,
        name: true,
        code: true,
        active: true,
        subscriptions: {
          orderBy: { id: 'desc' },
          take: 1,
          include: { plan: true },
        },
      },
      orderBy: { name: 'asc' },
    })

    const subscriptions = branches.map((b) => {
      const latestSub = b.subscriptions[0] || null
      return {
        branchId: b.id,
        branchName: b.name,
        branchCode: b.code,
        branchActive: b.active,
        latestSubscription: latestSub
          ? {
              id: latestSub.id,
              startDate: latestSub.startDate,
              expiryDate: latestSub.expiryDate,
              totalCost: Number(latestSub.totalCost),
              paymentStatus: latestSub.paymentStatus,
              planName: latestSub.plan.name,
              planSlug: latestSub.plan.slug,
              planId: latestSub.plan.id,
            }
          : null,
      }
    })

    return res.json({
      success: true,
      data: {
        plans,
        subscriptions,
      },
    })
  } catch (error) {
    console.error('[SUPERADMIN] GET subscriptions error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load subscription status.',
    })
  }
})

/**
 * POST /api/superadmin/branches/:id/renew-subscription
 * Renew subscription for branch. If renewed before expiration, the duration appends directly to current expiration date.
 */
router.post('/branches/:id/renew-subscription', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  const branchId = parseBranchId(req, res)
  if (!branchId) return

  try {
    const { planId, paymentStatus } = req.body || {}
    if (!planId) {
      return res.status(400).json({ success: false, message: 'Plan ID is required.' })
    }

    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: Number(planId) },
    })
    if (!plan || !plan.active) {
      return res.status(404).json({ success: false, message: 'Active plan not found.' })
    }

    // Get latest paid/active subscription to check expiration date
    const latestSub = await prisma.branchSubscription.findFirst({
      where: { branchId, paymentStatus: 'paid' },
      orderBy: { expiryDate: 'desc' },
    })

    const now = new Date()
    let startDate = now
    // If latest subscription expiry date is in the future, append renewal directly to it
    if (latestSub && latestSub.expiryDate > now) {
      startDate = new Date(latestSub.expiryDate)
    }

    const expiryDate = addMonths(startDate, plan.durationMonths)
    const statusPaid = paymentStatus === 'pending' ? 'pending' : 'paid'

    const subscription = await prisma.$transaction(async (tx) => {
      const sub = await tx.branchSubscription.create({
        data: {
          branchId,
          planId: plan.id,
          startDate,
          expiryDate,
          totalCost: plan.totalCost,
          paymentStatus: statusPaid,
          termsAccepted: true,
        },
        include: { plan: true },
      })

      // If immediately paid, activate the branch
      if (statusPaid === 'paid') {
        await tx.branch.update({
          where: { id: branchId },
          data: { active: true },
        })
        // Also active corresponding user credentials
        await tx.user.updateMany({
          where: { role: 2, legacyUserId: branchId },
          data: { active: true },
        })
      }

      return sub
    })

    return res.status(201).json({
      success: true,
      message: `Subscription renewed successfully under "${plan.name}" plan. Expiry: ${expiryDate.toISOString().slice(0, 10)}`,
      data: subscription,
    })
  } catch (error) {
    console.error('[SUPERADMIN] POST renew subscription error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to renew subscription.',
    })
  }
})

/**
 * POST /api/superadmin/branches/:id/extend-subscription
 * Extend branch subscription by a specified number of days (1 to 30) as a grace period.
 */
router.post('/branches/:id/extend-subscription', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  const branchId = parseBranchId(req, res)
  if (!branchId) return

  try {
    const { days, reason } = req.body || {}
    
    // Validate days: Must be between 1 and 30
    const extensionDays = parseInt(days, 10)
    if (isNaN(extensionDays) || extensionDays < 1 || extensionDays > 30) {
      return res.status(400).json({
        success: false,
        message: 'Invalid extension days. Must be an integer between 1 and 30.',
      })
    }

    // Verify branch exists and fetch details for email notification
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, name: true, email: true },
    })

    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found.' })
    }

    // Get latest paid subscription to check expiration date
    const latestSub = await prisma.branchSubscription.findFirst({
      where: { branchId, paymentStatus: 'paid' },
      orderBy: { expiryDate: 'desc' },
    })

    const now = new Date()
    let startDate = now
    // If latest subscription expiry date is in the future, append extension directly to it
    if (latestSub && latestSub.expiryDate > now) {
      startDate = new Date(latestSub.expiryDate)
    }

    // Add specified number of days to the start date
    const expiryDate = new Date(startDate)
    expiryDate.setDate(expiryDate.getDate() + extensionDays)

    // Resolve planId to copy from latest sub or find a default active plan
    let planId = latestSub ? latestSub.planId : null
    if (!planId) {
      const defaultPlan = await prisma.subscriptionPlan.findFirst({
        where: { active: true },
        orderBy: { id: 'asc' },
      })
      if (!defaultPlan) {
        return res.status(400).json({
          success: false,
          message: 'No active subscription plans found to link the extension.',
        })
      }
      planId = defaultPlan.id
    }

    const subscription = await prisma.$transaction(async (tx) => {
      const sub = await tx.branchSubscription.create({
        data: {
          branchId,
          planId,
          startDate,
          expiryDate,
          totalCost: 0.00, // Grace periods are free of charge
          paymentStatus: 'paid', // Mark as paid to activate access
          termsAccepted: true,
          message: reason || `Grace period extension: ${extensionDays} day(s).`,
        },
        include: { plan: true },
      })

      // Always activate the branch
      await tx.branch.update({
        where: { id: branchId },
        data: { active: true },
      })

      // Also active corresponding user credentials
      await tx.user.updateMany({
        where: { role: 2, legacyUserId: branchId },
        data: { active: true },
      })

      return sub
    })

    // Post-transaction: Fire-and-forget email notification to branch admin
    if (branch.email) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const formattedExpiry = `${String(expiryDate.getDate()).padStart(2, '0')}-${months[expiryDate.getMonth()]}-${expiryDate.getFullYear()}`

      const loginUrl = process.env.NEXT_PUBLIC_LOGIN_URL || 'http://localhost:3000/login'

      sendGracePeriodExtensionEmail({
        adminEmail: branch.email,
        schoolName: branch.name,
        days: extensionDays,
        newExpiryDate: formattedExpiry,
        reason: reason || 'Granted by super administrator.',
        loginUrl,
      }).catch((err) => {
        console.error('[SUPERADMIN] Failed to send grace period extension email:', err)
      })
    }

    return res.status(201).json({
      success: true,
      message: `Subscription extended successfully by ${extensionDays} days. New Expiry: ${expiryDate.toISOString().slice(0, 10)}`,
      data: subscription,
    })
  } catch (error) {
    console.error('[SUPERADMIN] POST extend subscription error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to extend subscription.',
    })
  }
})

/**
 * GET /api/superadmin/analytics
 * Aggregated data for Recharts visualizations
 */
router.get('/analytics', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    // 1. Branch Enrollments: student count per branch
    const branches = await prisma.branch.findMany({
      select: {
        id: true,
        name: true,
        students: {
          where: { active: true },
        },
      },
      orderBy: { name: 'asc' },
    })

    const branchEnrollments = branches.map((b) => ({
      name: b.name.replace('School', '').replace('Academy', '').replace('Management System', '').trim(),
      studentsCount: b.students.length,
    }))

    // 2. Subscription plans count & revenue
    const plans = await prisma.subscriptionPlan.findMany({
      include: {
        subscriptions: {
          where: { paymentStatus: 'paid' },
        },
      },
    })

    const planDistribution = plans.map((p) => {
      const totalRev = p.subscriptions.reduce((sum, s) => sum + Number(s.totalCost), 0)
      return {
        name: p.name,
        activeSubscriptions: p.subscriptions.length,
        revenue: totalRev,
      }
    })

    // 3. Subscriptions Expirations histogram
    const allSubs = await prisma.branchSubscription.findMany({
      where: { paymentStatus: 'paid' },
      orderBy: { expiryDate: 'desc' },
      distinct: ['branchId'],
    })

    const now = new Date()
    const oneMonthFromNow = new Date()
    oneMonthFromNow.setDate(now.getDate() + 30)
    const threeMonthsFromNow = new Date()
    threeMonthsFromNow.setDate(now.getDate() + 90)

    let expired = 0
    let critical = 0
    let warning = 0
    let healthy = 0

    allSubs.forEach((sub) => {
      const exp = new Date(sub.expiryDate)
      if (exp < now) {
        expired++
      } else if (exp <= oneMonthFromNow) {
        critical++
      } else if (exp <= threeMonthsFromNow) {
        warning++
      } else {
        healthy++
      }
    })

    const expirationStats = [
      { name: 'Expired', count: expired, color: '#ef4444' },
      { name: 'Expiring 0-30d', count: critical, color: '#f97316' },
      { name: 'Expiring 31-90d', count: warning, color: '#eab308' },
      { name: 'Healthy (>90d)', count: healthy, color: '#10b981' },
    ]

    return res.json({
      success: true,
      data: {
        branchEnrollments,
        planDistribution,
        expirationStats,
      },
    })
  } catch (error) {
    console.error('[SUPERADMIN] GET analytics error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to aggregate analytics statistics.',
    })
  }
})

/**
 * GET /api/superadmin/revenue-analytics
 * Consolidated multi-branch SaaS & institutional school fees revenue analytics
 */
router.get('/revenue-analytics', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    const { sessionId, branchId, period } = req.query as any
    const analytics = await getMultiBranchRevenueAnalytics(prisma, {
      sessionId: sessionId ? Number(sessionId) : undefined,
      branchId: branchId ? Number(branchId) : undefined,
      period: period ? String(period) : undefined
    })

    return res.json({
      success: true,
      data: analytics
    })
  } catch (error) {
    console.error('[SUPERADMIN] GET revenue analytics error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to aggregate multi-branch revenue analytics.'
    })
  }
})

/**
 * GET /api/superadmin/revenue-analytics/export/csv
 * CSV export of consolidated multi-branch financial matrices
 */
router.get('/revenue-analytics/export/csv', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    const { sessionId, branchId, period } = req.query as any
    const analytics = await getMultiBranchRevenueAnalytics(prisma, {
      sessionId: sessionId ? Number(sessionId) : undefined,
      branchId: branchId ? Number(branchId) : undefined,
      period: period ? String(period) : undefined
    })

    const csv = exportRevenueReportCsv(analytics)
    const timestamp = new Date().toISOString().slice(0, 10)

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="ugbekun-revenue-audit-${timestamp}.csv"`)
    return res.send(csv)
  } catch (error) {
    console.error('[SUPERADMIN] GET revenue analytics CSV export error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to export revenue analytics CSV.'
    })
  }
})

/**
 * GET /api/superadmin/revenue-analytics/export/pdf
 * Executive PDF report export of multi-branch revenue analytics
 */
router.get('/revenue-analytics/export/pdf', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  try {
    const { sessionId, branchId, period } = req.query as any
    const analytics = await getMultiBranchRevenueAnalytics(prisma, {
      sessionId: sessionId ? Number(sessionId) : undefined,
      branchId: branchId ? Number(branchId) : undefined,
      period: period ? String(period) : undefined
    })

    const pdfBuffer = await exportRevenueReportPdf(analytics)
    const timestamp = new Date().toISOString().slice(0, 10)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="ugbekun-revenue-audit-${timestamp}.pdf"`)
    return res.send(pdfBuffer)
  } catch (error) {
    console.error('[SUPERADMIN] GET revenue analytics PDF export error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to export revenue analytics PDF.'
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// SUPERADMIN SCHOOL HOMEPAGE / FRONT-CMS & DOMAIN MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/superadmin/branches/:branchId/landing-page
 * Fetch complete landing page configuration for a school
 */
router.get('/branches/:branchId/landing-page', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  const branchId = parseInt(req.params.branchId, 10)
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' })
  }

  try {
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { landingPage: true, systemSetting: true }
    })

    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found.' })
    }

    const landingPage = branch.landingPage || (await getOrCreateLandingPage(prisma, branch.id))
    const formatted = formatLandingPageResponse(branch, landingPage, branch.systemSetting)

    return res.json(formatted)
  } catch (error) {
    console.error('[SUPERADMIN] Fetch school landing page error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to load school landing page.' })
  }
})

/**
 * PUT /api/superadmin/branches/:branchId/landing-page
 * Update full landing page layout, hero banners, gallery, and branding
 */
router.put('/branches/:branchId/landing-page', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  const branchId = parseInt(req.params.branchId, 10)
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' })
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
      twitterUrl
    } = req.body

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
        ...(twitterUrl !== undefined && { twitterUrl })
      },
      create: {
        branchId,
        isEnabled: isEnabled !== undefined ? Boolean(isEnabled) : true,
        heroHeadline: heroHeadline || 'Nurturing Future Leaders & Scholars',
        heroSubheadline,
        heroBanners,
        welcomeTitle: welcomeTitle || 'Welcome from the Principal',
        welcomeMessage,
        welcomeAuthor,
        welcomePhoto,
        aboutText,
        photoGallery,
        academicPrograms,
        announcements,
        primaryColor: primaryColor || '#003da5',
        secondaryColor: secondaryColor || '#009ca6',
        showAdmissionCta: showAdmissionCta !== undefined ? Boolean(showAdmissionCta) : true,
        showPortalLoginCta: showPortalLoginCta !== undefined ? Boolean(showPortalLoginCta) : true,
        showGallery: showGallery !== undefined ? Boolean(showGallery) : true,
        showAnnouncements: showAnnouncements !== undefined ? Boolean(showAnnouncements) : true,
        facebookUrl,
        instagramUrl,
        youtubeUrl,
        twitterUrl
      }
    })

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { systemSetting: true }
    })

    const formatted = formatLandingPageResponse(branch, updatedLandingPage, branch?.systemSetting)
    return res.json({
      success: true,
      message: 'School Landing Page published successfully.',
      data: formatted
    })
  } catch (error) {
    console.error('[SUPERADMIN] Update school landing page error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to update landing page.' })
  }
})

/**
 * POST /api/superadmin/branches/:branchId/landing-page/upload-media
 * Upload high-resolution banners or campus photos
 */
router.post('/branches/:branchId/landing-page/upload-media', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  const branchId = parseInt(req.params.branchId, 10)
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' })
  }

  try {
    const { imageBase64, category = 'gallery', caption = '' } = req.body
    if (!imageBase64) {
      return res.status(400).json({ success: false, message: 'Image data is required.' })
    }

    let url = imageBase64
    if (imageBase64.startsWith('data:image')) {
      const uploadRes = await uploadBase64Image(imageBase64, `school_${branchId}_cms`)
      if (uploadRes) {
        url = uploadRes
      }
    }

    return res.json({
      success: true,
      data: {
        url,
        category,
        caption,
        id: Date.now()
      }
    })
  } catch (error) {
    console.error('[SUPERADMIN] Media upload error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload media.' })
  }
})

/**
 * GET /api/superadmin/domains
 * Global multi-branch custom domain and subdomain directory
 */
router.get('/domains', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

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
          select: { schoolName: true, website: true, logoUrl: true }
        },
        landingPage: {
          select: { isEnabled: true, updatedAt: true }
        }
      },
      orderBy: { name: 'asc' }
    })

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
      landingPageUpdatedAt: b.landingPage?.updatedAt
    }))

    return res.json({
      success: true,
      count: domainList.length,
      data: domainList
    })
  } catch (error) {
    console.error('[SUPERADMIN] Fetch domains error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to load domains.' })
  }
})

/**
 * POST /api/superadmin/domains/:branchId/force-activate
 * Operator override to manually verify and activate a custom domain
 */
router.post('/domains/:branchId/force-activate', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  const branchId = parseInt(req.params.branchId, 10)
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' })
  }

  try {
    const { customDomain, subdomain } = req.body

    const updated = await prisma.branch.update({
      where: { id: branchId },
      data: {
        ...(customDomain !== undefined && { customDomain: customDomain ? String(customDomain).trim().toLowerCase() : null }),
        ...(subdomain !== undefined && { subdomain: formatDomainSlug(subdomain) }),
        domainStatus: 'ACTIVE',
        sslStatus: 'ACTIVE',
        domainVerifiedAt: new Date()
      }
    })

    return res.json({
      success: true,
      message: `Domain for ${updated.name} forcefully activated.`,
      data: {
        branchId: updated.id,
        subdomain: updated.subdomain,
        customDomain: updated.customDomain,
        domainStatus: updated.domainStatus,
        sslStatus: updated.sslStatus
      }
    })
  } catch (error) {
    console.error('[SUPERADMIN] Force activate domain error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to activate domain.' })
  }
})

/**
 * POST /api/superadmin/domains/:branchId/verify-dns
 * Trigger live DNS probe from Superadmin portal
 */
router.post('/domains/:branchId/verify-dns', async (req, res) => {
  const decoded = assertSuperadmin(req, res)
  if (!decoded) return

  const branchId = parseInt(req.params.branchId, 10)
  if (isNaN(branchId)) {
    return res.status(400).json({ success: false, message: 'Invalid branch ID.' })
  }

  try {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } })
    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found.' })
    }

    if (!branch.customDomain) {
      return res.status(400).json({ success: false, message: 'No custom domain configured for this branch.' })
    }

    const token = branch.domainVerificationToken || generateDomainVerificationToken(branch.id)
    const target = branch.domainDnsTarget || DEFAULT_DNS_TARGET
    const probe = await verifyDomainDns(branch.customDomain, token, target)

    if (probe.verified) {
      await prisma.branch.update({
        where: { id: branchId },
        data: {
          domainStatus: 'ACTIVE',
          sslStatus: 'ACTIVE',
          domainVerifiedAt: new Date()
        }
      })
    } else {
      await prisma.branch.update({
        where: { id: branchId },
        data: { domainStatus: 'MISCONFIGURED' }
      })
    }

    return res.json({
      success: true,
      data: {
        branchId: branch.id,
        customDomain: branch.customDomain,
        ...probe
      }
    })
  } catch (error) {
    console.error('[SUPERADMIN] Verify DNS error:', error)
    return res.status(500).json({ success: false, message: error.message || 'Failed to run DNS verification.' })
  }
})

export default router;



