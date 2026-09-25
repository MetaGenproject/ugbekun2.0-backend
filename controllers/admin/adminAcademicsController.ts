import { Request, Response } from 'express';
import { LessonPlanStatus, Prisma } from '@prisma/client';
import prisma, { isDatabaseConnectivityError, retryOnConnectivity } from '../../lib/prisma';
import { bindEvaluationMatrix, wipeEvaluationMatrix } from '../../lib/studentService';
import { generateLessonPlanPdf } from '../../lib/pdfService';
import { parseSchoolDateKey, storedAttendanceDateKey, todaySchoolDateKey, parseSchoolMonthKey, todaySchoolMonthKey, schoolMonthDateKeys, schoolMonthLabel, schoolMonthStoredRange, schoolDateStoredRange, describeSchoolDate } from '../../lib/schoolDate';
import { parsePagination, paginateItems } from '../../lib/pagination';
import {
  AttendanceRegisterError,
  buildMonthlyAttendanceTables,
  getRegisterWithEntries,
  listSubmittedAttendance,
  openOrGetRegister,
  summarizeDailyPresence,
  summarizeEntries,
  upsertEntries,
} from '../../lib/attendanceRegisterService';
import { getAiModel, requireDeepseekClient } from '../../lib/aiClient';
import { generatePedagogicalLessonPlan } from '../../lib/lessonPlanService';
import { extractLessonSourceMaterial } from '../../lib/lessonMaterialExtract';
import gamificationService from '../../lib/gamificationService';

const openai = { chat: { completions: { create: (args: any) => requireDeepseekClient().chat.completions.create({ ...args, model: args.model || getAiModel() }) } } };

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

    const querySessionId = req.query.sessionId ? Number(req.query.sessionId) : undefined;
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = querySessionId || globalSetting?.sessionId || 6;

    let assignments = await prisma.subjectAssign.findMany({
      where: { branchId, ...(sessionId ? { sessionId } : {}) },
      include: {
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true } },
        teacher: { select: { id: true, name: true } },
      },
    });

    if (assignments.length === 0) {
      assignments = await prisma.subjectAssign.findMany({
        where: { branchId },
        include: {
          class: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true } },
          teacher: { select: { id: true, name: true } },
        },
      });
    }

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
 * Helper to resolve the active session for an admin query.
 * Priority: explicit param > global_settings > most recent session with enrollments for the branch/class.
 */
async function resolveAdminSession(
  branchId?: number,
  classId?: number,
  requestedSession?: number | null
): Promise<number> {
  if (requestedSession) return requestedSession;
  const globalSetting = await prisma.globalSettings.findFirst();
  const defaultSession = globalSetting?.sessionId || 4;
  if (!branchId) return defaultSession;

  const where: any = { branchId, sessionId: defaultSession };
  if (classId) where.classId = classId;
  const sessionCheck = await prisma.enroll.count({ where });
  if (sessionCheck > 0) return defaultSession;

  const fallbackWhere: any = { branchId };
  if (classId) fallbackWhere.classId = classId;
  const latestEnroll = await prisma.enroll.findFirst({
    where: fallbackWhere,
    orderBy: { sessionId: 'desc' },
    select: { sessionId: true },
  });
  if (latestEnroll) return latestEnroll.sessionId;

  // Try branch-wide latest session if class-specific had nothing
  if (classId) {
    const branchLatest = await prisma.enroll.findFirst({
      where: { branchId },
      orderBy: { sessionId: 'desc' },
      select: { sessionId: true },
    });
    if (branchLatest) return branchLatest.sessionId;
  }

  return defaultSession;
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

    const sessionId = await resolveAdminSession(
      branchId,
      Number(classId),
      req.body.sessionId ? Number(req.body.sessionId) : null
    );

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

    const sessionId = await resolveAdminSession(
      branchId,
      Number(classId),
      req.body.sessionId ? Number(req.body.sessionId) : null
    );

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
    const dateKey = parseSchoolDateKey(date) || todaySchoolDateKey();

    const requestedSession = req.query.sessionId ? Number(req.query.sessionId) : null;
    const activeSession = await resolveAdminSession(branchId, cId, requestedSession);

    const { page, pageSize, q } = parsePagination(req.query);

    if (secId) {
      const snapshot = await getRegisterWithEntries(prisma, {
        branchId,
        sessionId: activeSession,
        classId: cId,
        sectionId: secId,
        dateKey,
      });
      const students = snapshot.roster.map((row) => ({
        id: row.studentId,
        name: [row.firstName, row.lastName].filter(Boolean).join(' ') || `Student #${row.studentId}`,
        roll: row.roll != null ? String(row.roll) : null,
        registerNo: row.registerNo,
      }));
      const filtered = q
        ? students.filter((row) =>
            [row.name, row.roll, row.registerNo].join(' ').toLowerCase().includes(q as string)
          )
        : students;
      const paged = paginateItems(filtered, page, pageSize);
      const attendanceMap: Record<number, { status: string; remark: string | null }> = {};
      snapshot.entries.forEach((entry) => {
        attendanceMap[entry.studentId] = {
          status: String(entry.status || '').toUpperCase(),
          remark: entry.remark,
        };
      });
      const coded = snapshot.summary.total - snapshot.summary.unmarked;
      return res.json({
        success: true,
        students: paged.items,
        attendanceMap,
        register: snapshot.register,
        canEdit: snapshot.canEdit,
        pagination: paged.pagination,
        activeSessionId: activeSession,
        metrics: {
          totalEnrolled: snapshot.summary.total,
          presentCount: snapshot.summary.present,
          absentCount: snapshot.summary.absent,
          lateCount: snapshot.summary.late,
          excusedCount: snapshot.summary.excused + snapshot.summary.sick,
          unmarkedCount: snapshot.summary.unmarked,
          attendanceRate: coded > 0 ? Math.round(((snapshot.summary.present + snapshot.summary.late) / coded) * 100) : 0,
        },
      });
    }

    const enrolls = await prisma.enroll.findMany({
      where: {
        branchId,
        classId: cId,
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

    const { logs: attendanceRecords } = await listSubmittedAttendance(prisma, {
      branchId,
      sessionId: activeSession,
      classId: cId,
      studentIds: students.map((row) => row.id),
    });
    const forDate = attendanceRecords.filter((att) => storedAttendanceDateKey(att.attendanceDate) === dateKey);

    const attendanceMap: Record<number, any> = {};
    let presentCount = 0;
    let absentCount = 0;
    let lateCount = 0;
    let excusedCount = 0;

    forDate.forEach((att) => {
      const status = String(att.status || '').toUpperCase();
      attendanceMap[att.studentId] = {
        id: att.id,
        status,
        remark: att.remark,
      };
      if (status === 'PRESENT') presentCount++;
      else if (status === 'ABSENT') absentCount++;
      else if (status === 'LATE') lateCount++;
      else if (status === 'EXCUSED' || status === 'SICK') excusedCount++;
    });

    const totalEnrolled = students.length;
    const coded = presentCount + absentCount + lateCount + excusedCount;
    const attendanceRate = coded > 0 ? Math.round(((presentCount + lateCount) / coded) * 100) : 0;
    const filtered = q
      ? students.filter((row) =>
          [row.name, row.roll, row.registerNo, row.sectionName].join(' ').toLowerCase().includes(q as string)
        )
      : students;
    const paged = paginateItems(filtered, page, pageSize);

    return res.json({
      success: true,
      students: paged.items,
      attendanceMap,
      pagination: paged.pagination,
      activeSessionId: activeSession,
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
    const secId = sectionId ? Number(sectionId) : 1;
    const dateKey = parseSchoolDateKey(date);
    if (!dateKey) {
      return res.status(400).json({ success: false, message: 'Invalid date. Use YYYY-MM-DD.' });
    }
    if (!secId) {
      return res.status(400).json({ success: false, message: 'sectionId is required to save a class register.' });
    }

    const requestedSession = req.body.sessionId ? Number(req.body.sessionId) : null;
    const activeSession = await resolveAdminSession(branchId, cId, requestedSession);

    const register = await openOrGetRegister(prisma, {
      branchId,
      sessionId: activeSession,
      classId: cId,
      sectionId: secId,
      dateKey,
    });

    const result = await prisma.$transaction(
      async (tx) => {
        return upsertEntries(tx, {
          registerId: register.id,
          branchId,
          entries: attendance,
          requireComplete: false,
          mode: 'admin-save',
        });
      },
      { timeout: 20000, maxWait: 10000 }
    );

    const savedCount = result.planned.rows.length;

    return res.json({
      success: true,
      savedCount,
      register: {
        id: result.register.id,
        status: result.register.status,
        version: result.register.version,
      },
      message: `Student attendance saved successfully (${savedCount} records).`,
    });
  } catch (error) {
    if (error instanceof AttendanceRegisterError) {
      return res.status(error.httpStatus).json({
        success: false,
        message: error.message,
        code: error.code,
        ...error.extra,
      });
    }
    console.error('[ADMIN] Batch save student attendance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save student attendance.' });
  }
}

function csvCell(value: unknown) {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(headers: string[], rows: Array<Array<unknown>>) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

function summarizeStaffDay(totalStaff: number, records: Array<{ teacherId: number; status?: string | null }>) {
  const latest = new Map<number, string>();
  for (const record of records) {
    latest.set(record.teacherId, String(record.status || '').toUpperCase());
  }
  let present = 0;
  let absent = 0;
  let late = 0;
  let halfDay = 0;
  let onLeave = 0;
  for (const status of latest.values()) {
    if (status === 'PRESENT') present += 1;
    else if (status === 'ABSENT') absent += 1;
    else if (status === 'LATE') late += 1;
    else if (status === 'HALF_DAY') halfDay += 1;
    else if (status === 'ON_LEAVE') onLeave += 1;
    else present += 1;
  }
  const marked = present + absent + late + halfDay + onLeave;
  const inAttendance = present + late + halfDay;
  return {
    total: totalStaff,
    present,
    absent,
    late,
    halfDay,
    onLeave,
    unmarked: Math.max(0, totalStaff - marked),
    marked,
    inAttendance,
    attendanceRate: totalStaff > 0 ? Number(((inAttendance / totalStaff) * 100).toFixed(1)) : 0,
  };
}

/**
 * GET /api/admin/attendance/daily-report
 */
export async function getDailyAttendanceReport(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const dateKey = parseSchoolDateKey(req.query.date) || todaySchoolDateKey();
    const described = describeSchoolDate(dateKey);
    const range = schoolDateStoredRange(dateKey);

    const requestedSession = req.query.sessionId ? Number(req.query.sessionId) : null;
    const activeSession = await resolveAdminSession(branchId, undefined, requestedSession);

    const enrolls = await prisma.enroll.findMany({
      where: { branchId, sessionId: activeSession },
      select: { studentId: true },
    });
    const enrolledIds = Array.from(new Set(enrolls.map((row) => row.studentId)));

    const [{ logs }, staffTotal, staffRecords] = await Promise.all([
      listSubmittedAttendance(prisma, {
        branchId,
        sessionId: activeSession,
        dateFromKey: dateKey,
        dateToKey: dateKey,
        order: 'asc',
        includeDrafts: true,
      }),
      prisma.teacher.count({ where: { branchId, active: true } }),
      prisma.staffAttendance.findMany({
        where: { branchId, attendanceDate: range },
        select: { teacherId: true, status: true },
      }),
    ]);

    const dayLogs = logs.filter((log) => storedAttendanceDateKey(log.attendanceDate) === dateKey);
    const students = summarizeDailyPresence(summarizeEntries(enrolledIds, dayLogs));
    const staff = summarizeStaffDay(staffTotal, staffRecords);

    return res.json({
      success: true,
      date: dateKey,
      weekday: described.weekday,
      calendar: described,
      students,
      staff,
    });
  } catch (error) {
    console.error('[ADMIN] Daily attendance report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load daily attendance report.' });
  }
}

/**
 * GET /api/admin/attendance/monthly-report
 */
export async function getMonthlyAttendanceReport(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const monthKey = parseSchoolMonthKey(req.query.month) || todaySchoolMonthKey();
    const monthDays = schoolMonthDateKeys(monthKey);
    if (monthDays.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid month. Use YYYY-MM.' });
    }

    const classId = req.query.classId ? Number(req.query.classId) : 0;
    const sectionId = req.query.sectionId ? Number(req.query.sectionId) : 0;
    const requestedView = String(req.query.view || '').toLowerCase();
    const view =
      requestedView === 'students' || requestedView === 'streams'
        ? requestedView
        : classId
          ? 'students'
          : 'streams';
    const exporting = String(req.query.format || '').toLowerCase() === 'csv';
    const { page, pageSize, q } = parsePagination(req.query);

    const requestedSession = req.query.sessionId ? Number(req.query.sessionId) : null;
    const activeSession = await resolveAdminSession(branchId, classId || undefined, requestedSession);

    const enrolls = await prisma.enroll.findMany({
      where: {
        branchId,
        sessionId: activeSession,
        ...(classId ? { classId } : {}),
        ...(sectionId ? { sectionId } : {}),
      },
      include: {
        student: {
          select: { id: true, firstName: true, lastName: true, registerNo: true },
        },
        class: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
      },
      orderBy: [{ classId: 'asc' }, { sectionId: 'asc' }, { roll: 'asc' }, { studentId: 'asc' }],
    });

    const { logs } = await listSubmittedAttendance(prisma, {
      branchId,
      sessionId: activeSession,
      ...(classId ? { classId } : {}),
      ...(sectionId ? { sectionId } : {}),
      dateFromKey: monthDays[0],
      dateToKey: monthDays[monthDays.length - 1],
      order: 'asc',
      includeDrafts: true,
    });

    const monthSet = new Set(monthDays);
    const monthLogs = logs.filter((log) => monthSet.has(storedAttendanceDateKey(log.attendanceDate)));
    const tables = buildMonthlyAttendanceTables(
      enrolls.map((row) => ({
        studentId: row.student.id,
        classId: row.classId,
        sectionId: row.sectionId,
        className: row.class?.name || `Class ${row.classId}`,
        sectionName: row.section?.name || `Arm ${row.sectionId}`,
        roll: row.roll,
        firstName: row.student.firstName,
        lastName: row.student.lastName,
        registerNo: row.student.registerNo,
      })),
      monthLogs
    );

    const staffRange = schoolMonthStoredRange(monthKey);
    const [staffCount, staffRecords] = await Promise.all([
      prisma.teacher.count({ where: { branchId, active: true } }),
      prisma.staffAttendance.findMany({
        where: { branchId, ...(staffRange ? { attendanceDate: staffRange } : {}) },
        select: { status: true },
      }),
    ]);

    let staffPresent = 0;
    let staffAbsent = 0;
    let staffLate = 0;
    let staffHalfDay = 0;
    let staffOnLeave = 0;
    for (const record of staffRecords) {
      const status = String(record.status || '').toUpperCase();
      if (status === 'PRESENT') staffPresent += 1;
      else if (status === 'ABSENT') staffAbsent += 1;
      else if (status === 'LATE') staffLate += 1;
      else if (status === 'HALF_DAY') staffHalfDay += 1;
      else if (status === 'ON_LEAVE') staffOnLeave += 1;
    }
    const staffCoded = staffPresent + staffAbsent + staffLate + staffHalfDay + staffOnLeave;
    const staffInAttendance = staffPresent + staffLate + staffHalfDay;
    const staffMetrics = {
      totalStaff: staffCount,
      markedCount: staffCoded,
      presentCount: staffPresent,
      absentCount: staffAbsent,
      lateCount: staffLate,
      halfDayCount: staffHalfDay,
      onLeaveCount: staffOnLeave,
      attendanceRate: staffCoded > 0 ? Number(((staffInAttendance / staffCoded) * 100).toFixed(1)) : 0,
    };

    const streamRows = q
      ? tables.streams.filter((row) =>
          [row.streamName, row.className, row.sectionName].join(' ').toLowerCase().includes(q)
        )
      : tables.streams;
    const studentRows = q
      ? tables.students.filter((row) =>
          [row.name, row.registerNo, row.streamName, row.roll].join(' ').toLowerCase().includes(q)
        )
      : tables.students;

    if (exporting) {
      const filename = `monthly-attendance-${monthKey}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (view === 'students') {
        return res.send(
          toCsv(
            ['Class stream', 'Roll', 'Student', 'Admission no', 'Present', 'Late', 'Absent', 'Excused', 'Sick', 'Coded days', 'Presence %', 'Chronic'],
            studentRows.map((row) => [
              row.streamName,
              row.roll,
              row.name,
              row.registerNo,
              row.presentCount,
              row.lateCount,
              row.absentCount,
              row.excusedCount,
              row.sickCount,
              row.codedDays,
              row.percentage,
              row.chronic ? 'Yes' : 'No',
            ])
          )
        );
      }
      return res.send(
        toCsv(
          ['Class stream', 'Enrolled students', 'Coded days', 'Average presence rate', 'Chronic absentees'],
          streamRows.map((row) => [
            row.streamName,
            row.enrolled,
            row.codedDays,
            row.averagePresenceRate,
            row.chronicAbsenteeCount,
          ])
        )
      );
    }

    if (view === 'students') {
      const paged = paginateItems(studentRows, page, pageSize);
      return res.json({
        success: true,
        month: monthKey,
        monthLabel: schoolMonthLabel(monthKey),
        view,
        metrics: {
          ...tables.metrics,
          staff: staffMetrics,
        },
        streams: streamRows,
        students: paged.items,
        pagination: paged.pagination,
      });
    }

    const paged = paginateItems(streamRows, page, pageSize);
    return res.json({
      success: true,
      month: monthKey,
      monthLabel: schoolMonthLabel(monthKey),
      view,
      metrics: {
        ...tables.metrics,
        staff: staffMetrics,
      },
      streams: paged.items,
      students: [],
      pagination: paged.pagination,
    });
  } catch (error) {
    console.error('[ADMIN] Monthly attendance report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load monthly attendance report.' });
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

    const activeSessionId = await resolveAdminSession(
      branchId,
      parseInt(classId, 10),
      sessionId ? parseInt(sessionId, 10) : null
    );

    const baseWhere: any = {
      branchId,
      classId: parseInt(classId, 10),
    };

    if (sectionId && sectionId !== 'ALL') {
      baseWhere.sectionId = parseInt(sectionId, 10);
    }

    let enrolls = await prisma.enroll.findMany({
      where: {
        ...baseWhere,
        sessionId: activeSessionId,
      },
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

    if (enrolls.length === 0) {
      enrolls = await prisma.enroll.findMany({
        where: baseWhere,
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
    }

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

          // Always update current latest enrollment so student immediately reflects target class/section
          await tx.enroll.update({
            where: { id: currentEnroll.id },
            data: {
              classId: tClassId,
              sectionId: tSectionId,
              updatedAt: new Date(),
            },
          });

          if (tSessionId !== currentEnroll.sessionId) {
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
  const branchId = Number(req.branchId || 0);
  if (!branchId) {
    return res.status(400).json({ success: false, message: 'Branch is required.' });
  }

  const { classId, subjectId, teacherId, status, search } = (req.query || {}) as any;

  try {
    const filters: Prisma.Sql[] = [Prisma.sql`t.branch_id = ${branchId}`];
    if (classId) filters.push(Prisma.sql`lp.class_id = ${Number(classId)}`);
    if (subjectId) filters.push(Prisma.sql`lp.subject_id = ${Number(subjectId)}`);
    if (teacherId) filters.push(Prisma.sql`lp.teacher_id = ${Number(teacherId)}`);
    if (status) filters.push(Prisma.sql`lp.status::text = ${String(status)}`);
    if (search) {
      const q = `%${String(search).trim()}%`;
      filters.push(Prisma.sql`(lp.core_topic ILIKE ${q} OR COALESCE(lp.educational_objectives, '') ILIKE ${q})`);
    }

    const rows = await retryOnConnectivity(() => prisma.$queryRaw<any[]>`
      SELECT
        lp.id,
        lp.teacher_id AS "teacherId",
        lp.class_id AS "classId",
        lp.subject_id AS "subjectId",
        lp.core_topic AS "coreTopic",
        lp.educational_objectives AS "educationalObjectives",
        lp.material_lists AS "materialLists",
        lp.teaching_guide AS "teachingGuide",
        lp.assessment_criteria AS "assessmentCriteria",
        lp.class_assignments AS "classAssignments",
        lp.entry_behavior AS "entryBehavior",
        lp.ai_instruction AS "aiInstruction",
        lp.source_material AS "sourceMaterial",
        lp.source_file_name AS "sourceFileName",
        lp.sub_topic AS "subTopic",
        lp.duration,
        lp.week_no AS "weekNo",
        lp.reviewer_note AS "reviewerNote",
        lp.status,
        lp.created_at AS "createdAt",
        lp.updated_at AS "updatedAt",
        t.id AS "teacherRelId",
        t.name AS "teacherName",
        c.id AS "classRelId",
        c.name AS "className",
        s.id AS "subjectRelId",
        s.name AS "subjectName"
      FROM lesson_plans lp
      INNER JOIN teachers t ON t.id = lp.teacher_id
      INNER JOIN classes c ON c.id = lp.class_id
      INNER JOIN subjects s ON s.id = lp.subject_id
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY lp.created_at DESC
    `);

    const plans = rows.map((row) => ({
      id: row.id,
      teacherId: row.teacherId,
      classId: row.classId,
      subjectId: row.subjectId,
      coreTopic: row.coreTopic,
      educationalObjectives: row.educationalObjectives,
      materialLists: row.materialLists,
      teachingGuide: row.teachingGuide,
      assessmentCriteria: row.assessmentCriteria,
      classAssignments: row.classAssignments,
      entryBehavior: row.entryBehavior,
      aiInstruction: row.aiInstruction,
      sourceMaterial: row.sourceMaterial,
      sourceFileName: row.sourceFileName,
      subTopic: row.subTopic,
      duration: row.duration,
      weekNo: row.weekNo,
      reviewerNote: row.reviewerNote,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      teacher: { id: row.teacherRelId, name: row.teacherName },
      class: { id: row.classRelId, name: row.className },
      subject: { id: row.subjectRelId, name: row.subjectName },
    }));

    return res.json({ success: true, count: plans.length, plans });
  } catch (error) {
    console.error('[ADMIN] Fetch lesson plans error:', error);
    const message = isDatabaseConnectivityError(error)
      ? 'The database is busy. Please retry in a moment.'
      : 'Failed to fetch lesson plans.';
    return res.status(500).json({ success: false, message });
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

function mapLessonPlanBody(body: any, existing?: any) {
  return {
    coreTopic: body.coreTopic !== undefined ? String(body.coreTopic).trim() : existing?.coreTopic,
    educationalObjectives: body.objectives ?? body.educationalObjectives ?? existing?.educationalObjectives ?? null,
    materialLists: body.materials ?? body.materialLists ?? existing?.materialLists ?? null,
    teachingGuide: body.teachingGuide !== undefined ? body.teachingGuide : existing?.teachingGuide ?? null,
    assessmentCriteria: body.assessments ?? body.assessmentCriteria ?? existing?.assessmentCriteria ?? null,
    classAssignments: body.assignments ?? body.classAssignments ?? existing?.classAssignments ?? null,
    entryBehavior: body.entryBehavior !== undefined ? body.entryBehavior : existing?.entryBehavior ?? null,
    aiInstruction: body.instruction ?? body.aiInstruction ?? existing?.aiInstruction ?? null,
    sourceMaterial: body.sourceMaterial !== undefined ? body.sourceMaterial : existing?.sourceMaterial ?? null,
    sourceFileName: body.sourceFileName !== undefined ? body.sourceFileName : existing?.sourceFileName ?? null,
    subTopic: body.subTopic !== undefined ? body.subTopic : existing?.subTopic ?? null,
    duration: body.duration !== undefined ? body.duration : existing?.duration ?? null,
    weekNo: body.weekNo !== undefined ? body.weekNo : existing?.weekNo ?? null,
  };
}

function lessonPlanInclude() {
  return {
    teacher: { select: { id: true, name: true, branchId: true } },
    class: { select: { id: true, name: true } },
    subject: { select: { id: true, name: true } },
  };
}

/**
 * POST /api/admin/lesson-plans/generate
 */
export async function generateAdminLessonPlan(req: Request, res: Response): Promise<Response | void> {
  try {
    const coreTopic = String(req.body?.coreTopic || req.body?.topic || '').trim();
    if (!coreTopic) {
      return res.status(400).json({ success: false, message: 'A lesson topic is required.' });
    }

    const classId = Number(req.body?.classId || 0) || null;
    const subjectId = Number(req.body?.subjectId || 0) || null;

    const classObj = classId
      ? await prisma.class.findFirst({ where: { id: classId, ...(req.branchId ? { branchId: req.branchId } : {}) }, select: { id: true, name: true } })
      : null;
    const subjectObj = subjectId
      ? await prisma.subject.findFirst({ where: { id: subjectId, ...(req.branchId ? { branchId: req.branchId } : {}) }, select: { id: true, name: true } })
      : null;

    const extracted = await extractLessonSourceMaterial(req.body?.uploads || [], req.body?.sourceMaterial || req.body?.pastedText);
    const instruction = String(req.body?.instruction || req.body?.aiInstruction || '').trim();

    const result = await generatePedagogicalLessonPlan({
      subjectName: subjectObj?.name || String(req.body?.subjectName || 'General Studies'),
      className: classObj?.name || String(req.body?.className || 'Primary'),
      topic: coreTopic,
      subTopic: req.body.subTopic || '',
      duration: req.body.duration || '45 Minutes',
      weekNo: req.body.weekNo || 'Week 3',
      instruction,
      sourceMaterial: extracted.text,
    });

    const draft = {
      objectives: result.educationalObjectives,
      materials: result.materialLists,
      teachingGuide: result.teachingGuide,
      assessments: result.assessmentCriteria,
      assignments: result.classAssignments,
      entryBehavior: result.entryBehavior,
      coreTopic: result.coreTopic,
      sourceMaterial: extracted.text,
      sourceFileName: extracted.fileName,
      aiInstruction: instruction,
    };

    return res.json({
      success: true,
      draft,
      lessonPlan: {
        educationalObjectives: draft.objectives,
        materialLists: draft.materials,
        teachingGuide: draft.teachingGuide,
        assessmentCriteria: draft.assessments,
        classAssignments: draft.assignments,
        entryBehavior: draft.entryBehavior,
        coreTopic: draft.coreTopic,
      },
    });
  } catch (error) {
    console.error('[ADMIN] AI Lesson Plan Generation Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate AI lesson plan draft.' });
  }
}

/**
 * POST /api/admin/lesson-plans
 */
export async function createAdminLessonPlan(req: Request, res: Response): Promise<Response | void> {
  const body = req.body || {};
  const teacherId = Number(body.teacherId);
  const classId = Number(body.classId);
  const subjectId = Number(body.subjectId);
  const coreTopic = String(body.coreTopic || '').trim();
  if (!teacherId || !classId || !subjectId || !coreTopic) {
    return res.status(400).json({ success: false, message: 'teacherId, classId, subjectId, and coreTopic are required.' });
  }

  try {
    const teacher = await prisma.teacher.findFirst({
      where: { id: teacherId, ...(req.branchId ? { branchId: req.branchId } : {}) },
      select: { id: true },
    });
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found in this branch.' });
    }

    const requested = String(body.status || 'DRAFT').toUpperCase();
    const status =
      requested === 'APPROVED'
        ? 'APPROVED'
        : requested === 'PENDING_APPROVAL' || requested === 'PUBLISHED'
          ? 'PENDING_APPROVAL'
          : 'DRAFT';

    const plan = await prisma.lessonPlan.create({
      data: {
        teacherId,
        classId,
        subjectId,
        status,
        ...mapLessonPlanBody({ ...body, coreTopic }),
      },
      include: lessonPlanInclude(),
    });

    return res.json({
      success: true,
      message:
        status === 'APPROVED'
          ? 'Lesson note saved as an official school record.'
          : status === 'PENDING_APPROVAL'
            ? 'Lesson note saved for approval. It is not an official school record yet.'
            : 'Lesson note saved as a draft. It is not an official school record yet.',
      plan,
    });
  } catch (error) {
    console.error('[ADMIN] Save lesson plan error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save lesson plan.' });
  }
}

/**
 * PUT /api/admin/lesson-plans/:id
 */
export async function updateAdminLessonPlan(req: Request, res: Response): Promise<Response | void> {
  const body = req.body || {};
  try {
    const plan = await prisma.lessonPlan.findUnique({
      where: { id: Number(req.params.id) },
      include: { teacher: { select: { branchId: true } } },
    });
    if (!plan || (req.branchId && plan.teacher.branchId !== req.branchId)) {
      return res.status(404).json({ success: false, message: 'Lesson plan not found.' });
    }

    const requested = body.status ? String(body.status).toUpperCase() : plan.status;
    const status: LessonPlanStatus =
      requested === 'APPROVED'
        ? 'APPROVED'
        : requested === 'PENDING_APPROVAL' || requested === 'PUBLISHED'
          ? 'PENDING_APPROVAL'
          : requested === 'REVISION'
            ? 'REVISION'
            : requested === 'DRAFT'
              ? 'DRAFT'
              : plan.status;

    const updated = await prisma.lessonPlan.update({
      where: { id: plan.id },
      data: {
        ...(body.teacherId ? { teacherId: Number(body.teacherId) } : {}),
        ...(body.classId ? { classId: Number(body.classId) } : {}),
        ...(body.subjectId ? { subjectId: Number(body.subjectId) } : {}),
        ...mapLessonPlanBody(body, plan),
        status,
        ...(body.reviewerNote !== undefined ? { reviewerNote: String(body.reviewerNote || '') } : {}),
      },
      include: lessonPlanInclude(),
    });

    return res.json({ success: true, message: 'Lesson note updated. Official status only changes after approval.', plan: updated });
  } catch (error) {
    console.error('[ADMIN] Update lesson plan error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update lesson plan.' });
  }
}

/**
 * POST /api/admin/lesson-plans/:id/approve
 */
export async function approveLessonPlan(req: Request, res: Response): Promise<Response | void> {
  try {
    const plan = await prisma.lessonPlan.findUnique({
      where: { id: Number(req.params.id) },
      include: { teacher: { select: { branchId: true, id: true } } },
    });
    if (!plan || (req.branchId && plan.teacher.branchId !== req.branchId)) {
      return res.status(404).json({ success: false, message: 'Lesson plan not found.' });
    }

    const updated = await prisma.lessonPlan.update({
      where: { id: plan.id },
      data: {
        status: 'APPROVED',
        reviewerNote: req.body?.reviewerNote ? String(req.body.reviewerNote) : plan.reviewerNote,
      },
      include: lessonPlanInclude(),
    });

    gamificationService
      .checkLessonPlanEarly(prisma, plan.teacherId, plan.id, req.branchId)
      .catch((err: any) => console.error('[Gamification] Error in lesson plan trigger:', err.message));

    return res.json({ success: true, message: 'Lesson note approved as an official school record.', plan: updated });
  } catch (error) {
    console.error('[ADMIN] Approve lesson plan error:', error);
    return res.status(500).json({ success: false, message: 'Failed to approve lesson plan.' });
  }
}

/**
 * POST /api/admin/lesson-plans/:id/revision
 */
export async function requestLessonPlanRevision(req: Request, res: Response): Promise<Response | void> {
  const reviewerNote = String(req.body?.reviewerNote || req.body?.note || '').trim();
  if (!reviewerNote) {
    return res.status(400).json({ success: false, message: 'A revision note is required so the teacher knows what to correct.' });
  }

  try {
    const plan = await prisma.lessonPlan.findUnique({
      where: { id: Number(req.params.id) },
      include: { teacher: { select: { branchId: true } } },
    });
    if (!plan || (req.branchId && plan.teacher.branchId !== req.branchId)) {
      return res.status(404).json({ success: false, message: 'Lesson plan not found.' });
    }

    const updated = await prisma.lessonPlan.update({
      where: { id: plan.id },
      data: { status: 'REVISION', reviewerNote },
      include: lessonPlanInclude(),
    });

    return res.json({ success: true, message: 'Lesson note sent back for revision. It is not an official school record.', plan: updated });
  } catch (error) {
    console.error('[ADMIN] Lesson plan revision error:', error);
    return res.status(500).json({ success: false, message: 'Failed to request revision.' });
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

/**
 * PUT /api/admin/classes/:id
 */
export async function updateClass(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const classId = Number(req.params.id);

  try {
    const { name, nameNumeric, isEcd } = req.body;
    const existing = await prisma.class.findFirst({
      where: { id: classId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    const updated = await prisma.class.update({
      where: { id: classId },
      data: {
        ...(name !== undefined && { name }),
        ...(nameNumeric !== undefined && { nameNumeric: String(nameNumeric) }),
        ...(isEcd !== undefined && { isEcd: !!isEcd }),
      },
    });

    return res.json({ success: true, class: updated, message: 'Class updated successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Update class error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to update class.' });
  }
}

/**
 * DELETE /api/admin/classes/:id
 */
export async function deleteClass(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const classId = Number(req.params.id);

  try {
    const existing = await prisma.class.findFirst({
      where: { id: classId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    await prisma.$transaction([
      prisma.sectionsAllocation.deleteMany({ where: { classId } }),
      prisma.subjectAssign.deleteMany({ where: { classId } }),
      prisma.class.delete({ where: { id: classId } }),
    ]);

    return res.json({ success: true, message: 'Class deleted successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Delete class error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to delete class.' });
  }
}

/**
 * PUT /api/admin/sections/:id
 */
export async function updateSection(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const sectionId = Number(req.params.id);

  try {
    const { name, capacity } = req.body;
    const existing = await prisma.section.findFirst({
      where: { id: sectionId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Section not found.' });
    }

    const updated = await prisma.section.update({
      where: { id: sectionId },
      data: {
        ...(name !== undefined && { name }),
        ...(capacity !== undefined && { capacity: String(capacity) }),
      },
    });

    return res.json({ success: true, section: updated, message: 'Section updated successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Update section error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to update section.' });
  }
}

/**
 * DELETE /api/admin/sections/:id
 */
export async function deleteSection(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const sectionId = Number(req.params.id);

  try {
    const existing = await prisma.section.findFirst({
      where: { id: sectionId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Section not found.' });
    }

    await prisma.$transaction([
      prisma.sectionsAllocation.deleteMany({ where: { sectionId } }),
      prisma.subjectAssign.deleteMany({ where: { sectionId } }),
      prisma.section.delete({ where: { id: sectionId } }),
    ]);

    return res.json({ success: true, message: 'Section deleted successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Delete section error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to delete section.' });
  }
}

/**
 * PUT /api/admin/subjects/:id
 */
export async function updateSubject(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const subjectId = Number(req.params.id);

  try {
    const { name, subjectCode, subjectType, subjectAuthor } = req.body;
    const existing = await prisma.subject.findFirst({
      where: { id: subjectId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Subject not found.' });
    }

    const updated = await prisma.subject.update({
      where: { id: subjectId },
      data: {
        ...(name !== undefined && { name }),
        ...(subjectCode !== undefined && { subjectCode }),
        ...(subjectType !== undefined && { subjectType }),
        ...(subjectAuthor !== undefined && { subjectAuthor }),
      },
    });

    return res.json({ success: true, subject: updated, message: 'Subject updated successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Update subject error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to update subject.' });
  }
}

/**
 * DELETE /api/admin/subjects/:id
 */
export async function deleteSubject(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const subjectId = Number(req.params.id);

  try {
    const existing = await prisma.subject.findFirst({
      where: { id: subjectId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Subject not found.' });
    }

    await prisma.$transaction([
      prisma.subjectAssign.deleteMany({ where: { subjectId } }),
      prisma.subject.delete({ where: { id: subjectId } }),
    ]);

    return res.json({ success: true, message: 'Subject deleted successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Delete subject error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to delete subject.' });
  }
}

/**
 * DELETE /api/admin/subjects/assign/:id
 */
export async function deleteSubjectAssignment(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const assignmentId = Number(req.params.id);

  try {
    const existing = await prisma.subjectAssign.findFirst({
      where: { id: assignmentId, branchId },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }

    await prisma.subjectAssign.delete({
      where: { id: assignmentId },
    });

    return res.json({ success: true, message: 'Subject assignment removed successfully.' });
  } catch (error: any) {
    console.error('[ADMIN] Delete subject assignment error:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to remove subject assignment.' });
  }
}
