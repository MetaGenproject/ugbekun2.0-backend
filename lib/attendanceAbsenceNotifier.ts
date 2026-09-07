import prisma from './prisma';
import { sendMail } from './emailService';
import { sendSms } from './smsService';

function studentName(student: { firstName?: string | null; lastName?: string | null; id: number }) {
  return [student.firstName, student.lastName].filter(Boolean).join(' ') || `Student #${student.id}`;
}

export async function notifyParentsOfSubmittedAbsences(args: {
  branchId: number;
  className?: string;
  sectionName?: string;
  dateKey: string;
  absences: Array<{ studentId: number; status: string; remark?: string | null }>;
}) {
  if (!args.absences.length) return { notified: 0 };

  const settings = await prisma.systemSetting.findUnique({
    where: { branchId: args.branchId },
    select: {
      autoSmsAttendance: true,
      schoolName: true,
      notificationChannel: true,
      maxAbsentDaysAlert: true,
    },
  });

  const autoSms = settings?.autoSmsAttendance !== false;
  const channel = (settings?.notificationChannel || 'ALL').toUpperCase();
  const schoolName = settings?.schoolName || 'School';
  const classLabel = [args.className, args.sectionName].filter(Boolean).join(' ');

  const students = await prisma.student.findMany({
    where: { id: { in: args.absences.map((row) => row.studentId) }, branchId: args.branchId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      parentId: true,
      parent: { select: { id: true, name: true, email: true, mobileno: true } },
    },
  });
  const byId = new Map(students.map((student) => [student.id, student]));

  let notified = 0;
  for (const absence of args.absences) {
    const student = byId.get(absence.studentId);
    const parent = student?.parent;
    if (!student || !parent) continue;

    const name = studentName(student);
    const statusWord = absence.status.toLowerCase();
    const subject = `${name} marked ${statusWord} — ${args.dateKey}`;
    const message = `${name} was marked ${statusWord} on the class register for ${args.dateKey}${
      classLabel ? ` (${classLabel})` : ''
    } at ${schoolName}.${absence.remark ? ` Remark: ${absence.remark}.` : ''} Please contact the form teacher if this is unexpected.`;

    await prisma.parentMessage
      .create({
        data: {
          branchId: args.branchId,
          parentId: parent.id,
          studentId: student.id,
          senderType: 'SYSTEM',
          recipientRole: 'PARENT',
          subject,
          message,
        },
      })
      .catch((error) => console.warn('[ATTENDANCE] parent message failed:', error?.message || error));

    if (autoSms && (channel === 'ALL' || channel === 'EMAIL') && parent.email) {
      await sendMail(
        parent.email,
        subject,
        `<p>${message}</p><p style="color:#64748b;font-size:12px">${schoolName} attendance register</p>`
      ).catch(() => null);
    }

    if (autoSms && (channel === 'ALL' || channel === 'SMS')) {
      await sendSms(parent.mobileno, `${schoolName}: ${name} was marked ${statusWord} on ${args.dateKey}.`);
    }

    notified += 1;
  }

  return { notified };
}
