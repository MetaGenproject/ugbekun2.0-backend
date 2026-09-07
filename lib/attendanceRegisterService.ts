import { Prisma } from '@prisma/client';
import { classifySchoolDates, type SchoolDayClassification } from './schoolCalendarService';
import prisma from './prisma';
import {
  describeSchoolDate,
  isFutureSchoolDate,
  parseSchoolDateKey,
  requireSchoolDateKey,
  schoolDateStoredRange,
  schoolDateUtcMidnight,
  schoolWeekDateKeys,
  storedAttendanceDateKey,
  todaySchoolDateKey,
} from './schoolDate';

type DbClient = typeof prisma | Prisma.TransactionClient;

export const REGISTER_STATUS = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  LOCKED: 'LOCKED',
} as const;

export type RegisterStatus = (typeof REGISTER_STATUS)[keyof typeof REGISTER_STATUS];

export const ATTENDANCE_STATUS_VALUES = ['Present', 'Absent', 'Late', 'Excused', 'Sick'] as const;
export type AttendanceStatusValue = (typeof ATTENDANCE_STATUS_VALUES)[number];

const STATUS_ALIASES: Record<string, AttendanceStatusValue> = {
  present: 'Present',
  p: 'Present',
  '1': 'Present',
  h: 'Present',
  absent: 'Absent',
  a: 'Absent',
  '0': 'Absent',
  late: 'Late',
  l: 'Late',
  excused: 'Excused',
  e: 'Excused',
  sick: 'Sick',
  s: 'Sick',
};

export class AttendanceRegisterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
    public readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AttendanceRegisterError';
  }
}

function notSchoolDayError(classified: SchoolDayClassification) {
  const message =
    classified.isHoliday && classified.holidayTitle
      ? `${classified.holidayTitle} is not a school day. Add a Special school day on the calendar if classes sat.`
      : classified.isWeekend
        ? 'Weekends are not school days unless marked as a Special school day on the calendar.'
        : 'This date is not a school day.';
  return new AttendanceRegisterError('NOT_SCHOOL_DAY', message, 400, {
    isWeekend: classified.isWeekend,
    isHoliday: classified.isHoliday,
    holidayTitle: classified.holidayTitle,
  });
}

async function classifyDate(db: DbClient, branchId: number, dateKey: string) {
  const described = describeSchoolDate(dateKey);
  const [classified] = await classifySchoolDates(db, branchId, [dateKey], [described.isWeekend]);
  return { described, classified };
}

async function writeAudit(
  db: DbClient,
  row: {
    registerId: number;
    branchId: number;
    action: string;
    attendanceId?: number | null;
    studentId?: number | null;
    fromCode?: string | null;
    toCode?: string | null;
    actorUserId?: number | null;
    reason?: string | null;
  }
) {
  await db.attendanceAudit.create({
    data: {
      registerId: row.registerId,
      branchId: row.branchId,
      action: row.action,
      attendanceId: row.attendanceId ?? null,
      studentId: row.studentId ?? null,
      fromCode: row.fromCode ?? null,
      toCode: row.toCode ?? null,
      actorUserId: row.actorUserId ?? null,
      reason: row.reason ?? null,
    },
  });
}

export function normalizeAttendanceStatus(raw: unknown): AttendanceStatusValue | null {
  if (raw == null) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;
  return STATUS_ALIASES[key] ?? null;
}

export interface IncomingAttendanceLine {
  studentId?: unknown;
  status?: unknown;
  remark?: unknown;
}

export interface PlannedAttendanceEntry {
  studentId: number;
  status: AttendanceStatusValue;
  remark: string | null;
}

export function planRegisterEntries(args: {
  enrolledIds: number[];
  incoming: IncomingAttendanceLine[];
  markRemainingPresent?: boolean;
  requireComplete?: boolean;
}): { rows: PlannedAttendanceEntry[]; unmarkedIds: number[] } {
  const enrolled = new Set(args.enrolledIds);
  const unique = new Map<number, PlannedAttendanceEntry>();

  for (const item of args.incoming) {
    const studentId = Number(item.studentId);
    if (!studentId || !enrolled.has(studentId)) continue;
    const status = normalizeAttendanceStatus(item.status);
    if (!status) continue;
    const remarkRaw = item.remark != null ? String(item.remark).trim() : '';
    unique.set(studentId, {
      studentId,
      status,
      remark: remarkRaw || null,
    });
  }

  let unmarkedIds = args.enrolledIds.filter((id) => !unique.has(id));
  if (unmarkedIds.length > 0 && args.markRemainingPresent) {
    for (const studentId of unmarkedIds) {
      unique.set(studentId, { studentId, status: 'Present', remark: null });
    }
    unmarkedIds = [];
  }

  if (args.requireComplete && unmarkedIds.length > 0) {
    throw new AttendanceRegisterError(
      'INCOMPLETE',
      `Register incomplete: ${unmarkedIds.length} student${unmarkedIds.length === 1 ? '' : 's'} unmarked. Code every name, or send markRemainingPresent=true after an explicit confirmation.`,
      400,
      { unmarkedCount: unmarkedIds.length }
    );
  }

  return { rows: Array.from(unique.values()), unmarkedIds };
}

export function summarizeEntries(
  enrolledIds: number[],
  entries: Array<{ studentId: number; status: string }>
) {
  const byStudent = new Map(entries.map((row) => [row.studentId, normalizeAttendanceStatus(row.status)]));
  let present = 0;
  let absent = 0;
  let late = 0;
  let excused = 0;
  let sick = 0;
  let unmarked = 0;

  for (const studentId of enrolledIds) {
    const status = byStudent.get(studentId);
    if (status === 'Present') present += 1;
    else if (status === 'Absent') absent += 1;
    else if (status === 'Late') late += 1;
    else if (status === 'Excused') excused += 1;
    else if (status === 'Sick') sick += 1;
    else unmarked += 1;
  }

  return { total: enrolledIds.length, present, absent, late, excused, sick, unmarked };
}

export function summarizeDailyPresence(summary: {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  sick: number;
  unmarked: number;
}) {
  const coded = summary.total - summary.unmarked;
  const inAttendance = summary.present + summary.late;
  return {
    ...summary,
    coded,
    inAttendance,
    attendanceRate: coded > 0 ? Number(((inAttendance / coded) * 100).toFixed(1)) : 0,
  };
}

export function submittedAttendanceWhere(
  extra: Prisma.AttendanceWhereInput = {}
): Prisma.AttendanceWhereInput {
  return {
    AND: [
      extra,
      {
        OR: [
          { register: { status: { in: [REGISTER_STATUS.SUBMITTED, REGISTER_STATUS.LOCKED] } } },
          { registerId: null },
        ],
      },
    ],
  };
}

export function summarizeSubmittedLogs(logs: Array<{ status?: string | null }>) {
  let presentCount = 0;
  let absentCount = 0;
  let lateCount = 0;
  let excusedCount = 0;
  let sickCount = 0;

  for (const log of logs) {
    const status = normalizeAttendanceStatus(log.status);
    if (status === 'Present') presentCount += 1;
    else if (status === 'Absent') absentCount += 1;
    else if (status === 'Late') lateCount += 1;
    else if (status === 'Excused') excusedCount += 1;
    else if (status === 'Sick') sickCount += 1;
  }

  const totalDays = presentCount + absentCount + lateCount + excusedCount + sickCount;
  const inAttendance = presentCount + lateCount;
  const percentage = totalDays > 0 ? Number(((inAttendance / totalDays) * 100).toFixed(1)) : 100;

  return {
    totalDays,
    presentCount,
    absentCount,
    lateCount,
    excusedCount,
    sickCount,
    inAttendance,
    percentage,
  };
}

export function summarizeSubmittedAttendanceByStudent(
  logs: Array<{ studentId: number; status?: string | null }>
) {
  const grouped = new Map<number, Array<{ status?: string | null }>>();
  for (const log of logs) {
    const rows = grouped.get(log.studentId) || [];
    rows.push(log);
    grouped.set(log.studentId, rows);
  }

  const byStudent = new Map<number, ReturnType<typeof summarizeSubmittedLogs>>();
  for (const [studentId, rows] of grouped) {
    byStudent.set(studentId, summarizeSubmittedLogs(rows));
  }
  return byStudent;
}

export const CHRONIC_ABSENCE_PERCENT_THRESHOLD = 80;
export const CHRONIC_ABSENCE_MIN_CODED_DAYS = 4;

export function isChronicAbsentee(summary: { percentage: number; totalDays: number }): boolean {
  return summary.totalDays >= CHRONIC_ABSENCE_MIN_CODED_DAYS && summary.percentage < CHRONIC_ABSENCE_PERCENT_THRESHOLD;
}

export interface MonthlyEnrollRow {
  studentId: number;
  classId: number;
  sectionId: number;
  className: string;
  sectionName: string;
  roll?: number | null;
  firstName?: string | null;
  lastName?: string | null;
  registerNo?: string | null;
}

export function buildMonthlyAttendanceTables(
  enrolls: MonthlyEnrollRow[],
  logs: Array<{ studentId: number; status?: string | null }>
) {
  const byStudent = summarizeSubmittedAttendanceByStudent(logs);
  const empty = summarizeSubmittedLogs([]);

  const students = enrolls.map((row) => {
    const summary = byStudent.get(row.studentId) || empty;
    const percentage = summary.totalDays > 0 ? summary.percentage : 0;
    const nameParts = [row.lastName, row.firstName].map((part) => String(part || '').trim()).filter(Boolean);
    return {
      studentId: row.studentId,
      name: nameParts.length ? nameParts.join(', ') : `Student #${row.studentId}`,
      firstName: row.firstName || '',
      lastName: row.lastName || '',
      registerNo: row.registerNo || null,
      roll: row.roll ?? null,
      classId: row.classId,
      sectionId: row.sectionId,
      className: row.className,
      sectionName: row.sectionName,
      streamName: [row.className, row.sectionName].filter(Boolean).join(' '),
      presentCount: summary.presentCount,
      absentCount: summary.absentCount,
      lateCount: summary.lateCount,
      excusedCount: summary.excusedCount,
      sickCount: summary.sickCount,
      codedDays: summary.totalDays,
      percentage,
      chronic: isChronicAbsentee({ percentage, totalDays: summary.totalDays }),
    };
  });

  const streamMap = new Map<string, typeof students>();
  for (const student of students) {
    const key = `${student.classId}:${student.sectionId}`;
    const list = streamMap.get(key) || [];
    list.push(student);
    streamMap.set(key, list);
  }

  const streams = Array.from(streamMap.values())
    .map((list) => {
      const first = list[0];
      const codedDays = list.reduce((sum, student) => sum + student.codedDays, 0);
      const inAttendance = list.reduce((sum, student) => sum + student.presentCount + student.lateCount, 0);
      return {
        classId: first.classId,
        sectionId: first.sectionId,
        className: first.className,
        sectionName: first.sectionName,
        streamName: first.streamName,
        enrolled: list.length,
        codedDays,
        averagePresenceRate: codedDays > 0 ? Number(((inAttendance / codedDays) * 100).toFixed(1)) : 0,
        chronicAbsenteeCount: list.filter((student) => student.chronic).length,
      };
    })
    .sort((a, b) => a.streamName.localeCompare(b.streamName, undefined, { numeric: true, sensitivity: 'base' }));

  const codedDays = students.reduce((sum, student) => sum + student.codedDays, 0);
  const inAttendance = students.reduce((sum, student) => sum + student.presentCount + student.lateCount, 0);

  return {
    streams,
    students,
    metrics: {
      enrolledStudents: students.length,
      codedDays,
      averagePresenceRate: codedDays > 0 ? Number(((inAttendance / codedDays) * 100).toFixed(1)) : 0,
      chronicAbsenteeCount: students.filter((student) => student.chronic).length,
    },
  };
}

export async function listSubmittedAttendance(
  db: DbClient,
  args: {
    branchId: number;
    sessionId?: number;
    studentId?: number;
    studentIds?: number[];
    classId?: number;
    sectionId?: number;
    dateFromKey?: string;
    dateToKey?: string;
    order?: 'asc' | 'desc';
  }
) {
  if (args.studentIds && args.studentIds.length === 0) {
    return { logs: [], summary: summarizeSubmittedLogs([]) };
  }

  const dateRange =
    args.dateFromKey && args.dateToKey
      ? {
          attendanceDate: {
            gte: schoolDateStoredRange(args.dateFromKey).gte,
            lt: schoolDateStoredRange(args.dateToKey).lt,
          },
        }
      : {};

  const logs = await db.attendance.findMany({
    where: submittedAttendanceWhere({
      branchId: args.branchId,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.studentId ? { studentId: args.studentId } : {}),
      ...(args.studentIds ? { studentId: { in: args.studentIds } } : {}),
      ...(args.classId ? { classId: args.classId } : {}),
      ...(args.sectionId ? { sectionId: args.sectionId } : {}),
      ...dateRange,
    }),
    orderBy: { attendanceDate: args.order ?? 'desc' },
    select: {
      id: true,
      studentId: true,
      status: true,
      remark: true,
      attendanceDate: true,
    },
  });

  return { logs, summary: summarizeSubmittedLogs(logs) };
}

async function loadEnrolledStudentIds(
  db: DbClient,
  args: {
    branchId: number;
    sessionId: number;
    classId: number;
    sectionId: number;
    studentIds?: number[];
  }
): Promise<number[]> {
  const enrolls = await db.enroll.findMany({
    where: {
      branchId: args.branchId,
      sessionId: args.sessionId,
      classId: args.classId,
      sectionId: args.sectionId,
      ...(args.studentIds?.length ? { studentId: { in: args.studentIds } } : {}),
    },
    select: { studentId: true, roll: true },
    orderBy: [{ roll: 'asc' }, { studentId: 'asc' }],
  });
  return enrolls.map((row) => row.studentId);
}

async function loadRoster(
  db: DbClient,
  args: { branchId: number; sessionId: number; classId: number; sectionId: number }
) {
  const enrolls = await db.enroll.findMany({
    where: {
      branchId: args.branchId,
      sessionId: args.sessionId,
      classId: args.classId,
      sectionId: args.sectionId,
    },
    include: {
      student: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          registerNo: true,
          gender: true,
        },
      },
    },
    orderBy: [{ roll: 'asc' }, { studentId: 'asc' }],
  });

  return enrolls.map((row) => ({
    studentId: row.student.id,
    roll: row.roll,
    registerNo: row.student.registerNo,
    firstName: row.student.firstName,
    lastName: row.student.lastName,
    gender: row.student.gender,
  }));
}

function serializeRegister(register: {
  id: number;
  classId: number;
  sectionId: number;
  registerDate: Date;
  sessionId: number;
  branchId: number;
  status: string;
  takenByTeacherId: number | null;
  submittedAt: Date | null;
  version: number;
  notes: string | null;
  unlockedAt?: Date | null;
  unlockedReason?: string | null;
  takenByTeacher?: { id: number; name: string } | null;
}) {
  const dateKey = parseSchoolDateKey(register.registerDate) || storedAttendanceDateKey(register.registerDate);
  return {
    id: register.id,
    classId: register.classId,
    sectionId: register.sectionId,
    registerDate: dateKey,
    sessionId: register.sessionId,
    branchId: register.branchId,
    status: register.status,
    takenByTeacherId: register.takenByTeacherId,
    takenByTeacherName: register.takenByTeacher?.name ?? null,
    submittedAt: register.submittedAt,
    version: register.version,
    notes: register.notes,
    unlockedAt: register.unlockedAt ?? null,
    unlockedReason: register.unlockedReason ?? null,
    canEdit: register.status === REGISTER_STATUS.DRAFT,
  };
}

export async function findRegister(
  db: DbClient,
  args: { branchId: number; sessionId: number; classId: number; sectionId: number; dateKey: string }
) {
  const registerDate = schoolDateUtcMidnight(args.dateKey);
  return db.attendanceRegister.findUnique({
    where: {
      branchId_sessionId_classId_sectionId_registerDate: {
        branchId: args.branchId,
        sessionId: args.sessionId,
        classId: args.classId,
        sectionId: args.sectionId,
        registerDate,
      },
    },
    include: {
      takenByTeacher: { select: { id: true, name: true } },
    },
  });
}

export async function openOrGetRegister(
  db: DbClient,
  args: {
    branchId: number;
    sessionId: number;
    classId: number;
    sectionId: number;
    dateKey: string;
    teacherId?: number | null;
    allowFuture?: boolean;
  }
) {
  const dateKey = requireSchoolDateKey(args.dateKey);
  if (!args.allowFuture && isFutureSchoolDate(dateKey)) {
    throw new AttendanceRegisterError('FUTURE_DATE', 'Cannot open a register for a future school date.', 400);
  }

  const existing = await findRegister(db, { ...args, dateKey });
  if (existing) return existing;

  const { classified } = await classifyDate(db, args.branchId, dateKey);
  if (!classified.isSchoolDay) throw notSchoolDayError(classified);

  try {
    return await db.attendanceRegister.create({
      data: {
        branchId: args.branchId,
        sessionId: args.sessionId,
        classId: args.classId,
        sectionId: args.sectionId,
        registerDate: schoolDateUtcMidnight(dateKey),
        status: REGISTER_STATUS.DRAFT,
        version: 1,
        takenByTeacherId: args.teacherId ?? null,
      },
      include: {
        takenByTeacher: { select: { id: true, name: true } },
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const raced = await findRegister(db, { ...args, dateKey });
      if (raced) return raced;
    }
    throw error;
  }
}

async function upsertAttendanceRow(
  db: DbClient,
  row: {
    registerId: number;
    studentId: number;
    classId: number;
    sectionId: number;
    sessionId: number;
    branchId: number;
    attendanceDate: Date;
    status: string;
    remark: string | null;
    markedByTeacherId: number | null;
  }
) {
  const existing = await db.attendance.findFirst({
    where: {
      OR: [
        { registerId: row.registerId, studentId: row.studentId },
        {
          studentId: row.studentId,
          sessionId: row.sessionId,
          branchId: row.branchId,
          attendanceDate: row.attendanceDate,
        },
      ],
    },
    select: { id: true, status: true },
  });

  const data = {
    classId: row.classId,
    sectionId: row.sectionId,
    attendanceDate: row.attendanceDate,
    status: row.status,
    remark: row.remark,
    sessionId: row.sessionId,
    branchId: row.branchId,
    registerId: row.registerId,
    markedByTeacherId: row.markedByTeacherId,
  };

  if (existing) {
    return db.attendance.update({ where: { id: existing.id }, data });
  }

  try {
    return await db.attendance.create({
      data: {
        studentId: row.studentId,
        ...data,
      },
    });
  } catch (error: any) {
    if (error?.code !== 'P2002') throw error;
    const again = await db.attendance.findFirst({
      where: {
        OR: [
          { registerId: row.registerId, studentId: row.studentId },
          {
            studentId: row.studentId,
            sessionId: row.sessionId,
            branchId: row.branchId,
            attendanceDate: row.attendanceDate,
          },
        ],
      },
      select: { id: true },
    });
    if (!again) throw error;
    return db.attendance.update({ where: { id: again.id }, data });
  }
}

type WriteMode = 'patch' | 'submit' | 'legacy-save' | 'admin-save';

function assertWritable(register: { status: string }, mode: WriteMode) {
  if (register.status === REGISTER_STATUS.LOCKED || register.status === REGISTER_STATUS.SUBMITTED) {
    if (mode === 'admin-save') return;
    throw new AttendanceRegisterError(
      'LOCKED',
      'This register is locked. Ask a school admin to unlock it before editing.',
      409
    );
  }
  if (mode === 'patch' && register.status !== REGISTER_STATUS.DRAFT) {
    throw new AttendanceRegisterError(
      'NOT_DRAFT',
      'Draft autosave is only allowed while the register is still a draft.',
      409
    );
  }
}

function assertCurrentVersion(register: { version: number }, expectedVersion?: number) {
  if (expectedVersion == null) return;
  if (register.version !== Number(expectedVersion)) {
    throw new AttendanceRegisterError(
      'STALE_VERSION',
      'This register was updated elsewhere. Reload and try again.',
      409,
      { currentVersion: register.version }
    );
  }
}

export async function upsertEntries(
  db: DbClient,
  args: {
    registerId: number;
    branchId: number;
    teacherId?: number | null;
    actorUserId?: number | null;
    expectedVersion?: number;
    entries: IncomingAttendanceLine[];
    markRemainingPresent?: boolean;
    requireComplete?: boolean;
    mode?: WriteMode;
  }
) {
  const register = await db.attendanceRegister.findFirst({
    where: { id: args.registerId, branchId: args.branchId },
  });
  if (!register) {
    throw new AttendanceRegisterError('NOT_FOUND', 'Attendance register not found.', 404);
  }

  const mode = args.mode ?? 'patch';
  assertWritable(register, mode);
  assertCurrentVersion(register, args.expectedVersion);

  const dateKey = parseSchoolDateKey(register.registerDate) || storedAttendanceDateKey(register.registerDate);
  const attendanceDate = schoolDateUtcMidnight(dateKey);
  const incomingIds = args.entries.map((item) => Number(item.studentId)).filter(Boolean);
  const enrolledIds = await loadEnrolledStudentIds(db, {
    branchId: register.branchId,
    sessionId: register.sessionId,
    classId: register.classId,
    sectionId: register.sectionId,
    studentIds: mode === 'patch' && incomingIds.length ? incomingIds : undefined,
  });
  const enrolledSet = new Set(enrolledIds);
  const auditEdits = Boolean(register.submittedAt);

  if (mode === 'patch') {
    for (const item of args.entries) {
      const studentId = Number(item.studentId);
      if (!studentId || !enrolledSet.has(studentId)) continue;
      const status = normalizeAttendanceStatus(item.status);
      const remarkRaw = item.remark != null ? String(item.remark).trim() : '';
      if (!status) {
        const existing = await db.attendance.findFirst({
          where: { registerId: register.id, studentId },
          select: { id: true, status: true },
        });
        await db.attendance.deleteMany({ where: { registerId: register.id, studentId } });
        if (auditEdits && existing) {
          await writeAudit(db, {
            registerId: register.id,
            branchId: register.branchId,
            action: 'EDIT',
            attendanceId: existing.id,
            studentId,
            fromCode: existing.status,
            toCode: null,
            actorUserId: args.actorUserId,
          });
        }
        continue;
      }
      const before = await db.attendance.findFirst({
        where: { registerId: register.id, studentId },
        select: { id: true, status: true },
      });
      await upsertAttendanceRow(db, {
        registerId: register.id,
        studentId,
        classId: register.classId,
        sectionId: register.sectionId,
        sessionId: register.sessionId,
        branchId: register.branchId,
        attendanceDate,
        status,
        remark: remarkRaw || null,
        markedByTeacherId: args.teacherId ?? null,
      });
      if (auditEdits && (before?.status || null) !== status) {
        await writeAudit(db, {
          registerId: register.id,
          branchId: register.branchId,
          action: 'EDIT',
          attendanceId: before?.id ?? null,
          studentId,
          fromCode: before?.status ?? null,
          toCode: status,
          actorUserId: args.actorUserId,
        });
      }
    }

    const updated = await db.attendanceRegister.update({
      where: { id: register.id },
      data: {
        takenByTeacherId: args.teacherId ?? register.takenByTeacherId,
      },
      include: {
        takenByTeacher: { select: { id: true, name: true } },
      },
    });
    return { register: updated, planned: { rows: [], unmarkedIds: [] } };
  }

  const planned = planRegisterEntries({
    enrolledIds,
    incoming: args.entries,
    markRemainingPresent: args.markRemainingPresent,
    requireComplete: args.requireComplete,
  });

  for (const row of planned.rows) {
    await upsertAttendanceRow(db, {
      registerId: register.id,
      studentId: row.studentId,
      classId: register.classId,
      sectionId: register.sectionId,
      sessionId: register.sessionId,
      branchId: register.branchId,
      attendanceDate,
      status: row.status,
      remark: row.remark,
      markedByTeacherId: args.teacherId ?? null,
    });
  }

  const bumpVersion = mode === 'submit' || mode === 'legacy-save';
  const nextStatus =
    mode === 'submit' || mode === 'legacy-save' ? REGISTER_STATUS.SUBMITTED : register.status;

  const updated = await db.attendanceRegister.update({
    where: { id: register.id },
    data: {
      takenByTeacherId: args.teacherId ?? register.takenByTeacherId,
      submittedAt:
        nextStatus === REGISTER_STATUS.SUBMITTED ? register.submittedAt ?? new Date() : register.submittedAt,
      status: nextStatus,
      ...(bumpVersion ? { version: { increment: 1 } } : {}),
    },
    include: {
      takenByTeacher: { select: { id: true, name: true } },
    },
  });

  if (nextStatus === REGISTER_STATUS.SUBMITTED) {
    await writeAudit(db, {
      registerId: register.id,
      branchId: register.branchId,
      action: 'SUBMIT',
      actorUserId: args.actorUserId,
    });
  }

  return { register: updated, planned };
}

export async function getRegisterWithEntries(
  db: DbClient,
  args: { branchId: number; sessionId: number; classId: number; sectionId: number; dateKey: string }
) {
  const dateKey = requireSchoolDateKey(args.dateKey);
  const roster = await loadRoster(db, args);
  const enrolledIds = roster.map((row) => row.studentId);
  const register = await findRegister(db, { ...args, dateKey });

  let rawEntries: Array<{ studentId: number; status: string; remark: string | null; markedByTeacherId: number | null }> = [];

  if (register) {
    const rows = await db.attendance.findMany({
      where: { registerId: register.id, branchId: args.branchId },
      select: { studentId: true, status: true, remark: true, markedByTeacherId: true },
    });
    rawEntries = rows;
  } else {
    const range = schoolDateStoredRange(dateKey);
    const rows = await db.attendance.findMany({
      where: {
        branchId: args.branchId,
        sessionId: args.sessionId,
        classId: args.classId,
        sectionId: args.sectionId,
        attendanceDate: range,
      },
      select: {
        studentId: true,
        status: true,
        remark: true,
        markedByTeacherId: true,
        attendanceDate: true,
      },
    });
    rawEntries = rows
      .filter((row) => storedAttendanceDateKey(row.attendanceDate) === dateKey)
      .map((row) => ({
        studentId: row.studentId,
        status: row.status,
        remark: row.remark,
        markedByTeacherId: row.markedByTeacherId,
      }));
  }

  const entries = rawEntries.map((row) => ({
    studentId: row.studentId,
    status: normalizeAttendanceStatus(row.status) || row.status,
    remark: row.remark,
    markedByTeacherId: row.markedByTeacherId,
  }));

  const { described, classified } = await classifyDate(db, args.branchId, dateKey);
  const calendar = {
    ...described,
    isHoliday: classified.isHoliday,
    isSpecialSchoolDay: classified.isSpecialSchoolDay,
    isSchoolDay: classified.isSchoolDay,
    holidayTitle: classified.holidayTitle,
  };
  const canEdit =
    !calendar.isFuture &&
    calendar.isSchoolDay &&
    (!register || register.status === REGISTER_STATUS.DRAFT);

  return {
    register: register ? serializeRegister(register) : null,
    roster,
    entries,
    summary: summarizeEntries(enrolledIds, entries),
    calendar,
    canEdit,
    today: todaySchoolDateKey(),
  };
}

export async function submitRegister(
  db: DbClient,
  args: {
    registerId?: number;
    branchId: number;
    sessionId: number;
    classId: number;
    sectionId: number;
    dateKey: string;
    teacherId?: number | null;
    actorUserId?: number | null;
    expectedVersion?: number;
    entries?: IncomingAttendanceLine[];
    markRemainingPresent?: boolean;
    allowFuture?: boolean;
    mode?: WriteMode;
  }
) {
  const register = args.registerId
    ? await db.attendanceRegister.findFirst({
        where: { id: args.registerId, branchId: args.branchId },
      })
    : await openOrGetRegister(db, args);

  if (!register || register.branchId !== args.branchId) {
    throw new AttendanceRegisterError('NOT_FOUND', 'Attendance register not found.', 404);
  }

  return upsertEntries(db, {
    registerId: register.id,
    branchId: args.branchId,
    teacherId: args.teacherId,
    actorUserId: args.actorUserId,
    expectedVersion: args.expectedVersion,
    entries: args.entries || [],
    markRemainingPresent: args.markRemainingPresent,
    requireComplete: true,
    mode: args.mode ?? 'submit',
  });
}

export async function getWeekMatrix(
  db: DbClient,
  args: { branchId: number; sessionId: number; classId: number; sectionId: number; dateKey: string }
) {
  const dateKeys = schoolWeekDateKeys(requireSchoolDateKey(args.dateKey));
  const days = [];
  for (const dateKey of dateKeys) {
    const snapshot = await getRegisterWithEntries(db, { ...args, dateKey });
    days.push({
      dateKey,
      weekday: snapshot.calendar.weekday,
      weekdayShort: snapshot.calendar.weekdayShort,
      isToday: snapshot.calendar.isToday,
      isFuture: snapshot.calendar.isFuture,
      isWeekend: snapshot.calendar.isWeekend,
      isHoliday: snapshot.calendar.isHoliday,
      isSpecialSchoolDay: snapshot.calendar.isSpecialSchoolDay,
      isSchoolDay: snapshot.calendar.isSchoolDay,
      holidayTitle: snapshot.calendar.holidayTitle,
      canEdit: snapshot.canEdit,
      register: snapshot.register,
      summary: snapshot.summary,
    });
  }
  return { dateKeys, days };
}

export async function unlockRegister(
  db: DbClient,
  args: {
    branchId: number;
    registerId?: number;
    sessionId: number;
    classId?: number;
    sectionId?: number;
    dateKey?: string;
    reason: string;
    actorUserId?: number | null;
  }
) {
  const reason = String(args.reason || '').trim();
  if (reason.length < 3) {
    throw new AttendanceRegisterError('REASON_REQUIRED', 'Unlock reason is required (at least 3 characters).', 400);
  }

  const register = args.registerId
    ? await db.attendanceRegister.findFirst({
        where: { id: args.registerId, branchId: args.branchId },
        include: { takenByTeacher: { select: { id: true, name: true } } },
      })
    : await findRegister(db, {
        branchId: args.branchId,
        sessionId: args.sessionId,
        classId: Number(args.classId),
        sectionId: Number(args.sectionId),
        dateKey: requireSchoolDateKey(args.dateKey),
      });

  if (!register) {
    throw new AttendanceRegisterError('NOT_FOUND', 'Attendance register not found.', 404);
  }
  if (register.status !== REGISTER_STATUS.SUBMITTED && register.status !== REGISTER_STATUS.LOCKED) {
    throw new AttendanceRegisterError('NOT_LOCKED', 'Only a submitted or locked register can be unlocked.', 400);
  }

  const updated = await db.attendanceRegister.update({
    where: { id: register.id },
    data: {
      status: REGISTER_STATUS.DRAFT,
      unlockedAt: new Date(),
      unlockedByUserId: args.actorUserId ?? null,
      unlockedReason: reason,
      version: { increment: 1 },
    },
    include: { takenByTeacher: { select: { id: true, name: true } } },
  });

  await writeAudit(db, {
    registerId: register.id,
    branchId: args.branchId,
    action: 'UNLOCK',
    actorUserId: args.actorUserId,
    reason,
  });

  return updated;
}

export async function listRegisterAudits(db: DbClient, args: { branchId: number; registerId: number }) {
  return db.attendanceAudit.findMany({
    where: { registerId: args.registerId, branchId: args.branchId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function backfillAttendanceRegisters(db: DbClient = prisma) {
  await db.$executeRawUnsafe(`
    UPDATE attendance
    SET attendance_date = (((attendance_date AT TIME ZONE 'Africa/Lagos')::date)::timestamp AT TIME ZONE 'UTC')
    WHERE attendance_date IS NOT NULL
  `);

  await db.$executeRawUnsafe(`
    DELETE FROM attendance a
    USING attendance b
    WHERE a.student_id = b.student_id
      AND a.session_id = b.session_id
      AND a.branch_id = b.branch_id
      AND a.attendance_date = b.attendance_date
      AND a.id < b.id
  `);

  await db.$executeRawUnsafe(`
    INSERT INTO attendance_registers (
      class_id, section_id, register_date, session_id, branch_id, status, version, submitted_at, created_at
    )
    SELECT DISTINCT
      a.class_id,
      a.section_id,
      (a.attendance_date AT TIME ZONE 'UTC')::date,
      a.session_id,
      a.branch_id,
      'SUBMITTED',
      1,
      NOW(),
      NOW()
    FROM attendance a
    INNER JOIN branches b ON b.id = a.branch_id
    INNER JOIN class c ON c.id = a.class_id
    INNER JOIN section s ON s.id = a.section_id
    ON CONFLICT (branch_id, session_id, class_id, section_id, register_date) DO NOTHING
  `);

  const linked = await db.$executeRawUnsafe(`
    UPDATE attendance a
    SET register_id = r.id
    FROM attendance_registers r
    WHERE a.register_id IS NULL
      AND a.class_id = r.class_id
      AND a.section_id = r.section_id
      AND a.session_id = r.session_id
      AND a.branch_id = r.branch_id
      AND (a.attendance_date AT TIME ZONE 'UTC')::date = r.register_date
  `);

  return { linked };
}

export function toLegacyAttendancePayload(
  entries: Array<{ studentId: number; status: string; remark: string | null }>
) {
  return entries.map((row) => ({
    studentId: row.studentId,
    status: row.status,
    remark: row.remark,
  }));
}
