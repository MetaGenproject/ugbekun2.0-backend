import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma';
import { invalidateStudentContextCache } from '../../middleware/auth';

const ROLE_NAMES: Record<number, string> = {
  1: 'SuperAdmin',
  2: 'Branch Admin',
  3: 'Teacher',
  4: 'Accountant',
  6: 'Parent',
  7: 'Student',
  8: 'Receptionist',
  9: 'Proprietor',
  12: 'Librarian',
  13: 'Staff',
};

function generateSecurePassword(length = 10): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

async function resolveUserWithBranch(targetId: number, adminBranchId?: number, roleHint?: string) {
  const normalizedRole = roleHint ? roleHint.trim().toLowerCase() : '';

  // 1. Direct User lookup by Primary Key (id) first!
  const directUser = await prisma.user.findUnique({
    where: { id: targetId },
    include: {
      student: { select: { branchId: true, firstName: true, lastName: true } },
      teacher: { select: { branchId: true, name: true } },
      parent: { select: { branchId: true, name: true } },
    },
  });

  if (directUser) {
    const student = directUser.student;
    const teacher = directUser.teacher;
    const parent = directUser.parent;
    const resolvedBranch = student?.branchId || teacher?.branchId || parent?.branchId || directUser.legacyUserId;

    if (!adminBranchId || resolvedBranch === adminBranchId) {
      let displayName = directUser.username;
      if (student) displayName = `${student.firstName} ${student.lastName}`.trim();
      else if (teacher) displayName = teacher.name;
      else if (parent) displayName = parent.name;

      return {
        ...directUser,
        resolvedBranchId: resolvedBranch,
        displayName,
      };
    }
  }

  // 2. If adminBranchId is provided, fallback to resolving via student / teacher / parent ID
  if (adminBranchId) {
    // 2a. If roleHint is student or default check student first
    if (normalizedRole === 'student' || (!normalizedRole && targetId > 0)) {
      const student = await prisma.student.findFirst({
        where: {
          branchId: adminBranchId,
          OR: [
            { id: targetId },
            { userId: targetId },
          ],
        },
        include: {
          user: true,
        },
      });

      if (student?.user) {
        return {
          ...student.user,
          resolvedBranchId: adminBranchId,
          displayName: `${student.firstName} ${student.lastName}`.trim(),
        };
      }
    }

    // 2b. Check teacher
    if (normalizedRole === 'teacher' || (!normalizedRole && targetId > 0)) {
      const teacher = await prisma.teacher.findFirst({
        where: {
          branchId: adminBranchId,
          OR: [
            { id: targetId },
            { userId: targetId },
          ],
        },
        include: {
          user: true,
        },
      });

      if (teacher?.user) {
        return {
          ...teacher.user,
          resolvedBranchId: adminBranchId,
          displayName: teacher.name,
        };
      }
    }

    // 2c. Check parent
    if (normalizedRole === 'parent' || (!normalizedRole && targetId > 0)) {
      const parent = await prisma.parent.findFirst({
        where: {
          branchId: adminBranchId,
          OR: [
            { id: targetId },
            { userId: targetId },
          ],
        },
        include: {
          user: true,
        },
      });

      if (parent?.user) {
        return {
          ...parent.user,
          resolvedBranchId: adminBranchId,
          displayName: parent.name,
        };
      }
    }

    // 2d. Check direct user record in this branch
    const branchUser = await prisma.user.findFirst({
      where: {
        id: targetId,
        OR: [
          { legacyUserId: adminBranchId },
          { teacher: { branchId: adminBranchId } },
          { student: { branchId: adminBranchId } },
          { parent: { branchId: adminBranchId } },
        ],
      },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, branchId: true } },
        parent: { select: { id: true, name: true, branchId: true } },
        teacher: { select: { id: true, name: true, branchId: true } },
      },
    });

    if (branchUser) {
      const displayName =
        branchUser.teacher?.name ||
        (branchUser.student ? `${branchUser.student.firstName} ${branchUser.student.lastName}`.trim() : null) ||
        branchUser.parent?.name ||
        branchUser.username;

      return {
        ...branchUser,
        resolvedBranchId: adminBranchId,
        displayName,
      };
    }
  }

  // 3. Fallback: Search by direct User ID
  let user = await prisma.user.findFirst({
    where: { id: targetId },
    include: {
      student: { select: { id: true, firstName: true, lastName: true, branchId: true } },
      parent: { select: { id: true, name: true, branchId: true } },
      teacher: { select: { id: true, name: true, branchId: true } },
    },
  });

  // 4. Fallback: Search by profile record IDs or legacyUserId
  if (!user) {
    user = await prisma.user.findFirst({
      where: {
        OR: [
          { student: { id: targetId } },
          { teacher: { id: targetId } },
          { parent: { id: targetId } },
          { legacyUserId: targetId },
        ],
      },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, branchId: true } },
        parent: { select: { id: true, name: true, branchId: true } },
        teacher: { select: { id: true, name: true, branchId: true } },
      },
    });
  }

  if (!user) return null;

  const branchId = user.student?.branchId || user.teacher?.branchId || user.parent?.branchId || null;
  const displayName =
    (user.student ? `${user.student.firstName} ${user.student.lastName}`.trim() : null) ||
    user.teacher?.name ||
    user.parent?.name ||
    user.username;

  return {
    ...user,
    resolvedBranchId: branchId,
    displayName,
  };
}

/**
 * GET /api/admin/users/:userId/credentials
 * School Admin can view raw password and credentials of users in their branch
 */
export async function getUserCredentials(req: Request, res: Response): Promise<Response | void> {
  try {
    const adminBranchId = (req as any).branchId;
    const targetUserId = parseInt(String(req.params.userId), 10);
    const roleHint = req.query.role ? String(req.query.role) : undefined;

    if (isNaN(targetUserId)) {
      return res.status(400).json({ success: false, message: 'Invalid target user ID.' });
    }

    const targetUser = await resolveUserWithBranch(targetUserId, adminBranchId, roleHint);

    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User record not found.' });
    }

    // Strict multi-tenant isolation: Admin can only access users within their branch
    if (adminBranchId && targetUser.resolvedBranchId && targetUser.resolvedBranchId !== adminBranchId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User belongs to a different school branch.',
      });
    }

    let displayRawPassword = targetUser.rawPassword;
    if (!displayRawPassword && targetUser.password) {
      const isDefault = await bcrypt.compare('student123', targetUser.password).catch(() => false);
      if (isDefault) displayRawPassword = 'student123';
    }

    // Fallback for students (role 7) to the school's configured default password
    if (!displayRawPassword && targetUser.role === 7) {
      const branchSetting = targetUser.resolvedBranchId
        ? await prisma.systemSetting.findFirst({
            where: { branchId: targetUser.resolvedBranchId },
            select: { defaultStudentPassword: true },
          })
        : null;
      displayRawPassword = branchSetting?.defaultStudentPassword || 'student123';
    }

    return res.status(200).json({
      success: true,
      user: {
        id: targetUser.id,
        username: targetUser.username,
        rawPassword: displayRawPassword || '•••••••• (Initial Password Unchanged)',
        role: targetUser.role,
        roleName: ROLE_NAMES[targetUser.role] || 'User',
        name: targetUser.displayName,
        active: targetUser.active,
        branchId: targetUser.resolvedBranchId,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN_USER] Get credentials error:', error?.message || error, error?.stack);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to retrieve user credentials.' });
  }
}

/**
 * POST /api/admin/users/:userId/reset-password
 * PUT/POST /api/admin/users/:userId/credentials
 * School Admin can update both username and password for students and users in their branch
 */
export async function updateUserCredentials(req: Request, res: Response): Promise<Response | void> {
  try {
    const adminBranchId = (req as any).branchId;
    const targetUserId = parseInt(String(req.params.userId), 10);
    const { username, newPassword, password, roleHint } = req.body;

    if (isNaN(targetUserId)) {
      return res.status(400).json({ success: false, message: 'Invalid target user ID.' });
    }

    const targetUser = await resolveUserWithBranch(targetUserId, adminBranchId, roleHint);

    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User record not found.' });
    }

    // Strict multi-tenant isolation check
    if (adminBranchId && targetUser.resolvedBranchId && targetUser.resolvedBranchId !== adminBranchId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only manage credentials for users in your school branch.',
      });
    }

    const updateData: { username?: string; password?: string; rawPassword?: string; updatedAt: Date } = {
      updatedAt: new Date(),
    };

    let updatedUsername = targetUser.username;
    let finalRawPassword = targetUser.rawPassword;

    // 1. Process custom Username update if supplied
    if (username !== undefined && username !== null) {
      const trimmedUsername = String(username).trim();
      if (trimmedUsername.length < 3) {
        return res.status(400).json({
          success: false,
          message: 'Username must be at least 3 characters long.',
        });
      }

      if (trimmedUsername.toLowerCase() !== targetUser.username.toLowerCase()) {
        const existingUser = await prisma.user.findFirst({
          where: {
            username: { equals: trimmedUsername, mode: 'insensitive' },
            id: { not: targetUser.id },
          },
          select: { id: true },
        });

        if (existingUser) {
          return res.status(400).json({
            success: false,
            message: `Username "${trimmedUsername}" is already taken by another account. Please choose a different username.`,
          });
        }
      }

      updateData.username = trimmedUsername;
      updatedUsername = trimmedUsername;
    }

    // 2. Process custom Password update if supplied
    const rawPassInput = (newPassword !== undefined ? newPassword : password);
    if (rawPassInput !== undefined && rawPassInput !== null && String(rawPassInput).trim().length > 0) {
      const trimmedPass = String(rawPassInput).trim();
      if (trimmedPass.length < 4) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 4 characters long.',
        });
      }

      const hashedPassword = await bcrypt.hash(trimmedPass, 10);
      updateData.password = hashedPassword;
      updateData.rawPassword = trimmedPass;
      finalRawPassword = trimmedPass;
    } else if (rawPassInput !== undefined && String(rawPassInput).trim().length === 0 && !username) {
      // If admin explicitly requested auto-generated password without entering one
      const generated = generateSecurePassword();
      const hashedPassword = await bcrypt.hash(generated, 10);
      updateData.password = hashedPassword;
      updateData.rawPassword = generated;
      finalRawPassword = generated;
    }

    if (!updateData.username && !updateData.password) {
      return res.status(400).json({
        success: false,
        message: 'No changes provided. Please enter a new username or password.',
      });
    }

    // Update global user credentials in database
    await prisma.user.update({
      where: { id: targetUser.id },
      data: updateData,
    });

    const isStudent = targetUser.role === 7;
    if (isStudent) {
      invalidateStudentContextCache(targetUser.id);
    }
    const roleLabel = ROLE_NAMES[targetUser.role] || 'User';

    return res.status(200).json({
      success: true,
      message: `Credentials updated successfully for ${targetUser.displayName} (${roleLabel}).`,
      credentials: {
        id: targetUser.id,
        username: updatedUsername,
        newPassword: finalRawPassword || '••••••••',
        rawPassword: finalRawPassword || '••••••••',
        roleName: roleLabel,
        isStudent,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN_USER] Update credentials error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to update user credentials.' });
  }
}

export const resetUserPassword = updateUserCredentials;
