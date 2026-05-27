const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { uploadBase64Image } = require('../lib/cloudinary')

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

module.exports = router

