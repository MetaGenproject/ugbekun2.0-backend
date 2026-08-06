const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const router = express.Router();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Role map: role code -> role name
// Verified against ugbekunc_Saas (2).sql:
//   Role 1 = 1 user  (admin@ugbekun) → Superadmin / Master (global platform admin)
//   Role 2 = 45 users (md, branch names) → Branch Admin (per-school admin)
const ROLE_NAMES = {
  1: 'superadmin',
  2: 'admin',
  3: 'teacher',
  4: 'accountant',
  6: 'parent',
  7: 'student',
  8: 'receptionist',
  9: 'proprietor',
  12: 'librarian',
  13: 'staff',
};

/**
 * POST /api/auth/login
 * Body: { username: string, password: string }
 * Returns: { token, user: { id, username, role, roleName } }
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const trimmedUsername = String(username || '').trim().replace(/\s+/g, '');
    const trimmedPassword = String(password || '').trim();

    if (!trimmedUsername || !trimmedPassword) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required.',
      });
    }

    if (trimmedUsername.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Username must be at least 2 characters long.',
      });
    }

    // Find user by username using fast B-tree index lookup (@unique username)
    let user = await prisma.user.findUnique({
      where: { username: trimmedUsername },
    });

    // Fallback to case-insensitive mode only if exact B-tree lookup yields no record
    if (!user) {
      user = await prisma.user.findFirst({
        where: {
          username: {
            equals: trimmedUsername,
            mode: 'insensitive',
          },
        },
      });
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials.',
      });
    }

    if (!user.active) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated. Please contact the administrator.',
      });
    }

    // Compare password — supports both bcrypt hashes and legacy plain passwords
    let passwordMatch = false;
    const isBcryptHash = user.password.startsWith('$2');

    if (isBcryptHash) {
      passwordMatch = await bcrypt.compare(trimmedPassword, user.password);
    } else {
      // Legacy plain-text comparison (for migrated accounts not yet re-hashed)
      passwordMatch = user.password === trimmedPassword;
    }

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials.',
      });
    }

    // Update last login timestamp asynchronously in background without blocking API response
    prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    }).catch((err) => console.error('[AUTH] Failed to update lastLogin:', err));

    // Fetch branch information for student, parent, or teacher
    let branchInfo = null;
    const roleId = user.role;
    
    try {
      if (roleId === 7) { // Student
        const student = await prisma.student.findUnique({
          where: { userId: user.id },
          include: { branch: { select: { id: true, name: true, code: true } } },
        });
        if (student?.branch) {
          branchInfo = student.branch;
        }
      } else if (roleId === 6) { // Parent
        const parent = await prisma.parent.findUnique({
          where: { userId: user.id },
          include: { branch: { select: { id: true, name: true, code: true } } },
        });
        if (parent?.branch) {
          branchInfo = parent.branch;
        }
      } else if (roleId === 3) { // Teacher
        const teacher = await prisma.teacher.findUnique({
          where: { userId: user.id },
          include: { branch: { select: { id: true, name: true, code: true } } },
        });
        if (teacher?.branch) {
          branchInfo = teacher.branch;
        }
      }
    } catch (branchError) {
      console.error('[AUTH] Error fetching branch info:', branchError);
      // Continue without branch info if fetch fails
    }

    // Sign JWT
    const secret = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';
    const expiresIn = process.env.JWT_EXPIRES_IN || '8h';

    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      roleName: ROLE_NAMES[user.role] || 'user',
      legacyUserId: user.legacyUserId,
    };

    const token = jwt.sign(payload, secret, { expiresIn });

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        roleName: ROLE_NAMES[user.role] || 'user',
        legacyUserId: user.legacyUserId,
        lastLogin: user.lastLogin,
        branch: branchInfo,
      },
    });
  } catch (error) {
    console.error('[AUTH] Login error:', error);
    return res.status(500).json({
      success: false,
      message: 'An internal server error occurred. Please try again.',
    });
  }
});

/**
 * POST /api/auth/register
 * Body: { username: string, password: string, role: number }
 * Returns: { success: true, message: 'Registration successful.' }
 */
router.post('/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required.',
      });
    }

    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      return res.status(400).json({
        success: false,
        message: 'Username cannot be blank.',
      });
    }

    if (trimmedUsername.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Username must be at least 2 characters long.',
      });
    }

    // Check if the username already exists (case-insensitive)
    const existingUser = await prisma.user.findFirst({
      where: {
        username: {
          equals: trimmedUsername,
          mode: 'insensitive',
        },
      },
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Username already exists. Please choose another combination.',
      });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Get the maximum user ID in the database to generate a unique ID
    const maxUser = await prisma.user.findFirst({
      orderBy: {
        id: 'desc',
      },
    });
    const nextId = maxUser ? maxUser.id + 1 : 1;

    // Create the new user
    const newUser = await prisma.user.create({
      data: {
        id: nextId,
        username: trimmedUsername,
        password: hashedPassword,
        role: role ? parseInt(role) : 2, // Default to Branch Admin (Role 2)
        active: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Registration successful.',
      user: {
        id: newUser.id,
        username: newUser.username,
        role: newUser.role,
        roleName: ROLE_NAMES[newUser.role] || 'user',
      },
    });
  } catch (error) {
    console.error('[AUTH] Registration error:', error);
    return res.status(500).json({
      success: false,
      message: 'An internal server error occurred. Please try again.',
    });
  }
});

/**
 * GET /api/auth/me
 * Returns the currently authenticated user from their JWT.
 */
router.get('/me', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const secret = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';
    const decoded = jwt.verify(token, secret);

    return res.status(200).json({ success: true, user: decoded });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Token is invalid or expired.' });
  }
});

// ─── Forgot & Reset Password Endpoints ─────────────────────────────────────
const { sendMail } = require('../lib/emailService');
const { buildPasswordResetEmail } = require('../lib/emailTemplates');

// In-memory store for password reset tokens: key: identifier -> { code, expiresAt, userId }
const resetTokens = new Map();

/**
 * POST /api/auth/forgot-password
 * Body: { emailOrUsername: string }
 */
router.post('/forgot-password', async (req, res) => {
  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }
    const emailOrUsername = body.emailOrUsername || body.username || body.email;
    const input = String(emailOrUsername || '').trim();

    if (!input) {
      return res.status(400).json({
        success: false,
        message: 'Username or email address is required.',
      });
    }

    // Search user by username
    let user = await prisma.user.findFirst({
      where: {
        username: {
          equals: input,
          mode: 'insensitive',
        },
      },
    });

    let targetEmail = null;

    try {
      if (user) {
        if (user.role === 6) { // Parent
          const parent = await prisma.parent.findFirst({ where: { userId: user.id } });
          if (parent?.email) targetEmail = parent.email;
        } else if (user.role === 3) { // Teacher
          const teacher = await prisma.teacher.findFirst({ where: { userId: user.id } });
          if (teacher?.email) targetEmail = teacher.email;
        } else if (user.role === 7) { // Student
          const student = await prisma.student.findFirst({ where: { userId: user.id } });
          if (student?.email) targetEmail = student.email;
        }
      } else {
        // Input might be an email address directly
        const parent = await prisma.parent.findFirst({ where: { email: { equals: input, mode: 'insensitive' } }, include: { user: true } });
        if (parent?.user) {
          user = parent.user;
          targetEmail = parent.email;
        } else {
          const teacher = await prisma.teacher.findFirst({ where: { email: { equals: input, mode: 'insensitive' } }, include: { user: true } });
          if (teacher?.user) {
            user = teacher.user;
            targetEmail = teacher.email;
          }
        }
      }
    } catch (lookupErr) {
      console.error('[AUTH] Profile email lookup warning:', lookupErr.message);
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No account found matching that username or email address.',
      });
    }

    // Generate a 6-digit verification code
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes validity

    const tokenKey = input.toLowerCase();
    resetTokens.set(tokenKey, {
      code: resetCode,
      expiresAt,
      userId: user.id,
      username: user.username,
    });

    // Send email if recipient email is available
    if (targetEmail) {
      const emailContent = buildPasswordResetEmail({
        username: user.username,
        resetCode,
        schoolName: 'Ugbekun School Management System',
      });
      await sendMail(targetEmail, emailContent.subject, emailContent.html);
    }

    return res.status(200).json({
      success: true,
      message: targetEmail
        ? `Reset code sent to ${targetEmail}. Please check your inbox.`
        : `Reset code generated successfully for ${user.username}. Code: ${resetCode}`,
      demoCode: resetCode,
    });
  } catch (error) {
    console.error('[AUTH] Forgot password error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to process request. Please try again.',
    });
  }
});

/**
 * POST /api/auth/verify-reset-token
 * Body: { emailOrUsername: string, token: string }
 */
router.post('/verify-reset-token', async (req, res) => {
  try {
    const body = req.body || {};
    const emailOrUsername = body.emailOrUsername || body.username || body.email;
    const token = body.token || body.code;
    const tokenKey = String(emailOrUsername || '').trim().toLowerCase();
    const codeInput = String(token || '').trim();

    const record = resetTokens.get(tokenKey);
    if (!record) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification code.' });
    }

    if (Date.now() > record.expiresAt) {
      resetTokens.delete(tokenKey);
      return res.status(400).json({ success: false, message: 'Verification code has expired. Please request a new code.' });
    }

    if (record.code !== codeInput) {
      return res.status(400).json({ success: false, message: 'Incorrect verification code. Please check and try again.' });
    }

    return res.status(200).json({ success: true, message: 'Verification code confirmed.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Verification failed.' });
  }
});

/**
 * POST /api/auth/reset-password
 * Body: { emailOrUsername: string, token: string, newPassword: string }
 */
router.post('/reset-password', async (req, res) => {
  try {
    const body = req.body || {};
    const emailOrUsername = body.emailOrUsername || body.username || body.email;
    const token = body.token || body.code;
    const newPassword = body.newPassword || body.password;
    const tokenKey = String(emailOrUsername || '').trim().toLowerCase();
    const codeInput = String(token || '').trim();
    const cleanPassword = String(newPassword || '').trim();

    if (!cleanPassword || cleanPassword.length < 4) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 4 characters long.',
      });
    }

    const record = resetTokens.get(tokenKey);
    if (!record) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token. Please restart.' });
    }

    if (Date.now() > record.expiresAt) {
      resetTokens.delete(tokenKey);
      return res.status(400).json({ success: false, message: 'Reset token has expired.' });
    }

    if (record.code !== codeInput) {
      return res.status(400).json({ success: false, message: 'Incorrect verification code.' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(cleanPassword, 10);

    // Update User password in database
    await prisma.user.update({
      where: { id: record.userId },
      data: { password: hashedPassword },
    });

    // Clear reset token
    resetTokens.delete(tokenKey);

    return res.status(200).json({
      success: true,
      message: 'Password successfully updated! You can now sign in with your new password.',
    });
  } catch (error) {
    console.error('[AUTH] Reset password error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred resetting your password.',
    });
  }
});

module.exports = router;
