const assert = require('node:assert/strict');
const {
  dateKeyFromUtcMidnight,
  describeSchoolDate,
  isFutureSchoolDate,
  isWeekendSchoolDate,
  parseSchoolDateKey,
  parseSchoolMonthKey,
  schoolDateUtcMidnight,
  schoolMonthDateKeys,
  schoolMonthLabel,
  schoolWeekDateKeys,
  storedAttendanceDateKey,
  todaySchoolDateKey,
} = require('../../lib/schoolDate');
const {
  AttendanceRegisterError,
  buildMonthlyAttendanceTables,
  isChronicAbsentee,
  normalizeAttendanceStatus,
  planRegisterEntries,
  summarizeEntries,
  summarizeDailyPresence,
  summarizeSubmittedLogs,
} = require('../../lib/attendanceRegisterService');
const { inferEventKind, classifySchoolDateFromEvents } = require('../../lib/schoolCalendarService');
const { normalizeNigerianPhone } = require('../../lib/smsService');

async function testAttendanceRegisterUnit() {
  console.log('\n--- [UNIT TEST] Attendance register date + planning ---');

  assert.equal(parseSchoolDateKey('2026-09-07'), '2026-09-07');
  assert.equal(parseSchoolDateKey('2026-09-07T15:00:00.000Z'), '2026-09-07');
  assert.equal(parseSchoolDateKey('2026-02-30'), null);
  assert.equal(parseSchoolDateKey('07-09-2026'), null);
  assert.equal(parseSchoolDateKey(''), null);

  const utcMidnight = schoolDateUtcMidnight('2026-09-07');
  assert.equal(utcMidnight.toISOString(), '2026-09-07T00:00:00.000Z');
  assert.equal(dateKeyFromUtcMidnight(utcMidnight), '2026-09-07');
  assert.equal(utcMidnight.getUTCHours(), 0);
  console.log('✓ School date keys parse as Africa/Lagos calendar DATE, not local Date()');

  const lagosMidnightAsUtc = new Date('2026-09-06T23:00:00.000Z');
  assert.equal(storedAttendanceDateKey(lagosMidnightAsUtc), '2026-09-07');
  assert.equal(storedAttendanceDateKey(utcMidnight), '2026-09-07');
  console.log('✓ Legacy Lagos-midnight DateTime rows map to the same school date');

  const week = schoolWeekDateKeys('2026-09-09');
  assert.deepEqual(week, ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
  assert.equal(isFutureSchoolDate('2099-01-01'), true);
  assert.equal(isFutureSchoolDate(todaySchoolDateKey()), false);
  assert.equal(isWeekendSchoolDate('2026-09-06'), true);
  assert.equal(isWeekendSchoolDate('2026-09-07'), false);
  const described = describeSchoolDate('2026-09-07');
  assert.equal(described.weekday, 'Monday');
  assert.equal(described.isWeekend, false);
  console.log('✓ Week strip is Monday–Friday; weekends and future school dates are described');

  assert.equal(normalizeAttendanceStatus('PRESENT'), 'Present');
  assert.equal(normalizeAttendanceStatus('a'), 'Absent');
  assert.equal(normalizeAttendanceStatus('Late'), 'Late');
  assert.equal(normalizeAttendanceStatus('E'), 'Excused');
  assert.equal(normalizeAttendanceStatus(''), null);
  assert.equal(normalizeAttendanceStatus('maybe'), null);
  console.log('✓ Attendance codes normalize to Present/Absent/Late/Excused/Sick');

  const planned = planRegisterEntries({
    enrolledIds: [1, 2, 3],
    incoming: [
      { studentId: 1, status: 'Present' },
      { studentId: 2, status: '' },
      { studentId: 99, status: 'Absent' },
    ],
    requireComplete: false,
  });
  assert.equal(planned.rows.length, 1);
  assert.deepEqual(planned.unmarkedIds, [2, 3]);

  let incompleteThrown = false;
  try {
    planRegisterEntries({
      enrolledIds: [1, 2],
      incoming: [{ studentId: 1, status: 'Present' }],
      requireComplete: true,
    });
  } catch (error) {
    incompleteThrown = error instanceof AttendanceRegisterError && error.code === 'INCOMPLETE';
    assert.equal(error.extra.unmarkedCount, 1);
  }
  assert.equal(incompleteThrown, true, 'Incomplete submit must throw INCOMPLETE');

  const filled = planRegisterEntries({
    enrolledIds: [1, 2],
    incoming: [{ studentId: 1, status: 'Absent', remark: 'sick' }],
    markRemainingPresent: true,
    requireComplete: true,
  });
  assert.equal(filled.rows.length, 2);
  assert.equal(filled.rows.find((row) => row.studentId === 2).status, 'Present');
  assert.equal(filled.unmarkedIds.length, 0);
  console.log('✓ Unmarked students are not written as Present unless markRemainingPresent is explicit');

  const summary = summarizeEntries(
    [1, 2, 3, 4],
    [
      { studentId: 1, status: 'Present' },
      { studentId: 2, status: 'Late' },
      { studentId: 3, status: 'Absent' },
    ]
  );
  assert.equal(summary.present, 1);
  assert.equal(summary.late, 1);
  assert.equal(summary.absent, 1);
  assert.equal(summary.unmarked, 1);
  const daily = summarizeDailyPresence(summary);
  assert.equal(daily.inAttendance, 2);
  assert.equal(daily.coded, 3);
  assert.equal(daily.attendanceRate, 66.7);
  const emptyDay = summarizeDailyPresence(summarizeEntries([1, 2], []));
  assert.equal(emptyDay.attendanceRate, 0);
  assert.equal(emptyDay.unmarked, 2);
  console.log('✓ Register summary counts unmarked separately from Present');
  console.log('✓ Daily presence % is Present+Late over marked students only');

  assert.equal(inferEventKind('PTA Meeting', 'EVENT'), 'EVENT');
  assert.equal(inferEventKind('Independence Day', 'EVENT'), 'HOLIDAY');
  assert.equal(inferEventKind('Midterm Break', null), 'HOLIDAY');
  assert.equal(inferEventKind('Saturday school', 'EVENT'), 'SCHOOL_DAY');
  assert.equal(inferEventKind('Sports day', 'HOLIDAY'), 'HOLIDAY');
  assert.equal(inferEventKind('Sports day', 'SCHOOL_DAY'), 'SCHOOL_DAY');
  console.log('✓ Event kind infers holidays and special school days from titles');

  const monday = '2026-09-07';
  const saturday = '2026-09-12';
  const holidayEvent = {
    title: 'Midterm Break',
    kind: 'EVENT',
    startDate: new Date('2026-09-07T00:00:00.000Z'),
    endDate: new Date('2026-09-11T00:00:00.000Z'),
  };
  const specialSaturday = {
    title: 'Saturday school',
    kind: 'SCHOOL_DAY',
    startDate: new Date('2026-09-12T00:00:00.000Z'),
    endDate: null,
  };
  const sportsEvent = {
    title: 'Inter-house sports',
    kind: 'EVENT',
    startDate: new Date('2026-09-07T00:00:00.000Z'),
    endDate: null,
  };

  const weekdayOpen = classifySchoolDateFromEvents(monday, [sportsEvent], false);
  assert.equal(weekdayOpen.isSchoolDay, true);
  assert.equal(weekdayOpen.isHoliday, false);

  const weekdayHoliday = classifySchoolDateFromEvents(monday, [holidayEvent], false);
  assert.equal(weekdayHoliday.isSchoolDay, false);
  assert.equal(weekdayHoliday.isHoliday, true);
  assert.match(String(weekdayHoliday.holidayTitle), /Midterm/);

  const weekendClosed = classifySchoolDateFromEvents(saturday, [], true);
  assert.equal(weekendClosed.isSchoolDay, false);
  assert.equal(weekendClosed.isWeekend, true);

  const weekendOpen = classifySchoolDateFromEvents(saturday, [specialSaturday], true);
  assert.equal(weekendOpen.isSchoolDay, true);
  assert.equal(weekendOpen.isSpecialSchoolDay, true);

  const holidayOverride = classifySchoolDateFromEvents(
    monday,
    [holidayEvent, { ...specialSaturday, startDate: new Date('2026-09-07T00:00:00.000Z'), title: 'Makeup school' }],
    false
  );
  assert.equal(holidayOverride.isSchoolDay, true);
  assert.equal(holidayOverride.isHoliday, false);
  console.log('✓ Weekends/holidays are not school days unless a special school day covers the date');

  assert.equal(normalizeNigerianPhone('08031234567'), '+2348031234567');
  assert.equal(normalizeNigerianPhone('+2348031234567'), '+2348031234567');
  assert.equal(normalizeNigerianPhone('8031234567'), '+2348031234567');
  console.log('✓ Nigerian phone numbers normalize for absence SMS');

  const published = summarizeSubmittedLogs([
    { status: 'Present' },
    { status: 'Late' },
    { status: 'Absent' },
    { status: 'Excused' },
    { status: 'Sick' },
    { status: '' },
  ]);
  assert.equal(published.totalDays, 5);
  assert.equal(published.inAttendance, 2);
  assert.equal(published.presentCount, 1);
  assert.equal(published.lateCount, 1);
  assert.equal(published.absentCount, 1);
  assert.equal(published.excusedCount, 1);
  assert.equal(published.sickCount, 1);
  assert.equal(published.percentage, 40);
  console.log('✓ Published attendance % uses submitted codes only: Present+Late over coded school days');

  assert.equal(parseSchoolMonthKey('2026-09'), '2026-09');
  assert.equal(parseSchoolMonthKey('2026-09-07'), '2026-09');
  assert.equal(parseSchoolMonthKey('2026-13'), null);
  assert.equal(schoolMonthDateKeys('2026-09').length, 30);
  assert.equal(schoolMonthDateKeys('2026-09')[0], '2026-09-01');
  assert.equal(schoolMonthDateKeys('2026-09')[29], '2026-09-30');
  assert.equal(schoolMonthLabel('2026-09'), 'September 2026');
  console.log('✓ School month keys expand to Africa/Lagos calendar days');

  assert.equal(isChronicAbsentee({ percentage: 0, totalDays: 3 }), false);
  assert.equal(isChronicAbsentee({ percentage: 60, totalDays: 5 }), true);
  assert.equal(isChronicAbsentee({ percentage: 80, totalDays: 10 }), false);

  const monthly = buildMonthlyAttendanceTables(
    [
      { studentId: 1, classId: 10, sectionId: 2, className: 'Primary 1', sectionName: 'Gold', firstName: 'Omena', lastName: 'Ebor', registerNo: 'REG/1', roll: 1 },
      { studentId: 2, classId: 10, sectionId: 2, className: 'Primary 1', sectionName: 'Gold', firstName: 'Ada', lastName: 'Okoro', registerNo: 'REG/2', roll: 2 },
      { studentId: 3, classId: 11, sectionId: 3, className: 'Primary 2', sectionName: 'Blue', firstName: 'Tunde', lastName: 'Bello', registerNo: 'REG/3', roll: 1 },
    ],
    [
      { studentId: 1, status: 'Present' },
      { studentId: 1, status: 'Present' },
      { studentId: 1, status: 'Absent' },
      { studentId: 1, status: 'Absent' },
      { studentId: 1, status: 'Absent' },
      { studentId: 2, status: 'Present' },
      { studentId: 2, status: 'Late' },
    ]
  );
  assert.equal(monthly.streams.length, 2);
  assert.equal(monthly.metrics.enrolledStudents, 3);
  assert.equal(monthly.metrics.chronicAbsenteeCount, 1);
  const gold = monthly.streams.find((row) => row.streamName === 'Primary 1 Gold');
  assert.equal(gold.enrolled, 2);
  assert.equal(gold.chronicAbsenteeCount, 1);
  assert.equal(gold.averagePresenceRate, 57.1);
  const ebor = monthly.students.find((row) => row.studentId === 1);
  assert.equal(ebor.chronic, true);
  assert.equal(ebor.percentage, 40);
  console.log('✓ Monthly report groups class streams and flags chronic absentees below 80%');
}

module.exports = { testAttendanceRegisterUnit };

if (require.main === module) {
  testAttendanceRegisterUnit()
    .then(() => {
      console.log('\nAttendance register unit tests passed.');
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
