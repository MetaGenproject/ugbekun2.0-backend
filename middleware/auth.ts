import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { staffMatchesBranch } from '../lib/branchStats';

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';

export function getBearerToken(req: Request): string | null {
  const authHeader = req.headers?.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length);
}

export async function resolveBranchForAdmin(decoded: any): Promise<number | null> {
  const tokenBranchId = decoded.branchId ? Number(decoded.branchId) : (decoded.legacyUserId ? Number(decoded.legacyUserId) : null);
  if (tokenBranchId) {
    const branch = await prisma.branch.findUnique({
      where: { id: tokenBranchId },
      select: { id: true },
    });
    if (branch) {
      return branch.id;
    }
  }

  // Check database User profile relations
  const userId = decoded.sub || decoded.id;
  if (userId) {
    const userRecord = await prisma.user.findFirst({
      where: {
        OR: [
          { id: Number(userId) },
          { legacyUserId: Number(userId) },
        ],
      },
      select: {
        teacher: { select: { branchId: true } },
        student: { select: { branchId: true } },
        parent: { select: { branchId: true } },
      },
    });

    const dbBranchId = userRecord?.teacher?.branchId || userRecord?.student?.branchId || userRecord?.parent?.branchId;
    if (dbBranchId) {
      return dbBranchId;
    }
  }

  if (decoded.username) {
    const branches = await prisma.branch.findMany({
      where: { active: true },
      select: { id: true, name: true, code: true },
    });

    const matched = branches.find((branch: any) => staffMatchesBranch(decoded.username, branch));
    if (matched) {
      return matched.id;
    }
  }

  // Fallback to primary active branch
  const primaryBranch = await prisma.branch.findFirst({
    where: { active: true },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  return primaryBranch ? primaryBranch.id : 1;
}

/**
 * Validates any valid JWT and attaches user context to req.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' });
    return;
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.userRole = decoded.role;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Token is invalid or expired.' });
  }
}

/**
 * Verifies Role 2 (Branch Admin) and attaches resolved branchId to req.
 */
export async function requireBranchAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' });
    return;
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (!decoded || (decoded.role !== 2 && decoded.role !== 1)) {
      res.status(403).json({ success: false, message: 'Forbidden. Branch admin privileges required.' });
      return;
    }

    const branchId = await resolveBranchForAdmin(decoded);
    if (!branchId) {
      res.status(403).json({
        success: false,
        message: 'Branch admin account is not linked to an active school branch.',
      });
      return;
    }

    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.adminId = decoded.sub || decoded.id;
    req.userRole = decoded.role;
    req.branchId = branchId;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Token is invalid or expired.' });
  }
}

/**
 * Legacy compatibility helper that returns decoded object with branchId or null
 */
export async function assertBranchAdmin(req: Request, res: Response): Promise<any | null> {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' });
    return null;
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (!decoded || (decoded.role !== 2 && decoded.role !== 1)) {
      res.status(403).json({ success: false, message: 'Forbidden.' });
      return null;
    }

    const branchId = await resolveBranchForAdmin(decoded);
    if (!branchId) {
      res.status(403).json({
        success: false,
        message: 'Branch admin account is not linked to a school branch.',
      });
      return null;
    }

    return { ...decoded, branchId };
  } catch {
    res.status(401).json({ success: false, message: 'Token is invalid or expired.' });
    return null;
  }
}

/**
 * Verifies Role 1 (Superadmin)
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' });
    return;
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (!decoded || decoded.role !== 1) {
      res.status(403).json({ success: false, message: 'Forbidden. Superadmin privileges required.' });
      return;
    }

    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.userRole = decoded.role;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Token is invalid or expired.' });
  }
}

/**
 * Verifies Role 3 (Teacher) or Admin acting as Teacher
 */
export async function requireTeacher(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' });
    return;
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.userRole = decoded.role;

    if (decoded.role === 3) {
      const teacherRecord = await prisma.teacher.findFirst({
        where: {
          OR: [
            { userId: req.userId },
            { id: req.userId },
          ],
        },
        select: { id: true, branchId: true },
      });
      req.teacherId = teacherRecord ? teacherRecord.id : req.userId;
      req.branchId = teacherRecord?.branchId || (decoded.branchId ? Number(decoded.branchId) : (decoded.legacyUserId ? Number(decoded.legacyUserId) : null));
      next();
      return;
    }

    // Admin acting as teacher support via x-admin-teacher-id
    if (decoded.role === 2 || decoded.role === 1) {
      const headerTeacherId = req.headers['x-admin-teacher-id'];
      if (headerTeacherId) {
        req.teacherId = Number(headerTeacherId);
      }
      req.branchId = await resolveBranchForAdmin(decoded);
      next();
      return;
    }

    res.status(403).json({ success: false, message: 'Forbidden. Teacher privileges required.' });
  } catch {
    res.status(401).json({ success: false, message: 'Token is invalid or expired.' });
  }
}

/**
 * Verifies Role 7 (Student)
 */
export async function requireStudent(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' });
    return;
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (!decoded || decoded.role !== 7) {
      res.status(403).json({ success: false, message: 'Forbidden. Student privileges required.' });
      return;
    }

    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.userRole = decoded.role;

    const studentRecord = await prisma.student.findFirst({
      where: {
        OR: [
          { userId: req.userId },
          { id: req.userId },
        ],
      },
      select: { id: true, branchId: true },
    });

    req.studentId = studentRecord ? studentRecord.id : req.userId;
    req.branchId = studentRecord?.branchId || (decoded.branchId ? Number(decoded.branchId) : (decoded.legacyUserId ? Number(decoded.legacyUserId) : null));
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Token is invalid or expired.' });
  }
}

/**
 * Verifies Role 6 (Parent)
 */
export async function requireParent(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: 'No token provided.' });
    return;
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (!decoded || decoded.role !== 6) {
      res.status(403).json({ success: false, message: 'Forbidden. Parent privileges required.' });
      return;
    }

    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.userRole = decoded.role;

    const parentRecord = await prisma.parent.findFirst({
      where: {
        OR: [
          { userId: req.userId },
          { id: req.userId },
        ],
      },
      select: { id: true, branchId: true },
    });

    req.parentId = parentRecord ? parentRecord.id : req.userId;
    req.branchId = parentRecord?.branchId || (decoded.branchId ? Number(decoded.branchId) : (decoded.legacyUserId ? Number(decoded.legacyUserId) : null));
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Token is invalid or expired.' });
  }
}
