import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma';

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

async function resolveUserWithBranch(targetId: number) {
  // 1. Search by direct User ID or legacyUserId first
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { id: targetId },
        { legacyUserId: targetId },
      ],
    },
    include: {
      student: { select: { id: true, firstName: true, lastName: true, branchId: true } },
      parent: { select: { id: true, name: true, branchId: true } },
      teacher: { select: { id: true, name: true, branchId: true } },
    },
  });

  // 2. Fallback to profile record IDs if not matched by User ID
  if (!user) {
    user = await prisma.user.findFirst({
      where: {
        OR: [
          { student: { id: targetId } },
          { parent: { id: targetId } },
          { teacher: { id: targetId } },
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

  const branchId = user.student?.branchId || user.parent?.branchId || user.teacher?.branchId || null;
  const displayName =
    (user.student ? `${user.student.firstName} ${user.student.lastName}`.trim() : null) ||
    user.parent?.name ||
    user.teacher?.name ||
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

    if (isNaN(targetUserId)) {
      return res.status(400).json({ success: false, message: 'Invalid target user ID.' });
    }

    const targetUser = await resolveUserWithBranch(targetUserId);

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

    return res.status(200).json({
      success: true,
      user: {
        id: targetUser.id,
        username: targetUser.username,
        rawPassword: targetUser.rawPassword || '•••••••• (Initial Password Unchanged)',
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
 * School Admin resets user password globally across the system
 */
export async function resetUserPassword(req: Request, res: Response): Promise<Response | void> {
  try {
    const adminBranchId = (req as any).branchId;
    const targetUserId = parseInt(String(req.params.userId), 10);
    const { newPassword } = req.body;

    if (isNaN(targetUserId)) {
      return res.status(400).json({ success: false, message: 'Invalid target user ID.' });
    }

    const targetUser = await resolveUserWithBranch(targetUserId);

    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User record not found.' });
    }

    // Strict multi-tenant isolation check
    if (adminBranchId && targetUser.resolvedBranchId && targetUser.resolvedBranchId !== adminBranchId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only reset passwords for users in your school branch.',
      });
    }

    const finalPassword = (newPassword && String(newPassword).trim().length >= 6)
      ? String(newPassword).trim()
      : generateSecurePassword();

    const hashedPassword = await bcrypt.hash(finalPassword, 10);

    // Update global user credentials
    await prisma.user.update({
      where: { id: targetUser.id },
      data: {
        password: hashedPassword,
        rawPassword: finalPassword,
        updatedAt: new Date(),
      },
    });

    return res.status(200).json({
      success: true,
      message: `Password reset successfully for ${targetUser.displayName}.`,
      credentials: {
        id: targetUser.id,
        username: targetUser.username,
        newPassword: finalPassword,
        roleName: ROLE_NAMES[targetUser.role] || 'User',
      },
    });
  } catch (error: any) {
    console.error('[ADMIN_USER] Reset password error:', error);
    return res.status(500).json({ success: false, message: 'Failed to reset user password.' });
  }
}
