const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { uploadBase64Image } = require('../lib/cloudinary')
const { getBranchStatsMap } = require('../lib/branchStats')
const { BRANCH_SELECT, branchesToCsv, buildBranchesPdf } = require('../lib/branchExport')
const { deleteBranchCascade } = require('../lib/branchDelete')

const {
  DEFAULT_PLANS,
  addMonths,
} = require('../lib/plans')

const router = express.Router()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

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

function assertSuperadmin(req, res) {
  const token = getBearerToken(req)
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' })
    return null
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
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

async function loadBranchesWithStats(branchId) {
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

module.exports = router


