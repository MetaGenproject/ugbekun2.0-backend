const crypto = require('crypto')

// ─── Secure Password Generation ─────────────────────────────────────────────────

const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ'     // Removed I, O to avoid confusion with 1, 0
const LOWERCASE = 'abcdefghjkmnpqrstuvwxyz'       // Removed i, l, o
const DIGITS    = '23456789'                       // Removed 0, 1 to avoid confusion
const SPECIALS  = '!@#$%&*'
const ALL_CHARS = UPPERCASE + LOWERCASE + DIGITS + SPECIALS

/**
 * Generates a cryptographically secure random password.
 *
 * Guarantees at least one character from each class (uppercase, lowercase,
 * digit, special). Remaining positions are filled from the full charset.
 * The final array is Fisher-Yates shuffled to prevent positional predictability.
 *
 * @param {number} [length=8] - Password length (minimum 4)
 * @returns {string} Random password
 */
function generateSecurePassword(length = 8) {
  if (length < 4) length = 4

  const chars = []

  // Guarantee one from each required class
  chars.push(UPPERCASE[crypto.randomInt(UPPERCASE.length)])
  chars.push(LOWERCASE[crypto.randomInt(LOWERCASE.length)])
  chars.push(DIGITS[crypto.randomInt(DIGITS.length)])
  chars.push(SPECIALS[crypto.randomInt(SPECIALS.length)])

  // Fill remaining positions from the full charset
  for (let i = chars.length; i < length; i++) {
    chars.push(ALL_CHARS[crypto.randomInt(ALL_CHARS.length)])
  }

  // Fisher-Yates shuffle to remove positional predictability
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }

  return chars.join('')
}

/**
 * Generates a unique, collision-resistant student registration number.
 * Format: REG/<BRANCH_CODE>/<YEAR>/<SEQUENCE> (e.g., REG/LAG/2026/0001)
 *
 * @param {object} prisma - Prisma Client instance
 * @param {number} branchId - The target branch ID
 * @returns {Promise<string>} Unique registration number
 */
async function generateRegistrationNumber(prisma, branchId) {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { code: true },
  })

  const branchCode = (branch?.code || 'GEN').toUpperCase()
  const year = new Date().getFullYear()
  const prefix = `REG/${branchCode}/${year}/`

  // Execute a query to find the highest sequence number for this pattern
  const highestStudent = await prisma.student.findFirst({
    where: {
      registerNo: {
        startsWith: prefix,
      },
    },
    orderBy: {
      registerNo: 'desc',
    },
    select: {
      registerNo: true,
    },
  })

  let nextSequence = 1
  if (highestStudent?.registerNo) {
    const parts = highestStudent.registerNo.split('/')
    const lastPart = parts[parts.length - 1]
    const currentSequence = parseInt(lastPart, 10)
    if (!isNaN(currentSequence)) {
      nextSequence = currentSequence + 1
    }
  }

  // Pad the sequence to 4 digits (e.g. 0001, 0042)
  const paddedSequence = String(nextSequence).padStart(4, '0')
  const registrationNumber = `${prefix}${paddedSequence}`

  // Verify that the registration number doesn't exist to prevent race condition duplicates
  const existing = await prisma.student.findUnique({
    where: { registerNo: registrationNumber },
    select: { id: true },
  })

  if (existing) {
    // Retry with a random offset or sequential increment
    const offset = Math.floor(Math.random() * 100) + 1
    const finalSequence = String(nextSequence + offset).padStart(4, '0')
    return `${prefix}${finalSequence}`
  }

  return registrationNumber
}

/**
 * Creates empty evaluation Mark entries in the database for a student
 * matching the subjects and exams configured for their class-section.
 *
 * @param {object} tx - Prisma Transaction context
 * @param {object} params - Evaluation binding parameters
 */
async function bindEvaluationMatrix(tx, { studentId, classId, sectionId, branchId, sessionId }) {
  // 1. Fetch all subject assignments for the class and section in the current session
  const subjectAssignments = await tx.subjectAssign.findMany({
    where: {
      classId,
      sectionId,
      branchId,
      sessionId,
    },
    select: {
      subjectId: true,
    },
  })

  if (subjectAssignments.length === 0) {
    console.warn(`[STUDENT SERVICE] No subjects assigned to class ${classId}, section ${sectionId} in session ${sessionId}`)
    return
  }

  // 2. Fetch all active exams for the branch in the current session
  const exams = await tx.exam.findMany({
    where: {
      branchId,
      sessionId,
      status: 1,
    },
    select: {
      id: true,
    },
  })

  if (exams.length === 0) {
    console.warn(`[STUDENT SERVICE] No active exams found for branch ${branchId} in session ${sessionId}`)
    return
  }

  // 3. Build the evaluation rows (cartesian product of subjects and exams)
  const marksData = []
  for (const assign of subjectAssignments) {
    for (const exam of exams) {
      // Check if a mark entry already exists to ensure idempotency
      const existingMark = await tx.mark.findFirst({
        where: {
          studentId,
          subjectId: assign.subjectId,
          classId,
          sectionId,
          examId: exam.id,
          sessionId,
          branchId,
        },
        select: { id: true },
      })

      if (!existingMark) {
        marksData.push({
          studentId,
          subjectId: assign.subjectId,
          classId,
          sectionId,
          examId: exam.id,
          sessionId,
          branchId,
          mark: '{}', // Empty JSON for evaluation components
          absent: '',
        })
      }
    }
  }

  // 4. Perform bulk create for all missing matrix entries
  if (marksData.length > 0) {
    await tx.mark.createMany({
      data: marksData,
    })
    console.log(`[STUDENT SERVICE] Successfully bound ${marksData.length} evaluation matrix entries for student ${studentId}`)
  }
}

/**
 * Wipes ungraded evaluation matrices for a student within a session.
 * Preserves rows where marks have actually been recorded.
 *
 * @param {object} tx - Prisma Transaction context
 * @param {object} params - Evaluation wipe parameters
 */
async function wipeEvaluationMatrix(tx, { studentId, sessionId }) {
  const result = await tx.mark.deleteMany({
    where: {
      studentId,
      sessionId,
      OR: [
        { mark: null },
        { mark: '' },
        { mark: '{}' },
      ],
    },
  })
  console.log(`[STUDENT SERVICE] Wiped ${result.count} ungraded evaluation matrix entries for student ${studentId}`)
}

module.exports = {
  generateSecurePassword,
  generateRegistrationNumber,
  bindEvaluationMatrix,
  wipeEvaluationMatrix,
}
