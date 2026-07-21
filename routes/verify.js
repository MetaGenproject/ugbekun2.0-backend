const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const router = express.Router();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * GET /api/verify/:token
 * Public endpoint to verify ID cards and certificates.
 */
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';

    // 1. Try to find a matching ID Card
    const idCard = await prisma.idCard.findFirst({
      where: {
        OR: [
          { verifyToken: token },
          { cardNumber: token },
          { cardNumber: decodeURIComponent(token) }
        ]
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            photo: true
          }
        },
        user: {
          select: {
            id: true,
            username: true,
            role: true
          }
        },
        branch: {
          select: {
            name: true,
            code: true
          }
        }
      }
    });

    if (idCard) {
      // Log verification hit
      await prisma.verificationLog.create({
        data: {
          token,
          entityType: 'id_card',
          ipAddress,
          userAgent
        }
      });

      let name = 'Unknown';
      let photo = null;
      let role = 'Staff';

      if (idCard.entityType === 'student' && idCard.student) {
        name = `${idCard.student.firstName} ${idCard.student.lastName}`;
        photo = idCard.student.photo;
        role = 'Student';
      } else if (idCard.entityType === 'staff' && idCard.user) {
        name = idCard.user.username;
        // Map role codes to names
        const roles = { 3: 'Teacher', 4: 'Accountant', 8: 'Receptionist', 9: 'Proprietor', 12: 'Librarian', 13: 'Staff' };
        role = roles[idCard.user.role] || 'Staff';
      }

      return res.status(200).json({
        success: true,
        valid: true,
        type: 'id_card',
        cardNumber: idCard.cardNumber,
        status: idCard.status,
        name,
        role,
        photo,
        branchName: idCard.branch?.name || 'N/A',
        issuedAt: idCard.issuedAt,
        expiresAt: idCard.expiresAt,
        revokedAt: idCard.revokedAt,
        revokedReason: idCard.revokedReason
      });
    }

    // 2. Try to find a matching Certificate
    const certificate = await prisma.certificate.findFirst({
      where: {
        OR: [
          { verifyToken: token },
          { certificateNo: token },
          { certificateNo: decodeURIComponent(token) }
        ]
      },
      include: {
        student: {
          select: {
            firstName: true,
            lastName: true,
            registerNo: true
          }
        },
        branch: {
          select: {
            name: true,
            code: true
          }
        }
      }
    });

    if (certificate) {
      // Log verification hit
      await prisma.verificationLog.create({
        data: {
          token,
          entityType: 'certificate',
          ipAddress,
          userAgent
        }
      });

      const studentName = certificate.student
        ? `${certificate.student.firstName} ${certificate.student.lastName}`
        : 'Unknown';

      return res.status(200).json({
        success: true,
        valid: true,
        type: 'certificate',
        certificateNo: certificate.certificateNo,
        certificateType: certificate.certificateType,
        status: certificate.status,
        name: studentName,
        title: certificate.title,
        description: certificate.description,
        branchName: certificate.branch?.name || 'N/A',
        issuedAt: certificate.issuedAt
      });
    }

    // Not found
    return res.status(404).json({
      success: false,
      valid: false,
      message: 'Invalid verification token'
    });
  } catch (error) {
    console.error('[VERIFY] Public verification error:', error);
    return res.status(500).json({
      success: false,
      valid: false,
      message: 'Internal server error during verification'
    });
  }
});

module.exports = router;
