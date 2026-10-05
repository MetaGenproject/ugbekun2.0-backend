import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { validateGradeRanges, FALLBACK_PRIMARY_RANGES, GradeRange } from '../../lib/gradingService';

/**
 * GET /api/admin/grading-scales
 * List all grading scales in the branch with assigned classes
 */
export async function getGradingScales(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const scales = await prisma.gradingScale.findMany({
      where: { branchId },
      include: {
        classes: {
          select: { id: true, name: true },
        },
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    const parsedScales = scales.map((s) => {
      let ranges: GradeRange[] = [];
      try {
        ranges = typeof s.ranges === 'string' ? JSON.parse(s.ranges) : s.ranges;
      } catch {
        ranges = FALLBACK_PRIMARY_RANGES;
      }

      return {
        id: s.id,
        name: s.name,
        code: s.code,
        description: s.description,
        isDefault: s.isDefault,
        ranges,
        classes: s.classes,
        classCount: s.classes.length,
        createdAt: s.createdAt,
      };
    });

    return res.json({ success: true, scales: parsedScales });
  } catch (error: any) {
    console.error('[ADMIN GRADING] Get scales error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch grading scales.' });
  }
}

/**
 * POST /api/admin/grading-scales
 * Create a new grading scale
 */
export async function createGradingScale(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { name, code, description, isDefault, ranges } = req.body;

  if (!name || !code) {
    return res.status(400).json({ success: false, message: 'Grading scale Name and Code are required.' });
  }

  const validation = validateGradeRanges(ranges);
  if (!validation.valid) {
    return res.status(400).json({ success: false, message: validation.error });
  }

  try {
    if (isDefault) {
      await prisma.gradingScale.updateMany({
        where: { branchId },
        data: { isDefault: false },
      });
    }

    const scale = await prisma.gradingScale.create({
      data: {
        branchId,
        name: name.trim(),
        code: code.trim().toUpperCase(),
        description: description ? description.trim() : null,
        isDefault: Boolean(isDefault),
        ranges: ranges,
      },
    });

    return res.json({ success: true, scale, message: 'Grading scale created successfully.' });
  } catch (error: any) {
    console.error('[ADMIN GRADING] Create scale error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create grading scale.' });
  }
}

/**
 * PUT /api/admin/grading-scales/:id
 * Update an existing grading scale
 */
export async function updateGradingScale(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { id } = req.params;
  const { name, code, description, isDefault, ranges } = req.body;

  const scaleId = Number(id);
  if (!scaleId) {
    return res.status(400).json({ success: false, message: 'Invalid grading scale ID.' });
  }

  if (ranges) {
    const validation = validateGradeRanges(ranges);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.error });
    }
  }

  try {
    const existing = await prisma.gradingScale.findFirst({
      where: { id: scaleId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Grading scale not found.' });
    }

    if (isDefault && !existing.isDefault) {
      await prisma.gradingScale.updateMany({
        where: { branchId },
        data: { isDefault: false },
      });
    }

    const updated = await prisma.gradingScale.update({
      where: { id: scaleId },
      data: {
        ...(name ? { name: name.trim() } : {}),
        ...(code ? { code: code.trim().toUpperCase() } : {}),
        ...(description !== undefined ? { description: description ? description.trim() : null } : {}),
        ...(isDefault !== undefined ? { isDefault: Boolean(isDefault) } : {}),
        ...(ranges ? { ranges } : {}),
      },
    });

    return res.json({ success: true, scale: updated, message: 'Grading scale updated successfully.' });
  } catch (error: any) {
    console.error('[ADMIN GRADING] Update scale error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update grading scale.' });
  }
}

/**
 * DELETE /api/admin/grading-scales/:id
 * Delete a grading scale
 */
export async function deleteGradingScale(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { id } = req.params;
  const scaleId = Number(id);

  if (!scaleId) {
    return res.status(400).json({ success: false, message: 'Invalid grading scale ID.' });
  }

  try {
    const existing = await prisma.gradingScale.findFirst({
      where: { id: scaleId, branchId },
      include: { classes: { select: { id: true } } },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Grading scale not found.' });
    }

    if (existing.isDefault) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete the default grading scale. Please set another scale as default first.',
      });
    }

    // Unassign classes linked to this scale
    if (existing.classes.length > 0) {
      await prisma.class.updateMany({
        where: { gradingScaleId: scaleId },
        data: { gradingScaleId: null },
      });
    }

    await prisma.gradingScale.delete({
      where: { id: scaleId },
    });

    return res.json({ success: true, message: 'Grading scale deleted successfully.' });
  } catch (error: any) {
    console.error('[ADMIN GRADING] Delete scale error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete grading scale.' });
  }
}

/**
 * POST /api/admin/grading-scales/:id/set-default
 * Designate a scale as branch default
 */
export async function setDefaultGradingScale(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { id } = req.params;
  const scaleId = Number(id);

  if (!scaleId) {
    return res.status(400).json({ success: false, message: 'Invalid grading scale ID.' });
  }

  try {
    const scale = await prisma.gradingScale.findFirst({
      where: { id: scaleId, branchId },
    });

    if (!scale) {
      return res.status(404).json({ success: false, message: 'Grading scale not found.' });
    }

    await prisma.gradingScale.updateMany({
      where: { branchId },
      data: { isDefault: false },
    });

    await prisma.gradingScale.update({
      where: { id: scaleId },
      data: { isDefault: true },
    });

    return res.json({ success: true, message: `Grading scale "${scale.name}" is now the branch default.` });
  } catch (error: any) {
    console.error('[ADMIN GRADING] Set default scale error:', error);
    return res.status(500).json({ success: false, message: 'Failed to set default grading scale.' });
  }
}

/**
 * POST /api/admin/grading-scales/assign-class
 * Assign or unassign a grading scale to classes
 */
export async function assignGradingScaleToClass(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classIds, gradingScaleId } = req.body;

  if (!Array.isArray(classIds) || classIds.length === 0) {
    return res.status(400).json({ success: false, message: 'classIds must be a non-empty array.' });
  }

  try {
    const targetScaleId = gradingScaleId ? Number(gradingScaleId) : null;

    if (targetScaleId) {
      const scale = await prisma.gradingScale.findFirst({
        where: { id: targetScaleId, branchId },
      });
      if (!scale) {
        return res.status(404).json({ success: false, message: 'Grading scale not found.' });
      }
    }

    await prisma.class.updateMany({
      where: {
        id: { in: classIds.map(Number) },
        branchId,
      },
      data: {
        gradingScaleId: targetScaleId,
      },
    });

    return res.json({
      success: true,
      message: targetScaleId
        ? `Grading scale assigned to ${classIds.length} class(es).`
        : `Default grading scale restored for ${classIds.length} class(es).`,
    });
  } catch (error: any) {
    console.error('[ADMIN GRADING] Assign scale to class error:', error);
    return res.status(500).json({ success: false, message: 'Failed to assign grading scale to classes.' });
  }
}
