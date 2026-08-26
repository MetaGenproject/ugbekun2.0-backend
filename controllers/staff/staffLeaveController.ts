import { Request, Response } from 'express';
import prisma from '../../lib/prisma';

/**
 * GET /api/admin/hr/leave-categories
 */
export async function getLeaveCategories(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const categories = await prisma.leaveCategory.findMany({
      where: { branchId },
      orderBy: { name: 'asc' },
    });

    return res.json({ success: true, categories });
  } catch (error) {
    console.error('[ADMIN] Fetch leave categories error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch leave categories.' });
  }
}

/**
 * POST /api/admin/hr/leave-categories
 */
export async function createLeaveCategory(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, daysPerYear, isPaid, requiresAttachment, applicableRoles, description } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Category name is required.' });
    }

    const category = await prisma.leaveCategory.create({
      data: {
        name: String(name).trim(),
        daysPerYear: daysPerYear !== undefined ? Number(daysPerYear) : 14,
        isPaid: isPaid !== undefined ? Boolean(isPaid) : true,
        requiresAttachment: requiresAttachment !== undefined ? Boolean(requiresAttachment) : false,
        applicableRoles: applicableRoles || 'ALL',
        description: description ? String(description).trim() : null,
        branchId,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Leave category created successfully.',
      category,
    });
  } catch (error) {
    console.error('[ADMIN] Create leave category error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create leave category.' });
  }
}

/**
 * PUT /api/admin/hr/leave-categories/:id
 */
export async function updateLeaveCategory(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);
    const { name, daysPerYear, isPaid, requiresAttachment, applicableRoles, description, active } = req.body;

    const existing = await prisma.leaveCategory.findFirst({
      where: { id, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Leave category not found.' });
    }

    const updated = await prisma.leaveCategory.update({
      where: { id },
      data: {
        name: name ? String(name).trim() : existing.name,
        daysPerYear: daysPerYear !== undefined ? Number(daysPerYear) : existing.daysPerYear,
        isPaid: isPaid !== undefined ? Boolean(isPaid) : existing.isPaid,
        requiresAttachment: requiresAttachment !== undefined ? Boolean(requiresAttachment) : existing.requiresAttachment,
        applicableRoles: applicableRoles !== undefined ? applicableRoles : existing.applicableRoles,
        description: description !== undefined ? String(description).trim() : existing.description,
        active: active !== undefined ? Boolean(active) : existing.active,
      },
    });

    return res.json({
      success: true,
      message: 'Leave category updated successfully.',
      category: updated,
    });
  } catch (error) {
    console.error('[ADMIN] Update leave category error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update leave category.' });
  }
}

/**
 * DELETE /api/admin/hr/leave-categories/:id
 */
export async function deleteLeaveCategory(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);
    const category = await prisma.leaveCategory.findFirst({
      where: { id, branchId },
    });

    if (!category) {
      return res.status(404).json({ success: false, message: 'Leave category not found.' });
    }

    const activeLeaves = await prisma.leaveRequest.count({
      where: { leaveCategoryId: id },
    });

    if (activeLeaves > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category. There are ${activeLeaves} leave applications linked to it.`,
      });
    }

    await prisma.leaveCategory.delete({ where: { id } });

    return res.json({ success: true, message: 'Leave category deleted successfully.' });
  } catch (error) {
    console.error('[ADMIN] Delete leave category error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete leave category.' });
  }
}

/**
 * GET /api/admin/hr/leaves
 */
export async function getLeaveRequests(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { status } = req.query;

    const where: any = { branchId };
    if (status && status !== 'all') {
      where.status = String(status).toUpperCase();
    }

    const leaves = await prisma.leaveRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        leaveCategory: true,
      },
    });

    return res.json({
      success: true,
      leaves: leaves.map((l) => ({
        id: l.id,
        applicantId: l.applicantId,
        applicantName: l.applicantName,
        applicantType: l.applicantType,
        category: l.leaveCategory?.name || 'Leave',
        categoryId: l.leaveCategoryId,
        startDate: l.startDate,
        endDate: l.endDate,
        totalDays: l.totalDays,
        reason: l.reason,
        attachmentUrl: l.attachmentUrl || null,
        status: l.status || 'PENDING',
        reviewerNotes: l.reviewerNotes || null,
        appliedAt: l.createdAt,
      })),
    });
  } catch (error) {
    console.error('[ADMIN] Fetch leave requests error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch leave requests.' });
  }
}

/**
 * POST /api/admin/hr/leaves
 */
export async function createLeaveRequest(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { userId, applicantId, applicantName, applicantType, categoryId, leaveCategoryId, startDate, endDate, reason, attachmentUrl, totalDays } = req.body;

    const targetApplicantId = Number(applicantId || userId);
    const targetCategoryId = Number(leaveCategoryId || categoryId);

    if (!targetApplicantId || !targetCategoryId || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'Required fields missing.' });
    }

    let finalName = applicantName;
    if (!finalName) {
      const teacher = await prisma.teacher.findUnique({ where: { id: targetApplicantId } });
      if (teacher) finalName = teacher.name;
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const calculatedDays = totalDays ? Number(totalDays) : Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

    const newLeave = await prisma.leaveRequest.create({
      data: {
        applicantId: targetApplicantId,
        applicantType: applicantType || 'TEACHER',
        applicantName: finalName || 'Staff Member',
        leaveCategoryId: targetCategoryId,
        startDate: start,
        endDate: end,
        totalDays: calculatedDays,
        reason: reason ? String(reason).trim() : '',
        attachmentUrl: attachmentUrl || null,
        status: 'PENDING',
        branchId,
      },
      include: {
        leaveCategory: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Leave application submitted successfully.',
      leave: newLeave,
    });
  } catch (error) {
    console.error('[ADMIN] Create leave request error:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit leave application.' });
  }
}

/**
 * POST /api/admin/hr/leaves/:id/review
 */
export async function reviewLeaveRequest(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);
    const { status, reviewerNotes, comments } = req.body;

    if (!status || !['APPROVED', 'REJECTED', 'CANCELLED'].includes(String(status).toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Status must be APPROVED, REJECTED, or CANCELLED.' });
    }

    const leave = await prisma.leaveRequest.findFirst({
      where: { id, branchId },
    });

    if (!leave) {
      return res.status(404).json({ success: false, message: 'Leave application not found.' });
    }

    const statusUpper = String(status).toUpperCase();

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: statusUpper,
        reviewerNotes: reviewerNotes || comments ? String(reviewerNotes || comments).trim() : null,
        reviewedAt: new Date(),
      },
    });

    return res.json({
      success: true,
      message: `Leave application has been ${status.toLowerCase()} successfully.`,
      leave: updated,
    });
  } catch (error) {
    console.error('[ADMIN] Review leave request error:', error);
    return res.status(500).json({ success: false, message: 'Failed to review leave application.' });
  }
}
