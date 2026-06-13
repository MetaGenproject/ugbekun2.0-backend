const express = require('express')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { getBranchStats, listStaffForBranch } = require('../lib/branchStats')

const router = express.Router()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod'

function getBearerToken(req) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  return authHeader.slice('Bearer '.length)
}

function assertBranchAdmin(req, res) {
  const token = getBearerToken(req)
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' })
    return null
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (!decoded || decoded.role !== 2) {
      res.status(403).json({ success: false, message: 'Forbidden.' })
      return null
    }

    const branchId = decoded.legacyUserId ? Number(decoded.legacyUserId) : null
    if (!branchId) {
      res.status(403).json({
        success: false,
        message: 'Branch admin account is not linked to a school branch.',
      })
      return null
    }

    return { ...decoded, branchId }
  } catch {
    res.status(401).json({ success: false, message: 'Token is invalid or expired.' })
    return null
  }
}

/**
 * GET /api/admin/stats
 * Branch-scoped counts for the logged-in branch admin dashboard.
 */
router.get('/stats', async (req, res) => {
  const decoded = assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const stats = await getBranchStats(prisma, decoded.branchId)
    if (!stats) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found for this admin account.',
      })
    }

    return res.json({ success: true, data: stats })
  } catch (error) {
    console.error('[ADMIN] Stats error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load branch stats.',
    })
  }
})

/**
 * GET /api/admin/students-parents
 * Branch-scoped student and parent records for the Students & Parents section.
 */
router.get('/students-parents', async (req, res) => {
  const decoded = assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const where = { branchId: decoded.branchId, active: true }

    const [students, parents] = await Promise.all([
      prisma.student.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: {
          id: true,
          registerNo: true,
          firstName: true,
          lastName: true,
          gender: true,
          mobileno: true,
          email: true,
          parentId: true,
          parent: { select: { name: true } },
        },
      }),
      prisma.parent.findMany({
        where,
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          relation: true,
          email: true,
          mobileno: true,
          city: true,
          state: true,
          _count: { select: { students: true } },
        },
      }),
    ])

    return res.json({
      success: true,
      data: {
        students: students.map((student) => ({
          id: student.id,
          registerNo: student.registerNo,
          firstName: student.firstName,
          lastName: student.lastName,
          gender: student.gender,
          mobileno: student.mobileno,
          email: student.email,
          parentName: student.parent?.name || null,
        })),
        parents: parents.map((parent) => ({
          id: parent.id,
          name: parent.name,
          relation: parent.relation,
          email: parent.email,
          mobileno: parent.mobileno,
          city: parent.city,
          state: parent.state,
          studentCount: parent._count.students,
        })),
      },
    })
  } catch (error) {
    console.error('[ADMIN] Students/parents list error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load students and parents.',
    })
  }
})

/**
 * GET /api/admin/teachers-staff
 * Branch-scoped teacher and other staff records for the Teachers & Staff section.
 */
router.get('/teachers-staff', async (req, res) => {
  const decoded = assertBranchAdmin(req, res)
  if (!decoded) return

  try {
    const [teachers, staff] = await Promise.all([
      prisma.teacher.findMany({
        where: { branchId: decoded.branchId, active: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          _count: { select: { allocations: true } },
        },
      }),
      listStaffForBranch(prisma, decoded.branchId),
    ])

    return res.json({
      success: true,
      data: {
        teachers: teachers.map((teacher) => ({
          id: teacher.id,
          name: teacher.name,
          email: teacher.email,
          phone: teacher.phone,
          classCount: teacher._count.allocations,
        })),
        staff,
      },
    })
  } catch (error) {
    console.error('[ADMIN] Teachers/staff list error:', error)
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load teachers and staff.',
    })
  }
})

module.exports = router
