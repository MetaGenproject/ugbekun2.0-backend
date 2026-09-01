import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma';
import { listStaffForBranch, STAFF_ROLE_LABELS, extractCodePrefix } from '../../lib/branchStats';
import { generateSecurePassword } from '../../lib/studentService';
import { sendTeacherOnboardingCredentials } from '../../lib/emailService';
import { generateCredentialSlipPdf } from '../../lib/pdfService';
import { uploadBase64Image } from '../../lib/cloudinary';

export async function savePhoto(photoBase64?: string | null, folder: string = 'ugbekun2/staff/photos'): Promise<string | null> {
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
 * GET /api/admin/teachers-staff
 */
export async function getTeachersStaff(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const [teachers, staff] = await Promise.all([
      prisma.teacher.findMany({
        where: { branchId },
        orderBy: { name: 'asc' },
        include: {
          allocations: {
            include: {
              class: { select: { id: true, name: true } },
              section: { select: { id: true, name: true } },
            },
          },
          subjectAssigns: {
            include: {
              class: { select: { id: true, name: true } },
              section: { select: { id: true, name: true } },
              subject: { select: { id: true, name: true } },
            },
          },
          _count: { select: { allocations: true } },
        },
      }),
      listStaffForBranch(prisma, branchId),
    ]);

    return res.json({
      success: true,
      data: {
        teachers: teachers.map((teacher) => {
          const allocationsList = teacher.allocations.map((a) => ({
            id: a.id,
            classId: a.classId,
            className: a.class?.name || '',
            sectionId: a.sectionId,
            sectionName: a.section?.name || '',
          }));

          const subjectAssignsList = teacher.subjectAssigns.map((s) => ({
            id: s.id,
            subjectId: s.subjectId,
            subjectName: s.subject?.name || '',
            classId: s.classId,
            className: s.class?.name || '',
            sectionId: s.sectionId,
            sectionName: s.section?.name || '',
          }));

          const firstAlloc = allocationsList[0];
          const firstSubjAssign = subjectAssignsList[0];

          const allocatedClassStr = allocationsList.length > 0
            ? allocationsList.map((a) => `${a.className}${a.sectionName ? ` (${a.sectionName})` : ''}`).join(', ')
            : null;

          const assignedSubjectNames = subjectAssignsList
            .map((s) => s.subjectName)
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(', ');

          const subjectSpecStr = assignedSubjectNames || teacher.department || null;

          return {
            id: teacher.id,
            name: teacher.name,
            email: teacher.email,
            phone: teacher.phone,
            photo: teacher.photo || null,
            qualifications: teacher.qualifications || null,
            houseAddress: teacher.houseAddress || null,
            department: teacher.department || null,
            bankName: teacher.bankName || null,
            accountNumber: teacher.accountNumber || null,
            accountName: teacher.accountName || null,
            active: teacher.active,
            classCount: teacher._count.allocations,
            allocatedClass: allocatedClassStr || 'Unassigned',
            allocatedClassId: firstAlloc?.classId || null,
            allocatedSectionId: firstAlloc?.sectionId || null,
            isClassTeacher: allocationsList.length > 0,
            subjectSpecialization: subjectSpecStr || 'General Subject',
            assignedSubjectId: firstSubjAssign?.subjectId || null,
            assignedSubjectClassId: firstSubjAssign?.classId || null,
            assignedSubjectSectionId: firstSubjAssign?.sectionId || null,
            isSubjectTeacher: subjectAssignsList.length > 0,
            weeklyPeriods: (teacher as any).weeklyPeriods || 18,
            allocationsList,
            subjectAssignsList,
          };
        }),
        staff,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Teachers/staff list error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to load teachers and staff.',
    });
  }
}

/**
 * GET /api/admin/roles
 */
export async function getRoles(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const DEFAULT_SYSTEM_ROLES = [
      { roleCode: 3, name: 'Teacher', description: 'Form teacher or subject instructor', isSystem: true },
      { roleCode: 4, name: 'Accountant', description: 'Finance, fees, and payroll manager', isSystem: true },
      { roleCode: 8, name: 'Receptionist', description: 'Front desk and visitor management', isSystem: true },
      { roleCode: 9, name: 'Proprietor', description: 'School owner and executive oversight', isSystem: true },
      { roleCode: 12, name: 'Librarian', description: 'Library asset and book catalog manager', isSystem: true },
      { roleCode: 13, name: 'Staff', description: 'General administrative & support staff', isSystem: true },
    ];

    const customRoles = await prisma.staffRole.findMany({
      where: { branchId },
      orderBy: { name: 'asc' },
    });

    const allRolesMap = new Map();

    DEFAULT_SYSTEM_ROLES.forEach((r) => {
      allRolesMap.set(r.roleCode, { ...r, id: `sys-${r.roleCode}` });
    });

    customRoles.forEach((r: any) => {
      allRolesMap.set(r.roleCode, {
        id: r.id,
        roleCode: r.roleCode,
        name: r.name,
        description: r.description || null,
        isSystem: false,
        createdAt: r.createdAt,
      });
    });

    const roleList = Array.from(allRolesMap.values());

    const userRoleCounts = await prisma.user.groupBy({
      by: ['role'],
      where: { active: true },
      _count: { role: true },
    });

    const countMap = new Map();
    userRoleCounts.forEach((c: any) => {
      countMap.set(c.role, c._count.role);
    });

    const rolesWithCounts = roleList.map((r: any) => ({
      ...r,
      staffCount: countMap.get(r.roleCode) || 0,
    }));

    return res.json({ success: true, roles: rolesWithCounts });
  } catch (error) {
    console.error('[ADMIN] Fetch roles error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch staff roles.' });
  }
}

/**
 * POST /api/admin/roles
 */
export async function createRole(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Role name is required.' });
    }

    const trimmedName = name.trim();

    const existingRole = await prisma.staffRole.findFirst({
      where: {
        branchId,
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    });

    if (existingRole) {
      return res.status(400).json({ success: false, message: `A role named "${trimmedName}" already exists.` });
    }

    const maxRole = await prisma.staffRole.findFirst({
      orderBy: { roleCode: 'desc' },
      select: { roleCode: true },
    });
    const nextRoleCode = maxRole ? Math.max(maxRole.roleCode + 1, 100) : 100;

    const newRole = await prisma.staffRole.create({
      data: {
        name: trimmedName,
        description: description ? description.trim() : null,
        roleCode: nextRoleCode,
        branchId,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Custom staff role created successfully.',
      role: {
        id: newRole.id,
        roleCode: newRole.roleCode,
        name: newRole.name,
        description: newRole.description,
        isSystem: false,
        staffCount: 0,
        createdAt: newRole.createdAt,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Create role error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create staff role.' });
  }
}

/**
 * PUT /api/admin/roles/:id
 */
export async function updateRole(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { id } = req.params;
    const { name, description } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Role name is required.' });
    }

    const role = await prisma.staffRole.findFirst({
      where: { id: Number(id), branchId },
    });

    if (!role) {
      return res.status(404).json({ success: false, message: 'Role not found or is a protected system role.' });
    }

    const updated = await prisma.staffRole.update({
      where: { id: Number(id) },
      data: {
        name: name.trim(),
        description: description ? description.trim() : null,
      },
    });

    return res.json({
      success: true,
      message: 'Role updated successfully.',
      role: updated,
    });
  } catch (error: any) {
    console.error('[ADMIN] Update role error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update role.' });
  }
}

/**
 * DELETE /api/admin/roles/:id
 */
export async function deleteRole(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { id } = req.params;

    const role = await prisma.staffRole.findFirst({
      where: { id: Number(id), branchId },
    });

    if (!role) {
      return res.status(404).json({ success: false, message: 'Role not found or is a protected system role.' });
    }

    const usersWithRole = await prisma.user.count({
      where: { role: role.roleCode, active: true },
    });

    if (usersWithRole > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete role. There are ${usersWithRole} active staff member(s) assigned to this role.`,
      });
    }

    await prisma.staffRole.delete({
      where: { id: Number(id) },
    });

    return res.json({ success: true, message: 'Custom staff role deleted successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Delete role error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete role.' });
  }
}

/**
 * POST /api/admin/teachers/onboard
 */
export async function onboardTeacher(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const {
      name,
      email,
      phone,
      gender,
      birthday,
      religion,
      bloodGroup,
      houseAddress,
      qualification,
      department,
      designation,
      joiningDate,
      roleCode,
      role,
      classIds,
      subjectIds,
      photo,
      photoBase64,
      bankName,
      accountNumber,
      accountName,
    } = req.body;

    const teacherName = (name || '').trim();
    const teacherEmail = (email || '').trim().toLowerCase();
    const teacherPhone = (phone || '').trim();

    if (!teacherName) {
      return res.status(400).json({ success: false, message: 'Full name is required.' });
    }
    if (!teacherEmail && !teacherPhone) {
      return res.status(400).json({ success: false, message: 'Email or phone number is required.' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true, code: true },
    });

    const photoUrl = await savePhoto(photo || photoBase64, 'ugbekun2/staff/photos');
    const teacherPlainPassword = generateSecurePassword();
    const hashedPassword = await bcrypt.hash(teacherPlainPassword, 10);

    let finalUsername: string | null = null;
    let selectedRole = Number(roleCode || role) || 3;

    const result = await prisma.$transaction(async (tx: any) => {
      let baseUsername = '';
      if (teacherEmail) {
        baseUsername = teacherEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
      } else {
        baseUsername = teacherName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_').slice(0, 15);
      }

      let uniqueUsername = baseUsername;
      let counter = 1;
      while (true) {
        const userCheck = await tx.user.findUnique({ where: { username: uniqueUsername }, select: { id: true } });
        if (!userCheck) break;
        uniqueUsername = `${baseUsername}_${counter++}`;
      }

      finalUsername = uniqueUsername;

      const maxUser = await tx.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      const nextUserId = maxUser ? maxUser.id + 1 : 1;

      const user = await tx.user.create({
        data: {
          id: nextUserId,
          username: uniqueUsername,
          password: hashedPassword,
          rawPassword: teacherPlainPassword,
          photo: photoUrl || null,
          role: selectedRole,
          active: true,
        },
      });

      let teacher = null;
      if (selectedRole === 3) {
        teacher = await tx.teacher.create({
          data: {
            id: user.id,
            name: teacherName,
            email: teacherEmail || null,
            phone: teacherPhone || null,
            houseAddress: houseAddress || null,
            qualifications: qualification || null,
            department: department || designation || null,
            photo: photoUrl || null,
            bankName: bankName || null,
            accountNumber: accountNumber || null,
            accountName: accountName || null,
            active: true,
            branchId,
            userId: user.id,
          },
        });

        const globalSetting = await tx.globalSettings.findFirst();
        const sessionId = globalSetting?.sessionId || 5;

        if (Array.isArray(classIds) && classIds.length > 0) {
          for (const cId of classIds) {
            const secAlloc = await tx.sectionsAllocation.findFirst({
              where: { classId: Number(cId) },
              select: { sectionId: true },
            });
            const secId = secAlloc?.sectionId || 1;
            const maxAlloc = await tx.teacherAllocation.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
            const nextAllocId = maxAlloc ? maxAlloc.id + 1 : 1;
            await tx.teacherAllocation.create({
              data: {
                id: nextAllocId,
                teacherId: teacher.id,
                classId: Number(cId),
                sectionId: secId,
                sessionId,
                branchId,
              },
            }).catch(() => {});
          }
        }

        if (Array.isArray(subjectIds) && subjectIds.length > 0) {
          for (const sId of subjectIds) {
            const targetClassId = Array.isArray(classIds) && classIds[0] ? Number(classIds[0]) : 1;
            const secAlloc = await tx.sectionsAllocation.findFirst({
              where: { classId: targetClassId },
              select: { sectionId: true },
            });
            const secId = secAlloc?.sectionId || 1;
            await tx.subjectAssign.create({
              data: {
                teacherId: teacher.id,
                classId: targetClassId,
                sectionId: secId,
                subjectId: Number(sId),
                sessionId,
                branchId,
              },
            }).catch(() => {});
          }
        }
      } else {
        await tx.payrollComponent.create({
          data: {
            branchId,
            staffId: user.id,
            staffType: 'STAFF',
            staffName: teacherName,
            staffRole: (STAFF_ROLE_LABELS as Record<number, string>)[selectedRole] || 'Staff Member',
            baseSalary: 0,
            housingAllowance: 0,
            transportAllowance: 0,
            medicalAllowance: 0,
            taxDeduction: 0,
            pensionDeduction: 0,
            otherDeductions: 0,
          },
        }).catch(() => {});
      }

      return { user, teacher };
    }, { timeout: 30000, maxWait: 10000 });

    if (teacherEmail) {
      sendTeacherOnboardingCredentials({
        teacherEmail,
        teacherName,
        username: finalUsername!,
        password: teacherPlainPassword,
        schoolName: branch?.name || 'Your School',
        branchCode: branch?.code || '',
        loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
      }).catch((err) => console.warn('[ADMIN] Async teacher onboarding email failed:', err.message));
    }

    let pdfBase64: string | null = null;
    try {
      const pdfBuffer = await generateCredentialSlipPdf({
        schoolName: branch?.name || 'Your School',
        branchCode: branch?.code || '',
        studentName: teacherName,
        studentUsername: finalUsername!,
        studentPassword: teacherPlainPassword,
        loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
      });
      pdfBase64 = Buffer.from(pdfBuffer as any).toString('base64');
    } catch (err: any) {
      console.warn('[ADMIN] Credential PDF slip generation warning:', err?.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Staff member onboarded successfully.',
      pdfBase64,
      credentials: {
        username: finalUsername,
        password: teacherPlainPassword,
      },
      data: {
        user: {
          id: result.user.id,
          username: result.user.username,
          role: result.user.role,
          photo: result.user.photo || null,
        },
        teacher: result.teacher,
        credentials: {
          username: finalUsername,
          password: teacherPlainPassword,
        },
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Teacher/staff onboarding error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to onboard staff member.' });
  }
}

/**
 * PUT /api/admin/teachers/:id
 */
export async function updateTeacher(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);
    const {
      name,
      email,
      phone,
      designation,
      department,
      qualifications,
      houseAddress,
      bankName,
      accountNumber,
      accountName,
      photo,
      photoBase64,
      isClassTeacher,
      classTeacherClassId,
      classTeacherSectionId,
      isSubjectTeacher,
      subjectTeacherClassId,
      subjectTeacherSectionId,
      subjectTeacherSubjectId,
      subjectSpecialization,
      weeklyPeriods,
      subjectAssignments,
      classAllocations,
    } = req.body;

    const teacher = await prisma.teacher.findFirst({
      where: { id, branchId },
    });

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found.' });
    }

    let photoUrl = teacher.photo;
    if (photo || photoBase64) {
      const newPhoto = await savePhoto(photo || photoBase64, 'ugbekun2/staff/photos');
      if (newPhoto) photoUrl = newPhoto;
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    // 1. Handle Class Allocations (TeacherAllocation)
    if (Array.isArray(classAllocations)) {
      await prisma.teacherAllocation.deleteMany({ where: { teacherId: id } });
      let nextId = ((await prisma.teacherAllocation.findFirst({ orderBy: { id: 'desc' } }))?.id || 0) + 1;
      for (const item of classAllocations) {
        if (item.classId && item.sectionId) {
          await prisma.teacherAllocation.create({
            data: {
              id: nextId++,
              teacherId: id,
              classId: Number(item.classId),
              sectionId: Number(item.sectionId),
              sessionId,
              branchId,
            },
          });
        }
      }
    } else if (isClassTeacher === false) {
      await prisma.teacherAllocation.deleteMany({ where: { teacherId: id } });
    } else if (isClassTeacher === true && classTeacherClassId && classTeacherSectionId) {
      const clsId = Number(classTeacherClassId);
      const secId = Number(classTeacherSectionId);
      const existingAlloc = await prisma.teacherAllocation.findFirst({ where: { teacherId: id } });
      if (existingAlloc) {
        await prisma.teacherAllocation.update({
          where: { id: existingAlloc.id },
          data: { classId: clsId, sectionId: secId, sessionId },
        });
      } else {
        const lastAlloc = await prisma.teacherAllocation.findFirst({ orderBy: { id: 'desc' } });
        const nextId = (lastAlloc?.id || 0) + 1;
        await prisma.teacherAllocation.create({
          data: {
            id: nextId,
            teacherId: id,
            classId: clsId,
            sectionId: secId,
            sessionId,
            branchId,
          },
        });
      }
    }

    // 2. Handle Subject Specializations & Assignments (SubjectAssign)
    if (Array.isArray(subjectAssignments)) {
      await prisma.subjectAssign.deleteMany({ where: { teacherId: id } });
      for (const item of subjectAssignments) {
        if (item.subjectId && item.classId && item.sectionId) {
          await prisma.subjectAssign.create({
            data: {
              teacherId: id,
              subjectId: Number(item.subjectId),
              classId: Number(item.classId),
              sectionId: Number(item.sectionId),
              sessionId,
              branchId: branchId || 1,
            },
          });
        }
      }
    } else if (isSubjectTeacher === false) {
      await prisma.subjectAssign.deleteMany({ where: { teacherId: id } });
    } else if (isSubjectTeacher === true && subjectTeacherSubjectId && subjectTeacherClassId && subjectTeacherSectionId) {
      const subId = Number(subjectTeacherSubjectId);
      const clsId = Number(subjectTeacherClassId);
      const secId = Number(subjectTeacherSectionId);

      const existingSubj = await prisma.subjectAssign.findFirst({ where: { teacherId: id } });
      if (existingSubj) {
        await prisma.subjectAssign.update({
          where: { id: existingSubj.id },
          data: { subjectId: subId, classId: clsId, sectionId: secId, sessionId, branchId: branchId || existingSubj.branchId },
        });
      } else {
        await prisma.subjectAssign.create({
          data: {
            teacherId: id,
            subjectId: subId,
            classId: clsId,
            sectionId: secId,
            sessionId,
            branchId: branchId || 1,
          },
        });
      }
    }

    // 3. Handle Weekly Periods
    if (weeklyPeriods !== undefined && !isNaN(Number(weeklyPeriods))) {
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE teachers SET weekly_periods = $1 WHERE id = $2`,
          Number(weeklyPeriods),
          id
        );
      } catch (err) {
        console.error('[ADMIN] Failed to update weekly_periods:', err);
      }
    }

    const updatedDept = department || subjectSpecialization || teacher.department;

    const updated = await prisma.teacher.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(email !== undefined && { email: email.trim().toLowerCase() }),
        ...(phone !== undefined && { phone: phone.trim() }),
        ...(designation !== undefined && { designation: designation.trim() }),
        ...(updatedDept !== undefined && { department: updatedDept.trim() }),
        ...(qualifications !== undefined && { qualifications: qualifications.trim() }),
        ...(houseAddress !== undefined && { houseAddress: houseAddress.trim() }),
        ...(bankName !== undefined && { bankName: bankName.trim() }),
        ...(accountNumber !== undefined && { accountNumber: accountNumber.trim() }),
        ...(accountName !== undefined && { accountName: accountName.trim() }),
        ...(photoUrl !== undefined && { photo: photoUrl }),
      },
    });

    return res.json({
      success: true,
      message: 'Teacher profile updated successfully.',
      teacher: updated,
    });
  } catch (error: any) {
    console.error('[ADMIN] Update teacher error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update teacher.' });
  }
}

/**
 * DELETE /api/admin/teachers/:id
 */
export async function deleteTeacher(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);

    const teacher = await prisma.teacher.findFirst({
      where: { id, branchId },
    });

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found.' });
    }

    await prisma.$transaction([
      prisma.teacherAllocation.deleteMany({ where: { teacherId: id } }),
      prisma.subjectAssign.deleteMany({ where: { teacherId: id } }),
      prisma.staffAttendance.deleteMany({ where: { teacherId: id } }),
      prisma.timetableSlot.deleteMany({ where: { teacherId: id } }),
      prisma.lessonPlan.deleteMany({ where: { teacherId: id } }),
      prisma.teacher.delete({ where: { id } }),
      prisma.user.deleteMany({ where: { id: teacher.userId || id } }),
    ]);

    return res.json({ success: true, message: 'Teacher record deleted successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Delete teacher error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete teacher.' });
  }
}

/**
 * POST /api/admin/teachers/:id/upload-photo
 */
export async function uploadTeacherPhoto(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);
    const teacher = await prisma.teacher.findFirst({
      where: { id, branchId },
    });

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found.' });
    }

    let photoUrl: string | null = null;

    if (req.file) {
      const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      photoUrl = await savePhoto(base64, 'ugbekun2/staff/photos');
    } else if (req.body.photo || req.body.photoBase64) {
      photoUrl = await savePhoto(req.body.photo || req.body.photoBase64, 'ugbekun2/staff/photos');
    }

    if (!photoUrl) {
      return res.status(400).json({ success: false, message: 'No photo provided.' });
    }

    const updated = await prisma.teacher.update({
      where: { id },
      data: { photo: photoUrl },
    });

    if (teacher.userId) {
      await prisma.user.update({
        where: { id: teacher.userId },
        data: { photo: photoUrl },
      }).catch(() => {});
    }

    return res.json({
      success: true,
      message: 'Photo uploaded successfully.',
      photo: updated.photo,
    });
  } catch (error: any) {
    console.error('[ADMIN] Upload teacher photo error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload photo.' });
  }
}

/**
 * POST /api/admin/staff/:id/upload-photo
 */
export async function uploadStaffPhoto(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Staff user not found.' });
    }

    let photoUrl: string | null = null;

    if (req.file) {
      const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      photoUrl = await savePhoto(base64, 'ugbekun2/staff/photos');
    } else if (req.body.photo || req.body.photoBase64) {
      photoUrl = await savePhoto(req.body.photo || req.body.photoBase64, 'ugbekun2/staff/photos');
    }

    if (!photoUrl) {
      return res.status(400).json({ success: false, message: 'No photo provided.' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { photo: photoUrl },
    });

    // Also sync to teacher profile if one exists for this user
    await prisma.teacher.updateMany({
      where: { OR: [{ userId: id }, { id }] },
      data: { photo: photoUrl },
    }).catch(() => {});

    return res.json({
      success: true,
      message: 'Staff photo uploaded successfully.',
      photo: updated.photo,
    });
  } catch (error: any) {
    console.error('[ADMIN] Upload staff photo error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload photo.' });
  }
}

/**
 * POST /api/admin/teachers/:id/toggle-status
 */
export async function toggleTeacherStatus(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = Number(req.params.id);
    const teacher = await prisma.teacher.findFirst({
      where: { id, branchId },
    });

    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found.' });
    }

    const updated = await prisma.teacher.update({
      where: { id },
      data: { active: !teacher.active },
    });

    if (teacher.userId) {
      await prisma.user.update({
        where: { id: teacher.userId },
        data: { active: updated.active },
      }).catch(() => {});
    }

    return res.json({ success: true, active: updated.active, message: `Teacher status updated to ${updated.active ? 'active' : 'inactive'}.` });
  } catch (error: any) {
    console.error('[ADMIN] Toggle teacher status error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to toggle teacher status.' });
  }
}

/**
 * POST /api/admin/staff/:id/toggle-status
 */
export async function toggleStaffStatus(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Staff user not found.' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { active: !user.active },
    });

    return res.json({ success: true, active: updated.active, message: `Staff status updated to ${updated.active ? 'active' : 'inactive'}.` });
  } catch (error: any) {
    console.error('[ADMIN] Toggle staff status error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to toggle staff status.' });
  }
}

/**
 * PUT /api/admin/staff/:id
 */
export async function updateStaff(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const { name, username, email, phone, mobileno, department, role, roleLabel } = req.body;

    const contactPhone = phone || mobileno;
    const staffName = name || username;

    const roleMapRev: Record<string, number> = {
      'Bursar': 4,
      'Receptionist': 8,
      'HR Officer': 9,
      'Librarian': 12,
      'Staff': 13,
      'Security Personnel': 13,
      'Maintenance Officer': 13,
      'Driver': 13,
      'Laboratory Officer': 12,
      'ICT Officer': 12,
    };

    const newRoleCode = roleLabel ? roleMapRev[roleLabel] : (typeof role === 'number' ? role : undefined);

    await prisma.$executeRawUnsafe(
      `UPDATE users SET 
        username = COALESCE($1, username),
        email = $2,
        phone = $3,
        department = $4
        ${newRoleCode ? `, role = ${newRoleCode}` : ''}
       WHERE id = $5`,
      staffName || null,
      email || null,
      contactPhone || null,
      department || null,
      id
    );

    return res.json({
      success: true,
      message: 'Staff record updated successfully.',
    });
  } catch (error: any) {
    console.error('[ADMIN] Update staff error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to update staff record.' });
  }
}

/**
 * GET /api/admin/staff-messages
 */
export async function getStaffMessages(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const recipientId = req.query.recipientId ? Number(req.query.recipientId) : null;

  try {
    let sql = `SELECT id, branch_id AS "branchId", sender_id AS "senderId", sender_type AS "senderType", recipient_id AS "recipientId", target_department AS "targetDepartment", subject, message, is_memo AS "isMemo", created_at AS "createdAt" FROM staff_messages WHERE branch_id = $1`;
    const params: any[] = [branchId];

    if (recipientId) {
      sql += ` AND (recipient_id = $2 OR is_memo = true)`;
      params.push(recipientId);
    }
    sql += ` ORDER BY created_at ASC`;

    const messages = await prisma.$queryRawUnsafe(sql, ...params);

    return res.json({
      success: true,
      messages,
    });
  } catch (error: any) {
    console.error('[ADMIN] Get staff messages error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to fetch staff messages.' });
  }
}

/**
 * POST /api/admin/staff-messages
 */
export async function sendStaffMessage(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { recipientId, targetDepartment, subject, message, isMemo } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, message: 'Message content is required.' });
  }

  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_messages (branch_id, sender_id, sender_type, recipient_id, target_department, subject, message, is_memo)
       VALUES ($1, $2, 'admin', $3, $4, $5, $6, $7)`,
      branchId,
      (req as any).user?.id || 1,
      recipientId ? Number(recipientId) : null,
      targetDepartment || null,
      subject || null,
      message.trim(),
      Boolean(isMemo)
    );

    return res.json({
      success: true,
      message: isMemo ? 'Staff memo dispatched successfully.' : 'Message sent successfully.',
    });
  } catch (error: any) {
    console.error('[ADMIN] Send staff message error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to send message.' });
  }
}
