import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma';
import { uploadBase64Image } from '../../lib/cloudinary';

export async function savePhoto(photoBase64?: string | null, folder: string = 'ugbekun2/parents/photos'): Promise<string | null> {
  if (!photoBase64) return null;
  try {
    const uploadedUrl = await uploadBase64Image(photoBase64, folder);
    if (uploadedUrl) return uploadedUrl;
  } catch (err: any) {
    console.warn(`[PARENT PHOTO UPLOAD] Cloudinary upload unavailable for ${folder}, using fallback:`, err?.message);
  }
  if (photoBase64.startsWith('data:image/') || photoBase64.startsWith('http://') || photoBase64.startsWith('https://')) {
    return photoBase64;
  }
  return null;
}

/**
 * Middleware security guard to check if requested student is linked to the parent
 */
export async function assertChildLinked(req: Request, res: Response, next: NextFunction): Promise<void> {
  const studentId = parseInt(String(req.params?.studentId || req.query?.studentId || ''), 10);
  if (isNaN(studentId)) {
    res.status(400).json({ success: false, message: 'Invalid Student ID provided.' });
    return;
  }

  try {
    const student = await prisma.student.findFirst({
      where: {
        id: studentId,
        parentId: req.parentId,
      },
      include: {
        enrolls: {
          orderBy: { id: 'desc' },
          take: 1,
        },
      },
    });

    if (!student) {
      res.status(403).json({ success: false, message: 'Access denied: Student is not linked to this parent.' });
      return;
    }

    req.studentId = student.id;
    req.studentBranchId = student.branchId;

    const activeEnroll = student.enrolls[0];
    if (activeEnroll) {
      req.childClassId = activeEnroll.classId;
      req.childSectionId = activeEnroll.sectionId;
      req.childSessionId = activeEnroll.sessionId;
    } else {
      req.childClassId = null;
      req.childSectionId = null;
      req.childSessionId = 5;
    }

    next();
  } catch (error) {
    console.error('[PARENT] assertChildLinked error:', error);
    res.status(500).json({ success: false, message: 'Internal validation error.' });
  }
}

/**
 * GET /api/parent/children
 */
export async function getChildren(req: Request, res: Response): Promise<Response | void> {
  try {
    const children = await prisma.student.findMany({
      where: {
        parentId: req.parentId,
        active: true,
      },
      include: {
        enrolls: {
          include: {
            class: { select: { name: true } },
            section: { select: { name: true } },
          },
          orderBy: { id: 'desc' },
          take: 1,
        },
      },
    });

    const formatted = children.map((child) => {
      const enroll = child.enrolls[0] || null;
      return {
        id: child.id,
        registerNo: child.registerNo,
        firstName: child.firstName,
        lastName: child.lastName,
        photo: child.photo,
        className: enroll?.class?.name || 'Not Enrolled',
        sectionName: enroll?.section?.name || 'N/A',
      };
    });

    return res.json({ success: true, children: formatted });
  } catch (error) {
    console.error('[PARENT] Fetch children error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve children records.' });
  }
}

/**
 * GET /api/parent/child/:studentId/profile
 */
export async function getChildProfile(req: Request, res: Response): Promise<Response | void> {
  try {
    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: {
        branch: { select: { name: true, code: true } },
      },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Child record not found.' });
    }

    let classInfo = null;
    let sectionInfo = null;
    let fellowStudentsCount = 0;
    let formTeacher = null;
    let subjects: any[] = [];

    if (req.childClassId && req.childSectionId) {
      classInfo = await prisma.class.findUnique({ where: { id: req.childClassId }, select: { name: true } });
      sectionInfo = await prisma.section.findUnique({ where: { id: req.childSectionId }, select: { name: true } });

      fellowStudentsCount = await prisma.enroll.count({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
      });

      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
        include: {
          teacher: { select: { name: true, email: true, phone: true } },
        },
      });
      formTeacher = formAllocation?.teacher || null;

      const subjectAssigns = await prisma.subjectAssign.findMany({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
        include: {
          subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } },
        },
      });
      subjects = subjectAssigns.map((sa) => ({
        id: sa.subject.id,
        name: sa.subject.name,
        code: sa.subject.subjectCode,
        type: sa.subject.subjectType,
      }));
    }

    return res.json({
      success: true,
      studentId: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      registerNo: student.registerNo,
      gender: student.gender,
      photo: student.photo,
      branchName: student.branch?.name || null,
      classId: req.childClassId || null,
      className: classInfo?.name || null,
      sectionId: req.childSectionId || null,
      sectionName: sectionInfo?.name || null,
      sessionId: req.childSessionId,
      fellowStudentsCount,
      formTeacher,
      subjects,
    });
  } catch (error) {
    console.error('[PARENT] Child profile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve child profile details.' });
  }
}

/**
 * GET /api/parent/child/:studentId/teachers
 */
export async function getChildTeachers(req: Request, res: Response): Promise<Response | void> {
  if (!req.childClassId) {
    return res.json({ success: true, formTeacher: null, subjectTeachers: [] });
  }

  try {
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: {
        classId: req.childClassId,
        sectionId: req.childSectionId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
      },
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            photo: true,
            department: true,
            qualifications: true,
          },
        },
      },
    });

    const subjectAssigns = await prisma.subjectAssign.findMany({
      where: {
        classId: req.childClassId,
        sectionId: req.childSectionId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
      },
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            photo: true,
            department: true,
          },
        },
        subject: { select: { id: true, name: true, subjectCode: true } },
      },
    });

    const teacherMap = new Map();
    subjectAssigns.forEach((sa) => {
      if (!sa.teacher) return;
      const tid = sa.teacher.id;
      if (!teacherMap.has(tid)) {
        teacherMap.set(tid, {
          id: sa.teacher.id,
          name: sa.teacher.name,
          email: sa.teacher.email,
          phone: sa.teacher.phone,
          photo: sa.teacher.photo,
          department: sa.teacher.department,
          subjects: [],
        });
      }
      teacherMap.get(tid).subjects.push({
        id: sa.subject.id,
        name: sa.subject.name,
        code: sa.subject.subjectCode,
      });
    });

    return res.json({
      success: true,
      formTeacher: formAllocation?.teacher || null,
      subjectTeachers: Array.from(teacherMap.values()),
    });
  } catch (error) {
    console.error('[PARENT] Get child teachers error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve teachers directory.' });
  }
}

/**
 * GET /api/parent/messages
 */
export async function getMessages(req: Request, res: Response): Promise<Response | void> {
  try {
    const messages = await prisma.parentMessage.findMany({
      where: {
        parentId: req.parentId,
        branchId: req.branchId,
      },
      include: {
        student: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      success: true,
      messages: messages.map((m) => ({
        id: m.id,
        senderType: m.senderType,
        recipientRole: m.recipientRole,
        subject: m.subject,
        message: m.message,
        isRead: m.isRead,
        childName: m.student ? `${m.student.firstName} ${m.student.lastName}` : null,
        createdAt: m.createdAt,
      })),
    });
  } catch (error) {
    console.error('[PARENT] Get messages error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch messages.' });
  }
}

/**
 * POST /api/parent/messages
 */
export async function sendMessage(req: Request, res: Response): Promise<Response | void> {
  try {
    const { studentId, recipientRole = 'TEACHER', recipientId, subject, message } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message content is required.' });
    }

    const newMessage = await prisma.parentMessage.create({
      data: {
        parentId: req.parentId,
        branchId: req.branchId,
        studentId: studentId ? Number(studentId) : null,
        recipientId: recipientId ? Number(recipientId) : null,
        recipientRole,
        senderType: 'PARENT',
        subject: subject ? subject.trim() : 'Parent Inquiry',
        message: message.trim(),
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Message sent successfully.',
      data: newMessage,
    });
  } catch (error) {
    console.error('[PARENT] Post message error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send message.' });
  }
}

/**
 * GET /api/parent/profile
 */
export async function getProfile(req: Request, res: Response): Promise<Response | void> {
  try {
    const parent = await prisma.parent.findUnique({
      where: { id: req.parentId },
      include: {
        user: { select: { username: true } },
        branch: { select: { name: true, code: true } },
      },
    });

    if (!parent) {
      return res.status(404).json({ success: false, message: 'Parent profile not found.' });
    }

    return res.json({
      success: true,
      parent: {
        id: parent.id,
        username: parent.user?.username || '',
        name: parent.name,
        relation: parent.relation,
        fatherName: parent.fatherName,
        motherName: parent.motherName,
        occupation: parent.occupation,
        education: parent.education,
        income: parent.income,
        email: parent.email,
        mobileno: parent.mobileno,
        address: parent.address,
        city: parent.city,
        state: parent.state,
        photo: parent.photo,
        branchName: parent.branch?.name || null,
      },
    });
  } catch (error) {
    console.error('[PARENT] Get profile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve profile.' });
  }
}

/**
 * PUT /api/parent/profile
 */
export async function updateProfile(req: Request, res: Response): Promise<Response | void> {
  try {
    const { name, email, mobileno, address, city, state, occupation, education, fatherName, motherName } =
      req.body || {};

    const updated = await prisma.parent.update({
      where: { id: req.parentId },
      data: {
        ...(name ? { name: name.trim() } : {}),
        ...(email ? { email: email.trim() } : {}),
        ...(mobileno ? { mobileno: mobileno.trim() } : {}),
        ...(address ? { address: address.trim() } : {}),
        ...(city ? { city: city.trim() } : {}),
        ...(state ? { state: state.trim() } : {}),
        ...(occupation ? { occupation: occupation.trim() } : {}),
        ...(education ? { education: education.trim() } : {}),
        ...(fatherName ? { fatherName: fatherName.trim() } : {}),
        ...(motherName ? { motherName: motherName.trim() } : {}),
        updatedAt: new Date(),
      },
    });

    return res.json({ success: true, message: 'Profile updated successfully.', parent: updated });
  } catch (error) {
    console.error('[PARENT] Update profile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update profile.' });
  }
}

/**
 * POST /api/parent/profile/upload-photo
 */
export async function uploadParentPhoto(req: Request, res: Response): Promise<Response | void> {
  try {
    const { photoBase64, photo } = req.body || {};
    const inputPhoto = photoBase64 || photo;
    if (!inputPhoto) {
      return res.status(400).json({ success: false, message: 'Photograph data is required.' });
    }

    const photoUrl = await savePhoto(inputPhoto, 'ugbekun2/parents/photos');

    const updated = await prisma.parent.update({
      where: { id: req.parentId },
      data: { photo: photoUrl },
      select: { id: true, name: true, photo: true },
    });

    if (req.user?.id) {
      await prisma.user
        .update({
          where: { id: req.user.id },
          data: { photo: photoUrl },
        })
        .catch(() => null);
    }

    return res.json({
      success: true,
      message: 'Profile photograph updated successfully.',
      photo: updated.photo,
      parent: updated,
    });
  } catch (error: any) {
    console.error('[PARENT] Profile photo upload error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update photo.' });
  }
}

/**
 * POST /api/parent/child/:studentId/upload-photo
 */
export async function uploadChildPhoto(req: Request, res: Response): Promise<Response | void> {
  try {
    const studentId = Number(req.params.studentId);
    const { photoBase64, photo } = req.body || {};
    const inputPhoto = photoBase64 || photo;
    if (!inputPhoto) {
      return res.status(400).json({ success: false, message: 'Photograph data is required.' });
    }

    const student = await prisma.student.findFirst({
      where: { id: studentId, parentId: req.parentId },
      select: { id: true, userId: true, firstName: true, lastName: true },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Child record not found under your account.' });
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
        .catch(() => null);
    }

    return res.json({
      success: true,
      message: `${student.firstName}'s photograph updated successfully.`,
      photo: updated.photo,
      student: updated,
    });
  } catch (error: any) {
    console.error('[PARENT] Child photo upload error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update child photo.' });
  }
}

/**
 * PUT /api/parent/change-password
 */
export async function changePassword(req: Request, res: Response): Promise<Response | void> {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new passwords are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters long.' });
    }

    const parent = await prisma.parent.findUnique({
      where: { id: req.parentId },
      select: { userId: true },
    });

    if (!parent || !parent.userId) {
      return res.status(400).json({ success: false, message: 'User credential not linked to parent profile.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: parent.userId },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User record not found.' });
    }

    const isValid = bcrypt.compareSync(currentPassword, user.password);
    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Current password provided is incorrect.' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    await prisma.user.update({
      where: { id: parent.userId },
      data: {
        password: hashedPassword,
        updatedAt: new Date(),
      },
    });

    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    console.error('[PARENT] Change password error:', error);
    return res.status(500).json({ success: false, message: 'Failed to change password.' });
  }
}
