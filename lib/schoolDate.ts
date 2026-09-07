/**
 * School calendar dates for attendance.
 *
 * Registers are keyed by a calendar DATE in Africa/Lagos, not by a UTC DateTime.
 * Client payloads must send YYYY-MM-DD. Never parse that string with `new Date(value)`
 * in a local timezone — that is UTC midnight in some engines and local midnight in others.
 */

export const SCHOOL_TIMEZONE = 'Africa/Lagos';

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const lagosDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHOOL_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Returns YYYY-MM-DD or null. Accepts a full ISO string and uses the date prefix. */
export function parseSchoolDateKey(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return dateKeyFromUtcMidnight(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const prefix = trimmed.length >= 10 ? trimmed.slice(0, 10) : trimmed;
  const match = DATE_KEY_RE.exec(prefix);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function requireSchoolDateKey(value: unknown): string {
  const key = parseSchoolDateKey(value);
  if (!key) {
    throw new Error('Invalid school date. Use YYYY-MM-DD.');
  }
  return key;
}

/** UTC Date at 00:00:00.000Z for a Lagos calendar date. Safe for Prisma @db.Date and legacy DateTime columns. */
export function schoolDateUtcMidnight(dateKey: string): Date {
  const parsed = requireSchoolDateKey(dateKey);
  const [year, month, day] = parsed.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Inclusive UTC midnight → exclusive next UTC midnight. */
export function schoolDateUtcRange(dateKey: string): { gte: Date; lt: Date } {
  const gte = schoolDateUtcMidnight(dateKey);
  const lt = new Date(gte.getTime() + 24 * 60 * 60 * 1000);
  return { gte, lt };
}

/**
 * Window that also covers historical rows stored as Africa/Lagos local midnight
 * (UTC previous day 23:00). Callers must still filter with storedAttendanceDateKey.
 */
export function schoolDateStoredRange(dateKey: string): { gte: Date; lt: Date } {
  const utc = schoolDateUtcMidnight(dateKey);
  return {
    gte: new Date(utc.getTime() - 60 * 60 * 1000),
    lt: new Date(utc.getTime() + 24 * 60 * 60 * 1000),
  };
}

export function dateKeyFromUtcMidnight(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Calendar date in Africa/Lagos for an instant (legacy DateTime rows). */
export function storedAttendanceDateKey(value: Date): string {
  return lagosDateFormatter.format(value);
}

export function todaySchoolDateKey(now: Date = new Date()): string {
  return lagosDateFormatter.format(now);
}

export function isFutureSchoolDate(dateKey: string, now: Date = new Date()): boolean {
  return requireSchoolDateKey(dateKey) > todaySchoolDateKey(now);
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function schoolDateWeekdayIndex(dateKey: string): number {
  return schoolDateUtcMidnight(dateKey).getUTCDay();
}

export function schoolDateWeekdayName(dateKey: string): string {
  return WEEKDAY_NAMES[schoolDateWeekdayIndex(dateKey)];
}

export function isWeekendSchoolDate(dateKey: string): boolean {
  const dow = schoolDateWeekdayIndex(dateKey);
  return dow === 0 || dow === 6;
}

export function describeSchoolDate(dateKey: string, now: Date = new Date()) {
  const key = requireSchoolDateKey(dateKey);
  const weekday = schoolDateWeekdayName(key);
  return {
    dateKey: key,
    weekday,
    weekdayShort: weekday.slice(0, 3),
    isWeekend: isWeekendSchoolDate(key),
    isFuture: isFutureSchoolDate(key, now),
    isToday: key === todaySchoolDateKey(now),
  };
}

/** Monday–Friday date keys of the school week that contains `dateKey`. */
export function schoolWeekDateKeys(dateKey: string): string[] {
  const utc = schoolDateUtcMidnight(dateKey);
  const dow = utc.getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(utc.getTime() + mondayOffset * 86400000);
  return [0, 1, 2, 3, 4].map((offset) =>
    dateKeyFromUtcMidnight(new Date(monday.getTime() + offset * 86400000))
  );
}

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

/** Returns YYYY-MM or null. Also accepts a YYYY-MM-DD school date. */
export function parseSchoolMonthKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const monthMatch = MONTH_KEY_RE.exec(trimmed);
  if (monthMatch) {
    const month = Number(monthMatch[2]);
    if (month < 1 || month > 12) return null;
    return `${monthMatch[1]}-${monthMatch[2]}`;
  }
  const dateKey = parseSchoolDateKey(trimmed);
  return dateKey ? dateKey.slice(0, 7) : null;
}

export function todaySchoolMonthKey(now: Date = new Date()): string {
  return todaySchoolDateKey(now).slice(0, 7);
}

export function schoolMonthDateKeys(monthKey: string): string[] {
  const parsed = parseSchoolMonthKey(monthKey);
  if (!parsed) return [];
  const [year, month] = parsed.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: lastDay }, (_, index) => `${parsed}-${String(index + 1).padStart(2, '0')}`);
}

export function schoolMonthLabel(monthKey: string): string {
  const parsed = parseSchoolMonthKey(monthKey);
  if (!parsed) return '';
  const [year, month] = parsed.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Inclusive stored-date window covering every calendar day in the month. */
export function schoolMonthStoredRange(monthKey: string): { gte: Date; lt: Date } | null {
  const keys = schoolMonthDateKeys(monthKey);
  if (keys.length === 0) return null;
  return {
    gte: schoolDateStoredRange(keys[0]).gte,
    lt: schoolDateStoredRange(keys[keys.length - 1]).lt,
  };
}
