import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { generateReportCardPdf, generateMontessoriReportCardPdf } from '../../lib/pdfService';

/**
 * GET /api/student/attendance
 */
export async function getAttendance(req: Request, res: Response): Promise<Response | void> {
  try {
    const logs = await prisma.attendance.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.sessionId,
        branchId: req.branchId,
      },
      orderBy: { attendanceDate: 'desc' },
    });

    const totalDays = logs.length;
    const presentCount = logs.filter((l) => l.status === 'Present').length;
    const absentCount = logs.filter((l) => l.status === 'Absent').length;
    const lateCount = logs.filter((l) => l.status === 'Late').length;
    const percentage = totalDays > 0 ? ((presentCount + lateCount) / totalDays) * 100 : 100;

    return res.json({
      success: true,
      percentage: Number(percentage.toFixed(1)),
      totalDays,
      presentCount,
      absentCount,
      lateCount,
      logs: logs.map((l) => ({
        id: l.id,
        attendanceDate: l.attendanceDate,
        status: l.status,
        remark: l.remark,
      })),
    });
  } catch (error) {
    console.error('[STUDENT] Attendance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve attendance logs.' });
  }
}

/**
 * GET /api/student/tasks
 */
export async function getTasks(req: Request, res: Response): Promise<Response | void> {
  let targetClassId = req.classId;
  if (!targetClassId && req.studentId) {
    const latestEnroll = await prisma.enroll.findFirst({
      where: { studentId: req.studentId, isAlumni: 0 },
      orderBy: { id: 'desc' },
      select: { classId: true },
    });
    targetClassId = latestEnroll?.classId || null;
  }

  if (!targetClassId) {
    return res.json({ success: true, notes: [], onlineExams: [], homeworks: [] });
  }

  try {
    const allNotes = await prisma.teacherNote.findMany({
      where: { branchId: req.branchId },
      include: {
        teacher: { select: { name: true } },
      },
    });

    const notes = allNotes
      .filter((n) => n.classId.split(',').map((s) => s.trim()).includes(String(targetClassId)))
      .map((n) => ({
        id: n.id,
        title: n.title,
        description: n.description,
        fileName: n.fileName,
        encName: n.encName,
        teacherName: n.teacher?.name || 'Staff',
        createdAt: n.createdAt,
      }));

    const onlineExams = await prisma.onlineExam.findMany({
      where: {
        classId: targetClassId,
        ...(req.branchId ? { branchId: req.branchId } : {}),
      },
      include: {
        subject: { select: { name: true } },
        submissions: {
          where: { studentId: req.studentId },
          select: { totalMark: true, createdAt: true },
        },
      },
    });

    const homeworks = await prisma.homework.findMany({
      where: {
        classId: targetClassId,
        ...(req.branchId ? { branchId: req.branchId } : {}),
      },
      include: {
        subject: { select: { name: true } },
        submissions: {
          where: { studentId: req.studentId },
          select: { id: true, score: true, feedback: true, createdAt: true },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    return res.json({
      success: true,
      notes,
      onlineExams: onlineExams.map((ex) => {
        const submission = ex.submissions[0] || null;
        return {
          id: ex.id,
          title: ex.title,
          subjectName: ex.subject.name,
          passingMark: ex.passingMark,
          submitted: !!submission,
          score: submission ? submission.totalMark : null,
          submittedAt: submission ? submission.createdAt : null,
          createdAt: ex.createdAt,
        };
      }),
      homeworks: homeworks.map((hw) => {
        const submission = hw.submissions[0] || null;
        return {
          id: hw.id,
          title: hw.title,
          subjectName: hw.subject?.name || 'General',
          dueDate: hw.dueDate,
          description: hw.description,
          questions: hw.questions || [],
          submitted: !!submission,
          submissionScore: submission?.score ?? null,
          submissionStatus: submission ? (submission.score !== null ? 'GRADED' : 'SUBMITTED') : 'PENDING',
          feedback: submission?.feedback || null,
          submittedAt: submission?.createdAt || null,
        };
      }),
    });
  } catch (error) {
    console.error('[STUDENT] Tasks error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve tasks.' });
  }
}

/**
 * GET /api/student/grades
 */
export async function getGrades(req: Request, res: Response): Promise<Response | void> {
  try {
    let isEcdClass = false;
    let clsInfo = null;
    if (req.classId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: req.classId },
        select: { name: true, isEcd: true },
      });
      isEcdClass = !!clsInfo?.isEcd;
    }

    if (isEcdClass) {
      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: req.studentId,
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId,
        },
        include: {
          exam: { select: { name: true } },
        },
      });
      return res.json({
        success: true,
        isEcd: true,
        assessment: assessment || {
          writingMastery: '',
          drawingCapability: '',
          physicalCoordination: '',
          motorSkillProgression: '',
          generalPunctuality: '',
          peerRespect: '',
          aestheticNeatness: '',
          activeGroupParticipation: '',
          narrativeComment: '',
        },
      });
    }

    const studentMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.sessionId,
        branchId: req.branchId,
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        exam: { select: { id: true, name: true } },
      },
    });

    if (studentMarks.length === 0) {
      return res.json({ success: true, reportCard: [], overallAverage: 0, commentary: null });
    }

    const subjectIds = Array.from(new Set(studentMarks.map((m) => m.subjectId)));
    const classMarks = await prisma.mark.findMany({
      where: {
        classId: req.classId,
        sectionId: req.sectionId,
        sessionId: req.sessionId,
        subjectId: { in: subjectIds },
      },
    });

    const classAverageMap: Record<string, { sum: number; count: number }> = {};
    classMarks.forEach((m) => {
      const key = `${m.examId}-${m.subjectId}`;
      if (!classAverageMap[key]) {
        classAverageMap[key] = { sum: 0, count: 0 };
      }
      const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0;
      const examVal = m.mark ? parseFloat(m.mark) : 0;
      const totalVal = testVal + examVal;
      if (m.cbtMark !== null || m.mark !== null) {
        classAverageMap[key].sum += totalVal;
        classAverageMap[key].count += 1;
      }
    });

    const commentary = await prisma.studentCommentary.findFirst({
      where: {
        studentId: req.studentId,
        sessionId: req.sessionId,
        status: 'PRINCIPAL_SIGNED_OFF',
      },
      select: { remark: true },
    });

    let totalScoreSum = 0;
    let marksCount = 0;

    const reportCard = studentMarks.map((m) => {
      const testScore = m.cbtMark !== null ? parseFloat(m.cbtMark) : 0;
      const examScore = m.mark !== null ? parseFloat(m.mark) : 0;
      const totalScore = testScore + examScore;

      let markValue = null;
      let studentScore = NaN;
      if (m.cbtMark !== null || m.mark !== null) {
        studentScore = totalScore;
        markValue = String(totalScore);
      }

      if (!isNaN(studentScore)) {
        totalScoreSum += studentScore;
        marksCount++;
      }

      const avgKey = `${m.examId}-${m.subjectId}`;
      const avgData = classAverageMap[avgKey];
      const classAverage =
        avgData && avgData.count > 0
          ? Number((avgData.sum / avgData.count).toFixed(1))
          : isNaN(studentScore)
          ? 0
          : studentScore;

      return {
        id: m.id,
        examName: m.exam.name,
        subjectName: m.subject.name,
        subjectCode: m.subject.subjectCode,
        cbtMark: m.cbtMark !== null ? String(testScore) : null,
        theoryMark: m.mark !== null ? String(examScore) : null,
        mark: markValue,
        absent: m.absent === '1' || m.absent === 'true',
        classAverage,
      };
    });

    const overallAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;

    let rank = null;
    let totalClassStudents = 0;

    if (req.classId && req.sectionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId,
        },
        select: { studentId: true },
      });
      const studentIds = enrolls.map((e) => e.studentId);
      totalClassStudents = studentIds.length;

      if (studentIds.length > 0) {
        const allMarks = await prisma.mark.findMany({
          where: {
            studentId: { in: studentIds },
            sessionId: req.sessionId,
            branchId: req.branchId,
          },
          select: { studentId: true, mark: true, cbtMark: true },
        });

        const studentAggregates: Record<number, { sum: number; count: number }> = {};
        studentIds.forEach((id) => {
          studentAggregates[id] = { sum: 0, count: 0 };
        });

        allMarks.forEach((m) => {
          const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0;
          const examVal = m.mark ? parseFloat(m.mark) : 0;
          const totalVal = testVal + examVal;
          if (m.cbtMark !== null || m.mark !== null) {
            studentAggregates[m.studentId].sum += totalVal;
            studentAggregates[m.studentId].count += 1;
          }
        });

        const rankedList = studentIds.map((id) => {
          const agg = studentAggregates[id];
          const average = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(2)) : 0;
          return { studentId: id, average };
        });

        rankedList.sort((a, b) => b.average - a.average);

        const myIndex = rankedList.findIndex((x) => x.studentId === req.studentId);
        if (myIndex !== -1) {
          rank = myIndex + 1;
        }
      }
    }

    return res.json({
      success: true,
      reportCard,
      overallAverage,
      commentary: commentary?.remark || null,
      rank,
      totalClassStudents,
    });
  } catch (error) {
    console.error('[STUDENT] Grades error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve grade card.' });
  }
}

/**
 * GET /api/student/grades/export-pdf
 */
export async function exportGradesPdf(req: Request, res: Response): Promise<Response | void> {
  try {
    const { rankingType = 'full', rankingLimit = 3 } = req.query as any;
    const limit = parseInt(rankingLimit as string, 10) || 3;

    let isEcdClass = false;
    let clsInfo = null;
    if (req.classId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: req.classId },
        select: { name: true, isEcd: true },
      });
      isEcdClass = !!clsInfo?.isEcd;
    }

    if (isEcdClass && clsInfo) {
      const student = await prisma.student.findUnique({
        where: { id: req.studentId },
        include: {
          branch: { select: { name: true, code: true } },
        },
      });
      if (!student) {
        return res.status(404).json({ success: false, message: 'Student not found.' });
      }

      let sectionName = 'N/A';
      let sessionName = 'N/A';
      let formTeacherName = 'Form Teacher';

      if (req.sectionId) {
        const sec = await prisma.section.findUnique({ where: { id: req.sectionId }, select: { name: true } });
        sectionName = sec?.name || 'N/A';
        const sess = await prisma.schoolYear.findUnique({ where: { id: req.sessionId }, select: { schoolYear: true } });
        sessionName = sess?.schoolYear || 'N/A';

        const formAllocation = await prisma.teacherAllocation.findFirst({
          where: {
            classId: req.classId,
            sectionId: req.sectionId,
            sessionId: req.sessionId,
            branchId: req.branchId,
          },
          include: {
            teacher: { select: { name: true } },
          },
        });
        if (formAllocation?.teacher) {
          formTeacherName = formAllocation.teacher.name;
        }
      }

      const examIdVal = req.query.examId ? Number(req.query.examId) : undefined;

      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: req.studentId,
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId,
          ...(examIdVal ? { examId: examIdVal } : {}),
        },
        include: {
          exam: { select: { name: true, resumptionDate: true } },
        },
      });

      const examName = assessment?.exam?.name || 'Term Evaluation';
      const resumptionDate = assessment?.exam?.resumptionDate || null;

      const pdfBuffer = await generateMontessoriReportCardPdf({
        schoolName: student.branch?.name || 'Ugbekun Schools',
        branchCode: student.branch?.code || 'GEN',
        studentName: `${student.lastName}, ${student.firstName}`,
        registerNo: student.registerNo,
        className: clsInfo.name,
        sectionName,
        sessionName,
        examName,
        assessment: assessment || {},
        resumptionDate,
        formTeacherName,
      });

      const safeLastName = (student.lastName || 'Student').replace(/\s+/g, '_');
      const safeFirstName = (student.firstName || 'Grades').replace(/\s+/g, '_');

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="report_card_${safeLastName}_${safeFirstName}.pdf"`);
      return res.send(pdfBuffer);
    }

    const student = await prisma.student.findUnique({
      where: { id: req.studentId },
      include: {
        branch: { select: { name: true, code: true } },
      },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    let className = 'N/A';
    let sectionName = 'N/A';
    let sessionName = 'N/A';
    let formTeacherName = 'Form Teacher';

    if (req.classId && req.sectionId) {
      const cls = await prisma.class.findUnique({ where: { id: req.classId }, select: { name: true } });
      className = cls?.name || 'N/A';
      const sec = await prisma.section.findUnique({ where: { id: req.sectionId }, select: { name: true } });
      sectionName = sec?.name || 'N/A';
      const sess = await prisma.schoolYear.findUnique({ where: { id: req.sessionId }, select: { schoolYear: true } });
      sessionName = sess?.schoolYear || 'N/A';

      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId,
        },
        include: {
          teacher: { select: { name: true } },
        },
      });
      if (formAllocation?.teacher) {
        formTeacherName = formAllocation.teacher.name;
      }
    }

    const studentMarks = await prisma.mark.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.sessionId,
        branchId: req.branchId,
      },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } },
      },
    });

    if (studentMarks.length === 0) {
      return res.status(400).json({ success: false, message: 'No grade records found to export.' });
    }

    const subjectIds = Array.from(new Set(studentMarks.map((m) => m.subjectId)));
    const classMarks = await prisma.mark.findMany({
      where: {
        classId: req.classId,
        sectionId: req.sectionId,
        sessionId: req.sessionId,
        subjectId: { in: subjectIds },
      },
    });

    const classAverageMap: Record<string, { sum: number; count: number }> = {};
    classMarks.forEach((m) => {
      const key = `${m.examId}-${m.subjectId}`;
      if (!classAverageMap[key]) {
        classAverageMap[key] = { sum: 0, count: 0 };
      }
      const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0;
      const examVal = m.mark ? parseFloat(m.mark) : 0;
      const totalVal = testVal + examVal;
      if (m.cbtMark !== null || m.mark !== null) {
        classAverageMap[key].sum += totalVal;
        classAverageMap[key].count += 1;
      }
    });

    let totalScoreSum = 0;
    let marksCount = 0;

    const reportCard = studentMarks.map((m) => {
      const testScore = m.cbtMark !== null ? parseFloat(m.cbtMark) : 0;
      const examScore = m.mark !== null ? parseFloat(m.mark) : 0;
      const totalScore = testScore + examScore;

      let markValue = null;
      let studentScore = NaN;
      if (m.cbtMark !== null || m.mark !== null) {
        studentScore = totalScore;
        markValue = String(totalScore);
      }

      if (!isNaN(studentScore)) {
        totalScoreSum += studentScore;
        marksCount++;
      }

      const avgKey = `${m.examId}-${m.subjectId}`;
      const avgData = classAverageMap[avgKey];
      const classAverage =
        avgData && avgData.count > 0
          ? Number((avgData.sum / avgData.count).toFixed(1))
          : isNaN(studentScore)
          ? 0
          : studentScore;

      return {
        id: m.id,
        examName: m.exam.name,
        subjectName: m.subject.name,
        subjectCode: m.subject.subjectCode,
        cbtMark: m.cbtMark !== null ? String(testScore) : null,
        theoryMark: m.mark !== null ? String(examScore) : null,
        mark: markValue,
        absent: m.absent === '1' || m.absent === 'true',
        classAverage,
      };
    });

    const overallAverage = marksCount > 0 ? Number((totalScoreSum / marksCount).toFixed(1)) : 0;

    let rank = null;
    let totalClassStudents = 0;

    if (req.classId && req.sectionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: req.classId,
          sectionId: req.sectionId,
          sessionId: req.sessionId,
          branchId: req.branchId,
        },
        select: { studentId: true },
      });
      const studentIds = enrolls.map((e) => e.studentId);
      totalClassStudents = studentIds.length;

      if (studentIds.length > 0) {
        const allMarks = await prisma.mark.findMany({
          where: {
            studentId: { in: studentIds },
            sessionId: req.sessionId,
            branchId: req.branchId,
          },
          select: { studentId: true, mark: true, cbtMark: true },
        });

        const studentAggregates: Record<number, { sum: number; count: number }> = {};
        studentIds.forEach((id) => {
          studentAggregates[id] = { sum: 0, count: 0 };
        });

        allMarks.forEach((m) => {
          const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0;
          const examVal = m.mark ? parseFloat(m.mark) : 0;
          const totalVal = testVal + examVal;
          if (m.cbtMark !== null || m.mark !== null) {
            studentAggregates[m.studentId].sum += totalVal;
            studentAggregates[m.studentId].count += 1;
          }
        });

        const rankedList = studentIds.map((id) => {
          const agg = studentAggregates[id];
          const average = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(2)) : 0;
          return { studentId: id, average };
        });

        rankedList.sort((a, b) => b.average - a.average);

        const myIndex = rankedList.findIndex((x) => x.studentId === req.studentId);
        if (myIndex !== -1) {
          rank = myIndex + 1;
        }
      }
    }

    const commentaryRecord = await prisma.studentCommentary.findFirst({
      where: {
        studentId: req.studentId,
        sessionId: req.sessionId,
        status: 'PRINCIPAL_SIGNED_OFF',
      },
      select: { remark: true },
    });

    const resumptionDate = studentMarks[0]?.exam.resumptionDate || null;

    const pdfBuffer = await generateReportCardPdf({
      schoolName: student.branch?.name || 'Ugbekun Schools',
      branchCode: student.branch?.code || 'GEN',
      studentName: `${student.lastName}, ${student.firstName}`,
      registerNo: student.registerNo,
      className,
      sectionName,
      sessionName,
      reportCard,
      overallAverage,
      commentary: commentaryRecord?.remark || '',
      rank,
      totalClassStudents,
      rankingType,
      rankingLimit: limit,
      resumptionDate,
      formTeacherName,
    });

    const safeLastName = (student.lastName || 'Student').replace(/\s+/g, '_');
    const safeFirstName = (student.firstName || 'Grades').replace(/\s+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report_card_${safeLastName}_${safeFirstName}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[STUDENT] Export PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate PDF report card.' });
  }
}

/**
 * GET /api/student/events
 */
export async function getEvents(req: Request, res: Response): Promise<Response | void> {
  try {
    const events = await prisma.event.findMany({
      where: {
        branchId: req.branchId,
        sessionId: req.sessionId,
      },
      orderBy: {
        startDate: 'asc',
      },
    });
    return res.json({ success: true, events });
  } catch (error) {
    console.error('[STUDENT] Get events error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch events.' });
  }
}

/**
 * GET /api/student/teachers
 */
export async function getTeachers(req: Request, res: Response): Promise<Response | void> {
  if (!req.classId) {
    return res.json({ success: true, formTeacher: null, subjectTeachers: [] });
  }

  try {
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: {
        classId: req.classId,
        ...(req.sectionId ? { sectionId: req.sectionId } : {}),
        branchId: req.branchId,
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
      orderBy: { id: 'desc' },
    });

    const subjectAssigns = await prisma.subjectAssign.findMany({
      where: {
        classId: req.classId,
        ...(req.sectionId ? { sectionId: req.sectionId } : {}),
        branchId: req.branchId,
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
    console.error('[STUDENT] Get teachers error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve teachers directory.' });
  }
}

/**
 * GET /api/student/timetable
 */
export async function getTimetable(req: Request, res: Response): Promise<Response | void> {
  if (!req.classId) {
    return res.json({ success: true, timetableSlots: [], examScheduleSlots: [] });
  }

  try {
    // 1. Try matching student's section or class-wide slots (sectionId: null)
    let timetableSlots = await prisma.timetableSlot.findMany({
      where: {
        classId: req.classId,
        branchId: req.branchId,
        isPublished: true,
        ...(req.sectionId
          ? {
              OR: [{ sectionId: req.sectionId }, { sectionId: null }],
            }
          : {}),
      },
      include: {
        class: { select: { id: true, name: true, nameNumeric: true } },
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } },
        teacher: { select: { id: true, name: true, phone: true, photo: true } },
      },
      orderBy: [{ startTime: 'asc' }],
    });

    // 2. Fallback: if student's specific section has 0 slots, load all published slots for this class
    if (timetableSlots.length === 0) {
      timetableSlots = await prisma.timetableSlot.findMany({
        where: {
          classId: req.classId,
          branchId: req.branchId,
          isPublished: true,
        },
        include: {
          class: { select: { id: true, name: true, nameNumeric: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } },
          teacher: { select: { id: true, name: true, phone: true, photo: true } },
        },
        orderBy: [{ startTime: 'asc' }],
      });
    }

    // 3. Fallback: if isPublished filtered everything out, load class slots
    if (timetableSlots.length === 0) {
      timetableSlots = await prisma.timetableSlot.findMany({
        where: {
          classId: req.classId,
          branchId: req.branchId,
        },
        include: {
          class: { select: { id: true, name: true, nameNumeric: true } },
          section: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, subjectCode: true, subjectType: true } },
          teacher: { select: { id: true, name: true, phone: true, photo: true } },
        },
        orderBy: [{ startTime: 'asc' }],
      });
    }

    let examScheduleSlots = await prisma.examScheduleSlot.findMany({
      where: {
        classId: req.classId,
        branchId: req.branchId,
        isPublished: true,
        ...(req.sectionId
          ? {
              OR: [{ sectionId: req.sectionId }, { sectionId: null }],
            }
          : {}),
      },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        hall: { select: { name: true, location: true } },
        invigilator: { select: { name: true } },
      },
      orderBy: { examDate: 'asc' },
    });

    if (examScheduleSlots.length === 0) {
      examScheduleSlots = await prisma.examScheduleSlot.findMany({
        where: {
          classId: req.classId,
          branchId: req.branchId,
          isPublished: true,
        },
        include: {
          subject: { select: { name: true, subjectCode: true } },
          hall: { select: { name: true, location: true } },
          invigilator: { select: { name: true } },
        },
        orderBy: { examDate: 'asc' },
      });
    }

    const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const grouped: Record<string, any[]> = {};
    DAYS.forEach((d) => {
      grouped[d] = [];
    });

    const mappedSlots = timetableSlots.map((slot) => {
      const item = {
        id: slot.id,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        time: `${slot.startTime} - ${slot.endTime}`,
        type: slot.type,
        title:
          slot.title ||
          slot.subject?.name ||
          (slot.type === 'BREAK' ? 'Break / Recess' : slot.type === 'ASSEMBLY' ? 'Morning Assembly' : 'Class Period'),
        subjectId: slot.subjectId,
        subjectName: slot.subject?.name || null,
        subjectCode: slot.subject?.subjectCode || null,
        subjectType: slot.subject?.subjectType || null,
        teacherId: slot.teacherId,
        teacherName: slot.teacher?.name || null,
        teacherPhone: slot.teacher?.phone || null,
        teacherPhoto: slot.teacher?.photo || null,
        className: slot.class?.name || null,
        sectionName: slot.section?.name || null,
        roomLabel: slot.section?.name || null,
        sessionId: slot.sessionId,
        isPublished: slot.isPublished,
      };

      if (grouped[slot.dayOfWeek]) {
        grouped[slot.dayOfWeek].push(item);
      } else {
        grouped[slot.dayOfWeek] = [item];
      }

      return item;
    });

    return res.json({
      success: true,
      timetableSlots: mappedSlots,
      grouped,
      examScheduleSlots: examScheduleSlots.map((slot) => ({
        id: slot.id,
        examDate: slot.examDate,
        startTime: slot.startTime,
        endTime: slot.endTime,
        instructions: slot.instructions,
        subjectName: slot.subject.name,
        subjectCode: slot.subject.subjectCode,
        hallName: slot.hall?.name || 'Main Exam Hall',
        invigilatorName: slot.invigilator?.name || 'Invigilator',
      })),
    });
  } catch (error) {
    console.error('[STUDENT] Timetable error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve timetable slots.' });
  }
}
