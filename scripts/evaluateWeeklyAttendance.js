require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const gamificationService = require('../lib/gamificationService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function run() {
  console.log('[Weekly Attendance Evaluation] Starting job...');
  
  // Define current week range: Monday 12 AM to Friday 11:59 PM
  const now = new Date();
  const day = now.getDay();
  
  // Monday of this week
  const monday = new Date(now);
  const mDiff = now.getDate() - day + (day === 0 ? -6 : 1);
  monday.setDate(mDiff);
  monday.setHours(0, 0, 0, 0);

  // Friday of this week
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  friday.setHours(23, 59, 59, 999);

  console.log(`[Weekly Attendance Evaluation] Evaluating range: ${monday.toISOString()} to ${friday.toISOString()}`);

  try {
    const branches = await prisma.branch.findMany();
    for (const branch of branches) {
      console.log(`[Weekly Attendance Evaluation] Evaluating branch: ${branch.name} (ID: ${branch.id})`);

      // --- TEACHER EVALUATION ---
      const teachers = await prisma.teacher.findMany({
        where: { branchId: branch.id }
      });

      for (const teacher of teachers) {
        const allocations = await prisma.teacherAllocation.findMany({
          where: { teacherId: teacher.id }
        });

        if (allocations.length === 0) continue;

        let perfectWeek = true;

        for (const alloc of allocations) {
          for (let i = 0; i < 5; i++) {
            const checkDate = new Date(monday);
            checkDate.setDate(monday.getDate() + i);

            const startOfDay = new Date(checkDate);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(checkDate);
            endOfDay.setHours(23, 59, 59, 999);

            const attendances = await prisma.attendance.findMany({
              where: {
                classId: alloc.classId,
                sectionId: alloc.sectionId,
                attendanceDate: {
                  gte: startOfDay,
                  lte: endOfDay
                }
              }
            });

            if (attendances.length === 0) {
              perfectWeek = false;
              break;
            }

            const latestCreated = attendances.reduce((latest, current) => {
              const created = current.createdAt || new Date();
              return created > latest ? created : latest;
            }, new Date(0));

            const targetDeadline = new Date(checkDate);
            targetDeadline.setHours(9, 0, 0, 0);

            if (latestCreated > targetDeadline) {
              perfectWeek = false;
              break;
            }
          }

          if (!perfectWeek) break;
        }

        if (perfectWeek) {
          console.log(`[Weekly Attendance Evaluation] Teacher ID ${teacher.id} qualifies for perfect attendance.`);
          
          const refIdStr = `${teacher.id}_${monday.getFullYear()}_${monday.getMonth()}_${monday.getDate()}`;
          const refIdInt = Math.abs(refIdStr.split('').reduce((a, b) => {
            a = ((a << 5) - a) + b.charCodeAt(0);
            return a & a;
          }, 0));

          await gamificationService.awardPoints(prisma, {
            actorType: 'TEACHER',
            actorId: teacher.id,
            points: 250,
            actionType: 'WEEKLY_ATTENDANCE_PERFECT',
            referenceEntity: 'WeeklyAttendance',
            referenceId: refIdInt,
            branchId: branch.id,
            metadata: { monday: monday.toISOString(), friday: friday.toISOString() }
          }).catch(err => console.error(`[Weekly Attendance Evaluation] Failed to award points to Teacher ${teacher.id}:`, err.message));
        }
      }

      // --- STUDENT EVALUATION ---
      const students = await prisma.student.findMany({
        where: { branchId: branch.id }
      });

      for (const student of students) {
        const enrollment = await prisma.enroll.findFirst({
          where: { studentId: student.id, isAlumni: 0 }
        });

        if (!enrollment) continue;

        const attendances = await prisma.attendance.findMany({
          where: {
            classId: enrollment.classId,
            sectionId: enrollment.sectionId,
            attendanceDate: {
              gte: monday,
              lte: friday
            }
          }
        });

        if (attendances.length === 0) continue;

        const studentAttendances = attendances.filter(a => a.studentId === student.id);
        if (studentAttendances.length === 0) continue;

        const alwaysPresent = studentAttendances.every(a => {
          const status = (a.status || '').trim().toLowerCase();
          return status === 'present';
        });

        if (alwaysPresent) {
          console.log(`[Weekly Attendance Evaluation] Student ID ${student.id} qualifies for perfect attendance.`);
          
          const refIdStr = `${student.id}_${monday.getFullYear()}_${monday.getMonth()}_${monday.getDate()}`;
          const refIdInt = Math.abs(refIdStr.split('').reduce((a, b) => {
            a = ((a << 5) - a) + b.charCodeAt(0);
            return a & a;
          }, 0));

          await gamificationService.awardPoints(prisma, {
            actorType: 'STUDENT',
            actorId: student.id,
            points: 100,
            actionType: 'WEEKLY_ATTENDANCE_PERFECT',
            referenceEntity: 'WeeklyAttendance',
            referenceId: refIdInt,
            branchId: branch.id,
            metadata: { monday: monday.toISOString(), friday: friday.toISOString() }
          }).catch(err => console.error(`[Weekly Attendance Evaluation] Failed to award points to Student ${student.id}:`, err.message));
        }
      }
    }
  } catch (error) {
    console.error('[Weekly Attendance Evaluation] Job failed with error:', error);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

run();
