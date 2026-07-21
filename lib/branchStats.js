const STAFF_ROLES = [4, 8, 9, 12, 13]

function extractCodePrefix(code) {
  if (!code) return ''
  const match = String(code).match(/^([A-Za-z]+)/)
  return match ? match[1] : ''
}

function staffMatchesBranch(username, branch) {
  const normalized = String(username || '').trim()
  if (!normalized) return false

  const lowerUsername = normalized.toLowerCase()
  const prefix = extractCodePrefix(branch.code)
  if (prefix && lowerUsername.startsWith(`${prefix.toLowerCase()}/`)) {
    return true
  }

  const branchName = String(branch.name || '').trim()
  if (!branchName) return false

  const lowerBranchName = branchName.toLowerCase()
  if (lowerUsername === lowerBranchName) return true

  const branchSlug = lowerBranchName.split(/\s+/)[0]
  if (branchSlug && (lowerUsername === branchSlug || lowerBranchName.includes(lowerUsername))) {
    return true
  }

  return false
}

async function countStaffForBranch(prisma, branch, staffUsers) {
  const users = staffUsers || await prisma.user.findMany({
    where: { role: { in: STAFF_ROLES }, active: true },
    select: { username: true },
  })

  return users.filter((user) => staffMatchesBranch(user.username, branch)).length
}

async function getBranchStats(prisma, branchId, options = {}) {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { id: true, name: true, code: true, active: true },
  })

  if (!branch) return null

  const activeOnly = options.activeOnly !== false
  const entityWhere = activeOnly ? { branchId, active: true } : { branchId }

  const [students, parents, teachers, staff] = await Promise.all([
    prisma.student.count({ where: entityWhere }),
    prisma.parent.count({ where: entityWhere }),
    prisma.teacher.count({ where: entityWhere }),
    countStaffForBranch(prisma, branch, options.staffUsers),
  ])

  return {
    branchId: branch.id,
    branchName: branch.name,
    branchCode: branch.code,
    students,
    parents,
    teachers,
    staff,
  }
}

async function getBranchStatsMap(prisma, branches) {
  const staffUsers = await prisma.user.findMany({
    where: { role: { in: STAFF_ROLES }, active: true },
    select: { username: true },
  })

  const [studentGroups, parentGroups, teacherGroups] = await Promise.all([
    prisma.student.groupBy({
      by: ['branchId'],
      where: { branchId: { not: null }, active: true },
      _count: { id: true },
    }),
    prisma.parent.groupBy({
      by: ['branchId'],
      where: { branchId: { not: null }, active: true },
      _count: { id: true },
    }),
    prisma.teacher.groupBy({
      by: ['branchId'],
      where: { branchId: { not: null }, active: true },
      _count: { id: true },
    }),
  ])

  const studentsByBranch = new Map(studentGroups.map((row) => [row.branchId, row._count.id]))
  const parentsByBranch = new Map(parentGroups.map((row) => [row.branchId, row._count.id]))
  const teachersByBranch = new Map(teacherGroups.map((row) => [row.branchId, row._count.id]))

  const statsByBranch = new Map()

  for (const branch of branches) {
    statsByBranch.set(branch.id, {
      students: studentsByBranch.get(branch.id) || 0,
      parents: parentsByBranch.get(branch.id) || 0,
      teachers: teachersByBranch.get(branch.id) || 0,
      staff: staffUsers.filter((user) => staffMatchesBranch(user.username, branch)).length,
    })
  }

  return statsByBranch
}

const STAFF_ROLE_LABELS = {
  4: 'Accountant',
  8: 'Receptionist',
  9: 'Proprietor',
  12: 'Librarian',
  13: 'Staff',
}

async function listStaffForBranch(prisma, branchId) {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { id: true, name: true, code: true },
  })

  if (!branch) return []

  const users = await prisma.user.findMany({
    where: { role: { in: STAFF_ROLES } },
    select: { id: true, username: true, role: true, lastLogin: true, active: true },
    orderBy: { username: 'asc' },
  })

  return users
    .filter((user) => staffMatchesBranch(user.username, branch))
    .map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role,
      roleLabel: STAFF_ROLE_LABELS[user.role] || 'Staff',
      lastLogin: user.lastLogin,
      active: user.active,
    }))
}

module.exports = {
  STAFF_ROLES,
  STAFF_ROLE_LABELS,
  extractCodePrefix,
  staffMatchesBranch,
  getBranchStats,
  getBranchStatsMap,
  listStaffForBranch,
}
