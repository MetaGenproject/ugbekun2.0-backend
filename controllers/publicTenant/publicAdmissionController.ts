import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { resolveBranchContext } from './publicTenantController';
import { resolveDisplaySchoolName } from '../../lib/schoolDisplayName';
import { sendMail } from '../../lib/emailService';

// In-memory rate limiting map: ip -> timestamps[]
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_SUBMISSIONS_PER_HOUR = 8;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= MAX_SUBMISSIONS_PER_HOUR) {
    return true;
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return false;
}

/**
 * GET /api/public/tenant/admissions/meta
 * Returns active classes, session info, and school branding for prospective applicants.
 */
export async function getAdmissionMetadata(req: Request, res: Response): Promise<Response | void> {
  try {
    const branch = await resolveBranchContext(req);
    if (!branch) {
      return res.status(404).json({ success: false, message: 'School branch not found.' });
    }

    const branchId = branch.id;

    // Fetch active classes configured for this school branch
    const classes = await prisma.class.findMany({
      where: { branchId },
      select: {
        id: true,
        name: true,
        nameNumeric: true,
      },
      orderBy: [{ id: 'asc' }],
    });

    const frontCms = await prisma.frontCmsAdmission.findUnique({
      where: { branchId },
    });

    const settings = branch.systemSetting;
    const schoolName = resolveDisplaySchoolName(settings?.schoolName, branch.name);

    return res.json({
      success: true,
      data: {
        branchId,
        branchCode: branch.code,
        schoolName,
        tagline: settings?.tagline || branch.landingPage?.heroSubtitle || 'Excellence in Knowledge & Character',
        logoUrl: settings?.logoUrl || (branch as any)?.logo || null,
        primaryColor: settings?.primaryColor || '#0f172a',
        secondaryColor: settings?.secondaryColor || '#0284c7',
        phone: settings?.phone || branch.phone || null,
        email: settings?.email || branch.email || null,
        address: settings?.address || branch.address || null,
        academicSession: settings?.academicSession || '2025/2026',
        currentTerm: settings?.currentTerm || 'First Term',
        classes,
        instructions:
          frontCms?.description ||
          'Please fill out the prospective student and guardian information accurately. Our admissions office will review your submission and contact you via email.',
        termsConditions: frontCms?.termsConditionsDescription || null,
      },
    });
  } catch (error: any) {
    console.error('[PUBLIC TENANT] Get admission metadata error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve admission metadata.' });
  }
}

/**
 * POST /api/public/tenant/admissions/apply
 * Handles public prospective student and parent admission application submissions.
 */
export async function submitAdmissionApplication(req: Request, res: Response): Promise<Response | void> {
  try {
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
    if (isRateLimited(clientIp)) {
      return res.status(429).json({
        success: false,
        message: 'Too many application attempts from this network. Please try again later or contact the school directly.',
      });
    }

    const branch = await resolveBranchContext(req);
    if (!branch) {
      return res.status(404).json({ success: false, message: 'School branch not found.' });
    }

    const branchId = branch.id;
    const {
      firstName,
      lastName,
      gender,
      birthday,
      religion,
      bloodGroup,
      presentAddress,
      permanentAddress,
      previousSchoolDetails,
      guardianName,
      guardianRelation,
      grdEmail,
      grdMobileNo,
      grdAddress,
      classId,
      studentEmail,
      studentMobileNo,
    } = req.body;

    // Validate required fields
    if (!firstName || typeof firstName !== 'string' || firstName.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Student first name is required (minimum 2 characters).' });
    }

    if (!guardianName || typeof guardianName !== 'string' || guardianName.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Parent or Guardian full name is required.' });
    }

    if (!grdEmail || typeof grdEmail !== 'string' || !grdEmail.includes('@') || !grdEmail.includes('.')) {
      return res.status(400).json({ success: false, message: 'A valid Parent or Guardian email address is required.' });
    }

    if (!grdMobileNo || typeof grdMobileNo !== 'string' || grdMobileNo.trim().length < 7) {
      return res.status(400).json({ success: false, message: 'A valid Parent or Guardian mobile number is required.' });
    }

    const targetClassId = parseInt(classId as string, 10);
    if (isNaN(targetClassId) || targetClassId <= 0) {
      return res.status(400).json({ success: false, message: 'Please select a valid class for admission.' });
    }

    // Verify class belongs to branch
    const targetClass = await prisma.class.findFirst({
      where: { id: targetClassId, branchId },
    });
    if (!targetClass) {
      return res.status(400).json({ success: false, message: 'The selected class is not offered by this school.' });
    }

    // Generate unique reference number: ADM-YYYYMM-XXXX
    const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const referenceNo = `ADM-${yearMonth}-${randomSuffix}`;

    // Calculate sequential primary key ID
    const maxAdmission = await prisma.onlineAdmission.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const nextId = (maxAdmission?.id || 0) + 1;

    let parsedDob: Date | null = null;
    if (birthday) {
      const d = new Date(birthday);
      if (!isNaN(d.getTime())) {
        parsedDob = d;
      }
    }

    const cleanGrdEmail = grdEmail.trim().toLowerCase();
    const cleanGrdMobile = grdMobileNo.trim();
    const cleanFirstName = firstName.trim();
    const cleanLastName = (lastName || '').trim();

    // Persist new application
    const admission = await prisma.onlineAdmission.create({
      data: {
        id: nextId,
        referenceNo,
        firstName: cleanFirstName,
        lastName: cleanLastName || null,
        gender: gender || 'Unknown',
        birthday: parsedDob,
        religion: religion || null,
        bloodGroup: bloodGroup || null,
        email: studentEmail ? String(studentEmail).trim().toLowerCase() : null,
        mobileNo: studentMobileNo ? String(studentMobileNo).trim() : null,
        presentAddress: presentAddress || null,
        permanentAddress: permanentAddress || presentAddress || null,
        previousSchoolDetails: previousSchoolDetails || null,
        guardianName: guardianName.trim(),
        guardianRelation: guardianRelation || 'Parent',
        grdEmail: cleanGrdEmail,
        grdMobileNo: cleanGrdMobile,
        grdAddress: grdAddress || presentAddress || null,
        classId: targetClassId,
        sectionId: null,
        status: 1, // 1 = Pending Review
        applyDate: new Date(),
        createdDate: new Date(),
        branchId,
      },
    });

    const settings = branch.systemSetting;
    const schoolDisplayName = resolveDisplaySchoolName(settings?.schoolName, branch.name);

    // Send asynchronous acknowledgment email to parent
    const ackSubject = `Application Received — ${schoolDisplayName} [Ref: ${referenceNo}]`;
    const ackHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px;">
        <div style="border-bottom: 2px solid #0284c7; padding-bottom: 16px; margin-bottom: 20px;">
          <h2 style="color: #0f172a; margin: 0 0 6px;">${schoolDisplayName}</h2>
          <p style="color: #64748b; margin: 0; font-size: 14px;">Online Admission Application Confirmation</p>
        </div>
        <p style="color: #334155; font-size: 15px; line-height: 1.6;">
          Dear <strong>${guardianName.trim()}</strong>,
        </p>
        <p style="color: #334155; font-size: 15px; line-height: 1.6;">
          We have successfully received the admission application for <strong>${cleanFirstName} ${cleanLastName}</strong> for entry into <strong>${targetClass.name}</strong>.
        </p>
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 20px 0; text-align: center;">
          <p style="color: #166534; margin: 0 0 4px; font-size: 13px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em;">Application Reference Number</p>
          <p style="color: #14532d; margin: 0; font-size: 24px; font-weight: 800; font-family: monospace;">${referenceNo}</p>
        </div>
        <p style="color: #334155; font-size: 14px; line-height: 1.6;">
          Our admissions committee will review the details submitted. You will be notified at this email address once your application has been evaluated and approved.
        </p>
        <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 16px;">
          If you have any questions or additional documents to provide, please contact our administrative desk at 
          ${branch.phone ? `<strong>${branch.phone}</strong>` : ''} 
          ${branch.email ? `or <strong>${branch.email}</strong>` : ''}.
        </p>
      </div>
    `;

    sendMail(cleanGrdEmail, ackSubject, ackHtml).catch((err) => {
      console.warn('[PUBLIC TENANT] Async application acknowledgment email failed:', err?.message);
    });

    return res.status(201).json({
      success: true,
      message: 'Admission application submitted successfully.',
      referenceNo,
      admissionId: admission.id,
      schoolName: schoolDisplayName,
    });
  } catch (error: any) {
    console.error('[PUBLIC TENANT] Submit admission application error:', error);
    return res.status(500).json({ success: false, message: 'Failed to process admission application. Please try again.' });
  }
}
