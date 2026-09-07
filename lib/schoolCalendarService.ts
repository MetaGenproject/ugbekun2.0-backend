import { parseSchoolDateKey, storedAttendanceDateKey } from './schoolDate';

export const EVENT_KIND = {
  EVENT: 'EVENT',
  HOLIDAY: 'HOLIDAY',
  CLOSURE: 'CLOSURE',
  SCHOOL_DAY: 'SCHOOL_DAY',
} as const;

export type EventKind = (typeof EVENT_KIND)[keyof typeof EVENT_KIND];

export interface CalendarEventLike {
  title?: string | null;
  kind?: string | null;
  startDate: Date;
  endDate?: Date | null;
}

export interface SchoolDayClassification {
  dateKey: string;
  isWeekend: boolean;
  isHoliday: boolean;
  isSpecialSchoolDay: boolean;
  isSchoolDay: boolean;
  holidayTitle: string | null;
}

const HOLIDAY_TITLE_RE =
  /\b(holiday|mid-?term|midterm|break|vacation|vocation|closure|closed|public holiday|independence|democracy day|workers['’]? day|christmas|easter|eid)\b/i;
const SPECIAL_DAY_TITLE_RE = /\b(special school day|saturday school|weekend class|makeup school|make-up school)\b/i;

export function inferEventKind(title?: string | null, kind?: string | null): EventKind {
  const normalized = String(kind || '').trim().toUpperCase();
  if (
    normalized === EVENT_KIND.HOLIDAY ||
    normalized === EVENT_KIND.CLOSURE ||
    normalized === EVENT_KIND.SCHOOL_DAY ||
    normalized === EVENT_KIND.EVENT
  ) {
    if (normalized !== EVENT_KIND.EVENT) return normalized as EventKind;
  }
  const text = String(title || '');
  if (SPECIAL_DAY_TITLE_RE.test(text)) return EVENT_KIND.SCHOOL_DAY;
  if (HOLIDAY_TITLE_RE.test(text)) return EVENT_KIND.HOLIDAY;
  return EVENT_KIND.EVENT;
}

function eventDateKey(value: Date): string {
  return parseSchoolDateKey(value) || storedAttendanceDateKey(value);
}

export function eventCoversDate(event: CalendarEventLike, dateKey: string): boolean {
  const startKey = eventDateKey(event.startDate);
  const endKey = event.endDate ? eventDateKey(event.endDate) : startKey;
  return dateKey >= startKey && dateKey <= endKey;
}

export function classifySchoolDateFromEvents(
  dateKey: string,
  events: CalendarEventLike[],
  isWeekend: boolean
): SchoolDayClassification {
  const covering = events.filter((event) => eventCoversDate(event, dateKey));
  const special = covering.find((event) => inferEventKind(event.title, event.kind) === EVENT_KIND.SCHOOL_DAY);
  const holiday = covering.find((event) => {
    const kind = inferEventKind(event.title, event.kind);
    return kind === EVENT_KIND.HOLIDAY || kind === EVENT_KIND.CLOSURE;
  });

  const isSpecialSchoolDay = Boolean(special);
  const isHoliday = Boolean(holiday) && !isSpecialSchoolDay;
  const isSchoolDay = isSpecialSchoolDay || (!isWeekend && !isHoliday);

  return {
    dateKey,
    isWeekend,
    isHoliday,
    isSpecialSchoolDay,
    isSchoolDay,
    holidayTitle: isHoliday ? holiday?.title || 'School holiday' : null,
  };
}

export async function loadBranchCalendarEvents(db: { event: { findMany: Function } }, branchId: number) {
  return db.event.findMany({
    where: { branchId },
    select: { title: true, kind: true, startDate: true, endDate: true },
  }) as Promise<CalendarEventLike[]>;
}

export async function classifySchoolDates(
  db: { event: { findMany: Function } },
  branchId: number,
  dateKeys: string[],
  weekendFlags: boolean[]
): Promise<SchoolDayClassification[]> {
  const events = await loadBranchCalendarEvents(db, branchId);
  return dateKeys.map((dateKey, index) =>
    classifySchoolDateFromEvents(dateKey, events, Boolean(weekendFlags[index]))
  );
}
