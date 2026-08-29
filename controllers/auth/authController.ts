import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma';
import { sendMail } from '../../lib/emailService';
import { buildPasswordResetEmail } from '../../lib/emailTemplates';

// Role map: role code -> role name
export const ROLE_NAMES: Record<number, string> = {
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

// In-memory store for password reset tokens: key: identifier -> { code, expiresAt, userId }
const resetTokens = new Map<string, { code: string; expiresAt: number; userId: number; username: string }>();

/**
 * POST /api/auth/login
 * Body: { username: string, password: string }
 */
export async function login(req: Request, res: Response): Promise<Response | void> {
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
      passwordMatch = user.password === trimmedPassword;
    }

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials.',
      });
    }

    // Update last login timestamp asynchronously
    prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    }).catch((err) => console.error('[AUTH] Failed to update lastLogin:', err));

    // Fetch branch information for student, parent, teacher, or branch admin
    let branchInfo: any = null;
    const roleId = user.role;

    try {
      if (roleId === 2) { // Branch Admin
        if (user.legacyUserId) {
          const branch = await prisma.branch.findUnique({
            where: { id: user.legacyUserId },
            select: { id: true, name: true, code: true, logo: true },
          });
          if (branch) {
            branchInfo = branch;
          }
        }
        if (!branchInfo) {
          const fallbackBranch = await prisma.branch.findFirst({
            where: { active: true },
            orderBy: { id: 'desc' },
            select: { id: true, name: true, code: true, logo: true },
          });
          if (fallbackBranch) {
            branchInfo = fallbackBranch;
          }
        }
      } else if (roleId === 7) { // Student
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
          include: { branch: { select: { id: true, name: true, code: true, logo: true } } },
        });
        if (teacher?.branch) {
          branchInfo = teacher.branch;
        }
      } else { // Other staff roles (Accountant, Receptionist, Librarian, etc.)
        const [payrollStaff, teacherRecord] = await Promise.all([
          prisma.payrollComponent.findFirst({
            where: { staffId: user.id },
            include: { branch: { select: { id: true, name: true, code: true, logo: true } } },
          }).catch(() => null),
          prisma.teacher.findFirst({
            where: { userId: user.id },
            include: { branch: { select: { id: true, name: true, code: true, logo: true } } },
          }).catch(() => null),
        ]);
        if (payrollStaff?.branch) {
          branchInfo = payrollStaff.branch;
        } else if (teacherRecord?.branch) {
          branchInfo = teacherRecord.branch;
        } else if (user.legacyUserId) {
          const fallbackBranch = await prisma.branch.findUnique({
            where: { id: user.legacyUserId },
            select: { id: true, name: true, code: true, logo: true },
          }).catch(() => null);
          if (fallbackBranch) branchInfo = fallbackBranch;
        }
      }
    } catch (branchError) {
      console.error('[AUTH] Error fetching branch info:', branchError);
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

    const token = jwt.sign(payload, secret, { expiresIn } as any);

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
}

/**
 * POST /api/auth/register
 * Body: { username: string, password: string, role: number }
 */
export async function register(req: Request, res: Response): Promise<Response | void> {
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

    // Check if the username already exists
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

    // Get the maximum user ID
    const maxUser = await prisma.user.findFirst({
      orderBy: { id: 'desc' },
    });
    const nextId = maxUser ? maxUser.id + 1 : 1;

    // Create the new user
    const newUser = await prisma.user.create({
      data: {
        id: nextId,
        username: trimmedUsername,
        password: hashedPassword,
        role: role ? parseInt(role) : 2,
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
}

/**
 * GET /api/auth/me
 */
export function getMe(req: Request, res: Response): Response | void {
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
}

/**
 * POST /api/auth/forgot-password
 */
export async function forgotPassword(req: Request, res: Response): Promise<Response | void> {
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

    let targetEmail: string | null = null;

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
    } catch (lookupErr: any) {
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
    const expiresAt = Date.now() + 15 * 60 * 1000;

    const tokenKey = input.toLowerCase();
    resetTokens.set(tokenKey, {
      code: resetCode,
      expiresAt,
      userId: user.id,
      username: user.username,
    });

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
  } catch (error: any) {
    console.error('[AUTH] Forgot password error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to process request. Please try again.',
    });
  }
}

/**
 * POST /api/auth/verify-reset-token
 */
export async function verifyResetToken(req: Request, res: Response): Promise<Response | void> {
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
}

/**
 * POST /api/auth/reset-password
 */
export async function resetPassword(req: Request, res: Response): Promise<Response | void> {
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
}
