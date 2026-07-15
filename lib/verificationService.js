/**
 * verificationService.js
 * Public Certificate & ID Card verification engine.
 * Resolves tokens and SHA-256 hashes to verified entity data.
 * Strictly whitelists response fields — no PII leakage.
 */
const crypto = require('crypto');

/**
 * Computes the SHA-256 hash of a certificate/ID number for hash-based lookup.
 * @param {string} entityNumber - e.g. "CERT/MTGA/2026/0001"
 */
function hashEntityNumber(entityNumber) {
  return crypto.createHash('sha256').update(entityNumber.trim()).digest('hex');
}

/**
 * Logs the verification attempt to the VerificationLog table.
 */
async function logVerification(token, entityType, req, prisma) {
  try {
    await prisma.verificationLog.create({
      data: {
        token,
        entityType,
        ipAddress: req.ip || req.connection?.remoteAddress || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown'
      }
    });
  } catch (err) {
    console.error('[Verification] Failed to write audit log:', err.message);
  }
}

/**
 * Builds a safe, whitelisted response object from a Certificate record.
 * Never exposes internal IDs, financial data, contact details, or system scores.
 */
function serializeCertificate(cert, branch) {
  return {
    entityType: 'certificate',
    valid: cert.status === 'active',
    status: cert.status,
    certificateNo: cert.certificateNo,
    certificateType: cert.certificateType,
    title: cert.title,
    description: cert.description || null,
    studentName: `${cert.student.firstName} ${cert.student.lastName}`,
    registerNo: cert.student.registerNo,
    issuedAt: cert.issuedAt,
    institutionName: branch?.name || 'Ugbekun Institution',
    institutionBranch: branch?.city || null
  };
}

/**
 * Builds a safe, whitelisted response object from an IdCard record.
 */
function serializeIdCard(card, branch) {
  const holderName = card.student
    ? `${card.student.firstName} ${card.student.lastName}`
    : card.user?.username || 'Unknown';

  const registerNo = card.student?.registerNo || null;

  return {
    entityType: 'id_card',
    valid: card.status === 'active',
    status: card.status,
    cardNumber: card.cardNumber,
    entitySubtype: card.entityType,
    holderName,
    registerNo,
    issuedAt: card.issuedAt,
    expiresAt: card.expiresAt || null,
    institutionName: branch?.name || 'Ugbekun Institution',
    institutionBranch: branch?.city || null
  };
}

/**
 * Resolve by UUID verification token (QR scan path).
 * @param {string} token
 * @param {any} prisma
 * @param {any} req - Express request (for audit logging)
 */
async function resolveByToken(token, prisma, req) {
  // Try Certificate first
  const cert = await prisma.certificate.findUnique({
    where: { verifyToken: token },
    include: {
      student: { select: { firstName: true, lastName: true, registerNo: true } },
      branch: { select: { name: true, city: true } }
    }
  });

  if (cert) {
    await logVerification(token, 'certificate', req, prisma);
    return serializeCertificate(cert, cert.branch);
  }

  // Try IdCard
  const card = await prisma.idCard.findUnique({
    where: { verifyToken: token },
    include: {
      student: { select: { firstName: true, lastName: true, registerNo: true } },
      user: { select: { username: true } },
      branch: { select: { name: true, city: true } }
    }
  });

  if (card) {
    await logVerification(token, 'id_card', req, prisma);
    return serializeIdCard(card, card.branch);
  }

  return null;
}

/**
 * Resolve by SHA-256 hash of certificate number or card number (programmatic lookup).
 * @param {string} sha256Hash
 * @param {any} prisma
 * @param {any} req
 */
async function resolveByHash(sha256Hash, prisma, req) {
  // Fetch all certificates and find hash match
  // Note: For scale, store a pre-computed hash column; for current scale, compute on fetch
  const certs = await prisma.certificate.findMany({
    include: {
      student: { select: { firstName: true, lastName: true, registerNo: true } },
      branch: { select: { name: true, city: true } }
    }
  });

  for (const cert of certs) {
    if (hashEntityNumber(cert.certificateNo) === sha256Hash) {
      await logVerification(sha256Hash, 'certificate', req, prisma);
      return serializeCertificate(cert, cert.branch);
    }
  }

  const cards = await prisma.idCard.findMany({
    include: {
      student: { select: { firstName: true, lastName: true, registerNo: true } },
      user: { select: { username: true } },
      branch: { select: { name: true, city: true } }
    }
  });

  for (const card of cards) {
    if (hashEntityNumber(card.cardNumber) === sha256Hash) {
      await logVerification(sha256Hash, 'id_card', req, prisma);
      return serializeIdCard(card, card.branch);
    }
  }

  return null;
}

module.exports = { resolveByToken, resolveByHash, hashEntityNumber };
