import { Request, Response } from 'express';
import prisma from '../../lib/prisma';

/**
 * GET /api/admin/academics/exam-setup
 * List all Exam Setups for the branch, optionally filtered by sessionId or termId.
 */
export async function getExamSetups(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { sessionId, termId, mode } = req.query;

  try {
    const whereClause: any = {
      ...(branchId ? { branchId } : {}),
      ...(sessionId ? { sessionId: Number(sessionId) } : {}),
      ...(termId ? { termId: Number(termId) } : {}),
      ...(mode ? { schoolMode: String(mode) } : {}),
    };

    const setups = await prisma.examSetup.findMany({
      where: whereClause,
      include: {
        exam: {
          select: { id: true, name: true, termId: true, sessionId: true },
        },
        components: {
          orderBy: { order: 'asc' },
          include: {
            _count: {
              select: { cbtDistributions: true, scores: true },
            },
          },
        },
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });

    return res.json({
      success: true,
      data: setups,
      count: setups.length,
    });
  } catch (error) {
    console.error('[ADMIN] Error fetching exam setups:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve exam master setups.',
    });
  }
}

/**
 * GET /api/admin/academics/exam-setup/:id
 * Retrieve a specific Exam Setup by ID.
 */
export async function getExamSetupById(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const id = Number(req.params.id);

  if (!id || isNaN(id)) {
    return res.status(400).json({ success: false, message: 'Valid Exam Setup ID is required.' });
  }

  try {
    const setup = await prisma.examSetup.findFirst({
      where: {
        id,
        ...(branchId ? { branchId } : {}),
      },
      include: {
        exam: {
          select: { id: true, name: true, termId: true, sessionId: true },
        },
        components: {
          orderBy: { order: 'asc' },
          include: {
            cbtDistributions: {
              select: { id: true, title: true, targetSlot: true, classId: true, subjectId: true },
            },
          },
        },
      },
    });

    if (!setup) {
      return res.status(404).json({ success: false, message: 'Exam Setup not found.' });
    }

    return res.json({
      success: true,
      data: setup,
    });
  } catch (error) {
    console.error('[ADMIN] Error fetching exam setup by ID:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve exam setup details.',
    });
  }
}

/**
 * GET /api/admin/academics/exam-setup/active
 * Get the currently active exam setup for the current session/term.
 */
export async function getActiveExamSetup(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { sessionId, termId } = req.query;

  try {
    let activeSessionId = sessionId ? Number(sessionId) : undefined;
    if (!activeSessionId) {
      const globalSetting = await prisma.globalSettings.findFirst();
      activeSessionId = globalSetting?.sessionId || undefined;
    }

    const setup = await prisma.examSetup.findFirst({
      where: {
        ...(branchId ? { branchId } : {}),
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        ...(termId ? { termId: Number(termId) } : {}),
        isActive: true,
      },
      include: {
        components: {
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { id: 'desc' },
    });

    return res.json({
      success: true,
      data: setup || null,
    });
  } catch (error) {
    console.error('[ADMIN] Error fetching active exam setup:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve active exam setup.',
    });
  }
}

/**
 * POST /api/admin/academics/exam-setup
 * Create or update an Exam Setup with dynamic Assessment Components.
 */
export async function createOrUpdateExamSetup(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const {
    id,
    title,
    name, // alias for title
    sessionId,
    termId = 1,
    examId,
    schoolMode = 'CBT_HYBRID',
    mode, // alias for schoolMode
    isActive = true,
    components = [],
  } = req.body;

  const resolvedTitle = (title || name || '').trim();
  const resolvedMode = (schoolMode || mode || 'CBT_HYBRID').toUpperCase();

  if (!resolvedTitle) {
    return res.status(400).json({ success: false, message: 'Exam setup title is required.' });
  }

  if (!sessionId) {
    return res.status(400).json({ success: false, message: 'Academic session ID is required.' });
  }

  if (!branchId) {
    return res.status(400).json({ success: false, message: 'Branch ID context is required.' });
  }

  // Validate components array
  if (!Array.isArray(components) || components.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'At least one assessment component must be defined (e.g., CA1, CA2, Terminal Exam).',
    });
  }

  // Normalize components
  const normalizedComponents = components.map((c: any, index: number) => {
    const compName = (c.name || c.displayName || `Component ${index + 1}`).trim();
    const compType = (c.type || (c.hasCbt ? 'CBT' : 'THEORY')).toUpperCase();
    const compSlot = c.slot || c.code || null;
    const compWeight = Number(c.weight ?? c.maxMarks ?? 20);
    const compCategory = (c.category || (compSlot && compSlot.includes('EXAM') ? 'EXAM' : 'CA')).toUpperCase();
    const compOrder = Number(c.order ?? index + 1);

    return {
      id: c.id ? Number(c.id) : undefined,
      name: compName,
      type: compType,
      slot: compSlot,
      weight: compWeight,
      category: compCategory,
      order: compOrder,
    };
  });

  try {
    let resultSetup: any;

    if (id) {
      // Update existing setup
      const existing = await prisma.examSetup.findFirst({
        where: { id: Number(id), branchId },
      });

      if (!existing) {
        return res.status(404).json({ success: false, message: 'Exam Setup not found.' });
      }

      resultSetup = await prisma.$transaction(async (tx) => {
        // If activating this setup, deactivate other setups for the same session/term
        if (isActive) {
          await tx.examSetup.updateMany({
            where: { branchId, sessionId: Number(sessionId), termId: Number(termId), id: { not: existing.id } },
            data: { isActive: false },
          });
        }

        const updatedSetup = await tx.examSetup.update({
          where: { id: existing.id },
          data: {
            title: resolvedTitle,
            sessionId: Number(sessionId),
            termId: Number(termId),
            examId: examId ? Number(examId) : null,
            schoolMode: resolvedMode,
            isActive: Boolean(isActive),
          },
        });

        // Sync components: delete ones removed, update existing, create new
        const incomingIds = normalizedComponents.filter((c) => c.id).map((c) => c.id as number);
        await tx.assessmentComponent.deleteMany({
          where: {
            examSetupId: updatedSetup.id,
            id: { notIn: incomingIds },
          },
        });

        for (const comp of normalizedComponents) {
          if (comp.id) {
            await tx.assessmentComponent.update({
              where: { id: comp.id },
              data: {
                name: comp.name,
                type: comp.type,
                slot: comp.slot,
                weight: comp.weight,
                category: comp.category,
                order: comp.order,
              },
            });
          } else {
            await tx.assessmentComponent.create({
              data: {
                examSetupId: updatedSetup.id,
                name: comp.name,
                type: comp.type,
                slot: comp.slot,
                weight: comp.weight,
                category: comp.category,
                order: comp.order,
              },
            });
          }
        }

        return tx.examSetup.findUnique({
          where: { id: updatedSetup.id },
          include: {
            components: { orderBy: { order: 'asc' } },
          },
        });
      });
    } else {
      // Create new setup
      resultSetup = await prisma.$transaction(async (tx) => {
        if (isActive) {
          await tx.examSetup.updateMany({
            where: { branchId, sessionId: Number(sessionId), termId: Number(termId) },
            data: { isActive: false },
          });
        }

        const newSetup = await tx.examSetup.create({
          data: {
            branchId,
            title: resolvedTitle,
            sessionId: Number(sessionId),
            termId: Number(termId),
            examId: examId ? Number(examId) : null,
            schoolMode: resolvedMode,
            isActive: Boolean(isActive),
            components: {
              create: normalizedComponents.map((c) => ({
                name: c.name,
                type: c.type,
                slot: c.slot,
                weight: c.weight,
                category: c.category,
                order: c.order,
              })),
            },
          },
          include: {
            components: { orderBy: { order: 'asc' } },
          },
        });

        return newSetup;
      });
    }

    return res.json({
      success: true,
      message: id ? 'Exam setup updated successfully.' : 'Exam setup created successfully.',
      data: resultSetup,
    });
  } catch (error) {
    console.error('[ADMIN] Error saving exam setup:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to save exam setup.',
    });
  }
}

/**
 * DELETE /api/admin/academics/exam-setup/:id
 * Delete an Exam Setup and its associated assessment components.
 */
export async function deleteExamSetup(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const id = Number(req.params.id);

  if (!id || isNaN(id)) {
    return res.status(400).json({ success: false, message: 'Valid Exam Setup ID is required.' });
  }

  try {
    const existing = await prisma.examSetup.findFirst({
      where: { id, ...(branchId ? { branchId } : {}) },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Exam Setup not found.' });
    }

    await prisma.examSetup.delete({
      where: { id: existing.id },
    });

    return res.json({
      success: true,
      message: 'Exam setup deleted successfully.',
    });
  } catch (error) {
    console.error('[ADMIN] Error deleting exam setup:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete exam setup.',
    });
  }
}
