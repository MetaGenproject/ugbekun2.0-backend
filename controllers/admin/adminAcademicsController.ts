import { Request, Response } from 'express';
import OpenAI from 'openai';
import prisma from '../../lib/prisma';
import { bindEvaluationMatrix, wipeEvaluationMatrix } from '../../lib/studentService';
import { generateLessonPlanPdf } from '../../lib/pdfService';

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'dummy-key',
  baseURL: 'https://api.deepseek.com',
});

/**
 * GET /api/admin/classes-sections
 */
export async function getClassesSections(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const classes = await prisma.class.findMany({
      where: { branchId },
      include: {
        sections: {
          include: {
            section: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const sections = await prisma.section.findMany({
      where: { branchId },
      orderBy: { name: 'asc' },
    });

    return res.json({ success: true, classes, sections });
  } catch (error) {
    console.error('[ADMIN] Get classes-sections error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load classes and sections.' });
  }
}

/**
 * POST /api/admin/classes
 */
export async function createClass(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, nameNumeric, isEcd } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Class name is required.' });
    }

    const newClass = await prisma.class.create({
      data: {
        name,
        nameNumeric: nameNumeric || '',
        isEcd: !!isEcd,
        branchId,
      },
    });

    return res.status(201).json({ success: true, class: newClass });
  } catch (error) {
    console.error('[ADMIN] Create class error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create class.' });
  }
}

/**
 * POST /api/admin/classes/seed-preset
 */
export async function seedClassPreset(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const body = req.body || {};
    const category = (body.category || 'combined_k12').toLowerCase();

    let presetClasses: Array<{ name: string; isEcd: boolean }> = [];
    if (category === 'nursery_primary' || category === 'primary') {
      presetClasses = [
        { name: 'Nursery 1', isEcd: true },
        { name: 'Nursery 2', isEcd: true },
        { name: 'Primary 1', isEcd: false },
        { name: 'Primary 2', isEcd: false },
        { name: 'Primary 3', isEcd: false },
        { name: 'Primary 4', isEcd: false },
        { name: 'Primary 5', isEcd: false },
        { name: 'Primary 6', isEcd: false },
      ];
    } else if (category === 'secondary_only' || category === 'secondary') {
      presetClasses = [
        { name: 'JSS 1', isEcd: false },
        { name: 'JSS 2', isEcd: false },
        { name: 'JSS 3', isEcd: false },
        { name: 'SSS 1', isEcd: false },
        { name: 'SSS 2', isEcd: false },
        { name: 'SSS 3', isEcd: false },
      ];
    } else {
      presetClasses = [
        { name: 'Nursery 1', isEcd: true },
        { name: 'Nursery 2', isEcd: true },
        { name: 'Primary 1', isEcd: false },
        { name: 'Primary 2', isEcd: false },
        { name: 'Primary 3', isEcd: false },
        { name: 'Primary 4', isEcd: false },
        { name: 'Primary 5', isEcd: false },
        { name: 'Primary 6', isEcd: false },
        { name: 'JSS 1', isEcd: false },
        { name: 'JSS 2', isEcd: false },
        { name: 'JSS 3', isEcd: false },
        { name: 'SSS 1', isEcd: false },
        { name: 'SSS 2', isEcd: false },
        { name: 'SSS 3', isEcd: false },
      ];
    }

    const defaultSections = ['A (Gold)', 'B (Silver)'];
    const createdClasses: any[] = [];

    await prisma.$transaction(async (tx: any) => {
      const sectionMap: Record<string, number> = {};
      for (const secName of defaultSections) {
        let sec = await tx.section.findFirst({
          where: { name: secName, branchId },
        });
        if (!sec) {
          sec = await tx.section.create({
            data: { name: secName, capacity: '40', branchId },
          });
        }
        sectionMap[secName] = sec.id;
      }

      for (const item of presetClasses) {
        let cls = await tx.class.findFirst({
          where: { name: item.name, branchId },
        });
        if (!cls) {
          cls = await tx.class.create({
            data: {
              name: item.name,
              nameNumeric: item.name.replace(/\D/g, '') || '1',
              isEcd: item.isEcd,
              branchId,
            },
          });
        }

        for (const secName of defaultSections) {
          const secId = sectionMap[secName];
          if (secId) {
            const existingAlloc = await tx.sectionsAllocation.findFirst({
              where: { classId: cls.id, sectionId: secId },
            });
            if (!existingAlloc) {
              await tx.sectionsAllocation.create({
                data: {
                  classId: cls.id,
                  sectionId: secId,
                },
              });
            }
          }
        }
        createdClasses.push(cls);
      }
    }, { timeout: 30000, maxWait: 10000 });

    return res.status(200).json({
      success: true,
      message: `Seeded ${createdClasses.length} classes and sections for category "${category}".`,
      classesCount: createdClasses.length,
    });
  } catch (error: any) {
    console.error('[ADMIN] Seed class preset error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to seed class presets.' });
  }
}

/**
 * POST /api/admin/classes/toggle-ecd
 */
export async function toggleECD(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, isEcd } = req.body;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const updatedClass = await prisma.class.update({
      where: { id: Number(classId), branchId },
      data: { isEcd: !!isEcd },
    });

    return res.json({
      success: true,
      class: updatedClass,
      message: 'Class ECD status updated successfully.',
    });
  } catch (error) {
    console.error('[ADMIN] Toggle class ECD error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update class ECD status.' });
  }
}

/**
 * POST /api/admin/sections
 */
export async function createSection(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, capacity, classId } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Section name is required.' });
    }

    const newSection = await prisma.section.create({
      data: {
        name,
        capacity: capacity ? String(capacity) : '',
        branchId,
      },
    });

    if (classId) {
      await prisma.sectionsAllocation
        .create({
          data: {
            classId: Number(classId),
            sectionId: newSection.id,
          },
        })
        .catch(() => {});
    }

    return res.status(201).json({ success: true, section: newSection });
  } catch (error) {
    console.error('[ADMIN] Create section error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create section.' });
  }
}

/**
 * POST /api/admin/classes/allocate-sections
 */
export async function allocateSections(req: Request, res: Response): Promise<Response | void> {
  try {
    const { classId, sectionIds } = req.body;
    if (!classId || !Array.isArray(sectionIds)) {
      return res.status(400).json({ success: false, message: 'Invalid payload: classId and sectionIds array required.' });
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.sectionsAllocation.deleteMany({
        where: { classId },
      });

      if (sectionIds.length > 0) {
        await tx.sectionsAllocation.createMany({
          data: sectionIds.map((sid: number) => ({
            classId,
            sectionId: sid,
          })),
        });
      }
    });

    return res.json({ success: true, message: 'Sections allocated successfully.' });
  } catch (error) {
    console.error('[ADMIN] Allocate sections error:', error);
    return res.status(500).json({ success: false, message: 'Failed to allocate sections.' });
  }
}

/**
 * GET /api/admin/subjects
 */
export async function getSubjects(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const subjects = await prisma.subject.findMany({
      where: { branchId },
      orderBy: { name: 'asc' },
    });

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const assignments = await prisma.subjectAssign.findMany({
      where: { branchId, sessionId },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        teacher: { select: { id: true, name: true } },
      },
    });

    return res.json({ success: true, subjects, assignments });
  } catch (error) {
    console.error('[ADMIN] Get subjects error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load subjects.' });
  }
}

/**
 * POST /api/admin/subjects
 */
export async function createSubject(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, subjectCode, subjectType, subjectAuthor } = req.body;
    if (!name || !subjectCode) {
      return res.status(400).json({ success: false, message: 'Name and Subject Code are required.' });
    }

    const newSubject = await prisma.subject.create({
      data: {
        name,
        subjectCode,
        subjectType: subjectType || 'Mandatory',
        subjectAuthor: subjectAuthor || '',
        branchId,
      },
    });

    return res.status(201).json({ success: true, subject: newSubject });
  } catch (error) {
    console.error('[ADMIN] Create subject error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create subject.' });
  }
}

/**
 * POST /api/admin/subjects/assign
 */
export async function assignSubject(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, subjectId, teacherId } = req.body;
    if (!classId || !sectionId || !subjectId || !teacherId) {
      return res.status(400).json({ success: false, message: 'Class, Section, Subject and Teacher are required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const existing = await prisma.subjectAssign.findFirst({
      where: {
        classId,
        sectionId,
        subjectId,
        branchId,
        sessionId,
      },
    });

    if (existing) {
      const updated = await prisma.subjectAssign.update({
        where: { id: existing.id },
        data: { teacherId },
      });
      return res.json({ success: true, assignment: updated, message: 'Subject assignment teacher updated.' });
    }

    const newAssign = await prisma.subjectAssign.create({
      data: {
        classId,
        sectionId,
        subjectId,
        teacherId,
        branchId,
        sessionId,
      },
    });

    return res.status(201).json({ success: true, assignment: newAssign, message: 'Subject assigned successfully.' });
  } catch (error) {
    console.error('[ADMIN] Assign subject error:', error);
    return res.status(500).json({ success: false, message: 'Failed to assign subject.' });
  }
}

/**
 * POST /api/admin/subjects/assign-bulk
 */
export async function assignSubjectBulk(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, assignments } = req.body;
    if (!classId || !sectionId || !Array.isArray(assignments)) {
      return res.status(400).json({ success: false, message: 'Class, Section, and Assignments are required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    await prisma.$transaction(async (tx: any) => {
      for (const item of assignments) {
        const { subjectId, teacherId } = item;
        if (!subjectId || !teacherId) continue;

        const existing = await tx.subjectAssign.findFirst({
          where: {
            classId,
            sectionId,
            subjectId,
            branchId,
            sessionId,
          },
        });

        if (existing) {
          await tx.subjectAssign.update({
            where: { id: existing.id },
            data: { teacherId },
          });
        } else {
          await tx.subjectAssign.create({
            data: {
              classId,
              sectionId,
              subjectId,
              teacherId,
              branchId,
              sessionId,
            },
          });
        }
      }
    });

    return res.json({ success: true, message: 'Bulk subject assignments saved successfully.' });
  } catch (error) {
    console.error('[ADMIN] Bulk assign subject error:', error);
    return res.status(500).json({ success: false, message: 'Failed to complete bulk subject assignment.' });
  }
}

/**
 * GET /api/admin/attendance/students
 */
export async function getStudentAttendance(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, date } = req.query;
    if (!classId) {
      return res.status(400).json({ success: false, message: 'classId query parameter is required.' });
    }

    const cId = Number(classId);
    const secId = sectionId ? Number(sectionId) : null;

    let targetDate;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date as string)) {
      const [y, m, d] = (date as string).split('-').map(Number);
      targetDate = new Date(y, m - 1, d, 0, 0, 0, 0);
    } else {
      targetDate = new Date();
      targetDate.setHours(0, 0, 0, 0);
    }

    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);

    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSession = globalSetting?.sessionId || 1;

    const enrolls = await prisma.enroll.findMany({
      where: {
        branchId,
        classId: cId,
        ...(secId ? { sectionId: secId } : {}),
        sessionId: activeSession,
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
          },
        },
        section: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: [{ roll: 'asc' }],
    });

    const students = enrolls.map((e) => ({
      id: e.student.id,
      name: [e.student.firstName, e.student.lastName].filter(Boolean).join(' ') || `Student #${e.student.id}`,
      roll: e.roll ? String(e.roll) : null,
      registerNo: e.student.registerNo,
      sectionName: e.section?.name,
    }));

    const attendanceRecords = await prisma.attendance.findMany({
      where: {
        branchId,
        classId: cId,
        ...(secId ? { sectionId: secId } : {}),
        attendanceDate: {
          gte: targetDate,
          lt: nextDate,
        },
      },
    });

    const attendanceMap: Record<number, any> = {};
    let presentCount = 0;
    let absentCount = 0;
    let lateCount = 0;
    let excusedCount = 0;

    attendanceRecords.forEach((att: any) => {
      attendanceMap[att.studentId] = {
        id: att.id,
        status: att.status ? att.status.toUpperCase() : 'PRESENT',
        remark: att.remark,
      };

      const st = (att.status || '').toUpperCase();
      if (st === 'PRESENT' || st === 'H' || st === '1') presentCount++;
      else if (st === 'ABSENT' || st === 'A') absentCount++;
      else if (st === 'LATE' || st === 'L') lateCount++;
      else if (st === 'EXCUSED' || st === 'E') excusedCount++;
      else presentCount++;
    });

    const totalEnrolled = students.length;
    const attendanceRate =
      totalEnrolled > 0 ? Math.round(((presentCount + lateCount) / totalEnrolled) * 100) : 0;

    return res.json({
      success: true,
      students,
      attendanceMap,
      metrics: {
        totalEnrolled,
        presentCount,
        absentCount,
        lateCount,
        excusedCount,
        attendanceRate,
      },
    });
  } catch (error) {
    console.error('[ADMIN] Fetch student attendance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch student attendance.' });
  }
}

/**
 * POST /api/admin/attendance/students/batch-save
 */
export async function saveStudentAttendanceBatch(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, date, attendance } = req.body;

    if (!classId || !date || !Array.isArray(attendance)) {
      return res.status(400).json({ success: false, message: 'Invalid payload.' });
    }

    const cId = Number(classId);
    const secId = sectionId ? Number(sectionId) : null;

    let targetDate;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date as string)) {
      const [y, m, d] = (date as string).split('-').map(Number);
      targetDate = new Date(y, m - 1, d, 0, 0, 0, 0);
    } else {
      targetDate = new Date();
      targetDate.setHours(0, 0, 0, 0);
    }

    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);

    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSession = globalSetting?.sessionId || 1;

    let savedCount = 0;

    for (const item of attendance) {
      if (!item.studentId) continue;
      const sId = Number(item.studentId);
      const statusStr = item.status ? String(item.status).toUpperCase() : 'PRESENT';
      const remarkStr = item.remark ? String(item.remark).trim() : null;

      const existing = await prisma.attendance.findFirst({
        where: {
          branchId,
          classId: cId,
          studentId: sId,
          attendanceDate: {
            gte: targetDate,
            lt: nextDate,
          },
        },
      });

      if (existing) {
        await prisma.attendance.update({
          where: { id: existing.id },
          data: {
            status: statusStr,
            remark: remarkStr,
          },
        });
      } else {
        await prisma.attendance.create({
          data: {
            branchId,
            classId: cId,
            sectionId: secId || 1,
            studentId: sId,
            attendanceDate: targetDate,
            status: statusStr,
            remark: remarkStr,
            sessionId: activeSession,
          },
        });
      }
      savedCount++;
    }

    return res.json({
      success: true,
      savedCount,
      message: `Student attendance saved successfully (${savedCount} records).`,
    });
  } catch (error) {
    console.error('[ADMIN] Batch save student attendance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save student attendance.' });
  }
}

/**
 * GET /api/admin/promotions/class-students
 */
export async function getPromotionsClassStudents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, sessionId } = (req.query || {}) as any;

    if (!classId) {
      return res.status(400).json({ success: false, message: 'Class ID is required.' });
    }

    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSessionId = sessionId ? parseInt(sessionId, 10) : globalSetting?.sessionId || 5;

    const where: any = {
      branchId,
      classId: parseInt(classId, 10),
      sessionId: activeSessionId,
    };

    if (sectionId && sectionId !== 'ALL') {
      where.sectionId = parseInt(sectionId, 10);
    }

    const enrolls = await prisma.enroll.findMany({
      where,
      orderBy: [{ student: { firstName: 'asc' } }, { roll: 'asc' }],
      include: {
        student: {
          select: {
            id: true,
            registerNo: true,
            firstName: true,
            lastName: true,
            gender: true,
            photo: true,
            active: true,
          },
        },
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
      },
    });

    const activeStudents = enrolls
      .filter((e) => e.student && e.student.active)
      .map((e) => ({
        enrollId: e.id,
        studentId: e.student.id,
        registerNo: e.student.registerNo || `REG-${e.student.id}`,
        fullName: `${e.student.firstName || ''} ${e.student.lastName || ''}`.trim() || 'Student',
        gender: e.student.gender || 'N/A',
        roll: e.roll,
        currentClassId: e.classId,
        currentClassName: e.class?.name || 'Class',
        currentSectionId: e.sectionId,
        currentSectionName: e.section?.name || 'Section',
      }));

    return res.json({
      success: true,
      data: activeStudents,
      totalCount: activeStudents.length,
    });
  } catch (error: any) {
    console.error('[PROMOTIONS] Fetch class students error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch class students.' });
  }
}

/**
 * POST /api/admin/promotions/batch
 */
export async function batchPromoteStudents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { studentIds, targetClassId, targetSectionId, targetSessionId, action } = req.body;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please select at least one student for promotion.' });
    }

    if (!targetClassId || !targetSectionId || !targetSessionId) {
      return res
        .status(400)
        .json({ success: false, message: 'Target Class, Section, and Academic Session are required.' });
    }

    const tClassId = parseInt(targetClassId, 10);
    const tSectionId = parseInt(targetSectionId, 10);
    const tSessionId = parseInt(targetSessionId, 10);
    const promotionAction = action === 'REPEAT' ? 'REPEAT' : 'PROMOTE';

    let successCount = 0;
    let failureCount = 0;

    for (const id of studentIds) {
      const studentId = parseInt(id, 10);
      try {
        await prisma.$transaction(async (tx: any) => {
          const currentEnroll = await tx.enroll.findFirst({
            where: { studentId, branchId },
            orderBy: { id: 'desc' },
          });

          if (!currentEnroll) {
            throw new Error(`No active enrollment record for student ID ${studentId}`);
          }

          await tx.promotionHistory.create({
            data: {
              studentId,
              fromClassId: currentEnroll.classId,
              fromSectionId: currentEnroll.sectionId,
              toClassId: tClassId,
              toSectionId: tSectionId,
              promotedBy: req.userId,
              sessionId: tSessionId,
            },
          });

          const existingTargetEnroll = await tx.enroll.findFirst({
            where: { studentId, sessionId: tSessionId, branchId },
          });

          if (existingTargetEnroll) {
            await tx.enroll.update({
              where: { id: existingTargetEnroll.id },
              data: {
                classId: tClassId,
                sectionId: tSectionId,
                updatedAt: new Date(),
              },
            });
          } else {
            await tx.enroll.create({
              data: {
                studentId,
                classId: tClassId,
                sectionId: tSectionId,
                roll: currentEnroll.roll || 0,
                sessionId: tSessionId,
                branchId,
              },
            });
          }

          await wipeEvaluationMatrix(tx, { studentId, sessionId: tSessionId }).catch(() => {});
          await bindEvaluationMatrix(tx, {
            studentId,
            classId: tClassId,
            sectionId: tSectionId,
            branchId,
            sessionId: tSessionId,
          }).catch(() => {});
        });

        successCount++;
      } catch (err) {
        console.error(`[PROMOTIONS] Error processing student ${id}:`, err);
        failureCount++;
      }
    }

    return res.json({
      success: true,
      message: `Batch promotion completed. ${successCount} student(s) ${
        promotionAction === 'PROMOTE' ? 'promoted' : 'set to repeat'
      }.${failureCount > 0 ? ` (${failureCount} failed)` : ''}`,
      processedCount: successCount,
      failedCount: failureCount,
    });
  } catch (error: any) {
    console.error('[PROMOTIONS] Batch promotion error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to execute batch promotion.' });
  }
}

/**
 * GET /api/admin/promotions/history
 */
export async function getPromotionHistory(req: Request, res: Response): Promise<Response | void> {
  try {
    const { search, classId } = (req.query || {}) as any;

    const history = await prisma.promotionHistory.findMany({
      orderBy: { promotedAt: 'desc' },
      take: 100,
    });

    const studentIds = [...new Set(history.map((h: any) => h.studentId))];
    const classIds = [...new Set(history.flatMap((h: any) => [h.fromClassId, h.toClassId]))];
    const sectionIds = [...new Set(history.flatMap((h: any) => [h.fromSectionId, h.toSectionId]))];

    const [students, classes, sections] = await Promise.all([
      prisma.student.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, registerNo: true, firstName: true, lastName: true },
      }),
      prisma.class.findMany({
        where: { id: { in: classIds } },
        select: { id: true, name: true },
      }),
      prisma.section.findMany({
        where: { id: { in: sectionIds } },
        select: { id: true, name: true },
      }),
    ]);

    const studentMap = new Map(students.map((s: any) => [s.id, s]));
    const classMap = new Map(classes.map((c: any) => [c.id, c.name]));
    const sectionMap = new Map(sections.map((sec: any) => [sec.id, sec.name]));

    let logs = history.map((h: any) => {
      const st: any = studentMap.get(h.studentId);
      const fromClassName = classMap.get(h.fromClassId) || `Class #${h.fromClassId}`;
      const fromSectionName = sectionMap.get(h.fromSectionId) || `Section #${h.fromSectionId}`;
      const toClassName = classMap.get(h.toClassId) || `Class #${h.toClassId}`;
      const toSectionName = sectionMap.get(h.toSectionId) || `Section #${h.toSectionId}`;
      const isRepeated = h.fromClassId === h.toClassId;

      return {
        id: h.id,
        studentId: h.studentId,
        registerNo: st?.registerNo || `REG-${h.studentId}`,
        studentName: st ? `${st.firstName || ''} ${st.lastName || ''}`.trim() : `Student #${h.studentId}`,
        fromClass: `${fromClassName} (${fromSectionName})`,
        toClass: `${toClassName} (${toSectionName})`,
        fromClassId: h.fromClassId,
        toClassId: h.toClassId,
        action: isRepeated ? 'REPEATED' : 'PROMOTED',
        promotedAt: h.promotedAt,
        sessionId: h.sessionId,
      };
    });

    if (classId && classId !== 'ALL') {
      const cId = parseInt(classId, 10);
      logs = logs.filter((l: any) => l.fromClassId === cId || l.toClassId === cId);
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      logs = logs.filter(
        (l: any) => l.studentName.toLowerCase().includes(q) || l.registerNo.toLowerCase().includes(q)
      );
    }

    return res.json({
      success: true,
      data: logs,
      totalCount: logs.length,
    });
  } catch (error: any) {
    console.error('[PROMOTIONS] Fetch history error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch promotion history.' });
  }
}

/**
 * GET /api/admin/library/resources
 */
export async function getLibraryResources(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { type, category, search } = (req.query || {}) as any;
    const where: any = { branchId };

    if (type && type !== 'ALL') {
      where.type = type;
    }
    if (category && category !== 'ALL') {
      where.category = category;
    }

    const resources = await prisma.libraryResource.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        issues: {
          where: { status: 'ISSUED' },
          select: { id: true, borrowerName: true, dueDate: true },
        },
      },
    });

    let filtered = resources;
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = resources.filter(
        (r: any) =>
          r.title.toLowerCase().includes(q) ||
          r.author.toLowerCase().includes(q) ||
          (r.isbn && r.isbn.toLowerCase().includes(q))
      );
    }

    return res.json({
      success: true,
      data: filtered,
      totalCount: filtered.length,
    });
  } catch (error: any) {
    console.error('[LIBRARY] Fetch resources error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch library resources.' });
  }
}

/**
 * POST /api/admin/library/resources
 */
export async function createLibraryResource(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { title, author, isbn, category, type, totalCopies, fileUrl, videoUrl, description, isAiGenerated } =
      req.body;

    if (!title || !author) {
      return res.status(400).json({ success: false, message: 'Resource Title and Author are required.' });
    }

    const copies = totalCopies ? parseInt(totalCopies, 10) : 1;
    const resourceType = type || 'PHYSICAL_BOOK';

    const newResource = await prisma.libraryResource.create({
      data: {
        branchId,
        title,
        author,
        isbn: isbn || null,
        category: category || 'General',
        type: resourceType,
        totalCopies: copies,
        availableCopies: copies,
        fileUrl: fileUrl || null,
        videoUrl: videoUrl || null,
        description: description || null,
        isAiGenerated: isAiGenerated === true,
      },
    });

    return res.json({
      success: true,
      message: 'Library resource added successfully.',
      data: newResource,
    });
  } catch (error: any) {
    console.error('[LIBRARY] Add resource error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to add library resource.' });
  }
}

/**
 * POST /api/admin/library/resources/ai-ebook-draft
 */
export async function aiEbookDraft(req: Request, res: Response): Promise<Response | void> {
  try {
    const { topic, subject, gradeLevel, guidance } = req.body;

    if (!topic || !subject) {
      return res.status(400).json({ success: false, message: 'Topic and Subject are required.' });
    }

    let draftContent = '';
    try {
      const response = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content:
              'You are an expert school textbook writer and curriculum author. Generate structured, clear, and comprehensive educational e-book study content for school students.',
          },
          {
            role: 'user',
            content: `Draft a comprehensive educational study guide/e-book chapter for:
Subject: ${subject}
Topic: ${topic}
Target Grade/Class Level: ${gradeLevel || 'Secondary School'}
Special School Focus/Guidance: ${guidance || 'None'}

Please format the e-book chapter with clear section titles, key concept definitions, detailed explanations, practical examples, and 5 revision study questions at the end.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 1500,
      });

      draftContent = response.choices[0]?.message?.content || '';
    } catch (aiErr: any) {
      console.warn('[LIBRARY] AI fallback used:', aiErr.message);
      draftContent = `# STUDY GUIDE: ${topic.toUpperCase()} (${subject})
Grade Level: ${gradeLevel || 'All Grades'}

## 1. INTRODUCTION & OVERVIEW
${topic} is a key fundamental concept in ${subject}. This study guide covers the core principles, key definitions, and real-world applications required for academic success.

## 2. CORE CONCEPTS & DEFINITIONS
- Key Term 1: Definition and foundational context.
- Key Term 2: Standard formulas or conceptual breakdown.
- Key Term 3: Practical problem solving approach.

## 3. DETAILED STUDY EXPLANATION
Understanding ${topic} requires mastering both theoretical foundations and analytical application.
${guidance ? `Special Note: ${guidance}` : ''}

## 4. REVISION & PRACTICE QUESTIONS
1. Explain the primary principles of ${topic}.
2. How does ${topic} apply in real-world scenarios?
3. Calculate or describe the step-by-step resolution of a standard exam problem.
4. Compare and contrast key components of ${subject}.
5. Write a summary of key takeaways for exam revision.`;
    }

    return res.json({
      success: true,
      draftContent,
    });
  } catch (error: any) {
    console.error('[LIBRARY] AI E-Book drafting error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate AI e-book draft.' });
  }
}

/**
 * GET /api/admin/library/issues
 */
export async function getLibraryIssues(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { status, search } = (req.query || {}) as any;
    const where: any = { branchId };

    if (status && status !== 'ALL') {
      where.status = status;
    }

    const issues = await prisma.libraryIssue.findMany({
      where,
      orderBy: { issueDate: 'desc' },
      include: {
        resource: {
          select: { id: true, title: true, author: true, isbn: true, type: true },
        },
      },
    });

    const now = new Date();
    const processed = issues.map((i: any) => {
      let isOverdue = false;
      if (i.status === 'ISSUED' && new Date(i.dueDate) < now) {
        isOverdue = true;
      }
      return {
        ...i,
        status: isOverdue ? 'OVERDUE' : i.status,
      };
    });

    let filtered = processed;
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = processed.filter(
        (i: any) =>
          i.borrowerName.toLowerCase().includes(q) ||
          (i.resource?.title && i.resource.title.toLowerCase().includes(q))
      );
    }

    return res.json({
      success: true,
      data: filtered,
      totalCount: filtered.length,
    });
  } catch (error: any) {
    console.error('[LIBRARY] Fetch issues error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch library issue logs.' });
  }
}

/**
 * POST /api/admin/library/issues
 */
export async function issueLibraryBook(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { resourceId, borrowerId, borrowerType, borrowerName, borrowerRole, dueDate, remarks } = req.body;

    if (!resourceId || !borrowerName || !dueDate) {
      return res.status(400).json({ success: false, message: 'Resource, Borrower Name, and Due Date are required.' });
    }

    const resId = parseInt(resourceId, 10);

    const resource = await prisma.libraryResource.findUnique({
      where: { id: resId },
    });

    if (!resource) {
      return res.status(404).json({ success: false, message: 'Library resource not found.' });
    }

    if (resource.availableCopies <= 0) {
      return res.status(400).json({ success: false, message: 'No available copies left for this book.' });
    }

    const issue = await prisma.$transaction(async (tx: any) => {
      const created = await tx.libraryIssue.create({
        data: {
          branchId,
          resourceId: resId,
          borrowerId: borrowerId ? parseInt(borrowerId, 10) : 1,
          borrowerType: borrowerType || 'STUDENT',
          borrowerName,
          borrowerRole: borrowerRole || 'Student',
          dueDate: new Date(dueDate),
          status: 'ISSUED',
          remarks: remarks || null,
        },
      });

      await tx.libraryResource.update({
        where: { id: resId },
        data: {
          availableCopies: { decrement: 1 },
        },
      });

      return created;
    });

    return res.json({
      success: true,
      message: 'Book issued successfully.',
      data: issue,
    });
  } catch (error: any) {
    console.error('[LIBRARY] Issue book error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to issue book.' });
  }
}

/**
 * PUT /api/admin/library/issues/:id/return
 */
export async function returnLibraryBook(req: Request, res: Response): Promise<Response | void> {
  try {
    const issueId = parseInt(req.params.id as string, 10);

    const existing = await prisma.libraryIssue.findUnique({
      where: { id: issueId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Book issue record not found.' });
    }

    if (existing.status === 'RETURNED') {
      return res.status(400).json({ success: false, message: 'This book has already been returned.' });
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.libraryIssue.update({
        where: { id: issueId },
        data: {
          status: 'RETURNED',
          returnDate: new Date(),
        },
      });

      await tx.libraryResource.update({
        where: { id: existing.resourceId },
        data: {
          availableCopies: { increment: 1 },
        },
      });
    });

    return res.json({
      success: true,
      message: 'Book marked as returned successfully. Stock copy restored.',
    });
  } catch (error: any) {
    console.error('[LIBRARY] Return book error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to return book.' });
  }
}

/**
 * DELETE /api/admin/library/resources/:id
 */
export async function deleteLibraryResource(req: Request, res: Response): Promise<Response | void> {
  try {
    const resourceId = parseInt(req.params.id as string, 10);

    await prisma.libraryResource.delete({
      where: { id: resourceId },
    });

    return res.json({ success: true, message: 'Library resource deleted successfully.' });
  } catch (error: any) {
    console.error('[LIBRARY] Delete resource error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete resource.' });
  }
}

/**
 * GET /api/admin/lesson-plans
 */
export async function getLessonPlans(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  const { classId, subjectId, teacherId, status, search } = (req.query || {}) as any;

  try {
    const where: any = {
      teacher: { branchId },
    };

    if (classId) where.classId = Number(classId);
    if (subjectId) where.subjectId = Number(subjectId);
    if (teacherId) where.teacherId = Number(teacherId);
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { coreTopic: { contains: search, mode: 'insensitive' } },
        { educationalObjectives: { contains: search, mode: 'insensitive' } },
      ];
    }

    const plans = await prisma.lessonPlan.findMany({
      where,
      include: {
        teacher: { select: { id: true, name: true } },
        class: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, count: plans.length, plans });
  } catch (error) {
    console.error('[ADMIN] Fetch lesson plans error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch lesson plans.' });
  }
}

/**
 * GET /api/admin/lesson-plans/:id/pdf
 */
export async function downloadLessonPlanPdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const plan = await prisma.lessonPlan.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        teacher: { select: { name: true, branchId: true } },
        class: { select: { name: true } },
        subject: { select: { name: true } },
      },
    });

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Lesson plan not found.' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId || 1 },
      select: { name: true, code: true },
    });

    const pdfBuffer = await generateLessonPlanPdf({
      schoolName: branch?.name || 'Ugbekun Group of Schools',
      branchCode: branch?.code || 'MAIN',
      teacherName: plan.teacher.name || 'Subject Teacher',
      subjectName: plan.subject.name,
      className: plan.class.name,
      coreTopic: plan.coreTopic,
      educationalObjectives: plan.educationalObjectives,
      materialLists: plan.materialLists,
      teachingGuide: plan.teachingGuide,
      assessmentCriteria: plan.assessmentCriteria,
      classAssignments: plan.classAssignments,
      status: plan.status,
      createdAt: plan.createdAt,
    });

    const sanitizedTopic = (plan.coreTopic || 'Lesson_Plan').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Lesson_Plan_${sanitizedTopic}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN] Lesson plan PDF export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate lesson plan PDF.' });
  }
}

export const getClasses = getClassesSections;
export const seedClassPresets = seedClassPreset;
export const toggleClassEcd = toggleECD;
export const allocateSection = allocateSections;
export const saveStudentAttendance = saveStudentAttendanceBatch;
export const getPromotionSelection = getPromotionsClassStudents;
export const promoteStudentCohort = batchPromoteStudents;
export const aiDraftEbookResource = aiEbookDraft;
export const exportLessonPlanPdf = downloadLessonPlanPdf;
