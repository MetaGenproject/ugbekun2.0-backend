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

    // Find user by username (case-insensitive)
    const user = await prisma.user.findFirst({
      where: {
        username: {
          equals: username,
          mode: 'insensitive',
        },
      },
    });

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
      passwordMatch = await bcrypt.compare(password, user.password);
    } else {
      // Legacy plain-text comparison (for migrated accounts not yet re-hashed)
      passwordMatch = user.password === password;
    }

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials.',
      });
    }

    // Update last login timestamp
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

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

module.exports = router;
