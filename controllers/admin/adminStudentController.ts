import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import OpenAI from 'openai';
import prisma from '../../lib/prisma';
import { generateRegistrationNumber, bindEvaluationMatrix, wipeEvaluationMatrix, generateSecurePassword } from '../../lib/studentService';
import { sendOnboardingCredentials } from '../../lib/emailService';
import {
  generateCredentialSlipPdf,
  generateBatchClassCredentialSlipsPdf,
  generateStudentIdCardPdf,
  generateStaffIdCardPdf,
  generateCertificatePdf,
} from '../../lib/pdfService';
import {
  provisionStudentIdCard,
  provisionStaffIdCard,
  provisionCertificate,
  revokeIdCard,
  batchProvisionStudentIdCards,
} from '../../lib/idCardService';
import { uploadBase64Image } from '../../lib/cloudinary';

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'dummy-key',
  baseURL: 'https://api.deepseek.com',
});

let Tesseract: any;
try {
  Tesseract = require('tesseract.js');
} catch (e) {
  console.warn('[ADMIN] Tesseract.js could not be loaded; OCR image parsing is disabled.');
}

export async function savePhoto(photoBase64?: string | null, folder: string = 'ugbekun2/students/photos'): Promise<string | null> {
  if (!photoBase64) return null;
  try {
    const uploadedUrl = await uploadBase64Image(photoBase64, folder);
    if (uploadedUrl) return uploadedUrl;
  } catch (err: any) {
    console.warn(`[PHOTO UPLOAD] Cloudinary upload unavailable for ${folder}, using fallback:`, err?.message);
  }
  if (photoBase64.startsWith('data:image/') || photoBase64.startsWith('http://') || photoBase64.startsWith('https://')) {
    return photoBase64;
  }
  return null;
}

/**
 * GET /api/admin/students-parents
 */
export async function getStudentsParents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const [students, parents] = await Promise.all([
      prisma.student.findMany({
        where: { branchId },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: {
          id: true,
          registerNo: true,
          firstName: true,
          lastName: true,
          gender: true,
          mobileno: true,
          email: true,
          photo: true,
          parentId: true,
          active: true,
          parent: { select: { name: true, photo: true, mobileno: true, email: true } },
          enrolls: {
            take: 1,
            orderBy: { id: 'desc' },
            select: {
              class: { select: { id: true, name: true } },
              section: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.parent.findMany({
        where: { branchId },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          userId: true,
          name: true,
          relation: true,
          email: true,
          mobileno: true,
          photo: true,
          address: true,
          city: true,
          state: true,
          occupation: true,
          active: true,
          user: {
            select: {
              username: true,
            },
          },
          students: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              registerNo: true,
              enrolls: {
                take: 1,
                orderBy: { id: 'desc' },
                select: {
                  class: { select: { name: true } },
                  section: { select: { name: true } },
                },
              },
            },
          },
          _count: { select: { students: true } },
        },
      }),
    ]);

    // Map student parent relationships from the student query as well
    const parentStudentsMap = new Map<number, Array<{ id: number; name: string; registerNo?: string; className?: string; sectionName?: string }>>();

    students.forEach((s) => {
      if (s.parentId) {
        const studentName = `${s.firstName || ''} ${s.lastName || ''}`.trim() || `Student #${s.id}`;
        const studentObj = {
          id: s.id,
          name: studentName,
          registerNo: s.registerNo || '',
          className: s.enrolls[0]?.class?.name || '',
          sectionName: s.enrolls[0]?.section?.name || '',
        };
        if (!parentStudentsMap.has(s.parentId)) {
          parentStudentsMap.set(s.parentId, []);
        }
        parentStudentsMap.get(s.parentId)!.push(studentObj);
      }
    });

    const formattedParents = parents.map((parent) => {
      const dbStudents = (parent.students || []).map((s) => ({
        id: s.id,
        name: `${s.firstName || ''} ${s.lastName || ''}`.trim() || `Student #${s.id}`,
        registerNo: s.registerNo || '',
        className: s.enrolls[0]?.class?.name || '',
        sectionName: s.enrolls[0]?.section?.name || '',
      }));

      const mapStudents = parentStudentsMap.get(parent.id) || [];
      const combinedMap = new Map<number, any>();
      [...dbStudents, ...mapStudents].forEach((st) => {
        if (st.id && st.name) combinedMap.set(st.id, st);
      });
      const allLinkedStudents = Array.from(combinedMap.values());

      const parentEmail = parent.email || (parent.user?.username?.includes('@') ? parent.user.username : '') || '';
      const parentPhone = parent.mobileno || (!parent.user?.username?.includes('@') ? parent.user?.username : '') || '';
      const parentName = parent.name || 'Parent/Guardian';
      const parentAddress = parent.address || [parent.city, parent.state].filter(Boolean).join(', ') || '';

      return {
        id: parent.id,
        userId: parent.userId || parent.id,
        name: parentName,
        relation: parent.relation || 'Parent',
        email: parentEmail,
        mobileno: parentPhone,
        photo: parent.photo || null,
        address: parentAddress,
        city: parent.city || '',
        state: parent.state || '',
        occupation: parent.occupation || '',
        active: parent.active,
        studentCount: Math.max(parent._count.students, allLinkedStudents.length),
        students: allLinkedStudents,
      };
    });

    return res.json({
      success: true,
      data: {
        students: students.map((student) => ({
          id: student.id,
          registerNo: student.registerNo,
          firstName: student.firstName,
          lastName: student.lastName,
          gender: student.gender,
          mobileno: student.mobileno,
          email: student.email,
          photo: student.photo || null,
          active: student.active,
          parentName: student.parent?.name || null,
          parentPhoto: student.parent?.photo || null,
          parentPhone: student.parent?.mobileno || null,
          parentEmail: student.parent?.email || null,
          className: student.enrolls[0]?.class?.name || 'Unassigned',
          sectionName: student.enrolls[0]?.section?.name || '',
        })),
        parents: formattedParents,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Students/parents list error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load students and parents.',
    });
  }
}

/**
 * GET /api/admin/parents/search
 */
export async function searchParents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const rawQuery = String(req.query.query || req.query.q || '').trim();
    if (!rawQuery || rawQuery.length < 2) {
      return res.json({ success: true, parents: [] });
    }

    const cleanPhone = rawQuery.replace(/[^0-9]/g, '');

    const whereConditions: any[] = [
      { name: { contains: rawQuery, mode: 'insensitive' } },
      { email: { contains: rawQuery, mode: 'insensitive' } },
    ];

    if (cleanPhone.length >= 3) {
      whereConditions.push({ mobileno: { contains: cleanPhone } });
    }

    const parents = await prisma.parent.findMany({
      where: {
        branchId,
        OR: whereConditions,
      },
      take: 10,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        relation: true,
        email: true,
        mobileno: true,
        address: true,
        occupation: true,
        photo: true,
        active: true,
        students: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            photo: true,
            enrolls: {
              take: 1,
              orderBy: { id: 'desc' },
              select: {
                class: { select: { name: true } },
                section: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    const formatted = parents.map((p) => ({
      id: p.id,
      name: p.name,
      relation: p.relation,
      email: p.email,
      mobileno: p.mobileno,
      address: p.address,
      occupation: p.occupation,
      photo: p.photo,
      active: p.active,
      enrolledChildrenCount: p.students.length,
      children: p.students.map((s) => ({
        id: s.id,
        name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
        registerNo: s.registerNo,
        photo: s.photo,
        className: s.enrolls[0]?.class?.name || 'Unassigned',
        sectionName: s.enrolls[0]?.section?.name || '',
      })),
    }));

    return res.json({ success: true, parents: formatted });
  } catch (error) {
    console.error('[ADMIN] Parent search error:', error);
    return res.status(500).json({ success: false, message: 'Failed to search parents.' });
  }
}

/**
 * POST /api/admin/students/onboard
 */
export async function onboardStudent(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const body = req.body || {};
    const student = body.student || (body.firstName ? body : null);
    const parent =
      body.parent ||
      (body.parentName || body.parent_name || body.name || body.existingParentId || body.parentId ? body : null);

    if (!student || !parent) {
      return res.status(400).json({ success: false, message: 'Student and Parent details are required in request body.' });
    }

    const firstName = (student.firstName || body.firstName || '').trim();
    const lastName = (student.lastName || body.lastName || '').trim();
    const gender = student.gender || body.gender || 'Male';
    const birthday = student.birthday || student.dob || body.birthday || body.dob;
    const admissionDate = student.admissionDate || body.admissionDate || new Date();
    const bloodGroup = student.bloodGroup || body.bloodGroup || null;
    const religion = student.religion || body.religion || null;
    const motherTongue = student.motherTongue || body.motherTongue || null;
    const classId = Number(student.classId || body.classId);
    let sectionId = Number(student.sectionId || body.sectionId);

    if (!classId || isNaN(classId) || classId <= 0) {
      return res.status(400).json({ success: false, message: 'Class selection is required for student enrollment.' });
    }

    if (!sectionId || isNaN(sectionId) || sectionId <= 0) {
      const classSec = await prisma.sectionsAllocation.findFirst({
        where: { classId },
        select: { sectionId: true },
      });
      if (classSec?.sectionId) {
        sectionId = classSec.sectionId;
      } else {
        const firstSec = await prisma.section.findFirst({ select: { id: true } });
        sectionId = firstSec?.id || 1;
      }
    }
    const currentAddress = (student.currentAddress || body.currentAddress || body.address || '').trim();
    const permanentAddress = (student.permanentAddress || body.permanentAddress || '').trim();
    const previousDetails = (student.previousDetails || body.previousDetails || '').trim();

    const studentPhotoRaw =
      student.photo ||
      student.photoBase64 ||
      student.studentPhoto ||
      student.studentPhotoBase64 ||
      body.photo ||
      body.photoBase64 ||
      body.studentPhoto ||
      body.studentPhotoBase64;
    const parentPhotoRaw =
      parent.photo ||
      parent.photoBase64 ||
      parent.parentPhoto ||
      parent.parentPhotoBase64 ||
      body.parentPhoto ||
      body.parentPhotoBase64;

    const birthCertificate = student.birthCertificate || body.birthCertificate || null;
    const previousReportCard = student.previousReportCard || body.previousReportCard || null;
    const medicalReport = student.medicalReport || body.medicalReport || null;

    let combinedPreviousDetails = previousDetails;
    if (birthCertificate || previousReportCard || medicalReport) {
      const docEntries: string[] = [];
      if (birthCertificate) docEntries.push(`Birth Certificate Attached`);
      if (previousReportCard) docEntries.push(`Previous Transcript Attached`);
      if (medicalReport) docEntries.push(`Medical Report Attached`);
      combinedPreviousDetails = [previousDetails, docEntries.join(' | ')].filter(Boolean).join(' --- Docs: ');
    }

    const explicitParentId = Number(
      parent.id || parent.parentId || parent.existingParentId || body.existingParentId || body.parentId
    );
    const parentName = (parent.name || parent.parentName || body.parentName || body.parent_name || '').trim();
    const parentEmail = (parent.email || parent.parentEmail || body.parentEmail || body.parent_email || '').trim();
    const parentPhone = (parent.mobileno || parent.parentPhone || body.parentPhone || body.mobileno || '').trim();
    const parentRelation = parent.relation || parent.parentRelation || body.parentRelation || 'Father';
    const parentOccupation = parent.occupation || body.parentOccupation || null;
    const parentAddress = parent.address || body.parentAddress || currentAddress || null;

    if (!firstName || !lastName || !classId) {
      return res
        .status(400)
        .json({ success: false, message: 'Student first name, last name, and class are required.' });
    }

    if (!explicitParentId && !parentName && !parentEmail && !parentPhone) {
      return res.status(400).json({
        success: false,
        message: 'Parent name and at least one contact method (email or phone) are required.',
      });
    }

    const [studentPhotoUrl, parentPhotoUrl] = await Promise.all([
      savePhoto(studentPhotoRaw, 'ugbekun2/students/photos'),
      savePhoto(parentPhotoRaw, 'ugbekun2/parents/photos'),
    ]);

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true, code: true },
    });

    const registerNo = await generateRegistrationNumber(prisma, branchId);
    const idCardToken = crypto.randomUUID();

    const studentPlainPassword = generateSecurePassword();
    const parentPlainPassword = generateSecurePassword();
    const [hashedStudentPassword, hashedParentPassword] = await Promise.all([
      bcrypt.hash(studentPlainPassword, 10),
      bcrypt.hash(parentPlainPassword, 10),
    ]);

    let isExistingParent = false;
    let finalParentUsername: string | null = null;
    let finalStudentUsername: string | null = null;

    const result = await prisma.$transaction(async (tx: any) => {
      let parentRecord: any = null;
      let parentUserId: number | null = null;

      if (explicitParentId && !isNaN(explicitParentId) && explicitParentId > 0) {
        parentRecord = await tx.parent.findFirst({
          where: { id: explicitParentId, branchId },
          include: { user: true },
        });
      }

      if (!parentRecord && parentEmail) {
        parentRecord = await tx.parent.findFirst({
          where: {
            branchId,
            email: { equals: parentEmail.toLowerCase(), mode: 'insensitive' },
          },
          include: { user: true },
        });
      }

      if (!parentRecord && parentPhone) {
        const cleanPhone = parentPhone.replace(/[\s\-\+]/g, '');
        parentRecord = await tx.parent.findFirst({
          where: {
            branchId,
            mobileno: cleanPhone,
          },
          include: { user: true },
        });
      }

      if (parentRecord) {
        isExistingParent = true;
        parentUserId = parentRecord.userId;
        finalParentUsername = parentRecord.user ? parentRecord.user.username : null;
      } else {
        const baseUsername = parentEmail || parentPhone || `parent_${Date.now()}`;
        const cleanUsername = `${baseUsername.split('@')[0].replace(/[^a-zA-Z0-9]/g, '')}_parent`;

        let uniqueUsername = cleanUsername;
        let counter = 1;
        while (true) {
          const userCheck = await tx.user.findUnique({ where: { username: uniqueUsername }, select: { id: true } });
          if (!userCheck) break;
          uniqueUsername = `${cleanUsername}_${counter++}`;
        }
        finalParentUsername = uniqueUsername;

        const maxParentUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
        const nextParentUserId = (maxParentUser?.id || 0) + 1;

        const parentUser = await tx.user.create({
          data: {
            id: nextParentUserId,
            username: uniqueUsername,
            password: hashedParentPassword,
            rawPassword: parentPlainPassword,
            role: 6,
            active: true,
            photo: parentPhotoUrl || null,
          },
        });
        parentUserId = parentUser.id;

        const maxParent = await tx.parent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
        const nextParentId = (maxParent?.id || 0) + 1;

        parentRecord = await tx.parent.create({
          data: {
            id: nextParentId,
            name: parentName || 'Parent / Guardian',
            relation: parentRelation,
            email: parentEmail ? parentEmail.toLowerCase() : null,
            mobileno: parentPhone || '',
            occupation: parentOccupation,
            address: parentAddress,
            photo: parentPhotoUrl || null,
            active: true,
            branchId,
            userId: parentUserId,
          },
        });
      }

      const studentUsername = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`.replace(/[^a-zA-Z0-9.]/g, '');
      let uniqueStudentUsername = studentUsername;
      let sCounter = 1;
      while (true) {
        const userCheck = await tx.user.findUnique({ where: { username: uniqueStudentUsername }, select: { id: true } });
        if (!userCheck) break;
        uniqueStudentUsername = `${studentUsername}_${sCounter++}`;
      }
      finalStudentUsername = uniqueStudentUsername;

      const maxStudentUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      const nextStudentUserId = (maxStudentUser?.id || 0) + 1;

      const studentUser = await tx.user.create({
        data: {
          id: nextStudentUserId,
          username: uniqueStudentUsername,
          password: hashedStudentPassword,
          rawPassword: studentPlainPassword,
          role: 7,
          active: true,
          photo: studentPhotoUrl || null,
        },
      });

      const maxStudent = await tx.student.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      const nextStudentId = (maxStudent?.id || 0) + 1;

      const studentRecord = await tx.student.create({
        data: {
          id: nextStudentId,
          registerNo,
          admissionDate: new Date(admissionDate),
          firstName,
          lastName,
          gender,
          birthday: birthday ? new Date(birthday) : null,
          religion,
          bloodGroup,
          motherTongue,
          currentAddress: currentAddress || null,
          permanentAddress: permanentAddress || null,
          previousDetails: combinedPreviousDetails || null,
          photo: studentPhotoUrl || null,
          parentId: parentRecord.id,
          branchId,
          userId: studentUser.id,
          idCardToken,
          idCardStatus: 'active',
          active: true,
        },
      });

      const maxEnroll = await tx.enroll.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      const nextEnrollId = (maxEnroll?.id || 0) + 1;

      const enrollRecord = await tx.enroll.create({
        data: {
          id: nextEnrollId,
          studentId: studentRecord.id,
          classId,
          sectionId,
          roll: 0,
          sessionId,
          branchId,
        },
      });

      await bindEvaluationMatrix(tx, {
        studentId: studentRecord.id,
        classId,
        sectionId,
        branchId,
        sessionId,
      });

      return {
        student: studentRecord,
        parent: parentRecord,
        enroll: enrollRecord,
      };
    }, { timeout: 30000, maxWait: 10000 });

    const targetParentEmail = parentEmail || result.parent.email;
    let emailSent = false;
    let emailError: string | null = null;

    if (targetParentEmail) {
      sendOnboardingCredentials({
        parentEmail: targetParentEmail,
        parentName: result.parent.name,
        studentName: `${result.student.firstName} ${result.student.lastName}`,
        registerNo: result.student.registerNo,
        studentUsername: finalStudentUsername!,
        studentPassword: studentPlainPassword,
        parentUsername: isExistingParent ? null : finalParentUsername,
        parentPassword: isExistingParent ? null : parentPlainPassword,
        isExistingParent,
        schoolName: branch?.name || 'Your School',
        branchCode: branch?.code || '',
        loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
      })
        .then((res: any) => {
          emailSent = res.success;
        })
        .catch((err: any) => {
          console.warn('[ADMIN] Async onboarding email failed:', err.message);
          emailError = err.message;
        });
    }

    return res.status(201).json({
      success: true,
      message: 'Student onboarded successfully.',
      emailSent: Boolean(targetParentEmail),
      emailError,
      isExistingParent,
      data: {
        student: {
          id: result.student.id,
          userId: result.student.userId,
          registerNo: result.student.registerNo,
          firstName: result.student.firstName,
          lastName: result.student.lastName,
          gender: result.student.gender,
          photo: result.student.photo,
          classId: result.enroll.classId,
          sectionId: result.enroll.sectionId,
        },
        parent: {
          id: result.parent.id,
          userId: result.parent.userId,
          name: result.parent.name,
          email: result.parent.email,
          mobileno: result.parent.mobileno,
          photo: result.parent.photo,
        },
        credentials: {
          student: {
            userId: result.student.userId,
            username: finalStudentUsername,
            password: studentPlainPassword,
          },
          parent: isExistingParent
            ? null
            : {
                userId: result.parent.userId,
                username: finalParentUsername,
                password: parentPlainPassword,
              },
        },
      },
      credentials: {
        student: {
          userId: result.student.userId,
          username: finalStudentUsername,
          password: studentPlainPassword,
        },
        parent: isExistingParent
          ? null
          : {
              username: finalParentUsername,
              password: parentPlainPassword,
            },
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Student onboarding error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to complete student onboarding.' });
  }
}

/**
 * POST /api/admin/students/import-bulk
 */
export async function importBulkStudents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { students } = req.body || {};
    if (!students || !Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ success: false, message: 'A non-empty list of students is required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true, code: true },
    });

    const dbClasses = await prisma.class.findMany({
      where: { branchId },
    });
    const dbSections = await prisma.section.findMany({
      where: { branchId },
    });
    const dbAllocations = await prisma.sectionsAllocation.findMany({
      include: {
        class: true,
        section: true,
      },
    });

    const validationErrors: any[] = [];

    for (let i = 0; i < students.length; i++) {
      const row = students[i];
      const rowNum = i + 1;

      if (!row.firstName || !row.firstName.trim()) {
        validationErrors.push({ row: rowNum, error: 'Student first name is required.' });
      }
      if (!row.lastName || !row.lastName.trim()) {
        validationErrors.push({ row: rowNum, error: 'Student last name is required.' });
      }
      if (!row.parentName || !row.parentName.trim()) {
        validationErrors.push({ row: rowNum, error: 'Parent name is required.' });
      }
      if ((!row.parentEmail || !row.parentEmail.trim()) && (!row.parentPhone || !row.parentPhone.trim())) {
        validationErrors.push({ row: rowNum, error: 'Parent must have either an email or mobile phone number.' });
      }

      if (!row.className || !row.className.trim()) {
        validationErrors.push({ row: rowNum, error: 'Class name is required.' });
      } else {
        const matchedClass = dbClasses.find(
          (c) => c.name.trim().toLowerCase() === row.className.trim().toLowerCase()
        );
        if (!matchedClass) {
          validationErrors.push({ row: rowNum, error: `Class '${row.className}' not found in this branch.` });
        } else {
          if (!row.sectionName || !row.sectionName.trim()) {
            validationErrors.push({ row: rowNum, error: 'Section name is required.' });
          } else {
            const matchedSection = dbSections.find(
              (s) => s.name.trim().toLowerCase() === row.sectionName.trim().toLowerCase()
            );
            if (!matchedSection) {
              validationErrors.push({ row: rowNum, error: `Section '${row.sectionName}' not found in this branch.` });
            } else {
              const hasAllocation = dbAllocations.some(
                (a) => a.classId === matchedClass.id && a.sectionId === matchedSection.id
              );
              if (!hasAllocation) {
                validationErrors.push({
                  row: rowNum,
                  error: `Section '${row.sectionName}' is not allocated to Class '${row.className}'.`,
                });
              }
            }
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({ success: false, errors: validationErrors });
    }

    const results: any[] = [];
    const batchParentCache = new Map();

    await prisma.$transaction(async (tx: any) => {
      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      let nextUserId = maxUser ? maxUser.id + 1 : 1;

      const maxParent = await tx.parent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      let nextParentId = maxParent ? maxParent.id + 1 : 1;

      const maxStudent = await tx.student.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      let nextStudentId = maxStudent ? maxStudent.id + 1 : 1;

      const maxEnroll = await tx.enroll.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      let nextEnrollId = maxEnroll ? maxEnroll.id + 1 : 1;

      for (let i = 0; i < students.length; i++) {
        const row = students[i];

        const matchedClass = dbClasses.find(
          (c) => c.name.trim().toLowerCase() === row.className.trim().toLowerCase()
        )!;
        const matchedSection = dbSections.find(
          (s) => s.name.trim().toLowerCase() === row.sectionName.trim().toLowerCase()
        )!;

        const registerNo = await generateRegistrationNumber(tx, branchId);
        const idCardToken = crypto.randomUUID();

        const studentPlainPassword = generateSecurePassword();
        const parentPlainPassword = generateSecurePassword();

        let parentRecord: any = null;
        let parentUserId: number | null = null;
        let isExistingParent = false;
        let finalParentUsername: string | null = null;

        const normEmail = row.parentEmail ? row.parentEmail.trim().toLowerCase() : '';
        const normPhone = row.parentPhone ? row.parentPhone.trim().replace(/[\s\-\+]/g, '') : '';

        if (normEmail && batchParentCache.has(`email:${normEmail}`)) {
          parentRecord = batchParentCache.get(`email:${normEmail}`);
          isExistingParent = true;
        } else if (normPhone && batchParentCache.has(`phone:${normPhone}`)) {
          parentRecord = batchParentCache.get(`phone:${normPhone}`);
          isExistingParent = true;
        }

        if (!parentRecord && normEmail) {
          parentRecord = await tx.parent.findFirst({
            where: {
              branchId,
              email: { equals: normEmail, mode: 'insensitive' },
            },
          });
          if (parentRecord) isExistingParent = true;
        }

        if (!parentRecord && normPhone) {
          parentRecord = await tx.parent.findFirst({
            where: {
              branchId,
              mobileno: normPhone,
            },
          });
          if (parentRecord) isExistingParent = true;
        }

        if (parentRecord) {
          parentUserId = parentRecord.userId;
        } else {
          const baseUsername = normEmail || normPhone || `parent_${nextParentId}`;
          const cleanUsername = `${baseUsername.split('@')[0]}_parent`;

          let uniqueUsername = cleanUsername;
          let counter = 1;
          while (true) {
            const userCheck = await tx.user.findUnique({ where: { username: uniqueUsername }, select: { id: true } });
            if (!userCheck) break;
            uniqueUsername = `${cleanUsername}_${counter++}`;
          }

          finalParentUsername = uniqueUsername;

          const hashedParentPassword = await bcrypt.hash(parentPlainPassword, 10);
          const parentUser = await tx.user.create({
            data: {
              id: nextUserId++,
              username: uniqueUsername,
              password: hashedParentPassword,
              role: 6,
              active: true,
            },
          });
          parentUserId = parentUser.id;

          parentRecord = await tx.parent.create({
            data: {
              id: nextParentId++,
              name: row.parentName.trim(),
              relation: row.parentRelation || 'Father',
              email: normEmail,
              mobileno: row.parentPhone || '',
              active: true,
              branchId,
              userId: parentUserId,
            },
          });
        }

        if (normEmail) batchParentCache.set(`email:${normEmail}`, parentRecord);
        if (normPhone) batchParentCache.set(`phone:${normPhone}`, parentRecord);

        const studentUsername = `${row.firstName.toLowerCase()}.${row.lastName.toLowerCase()}`;
        let uniqueStudentUsername = studentUsername;
        let sCounter = 1;
        while (true) {
          const userCheck = await tx.user.findUnique({ where: { username: uniqueStudentUsername }, select: { id: true } });
          if (!userCheck) break;
          uniqueStudentUsername = `${studentUsername}_${sCounter++}`;
        }

        const hashedStudentPassword = await bcrypt.hash(studentPlainPassword, 10);
        const studentUser = await tx.user.create({
          data: {
            id: nextUserId++,
            username: uniqueStudentUsername,
            password: hashedStudentPassword,
            role: 7,
            active: true,
          },
        });

        const studentRecord = await tx.student.create({
          data: {
            id: nextStudentId++,
            registerNo,
            firstName: row.firstName,
            lastName: row.lastName,
            gender: row.gender || 'Male',
            birthday: row.birthday ? new Date(row.birthday) : null,
            parentId: parentRecord.id,
            branchId,
            userId: studentUser.id,
            idCardToken,
            idCardStatus: 'active',
            active: true,
          },
        });

        await tx.enroll.create({
          data: {
            id: nextEnrollId++,
            studentId: studentRecord.id,
            classId: matchedClass.id,
            sectionId: matchedSection.id,
            roll: 0,
            sessionId,
            branchId,
          },
        });

        await bindEvaluationMatrix(tx, {
          studentId: studentRecord.id,
          classId: matchedClass.id,
          sectionId: matchedSection.id,
          branchId,
          sessionId,
        });

        results.push({
          firstName: row.firstName,
          lastName: row.lastName,
          registerNo,
          parentName: row.parentName,
          parentEmail: row.parentEmail || null,
          credentials: {
            student: {
              username: uniqueStudentUsername,
              password: studentPlainPassword,
            },
            parent: isExistingParent
              ? null
              : {
                  username: finalParentUsername,
                  password: parentPlainPassword,
                },
          },
        });
      }
    });

    for (const resItem of results) {
      if (resItem.parentEmail) {
        sendOnboardingCredentials({
          parentEmail: resItem.parentEmail,
          parentName: resItem.parentName,
          studentName: `${resItem.firstName} ${resItem.lastName}`,
          registerNo: resItem.registerNo,
          studentUsername: resItem.credentials.student.username,
          studentPassword: resItem.credentials.student.password,
          parentUsername: resItem.credentials.parent ? resItem.credentials.parent.username : null,
          parentPassword: resItem.credentials.parent ? resItem.credentials.parent.password : null,
          isExistingParent: !resItem.credentials.parent,
          schoolName: branch?.name || 'Your School',
          branchCode: branch?.code || '',
          loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
        }).catch((err: any) => {
          console.warn('[ADMIN] Async bulk onboarding email failed:', err.message);
        });
      }
    }

    return res.status(201).json({ success: true, createdCount: results.length, data: results });
  } catch (error: any) {
    console.error('[ADMIN] Bulk student onboarding error:', error);
    return res
      .status(500)
      .json({ success: false, message: error.message || 'Failed to complete bulk student onboarding.' });
  }
}

/**
 * GET /api/admin/credentials-slips/class-pdf
 */
export async function exportClassCredentialSlipsPdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const classId = req.query.classId;
    const sectionId = req.query.sectionId;

    if (!classId) {
      return res.status(400).json({ success: false, message: 'classId query parameter is required.' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true, code: true },
    });

    let targetClass = null;
    let targetSection = null;

    if (classId !== 'all') {
      targetClass = await prisma.class.findFirst({
        where: { id: Number(classId), branchId },
      });
      if (!targetClass) {
        return res.status(404).json({ success: false, message: 'Class not found in this branch.' });
      }
    }

    if (sectionId && sectionId !== 'all') {
      targetSection = await prisma.section.findFirst({
        where: { id: Number(sectionId), branchId },
      });
    }

    const whereEnroll: any = {
      branchId,
      ...(targetClass ? { classId: targetClass.id } : {}),
      ...(targetSection ? { sectionId: targetSection.id } : {}),
    };

    const enrolls = await prisma.enroll.findMany({
      where: whereEnroll,
      include: {
        student: {
          include: {
            user: { select: { username: true } },
            parent: {
              include: {
                user: { select: { username: true } },
              },
            },
          },
        },
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
      orderBy: { id: 'asc' },
    });

    const slips = enrolls.map((e) => {
      const s = e.student;
      const p = s.parent;
      return {
        studentName: `${s.firstName} ${s.lastName}`,
        registerNo: s.registerNo || '',
        studentUsername: s.user?.username || `${s.firstName.toLowerCase()}.${s.lastName.toLowerCase()}`,
        studentPassword: 'Check Login Slip / Contact Admin',
        parentName: p ? p.name : '',
        parentRelation: p ? p.relation : 'Parent',
        parentUsername: p?.user?.username || null,
        parentPassword: 'Check Login Slip / Contact Admin',
        isExistingParent: true,
      };
    });

    const pdfBuffer = await generateBatchClassCredentialSlipsPdf({
      schoolName: branch?.name || 'Ugbekun Academy',
      branchCode: branch?.code || '',
      className: targetClass ? targetClass.name : 'All Classes',
      sectionName: targetSection ? targetSection.name : '',
      slips,
      loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    });

    const safeClassName = targetClass ? targetClass.name.replace(/\s+/g, '_') : 'All_Classes';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Batch_Login_Slips_${safeClassName}.pdf`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Export batch login slips PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate batch login slips PDF.' });
  }
}

/**
 * POST /api/admin/students/:id/promote
 */
export async function promoteStudent(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const studentId = Number(req.params.id);

  try {
    const { classId, sectionId } = req.body;
    if (!classId || !sectionId) {
      return res.status(400).json({ success: false, message: 'Target classId and sectionId are required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    await prisma.$transaction(async (tx: any) => {
      const currentEnroll = await tx.enroll.findFirst({
        where: { studentId, sessionId, branchId },
      });

      if (!currentEnroll) {
        throw new Error('Student has no current active enrollment in this session.');
      }

      await tx.promotionHistory.create({
        data: {
          studentId,
          fromClassId: currentEnroll.classId,
          fromSectionId: currentEnroll.sectionId,
          toClassId: Number(classId),
          toSectionId: Number(sectionId),
          promotedBy: req.userId,
          sessionId,
        },
      });

      await wipeEvaluationMatrix(tx, { studentId, sessionId });

      await tx.enroll.update({
        where: { id: currentEnroll.id },
        data: {
          classId: Number(classId),
          sectionId: Number(sectionId),
          updatedAt: new Date(),
        },
      });

      await bindEvaluationMatrix(tx, {
        studentId,
        classId: Number(classId),
        sectionId: Number(sectionId),
        branchId,
        sessionId,
      });
    });

    return res.json({ success: true, message: 'Student promoted successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Student promotion error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to promote student.' });
  }
}

/**
 * GET /api/admin/students/:id
 */
export async function getStudentById(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const studentId = Number(req.params.id);

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: {
        parent: true,
        enrolls: {
          take: 1,
          orderBy: { id: 'desc' },
          include: {
            class: true,
            section: true,
          },
        },
      },
    });

    if (!student || student.branchId !== branchId) {
      return res.status(404).json({ success: false, message: 'Student not found or access denied.' });
    }

    const currentEnroll = student.enrolls[0] || null;

    return res.json({
      success: true,
      student: {
        id: student.id,
        registerNo: student.registerNo || '',
        firstName: student.firstName || '',
        lastName: student.lastName || '',
        gender: student.gender || '',
        birthday: student.birthday ? student.birthday.toISOString().split('T')[0] : '',
        religion: student.religion || '',
        caste: student.caste || '',
        bloodGroup: student.bloodGroup || '',
        motherTongue: student.motherTongue || '',
        currentAddress: student.currentAddress || '',
        permanentAddress: student.permanentAddress || '',
        city: student.city || '',
        state: student.state || '',
        mobileno: student.mobileno || '',
        email: student.email || '',
        previousDetails: student.previousDetails || '',
        photo: student.photo || '',
        active: student.active,
        classId: currentEnroll?.classId || '',
        sectionId: currentEnroll?.sectionId || '',
        className: currentEnroll?.class?.name || '',
        sectionName: currentEnroll?.section?.name || '',
        parent: student.parent
          ? {
              id: student.parent.id,
              name: student.parent.name || '',
              email: student.parent.email || '',
              mobileno: student.parent.mobileno || '',
              relation: student.parent.relation || '',
            }
          : null,
      },
    });
  } catch (error) {
    console.error('[ADMIN] Get student details error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch student details.' });
  }
}

/**
 * POST /api/admin/students/:id/upload-photo
 */
export async function uploadStudentPhoto(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const studentId = Number(req.params.id);

  try {
    const { photoBase64, photo } = req.body || {};
    const inputPhoto = photoBase64 || photo;
    if (!inputPhoto) {
      return res.status(400).json({ success: false, message: 'Photograph data is required.' });
    }

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, branchId: true, userId: true },
    });

    if (!student || student.branchId !== branchId) {
      return res.status(404).json({ success: false, message: 'Student not found or access denied.' });
    }

    const photoUrl = await savePhoto(inputPhoto, 'ugbekun2/students/photos');

    const updated = await prisma.student.update({
      where: { id: studentId },
      data: { photo: photoUrl },
      select: { id: true, firstName: true, lastName: true, photo: true },
    });

    if (student.userId) {
      await prisma.user
        .update({
          where: { id: student.userId },
          data: { photo: photoUrl },
        })
        .catch((e: any) => console.warn('[ADMIN] User photo sync warning:', e.message));
    }

    return res.json({
      success: true,
      message: 'Student photograph updated successfully.',
      photo: updated.photo,
      student: updated,
    });
  } catch (error: any) {
    console.error('[ADMIN] Student photo upload error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload photo.' });
  }
}

/**
 * POST /api/admin/parents/:id/upload-photo
 */
export async function uploadParentPhoto(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const parentId = Number(req.params.id);

  try {
    const { photoBase64, photo } = req.body || {};
    const inputPhoto = photoBase64 || photo;
    if (!inputPhoto) {
      return res.status(400).json({ success: false, message: 'Photograph data is required.' });
    }

    const parent = await prisma.parent.findUnique({
      where: { id: parentId },
      select: { id: true, branchId: true, userId: true },
    });

    if (!parent || parent.branchId !== branchId) {
      return res.status(404).json({ success: false, message: 'Parent not found or access denied.' });
    }

    const photoUrl = await savePhoto(inputPhoto, 'ugbekun2/parents/photos');

    const updated = await prisma.parent.update({
      where: { id: parentId },
      data: { photo: photoUrl },
      select: { id: true, name: true, photo: true },
    });

    if (parent.userId) {
      await prisma.user
        .update({
          where: { id: parent.userId },
          data: { photo: photoUrl },
        })
        .catch((e: any) => console.warn('[ADMIN] Parent user photo sync warning:', e.message));
    }

    return res.json({
      success: true,
      message: 'Parent photograph updated successfully.',
      photo: updated.photo,
      parent: updated,
    });
  } catch (error: any) {
    console.error('[ADMIN] Parent photo upload error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload photo.' });
  }
}

/**
 * PUT /api/admin/students/:id
 */
export async function updateStudent(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const studentId = Number(req.params.id);

  try {
    const {
      firstName,
      lastName,
      gender,
      birthday,
      registerNo,
      religion,
      caste,
      bloodGroup,
      motherTongue,
      currentAddress,
      permanentAddress,
      city,
      state,
      mobileno,
      email,
      previousDetails,
      photo,
      active,
      classId,
      sectionId,
      parentName,
      parentEmail,
      parentPhone,
      parentRelation,
    } = req.body;

    const existingStudent = await prisma.student.findUnique({
      where: { id: studentId },
      include: { parent: true },
    });

    if (!existingStudent || existingStudent.branchId !== branchId) {
      return res.status(404).json({ success: false, message: 'Student not found or access denied.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    await prisma.$transaction(async (tx: any) => {
      const updateData: any = {};
      if (firstName !== undefined) updateData.firstName = firstName;
      if (lastName !== undefined) updateData.lastName = lastName;
      if (gender !== undefined) updateData.gender = gender;
      if (birthday !== undefined) updateData.birthday = birthday ? new Date(birthday) : null;
      if (registerNo !== undefined) updateData.registerNo = registerNo;
      if (religion !== undefined) updateData.religion = religion;
      if (caste !== undefined) updateData.caste = caste;
      if (bloodGroup !== undefined) updateData.bloodGroup = bloodGroup;
      if (motherTongue !== undefined) updateData.motherTongue = motherTongue;
      if (currentAddress !== undefined) updateData.currentAddress = currentAddress;
      if (permanentAddress !== undefined) updateData.permanentAddress = permanentAddress;
      if (city !== undefined) updateData.city = city;
      if (state !== undefined) updateData.state = state;
      if (mobileno !== undefined) updateData.mobileno = mobileno;
      if (email !== undefined) updateData.email = email;
      if (previousDetails !== undefined) updateData.previousDetails = previousDetails;
      if (photo !== undefined) updateData.photo = photo;
      if (active !== undefined) updateData.active = Boolean(active);
      updateData.updatedAt = new Date();

      await tx.student.update({
        where: { id: studentId },
        data: updateData,
      });

      if (existingStudent.userId && (firstName || lastName || email)) {
        const userUpdate: any = {};
        if (firstName || lastName) {
          userUpdate.name = `${firstName || existingStudent.firstName || ''} ${
            lastName || existingStudent.lastName || ''
          }`.trim();
        }
        if (email) userUpdate.email = email;
        await tx.user.update({
          where: { id: existingStudent.userId },
          data: userUpdate,
        });
      }

      if (classId && sectionId) {
        const numClassId = Number(classId);
        const numSectionId = Number(sectionId);

        const existingEnroll = await tx.enroll.findFirst({
          where: { studentId, sessionId, branchId },
        });

        if (existingEnroll) {
          if (existingEnroll.classId !== numClassId || existingEnroll.sectionId !== numSectionId) {
            await tx.enroll.update({
              where: { id: existingEnroll.id },
              data: {
                classId: numClassId,
                sectionId: numSectionId,
                updatedAt: new Date(),
              },
            });
          }
        } else {
          const maxEnroll = await tx.enroll.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
          await tx.enroll.create({
            data: {
              id: maxEnroll ? maxEnroll.id + 1 : 1,
              studentId,
              classId: numClassId,
              sectionId: numSectionId,
              sessionId,
              branchId,
              isAlumni: 0,
            },
          });
        }
      }

      if (existingStudent.parentId && (parentName || parentEmail || parentPhone || parentRelation)) {
        const parentUpdate: any = {};
        if (parentName) parentUpdate.name = parentName;
        if (parentEmail) parentUpdate.email = parentEmail;
        if (parentPhone) parentUpdate.mobileno = parentPhone;
        if (parentRelation) parentUpdate.relation = parentRelation;
        parentUpdate.updatedAt = new Date();

        await tx.parent.update({
          where: { id: existingStudent.parentId },
          data: parentUpdate,
        });

        if (existingStudent.parent?.userId && (parentName || parentEmail)) {
          const parentUserUpdate: any = {};
          if (parentName) parentUserUpdate.name = parentName;
          if (parentEmail) parentUserUpdate.email = parentEmail;
          await tx.user.update({
            where: { id: existingStudent.parent.userId },
            data: parentUserUpdate,
          });
        }
      }
    });

    return res.json({ success: true, message: 'Student information updated successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Update student error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update student information.' });
  }
}

/**
 * DELETE /api/admin/students/:id
 */
export async function deleteStudent(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const studentId = Number(req.params.id);

  try {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
    });

    if (!student || student.branchId !== branchId) {
      return res.status(404).json({ success: false, message: 'Student not found or access denied.' });
    }

    await prisma.student.update({
      where: { id: studentId },
      data: { active: false, updatedAt: new Date() },
    });

    return res.json({ success: true, message: 'Student record deactivated successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Delete student error:', error);
    return res.status(500).json({ success: false, message: 'Failed to deactivate student.' });
  }
}

/**
 * POST /api/admin/students/:id/toggle-status
 */
export async function toggleStudentStatus(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const id = Number(req.params.id);

  try {
    const student = await prisma.student.findUnique({
      where: { id },
      select: { id: true, active: true, branchId: true, userId: true },
    });

    if (!student || student.branchId !== branchId) {
      return res.status(404).json({ success: false, message: 'Student not found or access denied.' });
    }

    const updated = await prisma.student.update({
      where: { id },
      data: { active: !student.active },
    });

    if (student.userId) {
      await prisma.user
        .update({
          where: { id: student.userId },
          data: { active: updated.active },
        })
        .catch((e: any) => console.warn('[ADMIN] Sync user active warning:', e.message));
    }

    return res.json({ success: true, active: updated.active, message: `Student status updated to ${updated.active ? 'active' : 'inactive'}.` });
  } catch (error: any) {
    console.error('[ADMIN] Toggle student status error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to toggle student status.' });
  }
}

/**
 * GET /api/admin/sibling-requests
 */
export async function getSiblingRequests(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const requests = await prisma.parentSiblingRequest.findMany({
      where: { branchId },
      include: {
        parent: { select: { name: true, email: true, mobileno: true } },
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const formatted = requests.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      parentName: r.parent.name,
      parentEmail: r.parent.email,
      parentPhone: r.parent.mobileno,
      firstName: r.firstName,
      lastName: r.lastName,
      gender: r.gender,
      birthday: r.birthday,
      status: r.status,
      rejectionReason: r.rejectionReason,
      className: r.class.name,
      sectionName: r.section.name,
      createdAt: r.createdAt,
    }));

    return res.json({ success: true, siblingRequests: formatted });
  } catch (error) {
    console.error('[ADMIN] Get sibling requests error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load sibling requests.' });
  }
}

/**
 * POST /api/admin/sibling-requests/:id/approve
 */
export async function approveSiblingRequest(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const requestId = parseInt(req.params.id as string, 10);
    if (isNaN(requestId)) {
      return res.status(400).json({ success: false, message: 'Invalid Request ID.' });
    }

    const request = await prisma.parentSiblingRequest.findFirst({
      where: { id: requestId, branchId },
      include: {
        parent: true,
        branch: true,
      },
    });

    if (!request) {
      return res.status(404).json({ success: false, message: 'Sibling request not found.' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Request is already ${request.status}.` });
    }

    const { firstName, lastName, gender, birthday, classId, sectionId, parentId } = request;
    const parentEmail = request.parent.email;
    const parentName = request.parent.name;

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const registerNo = await generateRegistrationNumber(prisma, branchId);
    const idCardToken = crypto.randomUUID();
    const studentPlainPassword = generateSecurePassword();

    let finalStudentUsername: string | null = null;

    await prisma.$transaction(async (tx: any) => {
      const studentUsername = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`;
      let uniqueStudentUsername = studentUsername;
      let sCounter = 1;
      while (true) {
        const userCheck = await tx.user.findUnique({ where: { username: uniqueStudentUsername }, select: { id: true } });
        if (!userCheck) break;
        uniqueStudentUsername = `${studentUsername}_${sCounter++}`;
      }
      finalStudentUsername = uniqueStudentUsername;

      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      const nextStudentUserId = maxUser ? maxUser.id + 1 : 1;
      const hashedStudentPassword = await bcrypt.hash(studentPlainPassword, 10);

      const studentUser = await tx.user.create({
        data: {
          id: nextStudentUserId,
          username: finalStudentUsername,
          password: hashedStudentPassword,
          role: 7,
          active: true,
        },
      });

      const maxStudent = await tx.student.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      const nextStudentId = maxStudent ? maxStudent.id + 1 : 1;

      const studentRecord = await tx.student.create({
        data: {
          id: nextStudentId,
          registerNo,
          firstName,
          lastName,
          gender: gender || 'Male',
          birthday,
          parentId,
          branchId,
          userId: studentUser.id,
          idCardToken,
          idCardStatus: 'active',
          active: true,
        },
      });

      const maxEnroll = await tx.enroll.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      const nextEnrollId = maxEnroll ? maxEnroll.id + 1 : 1;

      await tx.enroll.create({
        data: {
          id: nextEnrollId,
          studentId: studentRecord.id,
          classId: Number(classId),
          sectionId: Number(sectionId),
          roll: 0,
          sessionId,
          branchId,
        },
      });

      await bindEvaluationMatrix(tx, {
        studentId: studentRecord.id,
        classId: Number(classId),
        sectionId: Number(sectionId),
        branchId,
        sessionId,
      });

      await tx.parentSiblingRequest.update({
        where: { id: requestId },
        data: { status: 'approved' },
      });
    });

    let emailSent = false;
    if (parentEmail) {
      try {
        const emailResult = await sendOnboardingCredentials({
          parentEmail,
          parentName,
          studentName: `${firstName} ${lastName}`,
          registerNo,
          studentUsername: finalStudentUsername!,
          studentPassword: studentPlainPassword,
          parentUsername: null,
          parentPassword: null,
          isExistingParent: true,
          schoolName: request.branch?.name || 'Your School',
          branchCode: request.branch?.code || '',
          loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
        });
        emailSent = emailResult.success;
      } catch (err) {
        console.warn('[ADMIN] Sibling onboarding email failed:', err);
      }
    }

    return res.json({
      success: true,
      message: 'Sibling request approved and student registered successfully.',
      emailSent,
      credentials: {
        student: {
          username: finalStudentUsername,
          password: studentPlainPassword,
        },
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Approve sibling request error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to approve sibling request.' });
  }
}

/**
 * POST /api/admin/sibling-requests/:id/reject
 */
export async function rejectSiblingRequest(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const requestId = parseInt(req.params.id as string, 10);
    const { reason } = req.body || {};

    if (isNaN(requestId)) {
      return res.status(400).json({ success: false, message: 'Invalid Request ID.' });
    }

    const request = await prisma.parentSiblingRequest.findFirst({
      where: { id: requestId, branchId },
    });

    if (!request) {
      return res.status(404).json({ success: false, message: 'Sibling request not found.' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Request is already ${request.status}.` });
    }

    await prisma.parentSiblingRequest.update({
      where: { id: requestId },
      data: {
        status: 'rejected',
        rejectionReason: reason || 'Not specified',
      },
    });

    return res.json({ success: true, message: 'Sibling request rejected successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Reject sibling request error:', error);
    return res.status(500).json({ success: false, message: 'Failed to reject sibling request.' });
  }
}

/**
 * GET /api/admin/classroom-students
 */
export async function getClassroomStudents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId } = req.query;
    if (!classId || !sectionId) {
      return res.json({
        success: true,
        students: [],
        formTeacher: null,
        stats: { total: 0, male: 0, female: 0 },
      });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    let enrollments = await prisma.enroll.findMany({
      where: {
        branchId,
        sessionId,
        classId: Number(classId),
        sectionId: Number(sectionId),
        isAlumni: 0,
      },
      include: {
        student: {
          include: {
            parent: true,
          },
        },
      },
      orderBy: {
        student: {
          lastName: 'asc',
        },
      },
    });

    if (enrollments.length === 0) {
      enrollments = await prisma.enroll.findMany({
        where: {
          branchId,
          classId: Number(classId),
          sectionId: Number(sectionId),
          isAlumni: 0,
        },
        include: {
          student: {
            include: {
              parent: true,
            },
          },
        },
        orderBy: {
          student: {
            lastName: 'asc',
          },
        },
      });
    }

    const formTeacherAllocation = await prisma.teacherAllocation.findFirst({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        sessionId,
        branchId,
      },
      include: {
        teacher: true,
      },
    });

    const students = enrollments.map((e) => ({
      id: e.student.id,
      registerNo: e.student.registerNo,
      firstName: e.student.firstName,
      lastName: e.student.lastName,
      gender: e.student.gender,
      mobileno: e.student.mobileno,
      email: e.student.email,
      active: e.student.active,
      parentName: e.student.parent?.name || null,
      parentRelation: e.student.parent?.relation || null,
      parentMobile: e.student.parent?.mobileno || null,
      parentEmail: e.student.parent?.email || null,
    }));

    const total = students.length;
    const male = students.filter((s) => s.gender?.toLowerCase() === 'male').length;
    const female = total - male;

    return res.json({
      success: true,
      students,
      formTeacher: formTeacherAllocation?.teacher?.name || 'Unassigned',
      stats: { total, male, female },
    });
  } catch (error) {
    console.error('[ADMIN] Get classroom students error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load classroom students.' });
  }
}

/**
 * GET /api/admin/online-admissions
 */
export async function getOnlineAdmissions(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { status } = req.query;
    const where: any = { branchId };

    if (status !== undefined && status !== '') {
      where.status = parseInt(status as string, 10);
    }

    const admissions = await prisma.onlineAdmission.findMany({
      where,
      orderBy: {
        applyDate: 'desc',
      },
    });

    return res.json({ success: true, admissions });
  } catch (error) {
    console.error('[ADMIN] Get online admissions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch online admissions.' });
  }
}

/**
 * POST /api/admin/online-admissions/:id/status
 */
export async function updateOnlineAdmissionStatus(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const admissionId = parseInt(req.params.id as string, 10);
    if (isNaN(admissionId)) {
      return res.status(400).json({ success: false, message: 'Invalid Admission ID.' });
    }

    const { status, classId, sectionId } = req.body;
    const targetStatus = parseInt(status, 10);

    if (isNaN(targetStatus) || ![1, 2, 3, 4].includes(targetStatus)) {
      return res.status(400).json({ success: false, message: 'Invalid admission status (1=Pending, 2=Screening, 3=Approved, 4=Rejected).' });
    }

    const admission = await prisma.onlineAdmission.findFirst({
      where: { id: admissionId, branchId },
    });

    if (!admission) {
      return res.status(404).json({ success: false, message: 'Online admission record not found.' });
    }

    if (targetStatus === 3) {
      const targetClassId = Number(classId || admission.classId);
      const targetSectionId = Number(sectionId || admission.sectionId);

      if (!targetClassId || !targetSectionId) {
        return res.status(400).json({ success: false, message: 'Class and section allocation required for approving admission.' });
      }

      const globalSetting = await prisma.globalSettings.findFirst();
      const sessionId = globalSetting?.sessionId || 5;

      const registerNo = await generateRegistrationNumber(prisma, branchId);
      const studentPlainPassword = generateSecurePassword();
      const parentPlainPassword = generateSecurePassword();

      let studentUsername = '';
      let parentUsername = '';

      await prisma.$transaction(async (tx: any) => {
        let parentRecord = null;
        if (admission.grdEmail) {
          parentRecord = await tx.parent.findFirst({
            where: { branchId, email: admission.grdEmail },
          });
        }

        if (!parentRecord) {
          const maxParentUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
          const nextParentUserId = (maxParentUser?.id || 0) + 1;

          const parentUser = await tx.user.create({
            data: {
              id: nextParentUserId,
              username: (admission.grdEmail || `parent_${admissionId}`).split('@')[0],
              password: await bcrypt.hash(parentPlainPassword, 10),
              role: 6,
              active: true,
            },
          });
          parentUsername = parentUser.username;

          const maxParent = await tx.parent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
          const nextParentId = (maxParent?.id || 0) + 1;

          parentRecord = await tx.parent.create({
            data: {
              id: nextParentId,
              name: admission.guardianName || 'Guardian',
              relation: admission.guardianRelation || 'Guardian',
              email: admission.grdEmail,
              mobileno: admission.grdMobileNo || '',
              address: admission.grdAddress,
              branchId,
              userId: parentUser.id,
              active: true,
            },
          });
        }

        const maxStudentUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
        const nextStudentUserId = (maxStudentUser?.id || 0) + 1;

        const studentUser = await tx.user.create({
          data: {
            id: nextStudentUserId,
            username: `${admission.firstName.toLowerCase()}.${(admission.lastName || 'student').toLowerCase()}`,
            password: await bcrypt.hash(studentPlainPassword, 10),
            role: 7,
            active: true,
          },
        });
        studentUsername = studentUser.username;

        const maxStudent = await tx.student.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
        const nextStudentId = (maxStudent?.id || 0) + 1;

        const studentRecord = await tx.student.create({
          data: {
            id: nextStudentId,
            registerNo,
            admissionDate: new Date(),
            firstName: admission.firstName,
            lastName: admission.lastName || '',
            gender: admission.gender || 'Unknown',
            birthday: admission.birthday,
            religion: admission.religion,
            bloodGroup: admission.bloodGroup,
            currentAddress: admission.presentAddress,
            permanentAddress: admission.permanentAddress,
            photo: admission.studentPhoto,
            parentId: parentRecord.id,
            branchId,
            userId: studentUser.id,
            active: true,
          },
        });

        const maxEnroll = await tx.enroll.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
        const nextEnrollId = (maxEnroll?.id || 0) + 1;

        await tx.enroll.create({
          data: {
            id: nextEnrollId,
            studentId: studentRecord.id,
            classId: targetClassId,
            sectionId: targetSectionId,
            roll: 0,
            sessionId,
            branchId,
          },
        });

        await bindEvaluationMatrix(tx, {
          studentId: studentRecord.id,
          classId: targetClassId,
          sectionId: targetSectionId,
          branchId,
          sessionId,
        });

        await tx.onlineAdmission.update({
          where: { id: admissionId },
          data: { status: 3 },
        });
      });

      return res.json({
        success: true,
        message: 'Admission approved and student record created successfully.',
        credentials: {
          student: { username: studentUsername, password: studentPlainPassword },
          parent: { username: parentUsername, password: parentPlainPassword },
        },
      });
    }

    const updated = await prisma.onlineAdmission.update({
      where: { id: admissionId },
      data: { status: targetStatus },
    });

    return res.json({ success: true, message: 'Admission status updated.', admission: updated });
  } catch (error: any) {
    console.error('[ADMIN] Update admission status error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update admission status.' });
  }
}

/**
 * POST /api/admin/id-cards/provision/student/:studentId
 */
export async function provisionStudentIdCardHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const studentId = parseInt(req.params.studentId as string, 10);
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const card = await provisionStudentIdCard(prisma, {
      studentId,
      branchId,
      sessionId,
    });

    return res.status(201).json({
      success: true,
      message: 'Student ID card provisioned successfully.',
      card,
    });
  } catch (error: any) {
    console.error('[ADMIN] Student ID provisioning error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to provision ID card.' });
  }
}

/**
 * POST /api/admin/id-cards/provision/staff/:userId
 */
export async function provisionStaffIdCardHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const userId = parseInt(req.params.userId as string, 10);
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const card = await provisionStaffIdCard(prisma, {
      userId,
      branchId,
      sessionId,
    });

    return res.status(201).json({
      success: true,
      message: 'Staff ID card provisioned successfully.',
      card,
    });
  } catch (error: any) {
    console.error('[ADMIN] Staff ID provisioning error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to provision ID card.' });
  }
}

/**
 * POST /api/admin/id-cards/provision/batch
 */
export async function batchProvisionIdCards(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId } = req.body;
    if (!classId || !sectionId) {
      return res.status(400).json({ success: false, message: 'Class ID and Section ID are required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const results = await batchProvisionStudentIdCards(prisma, {
      classId: parseInt(classId, 10),
      sectionId: parseInt(sectionId, 10),
      branchId,
      sessionId,
    });

    const successCount = results.filter((r: any) => r.success).length;

    return res.status(201).json({
      success: true,
      message: `Batch ID provisioning completed: ${successCount} successful, ${results.length - successCount} failed.`,
      results,
    });
  } catch (error: any) {
    console.error('[ADMIN] Batch ID provisioning error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to run batch ID provisioning.' });
  }
}

/**
 * GET /api/admin/id-cards
 */
export async function getIdCards(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { entityType, status, page = 1, limit = 20, search } = (req.query || {}) as any;
    const p = parseInt(page as string, 10);
    const l = parseInt(limit as string, 10);
    const skip = (p - 1) * l;

    const where: any = {
      branchId,
    };

    if (entityType) where.entityType = entityType;
    if (status) where.status = status;

    if (search) {
      where.OR = [
        { cardNumber: { contains: search, mode: 'insensitive' } },
        {
          student: {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
            ],
          },
        },
        {
          user: {
            username: { contains: search, mode: 'insensitive' },
          },
        },
      ];
    }

    const [cards, total] = await Promise.all([
      prisma.idCard.findMany({
        where,
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              registerNo: true,
              photo: true,
            },
          },
          user: {
            select: {
              username: true,
              role: true,
            },
          },
        },
        orderBy: { issuedAt: 'desc' },
        skip,
        take: l,
      }),
      prisma.idCard.count({ where }),
    ]);

    const mappedCards = cards.map((c) => {
      let name = 'Unknown';
      let photo = null;
      let role = 'Staff';

      if (c.entityType === 'student' && c.student) {
        name = `${c.student.firstName} ${c.student.lastName}`;
        photo = c.student.photo;
        role = 'Student';
      } else if (c.entityType === 'staff' && c.user) {
        name = c.user.username;
        const roles: Record<number, string> = {
          3: 'Teacher',
          4: 'Accountant',
          8: 'Receptionist',
          9: 'Proprietor',
          12: 'Librarian',
          13: 'Staff',
        };
        role = roles[c.user.role] || 'Staff';
      }

      return {
        id: c.id,
        entityType: c.entityType,
        cardNumber: c.cardNumber,
        verifyToken: c.verifyToken,
        status: c.status,
        issuedAt: c.issuedAt,
        expiresAt: c.expiresAt,
        revokedAt: c.revokedAt,
        revokedReason: c.revokedReason,
        name,
        photo,
        role,
      };
    });

    return res.json({
      success: true,
      data: mappedCards,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
      },
    });
  } catch (error) {
    console.error('[ADMIN] Get ID cards error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve ID cards list.' });
  }
}

/**
 * PUT /api/admin/id-cards/:cardId/revoke
 */
export async function revokeIdCardHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const cardId = parseInt(req.params.cardId as string, 10);
    const { reason } = req.body;

    const card = await prisma.idCard.findFirst({
      where: { id: cardId, branchId },
    });

    if (!card) {
      return res.status(404).json({ success: false, message: 'ID card not found.' });
    }

    const updated = await revokeIdCard(prisma, cardId, reason || 'Administrative revocation');

    return res.json({
      success: true,
      message: 'ID card has been successfully revoked.',
      card: updated,
    });
  } catch (error: any) {
    console.error('[ADMIN] Revoke ID card error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to revoke ID card.' });
  }
}

/**
 * GET /api/admin/id-cards/:cardId/download
 */
export async function downloadIdCardPdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const cardId = parseInt(req.params.cardId as string, 10);
    const card = await prisma.idCard.findFirst({
      where: { id: cardId, branchId },
      include: {
        student: {
          include: {
            enrolls: {
              orderBy: { id: 'desc' },
              take: 1,
              include: {
                class: true,
                section: true,
              },
            },
          },
        },
        user: true,
        branch: true,
      },
    });

    if (!card) {
      return res.status(404).json({ success: false, message: 'ID card not found.' });
    }

    const session = await prisma.schoolYear.findFirst({
      where: { id: card.sessionId },
    });

    const sessionName = session?.schoolYear || 'Current';

    const pdfParams = {
      schoolName: card.branch.name,
      branchName: card.branch.city || card.branch.name,
      primaryColor: card.branch.idCardPrimaryColor || '#1b5e20',
      secondaryColor: card.branch.idCardSecondaryColor || '#2e7d32',
      verifyToken: card.verifyToken,
      cardNumber: card.cardNumber,
    };

    let pdfBuffer: Buffer;
    if (card.entityType === 'student' && card.student) {
      const activeEnroll = card.student.enrolls[0];
      pdfBuffer = (await generateStudentIdCardPdf({
        ...pdfParams,
        studentName: `${card.student.firstName} ${card.student.lastName}`,
        registerNo: card.student.registerNo,
        className: activeEnroll?.class?.name || 'Unassigned',
        sectionName: activeEnroll?.section?.name || 'Unassigned',
        sessionName,
        photoUrl: card.student.photo,
      })) as Buffer;
    } else if (card.entityType === 'staff' && card.user) {
      const roles: Record<number, string> = {
        3: 'Teacher',
        4: 'Accountant',
        8: 'Receptionist',
        9: 'Proprietor',
        12: 'Librarian',
        13: 'Staff',
      };
      pdfBuffer = (await generateStaffIdCardPdf({
        ...pdfParams,
        staffName: card.user.username,
        roleName: roles[card.user.role] || 'Staff',
        username: card.user.username,
        photoUrl: null,
      })) as Buffer;
    } else {
      return res.status(400).json({ success: false, message: 'Entity profile missing on ID card.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=ID_Card_${card.cardNumber.replace(/\//g, '_')}.pdf`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Download ID PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate ID card PDF document.' });
  }
}

/**
 * GET /api/admin/card-template
 */
export async function getCardTemplate(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  try {
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        name: true,
        city: true,
        systemLogo: true,
        idCardPrimaryColor: true,
        idCardSecondaryColor: true,
        idCardLayoutType: true,
      },
    });

    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found.' });

    const [totalCards, activeCards, revokedCards] = await Promise.all([
      prisma.idCard.count({ where: { branchId } }),
      prisma.idCard.count({ where: { branchId, status: 'active' } }),
      prisma.idCard.count({ where: { branchId, status: 'revoked' } }),
    ]);

    return res.json({
      success: true,
      template: {
        schoolName: branch.name,
        branchName: branch.city || branch.name,
        logo: branch.systemLogo,
        primaryColor: branch.idCardPrimaryColor || '#1b5e20',
        secondaryColor: branch.idCardSecondaryColor || '#2e7d32',
        layoutType: branch.idCardLayoutType || 'classic',
      },
      stats: { totalCards, activeCards, revokedCards },
    });
  } catch (error) {
    console.error('[ADMIN] Get card template error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load card template.' });
  }
}

/**
 * PUT /api/admin/card-template
 */
export async function updateCardTemplate(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  try {
    const { primaryColor, secondaryColor, layoutType } = req.body;

    const validLayouts = ['classic', 'modern', 'minimal'];
    if (layoutType && !validLayouts.includes(layoutType)) {
      return res.status(400).json({ success: false, message: 'Invalid layout type.' });
    }

    const updated = await prisma.branch.update({
      where: { id: branchId },
      data: {
        ...(primaryColor ? { idCardPrimaryColor: primaryColor } : {}),
        ...(secondaryColor ? { idCardSecondaryColor: secondaryColor } : {}),
        ...(layoutType ? { idCardLayoutType: layoutType } : {}),
      },
      select: { idCardPrimaryColor: true, idCardSecondaryColor: true, idCardLayoutType: true },
    });

    return res.json({
      success: true,
      message: 'Card template settings updated successfully.',
      template: {
        primaryColor: updated.idCardPrimaryColor,
        secondaryColor: updated.idCardSecondaryColor,
        layoutType: updated.idCardLayoutType,
      },
    });
  } catch (error) {
    console.error('[ADMIN] Update card template error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update card template.' });
  }
}

/**
 * GET /api/admin/id-cards/stats
 */
export async function getIdCardsStats(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  try {
    const [studentActive, studentRevoked, staffActive, staffRevoked] = await Promise.all([
      prisma.idCard.count({ where: { branchId, entityType: 'student', status: 'active' } }),
      prisma.idCard.count({ where: { branchId, entityType: 'student', status: 'revoked' } }),
      prisma.idCard.count({ where: { branchId, entityType: 'staff', status: 'active' } }),
      prisma.idCard.count({ where: { branchId, entityType: 'staff', status: 'revoked' } }),
    ]);
    return res.json({
      success: true,
      stats: {
        student: { active: studentActive, revoked: studentRevoked, total: studentActive + studentRevoked },
        staff: { active: staffActive, revoked: staffRevoked, total: staffActive + staffRevoked },
        total: studentActive + studentRevoked + staffActive + staffRevoked,
        totalActive: studentActive + staffActive,
        totalRevoked: studentRevoked + staffRevoked,
      },
    });
  } catch (error) {
    console.error('[ADMIN] ID cards stats error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load ID card stats.' });
  }
}

/**
 * POST /api/admin/certificates/issue
 */
export async function issueCertificate(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { studentId, certificateType, title, description } = req.body;
    if (!studentId || !certificateType || !title) {
      return res.status(400).json({ success: false, message: 'Student ID, Type, and Title are required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const cert = await provisionCertificate(prisma, {
      studentId: parseInt(studentId, 10),
      certificateType,
      title,
      description,
      branchId,
      sessionId,
    });

    return res.status(201).json({
      success: true,
      message: 'Certificate issued successfully.',
      certificate: cert,
    });
  } catch (error: any) {
    console.error('[ADMIN] Issue certificate error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to issue certificate.' });
  }
}

/**
 * GET /api/admin/certificates
 */
export async function getCertificates(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { certificateType, status, search, page = 1, limit = 20 } = (req.query || {}) as any;
    const p = parseInt(page as string, 10);
    const l = parseInt(limit as string, 10);
    const skip = (p - 1) * l;

    const where: any = {
      branchId,
    };

    if (certificateType) where.certificateType = certificateType;
    if (status) where.status = status;

    if (search) {
      where.OR = [
        { certificateNo: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
        {
          student: {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }

    const [certs, total] = await Promise.all([
      prisma.certificate.findMany({
        where,
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              registerNo: true,
            },
          },
        },
        orderBy: { issuedAt: 'desc' },
        skip,
        take: l,
      }),
      prisma.certificate.count({ where }),
    ]);

    return res.json({
      success: true,
      data: certs,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
      },
    });
  } catch (error) {
    console.error('[ADMIN] Get certificates error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve certificates list.' });
  }
}

/**
 * GET /api/admin/certificates/:certId/download
 */
export async function downloadCertificatePdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const certId = parseInt(req.params.certId as string, 10);
    const cert = await prisma.certificate.findFirst({
      where: { id: certId, branchId },
      include: {
        student: true,
        branch: true,
      },
    });

    if (!cert) {
      return res.status(404).json({ success: false, message: 'Certificate not found.' });
    }

    const session = await prisma.schoolYear.findFirst({
      where: { id: cert.sessionId },
    });

    const sessionName = session?.schoolYear || 'Current';

    const pdfBuffer = await generateCertificatePdf({
      schoolName: cert.branch.name,
      branchName: cert.branch.city || cert.branch.name,
      primaryColor: cert.branch.idCardPrimaryColor || '#1b5e20',
      secondaryColor: cert.branch.idCardSecondaryColor || '#2e7d32',
      studentName: `${cert.student.firstName} ${cert.student.lastName}`,
      certificateType: cert.certificateType,
      certificateNo: cert.certificateNo,
      title: cert.title,
      description: cert.description,
      sessionName,
      verifyToken: cert.verifyToken,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Certificate_${cert.certificateNo.replace(/\//g, '_')}.pdf`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Download certificate PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate certificate PDF document.' });
  }
}

/**
 * POST /api/admin/students/parse-document
 */
export async function parseStudentDocument(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No document file uploaded.' });
  }

  try {
    let rawText = '';
    const fileMimetype = req.file.mimetype;

    if (fileMimetype === 'application/pdf') {
      const pdfBuffer = req.file.buffer;
      try {
        const pdfModule: any = pdfParse;
        if (pdfModule?.PDFParse) {
          const parser = new pdfModule.PDFParse({ data: pdfBuffer });
          await parser.load();
          const resText = await parser.getText();
          rawText = typeof resText === 'string' ? resText : resText?.text || '';
        } else if (typeof pdfModule === 'function') {
          const data = await pdfModule(pdfBuffer);
          rawText = data.text || '';
        } else if (pdfModule?.default && typeof pdfModule.default === 'function') {
          const data = await pdfModule.default(pdfBuffer);
          rawText = data.text || '';
        }
      } catch (pdfErr: any) {
        console.warn('[ADMIN PDF PARSE] PDF parsing error:', pdfErr?.message);
      }
    } else if (fileMimetype.startsWith('image/')) {
      if (Tesseract) {
        try {
          const result = await Tesseract.recognize(req.file.buffer, 'eng');
          rawText = result?.data?.text || '';
        } catch (ocrErr: any) {
          console.warn('[ADMIN OCR] Tesseract processing warning:', ocrErr?.message);
        }
      }
    } else {
      return res
        .status(400)
        .json({ success: false, message: 'Unsupported file format. Please upload a PDF or an Image (JPG, PNG, WEBP).' });
    }

    const documentPreview = {
      mimeType: fileMimetype,
      dataUrl: `data:${fileMimetype};base64,${req.file.buffer.toString('base64')}`,
    };

    let extractedData: any = null;

    if (rawText && rawText.trim().length >= 5 && process.env.DEEPSEEK_API_KEY) {
      try {
        const prompt = `
          You are an expert administrative assistant for school student onboarding.
          Analyze the following text extracted from a physical admission form, birth certificate, or academic transcript.
          Extract and structure the data strictly adhering to the JSON schema below.

          Raw Document Text:
          """
          ${rawText}
          """

          Extraction Guidelines:
          - Extract student's first, last, and middle name.
          - Normalize Date of Birth (birthday) and admissionDate to "YYYY-MM-DD" if present.
          - Extract targetClass (e.g. "Primary 1", "JSS 2", "Nursery 1", "Basic 3") and targetSection.
          - Extract Blood Group (e.g. "O+", "A+", "B+", "AB-") and Religion.
          - Extract Parent/Guardian name, relationship (Father/Mother/Guardian), phone number, email, and occupation.
          - For "historicalPerformance", summarize previous schools, report card scores, or comments.
          - If a field is missing, set it to "" or null.
          - Output strictly a valid JSON object without markdown or formatting.

          Output JSON Schema:
          {
            "firstName": "string",
            "lastName": "string",
            "middleName": "string",
            "gender": "Male | Female",
            "birthday": "YYYY-MM-DD",
            "admissionDate": "YYYY-MM-DD",
            "bloodGroup": "string",
            "religion": "string",
            "motherTongue": "string",
            "targetClass": "string",
            "targetSection": "string",
            "homeAddress": "string",
            "historicalPerformance": "string",
            "parentName": "string",
            "parentRelation": "Father | Mother | Guardian",
            "parentEmail": "string",
            "parentPhone": "string",
            "parentOccupation": "string",
            "parentAddress": "string"
          }
        `;

        const completion = await openai.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: 'You are a precise JSON extractor for school documents. Return valid JSON only.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        });

        const content = completion.choices?.[0]?.message?.content?.trim();
        if (content) {
          extractedData = JSON.parse(content);
        }
      } catch (aiErr: any) {
        console.warn('[ADMIN] DeepSeek AI parsing failed, attempting heuristic fallback:', aiErr?.message);
      }
    }

    if (!extractedData) {
      const text = rawText || '';
      const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const phoneMatch = text.match(/(?:\+?234|0)[789][01]\d{8}/);
      const dobMatch = text.match(
        /(?:DOB|Birth|Born|Date of Birth)[\s:]*([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}[-/][0-9]{1,2}[-/][0-9]{4})/i
      );
      const bloodMatch = text.match(/\b(A\+|A-|B\+|B-|AB\+|AB-|O\+|O-)\b/i);
      const genderMatch = text.match(/\b(Female|Male|Girl|Boy)\b/i);
      const classMatch = text.match(
        /\b(Primary\s*\d+|JSS\s*\d+|SSS\s*\d+|Nursery\s*\d+|Kindergarten\s*\d+|Grade\s*\d+|Basic\s*\d+)\b/i
      );

      let formattedDob = '';
      if (dobMatch && dobMatch[1]) {
        const parts = dobMatch[1].split(/[-/]/);
        if (parts.length === 3) {
          if (parts[0].length === 4) {
            formattedDob = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
          } else if (parts[2].length === 4) {
            formattedDob = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
          }
        }
      }

      const nameMatch = text.match(/(?:Student Name|Full Name|Name of Student|Candidate Name)[\s:]*([A-Za-z\s]+)/i);
      const nameParts = nameMatch ? nameMatch[1].trim().split(/\s+/) : [];

      const parentMatch = text.match(
        /(?:Parent Name|Father Name|Mother Name|Guardian Name|Parent\/Guardian)[\s:]*([A-Za-z\s]+)/i
      );

      extractedData = {
        firstName: nameParts[0] || '',
        lastName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : '',
        middleName: '',
        gender: genderMatch ? (genderMatch[1].toLowerCase().startsWith('f') ? 'Female' : 'Male') : 'Male',
        birthday: formattedDob || '',
        admissionDate: new Date().toISOString().substring(0, 10),
        bloodGroup: bloodMatch ? bloodMatch[1].toUpperCase() : '',
        religion: /islam|muslim/i.test(text) ? 'Islam' : /christian|catholic|anglican/i.test(text) ? 'Christianity' : '',
        motherTongue: '',
        targetClass: classMatch ? classMatch[1] : '',
        targetSection: '',
        homeAddress: '',
        historicalPerformance: '',
        parentName: parentMatch ? parentMatch[1].trim() : '',
        parentRelation: /mother/i.test(text) ? 'Mother' : /guardian/i.test(text) ? 'Guardian' : 'Father',
        parentEmail: emailMatch ? emailMatch[0] : '',
        parentPhone: phoneMatch ? phoneMatch[0] : '',
        parentOccupation: '',
        parentAddress: '',
      };
    }

    let matchedExistingParent: any = null;
    const pPhone = extractedData.parentPhone ? String(extractedData.parentPhone).trim() : '';
    const pEmail = extractedData.parentEmail ? String(extractedData.parentEmail).trim().toLowerCase() : '';

    if (pPhone || pEmail) {
      const searchConditions: any[] = [];
      if (pPhone) {
        searchConditions.push({ mobileno: { contains: pPhone.slice(-8) } });
      }
      if (pEmail) {
        searchConditions.push({ email: { equals: pEmail, mode: 'insensitive' } });
      }

      const foundParent = await prisma.parent.findFirst({
        where: {
          branchId,
          OR: searchConditions,
        },
        include: {
          students: {
            where: { active: true },
            include: {
              enrolls: {
                include: { class: { select: { name: true } }, section: { select: { name: true } } },
                orderBy: { id: 'desc' },
                take: 1,
              },
            },
          },
        },
      });

      if (foundParent) {
        matchedExistingParent = {
          id: foundParent.id,
          name: foundParent.name,
          relation: foundParent.relation,
          email: foundParent.email,
          mobileno: foundParent.mobileno,
          photo: foundParent.photo,
          occupation: foundParent.occupation,
          address: foundParent.address,
          enrolledChildrenCount: foundParent.students.length,
          children: foundParent.students.map((s: any) => ({
            id: s.id,
            name: `${s.firstName} ${s.lastName}`,
            registerNo: s.registerNo,
            className: s.enrolls?.[0]?.class?.name || 'Enrolled',
            sectionName: s.enrolls?.[0]?.section?.name || 'N/A',
          })),
        };
      }
    }

    return res.json({
      success: true,
      extractedData,
      matchedExistingParent,
      documentPreview,
      rawTextSnippet: rawText ? rawText.slice(0, 300) : '',
    });
  } catch (error: any) {
    console.error('[ADMIN] Document parsing error:', error);
    return res.status(500).json({ success: false, message: 'Failed to process document. ' + (error?.message || '') });
  }
}

export const onboardStudentWithPhoto = onboardStudent;
export const bulkImportStudents = importBulkStudents;
export const exportCredentialSlips = exportClassCredentialSlipsPdf;
export const promoteStudents = promoteStudent;
export const getStudentProfile = getStudentById;
export const updateStudentProfile = updateStudent;
export const processSiblingRequest = approveSiblingRequest;
export const reviewOnlineAdmission = updateOnlineAdmissionStatus;
export const getStudentsForIdCards = getIdCards;
export const getStaffForIdCards = getIdCards;
export const provisionIdCardHandler = provisionStudentIdCardHandler;
export const batchProvisionIdCardsHandler = batchProvisionIdCards;
export const getIdCardTemplateConfig = getCardTemplate;
export const saveIdCardTemplateConfig = updateCardTemplate;

/**
 * PUT /api/admin/parents/:id
 */
export async function updateParent(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const parentId = Number(req.params.id);
  const { name, relation, email, mobileno, address, city, state, occupation } = req.body;

  try {
    const parent = await prisma.parent.findUnique({
      where: { id: parentId },
      select: { id: true, branchId: true, userId: true },
    });

    if (!parent || (parent.branchId && parent.branchId !== branchId)) {
      return res.status(404).json({ success: false, message: 'Parent record not found or access denied.' });
    }

    const updated = await prisma.parent.update({
      where: { id: parentId },
      data: {
        ...(name !== undefined && { name }),
        ...(relation !== undefined && { relation }),
        ...(email !== undefined && { email }),
        ...(mobileno !== undefined && { mobileno }),
        ...(address !== undefined && { address }),
        ...(city !== undefined && { city }),
        ...(state !== undefined && { state }),
        ...(occupation !== undefined && { occupation }),
        updatedAt: new Date(),
      },
    });

    if (parent.userId && email) {
      await prisma.user.update({
        where: { id: parent.userId },
        data: {
          username: email,
        },
      }).catch(() => {});
    }

    return res.json({ success: true, message: 'Parent details updated successfully.', data: updated });
  } catch (error: any) {
    console.error('[ADMIN] Update parent error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to update parent record.' });
  }
}

/**
 * DELETE /api/admin/parents/:id
 */
export async function deleteParent(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const parentId = Number(req.params.id);

  try {
    const parent = await prisma.parent.findUnique({
      where: { id: parentId },
      select: { id: true, branchId: true, userId: true },
    });

    if (!parent || (parent.branchId && parent.branchId !== branchId)) {
      return res.status(404).json({ success: false, message: 'Parent record not found or access denied.' });
    }

    // Unlink any students referencing this parent
    await prisma.student.updateMany({
      where: { parentId },
      data: { parentId: null },
    });

    // Delete sibling requests & messages linked to this parent
    await prisma.parentSiblingRequest.deleteMany({ where: { parentId } }).catch(() => {});
    await prisma.parentMessage.deleteMany({ where: { parentId } }).catch(() => {});

    // Delete parent record
    await prisma.parent.delete({
      where: { id: parentId },
    });

    // Delete user account if associated
    if (parent.userId) {
      await prisma.user.delete({ where: { id: parent.userId } }).catch(() => {});
    }

    return res.json({ success: true, message: 'Parent record deleted successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Delete parent error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to delete parent record.' });
  }
}

/**
 * GET /api/admin/parents/:parentId/messages
 */
export async function getParentMessages(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const parentId = Number(req.params.parentId);

  try {
    const messages = await prisma.parentMessage.findMany({
      where: {
        parentId,
        branchId,
      },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({
      success: true,
      data: messages.map((m) => ({
        id: m.id,
        parentId: m.parentId,
        senderType: m.senderType,
        recipientRole: m.recipientRole,
        subject: m.subject,
        message: m.message,
        isRead: m.isRead,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
    });
  } catch (error: any) {
    console.error('[ADMIN] Get parent messages error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch parent chat messages.' });
  }
}

/**
 * POST /api/admin/parents/:parentId/messages
 */
export async function sendParentMessage(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const parentId = Number(req.params.parentId);
  const { message, subject } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, message: 'Message content is required.' });
  }

  try {
    const parent = await prisma.parent.findUnique({
      where: { id: parentId },
      select: { id: true, branchId: true },
    });

    if (!parent || (parent.branchId && parent.branchId !== branchId)) {
      return res.status(404).json({ success: false, message: 'Parent record not found.' });
    }

    const newMessage = await prisma.parentMessage.create({
      data: {
        branchId,
        parentId,
        senderType: 'ADMIN',
        recipientRole: 'PARENT',
        subject: subject ? subject.trim() : 'EduChat Message',
        message: message.trim(),
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Message sent successfully via EduChat.',
      data: newMessage,
    });
  } catch (error: any) {
    console.error('[ADMIN] Send parent message error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send chat message.' });
  }
}

/**
 * PUT /api/admin/parent-messages/:messageId
 */
export async function updateParentMessage(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const messageId = Number(req.params.messageId);
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, message: 'Updated message content is required.' });
  }

  try {
    const existing = await prisma.parentMessage.findUnique({
      where: { id: messageId },
    });

    if (!existing || existing.branchId !== branchId) {
      return res.status(404).json({ success: false, message: 'Message not found or access denied.' });
    }

    const updated = await prisma.parentMessage.update({
      where: { id: messageId },
      data: {
        message: message.trim(),
        updatedAt: new Date(),
      },
    });

    return res.json({
      success: true,
      message: 'Message updated successfully.',
      data: updated,
    });
  } catch (error: any) {
    console.error('[ADMIN] Update parent message error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update message.' });
  }
}

/**
 * DELETE /api/admin/parent-messages/:messageId
 */
export async function deleteParentMessage(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const messageId = Number(req.params.messageId);

  try {
    const existing = await prisma.parentMessage.findUnique({
      where: { id: messageId },
    });

    if (!existing || existing.branchId !== branchId) {
      return res.status(404).json({ success: false, message: 'Message not found or access denied.' });
    }

    await prisma.parentMessage.delete({
      where: { id: messageId },
    });

    return res.json({
      success: true,
      message: 'Message deleted successfully.',
    });
  } catch (error: any) {
    console.error('[ADMIN] Delete parent message error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete message.' });
  }
}

/**
 * POST /api/admin/parents/broadcast
 */
export async function sendParentBroadcast(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { target = 'all', message, subject = 'School Announcement' } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, message: 'Broadcast message content is required.' });
  }

  try {
    const parents = await prisma.parent.findMany({
      where: { branchId },
      select: { id: true },
    });

    if (parents.length === 0) {
      return res.status(404).json({ success: false, message: 'No parents found to receive broadcast.' });
    }

    const records = parents.map((p) => ({
      branchId,
      parentId: p.id,
      senderType: 'ADMIN',
      recipientRole: 'PARENT',
      subject,
      message: message.trim(),
    }));

    await prisma.parentMessage.createMany({
      data: records,
    });

    return res.status(201).json({
      success: true,
      message: `Broadcast successfully sent to ${parents.length} parents.`,
      count: parents.length,
    });
  } catch (error: any) {
    console.error('[ADMIN] Parent broadcast error:', error);
    return res.status(500).json({ success: false, message: 'Failed to dispatch broadcast message.' });
  }
}

