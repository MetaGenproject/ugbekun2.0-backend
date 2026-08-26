import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { generateEmploymentLetterPdf } from '../../lib/pdfService';
import OpenAI from 'openai';

/**
 * GET /api/admin/hr/letters
 */
export async function getEmploymentLetters(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const letters = await prisma.employmentLetter.findMany({
      where: { branchId },
      orderBy: { issuedDate: 'desc' },
    });

    return res.json({ success: true, letters });
  } catch (error) {
    console.error('[ADMIN] Fetch employment letters error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch employment letters.' });
  }
}

/**
 * POST /api/admin/hr/letters/ai-draft
 */
export async function aiGenerateEmploymentLetter(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { teacherId, staffId, type, customNotes } = req.body;
    const targetStaffId = Number(staffId || teacherId);
    if (!targetStaffId) {
      return res.status(400).json({ success: false, message: 'Staff/Teacher ID is required.' });
    }

    const [teacher, branch] = await Promise.all([
      prisma.teacher.findFirst({ where: { id: targetStaffId, branchId } }),
      prisma.branch.findUnique({ where: { id: branchId }, include: { systemSetting: true } }),
    ]);

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }

    const schoolName = branch?.systemSetting?.schoolName || branch?.name || 'School Name';
    const staffName = teacher.name;
    const designation = (teacher as any).designation || teacher.department || 'Staff Member';
    const letterType = type || 'OFFER';

    let draftedContent = '';

    if (process.env.OPENAI_API_KEY) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const prompt = `Write a formal, comprehensive, professional Nigerian school ${letterType} letter for ${staffName} for the position of ${designation} at ${schoolName}.
Additional specifics: ${customNotes || 'Include standard terms, probation, confidentiality, and professional code of conduct.'}
Output ONLY the letter text with clear placeholders for dates and signature.`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      });

      draftedContent = response.choices[0]?.message?.content || '';
    }

    if (!draftedContent) {
      draftedContent = `Dear ${staffName},\n\nWe are pleased to formally offer you the position of ${designation} at ${schoolName}.\n\nYour duties will encompass delivering top-tier academic instruction and character development in accordance with the policies of the institution.\n\nWe look forward to a fruitful and impactful tenure together.\n\nSincerely,\nManagement,\n${schoolName}`;
    }

    return res.json({
      success: true,
      draft: draftedContent,
    });
  } catch (error) {
    console.error('[ADMIN] AI generate letter error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate letter draft.' });
  }
}

/**
 * POST /api/admin/hr/letters
 */
export async function createEmploymentLetter(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { teacherId, staffId, staffName, jobTitle, salaryAmount, joiningDate, content, letterContent, isAiGenerated } = req.body;
    const targetStaffId = Number(staffId || teacherId);
    if (!targetStaffId) {
      return res.status(400).json({ success: false, message: 'Staff ID is required.' });
    }

    let finalStaffName = staffName;
    let finalJobTitle = jobTitle || 'Staff Member';
    if (!finalStaffName && targetStaffId) {
      const teacher = await prisma.teacher.findUnique({ where: { id: targetStaffId } });
      if (teacher) {
        finalStaffName = teacher.name;
        finalJobTitle = (teacher as any).designation || teacher.department || finalJobTitle;
      }
    }

    const newLetter = await prisma.employmentLetter.create({
      data: {
        branchId,
        staffId: targetStaffId,
        staffName: finalStaffName || 'Staff Member',
        jobTitle: finalJobTitle,
        joiningDate: joiningDate ? new Date(joiningDate) : new Date(),
        salaryAmount: salaryAmount !== undefined ? Number(salaryAmount) : 0,
        letterContent: String(content || letterContent || ''),
        isAiGenerated: Boolean(isAiGenerated),
        issuedDate: new Date(),
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Employment letter issued and archived successfully.',
      letter: newLetter,
    });
  } catch (error) {
    console.error('[ADMIN] Create employment letter error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create employment letter.' });
  }
}

/**
 * GET /api/admin/hr/letters/:id/pdf
 */
export async function getEmploymentLetterPdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);
    const letter = await prisma.employmentLetter.findFirst({
      where: { id, branchId },
    });

    if (!letter) {
      return res.status(404).json({ success: false, message: 'Letter not found.' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { systemSetting: true },
    });

    const pdfBuffer = await generateEmploymentLetterPdf({
      schoolName: branch?.systemSetting?.schoolName || branch?.name || 'School Name',
      schoolAddress: branch?.systemSetting?.address || branch?.address || '',
      schoolPhone: branch?.systemSetting?.phone || branch?.phone || '',
      schoolLogo: branch?.systemSetting?.logoUrl || branch?.logo || null,
      recipientName: letter.staffName,
      recipientRole: letter.jobTitle,
      title: `${letter.jobTitle} - Employment Letter`,
      body: letter.letterContent,
      date: letter.issuedDate,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="employment-letter-${letter.staffName.replace(/\s+/g, '_')}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Generate letter PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate letter PDF.' });
  }
}
