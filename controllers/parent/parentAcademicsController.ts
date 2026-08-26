import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { generateReportCardPdf, generateMontessoriReportCardPdf } from '../../lib/pdfService';

/**
 * GET /api/parent/child/:studentId/attendance
 */
export async function getChildAttendance(req: Request, res: Response): Promise<Response | void> {
  try {
    const logs = await prisma.attendance.findMany({
      where: {
        studentId: req.studentId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
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
    console.error('[PARENT] Child attendance error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve child attendance logs.' });
  }
}

/**
 * GET /api/parent/child/:studentId/tasks
 */
export async function getChildTasks(req: Request, res: Response): Promise<Response | void> {
  if (!req.childClassId) {
    return res.json({ success: true, notes: [], onlineExams: [] });
  }

  try {
    const allNotes = await prisma.teacherNote.findMany({
      where: { branchId: req.studentBranchId },
      include: {
        teacher: { select: { name: true } },
      },
    });

    const notes = allNotes
      .filter((n) => n.classId.split(',').map((s) => s.trim()).includes(String(req.childClassId)))
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
        classId: req.childClassId,
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
      },
      include: {
        subject: { select: { name: true } },
        submissions: {
          where: { studentId: req.studentId },
          select: { totalMark: true, createdAt: true },
        },
      },
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
    });
  } catch (error) {
    console.error('[PARENT] Child tasks error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve child tasks.' });
  }
}

/**
 * GET /api/parent/child/:studentId/grades
 */
export async function getChildGrades(req: Request, res: Response): Promise<Response | void> {
  try {
    let isEcdClass = false;
    let clsInfo = null;
    if (req.childClassId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: req.childClassId },
        select: { name: true, isEcd: true },
      });
      isEcdClass = !!clsInfo?.isEcd;
    }

    if (isEcdClass) {
      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: req.studentId,
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
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
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
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
        classId: req.childClassId,
        sectionId: req.childSectionId,
        sessionId: req.childSessionId,
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
        sessionId: req.childSessionId,
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

    if (req.childClassId && req.childSectionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
        select: { studentId: true },
      });
      const studentIds = enrolls.map((e) => e.studentId);
      totalClassStudents = studentIds.length;

      if (studentIds.length > 0) {
        const allMarks = await prisma.mark.findMany({
          where: {
            studentId: { in: studentIds },
            sessionId: req.childSessionId,
            branchId: req.studentBranchId,
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
    console.error('[PARENT] Child grades error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve child grade card.' });
  }
}

/**
 * GET /api/parent/child/:studentId/export-pdf
 */
export async function exportChildReportPdf(req: Request, res: Response): Promise<Response | void> {
  try {
    const { rankingType = 'full', rankingLimit = 3 } = req.query as any;
    const limit = parseInt(rankingLimit as string, 10) || 3;

    let isEcdClass = false;
    let clsInfo = null;
    if (req.childClassId) {
      clsInfo = await prisma.class.findUnique({
        where: { id: req.childClassId },
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

      if (req.childSectionId) {
        const sec = await prisma.section.findUnique({ where: { id: req.childSectionId }, select: { name: true } });
        sectionName = sec?.name || 'N/A';
        const sess = await prisma.schoolYear.findUnique({ where: { id: req.childSessionId }, select: { schoolYear: true } });
        sessionName = sess?.schoolYear || 'N/A';

        const formAllocation = await prisma.teacherAllocation.findFirst({
          where: {
            classId: req.childClassId,
            sectionId: req.childSectionId,
            sessionId: req.childSessionId,
            branchId: req.studentBranchId,
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
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
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

    if (req.childClassId && req.childSectionId) {
      const cls = await prisma.class.findUnique({ where: { id: req.childClassId }, select: { name: true } });
      className = cls?.name || 'N/A';
      const sec = await prisma.section.findUnique({ where: { id: req.childSectionId }, select: { name: true } });
      sectionName = sec?.name || 'N/A';
      const sess = await prisma.schoolYear.findUnique({ where: { id: req.childSessionId }, select: { schoolYear: true } });
      sessionName = sess?.schoolYear || 'N/A';

      const formAllocation = await prisma.teacherAllocation.findFirst({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
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
        sessionId: req.childSessionId,
        branchId: req.studentBranchId,
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
        classId: req.childClassId,
        sectionId: req.childSectionId,
        sessionId: req.childSessionId,
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

    if (req.childClassId && req.childSectionId) {
      const enrolls = await prisma.enroll.findMany({
        where: {
          classId: req.childClassId,
          sectionId: req.childSectionId,
          sessionId: req.childSessionId,
          branchId: req.studentBranchId,
        },
        select: { studentId: true },
      });
      const studentIds = enrolls.map((e) => e.studentId);
      totalClassStudents = studentIds.length;

      if (studentIds.length > 0) {
        const allMarks = await prisma.mark.findMany({
          where: {
            studentId: { in: studentIds },
            sessionId: req.childSessionId,
            branchId: req.studentBranchId,
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
        sessionId: req.childSessionId,
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
    console.error('[PARENT] Export PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate PDF report card.' });
  }
}

/**
 * GET /api/parent/classes-sections
 */
export async function getClassesSections(req: Request, res: Response): Promise<Response | void> {
  try {
    const classes = await prisma.class.findMany({
      where: { branchId: req.branchId },
      include: {
        sections: {
          include: {
            section: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return res.json({ success: true, classes });
  } catch (error) {
    console.error('[PARENT] Get classes-sections error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load classes and sections.' });
  }
}

/**
 * GET /api/parent/sibling-requests
 */
export async function getSiblingRequests(req: Request, res: Response): Promise<Response | void> {
  try {
    const requests = await prisma.parentSiblingRequest.findMany({
      where: { parentId: req.parentId, branchId: req.branchId },
      include: {
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const formatted = requests.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      gender: r.gender,
      birthday: r.birthday,
      status: r.status,
      rejectionReason: r.rejectionReason,
      className: r.class?.name || 'Class',
      sectionName: r.section?.name || 'General',
      createdAt: r.createdAt,
    }));

    return res.json({ success: true, siblingRequests: formatted });
  } catch (error) {
    console.error('[PARENT] Get sibling requests error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load sibling requests.' });
  }
}

/**
 * POST /api/parent/sibling-requests
 */
export async function createSiblingRequest(req: Request, res: Response): Promise<Response | void> {
  try {
    const { firstName, lastName, gender, birthday, classId, sectionId } = req.body || {};

    if (!firstName || !lastName || !gender || !classId || !sectionId) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, gender, class, and section are required.',
      });
    }

    const cls = await prisma.class.findFirst({
      where: { id: Number(classId), branchId: req.branchId },
    });
    const sec = await prisma.section.findFirst({
      where: { id: Number(sectionId), branchId: req.branchId },
    });

    if (!cls || !sec) {
      return res.status(400).json({ success: false, message: 'Invalid class or section selected.' });
    }

    const duplicate = await prisma.parentSiblingRequest.findFirst({
      where: {
        parentId: req.parentId,
        branchId: req.branchId,
        firstName: { equals: firstName.trim(), mode: 'insensitive' },
        lastName: { equals: lastName.trim(), mode: 'insensitive' },
        status: { in: ['pending', 'approved'] },
      },
    });

    if (duplicate) {
      return res.status(400).json({ success: false, message: 'A request for this child has already been submitted.' });
    }

    const siblingRequest = await prisma.parentSiblingRequest.create({
      data: {
        parentId: req.parentId,
        branchId: req.branchId,
        classId: Number(classId),
        sectionId: Number(sectionId),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        gender,
        birthday: birthday ? new Date(birthday) : null,
        status: 'pending',
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Sibling request submitted successfully.',
      siblingRequest,
    });
  } catch (error) {
    console.error('[PARENT] Create sibling request error:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit sibling request.' });
  }
}

/**
 * GET /api/parent/events
 */
export async function getEvents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const events = await prisma.event.findMany({
      where: {
        branchId,
        sessionId,
      },
      orderBy: {
        startDate: 'asc',
      },
    });

    return res.json({ success: true, events });
  } catch (error) {
    console.error('[PARENT] Get events error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch events.' });
  }
}

/**
 * GET /api/parent/child/:studentId/timetable
 */
export async function getChildTimetable(req: Request, res: Response): Promise<Response | void> {
  if (!req.childClassId) {
    return res.json({ success: true, timetableSlots: [], examScheduleSlots: [] });
  }

  try {
    const timetableSlots = await prisma.timetableSlot.findMany({
      where: {
        classId: req.childClassId,
        branchId: req.studentBranchId,
        ...(req.childSectionId ? { sectionId: req.childSectionId } : {}),
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        teacher: { select: { id: true, name: true } },
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    const examScheduleSlots = await prisma.examScheduleSlot.findMany({
      where: {
        classId: req.childClassId,
        branchId: req.studentBranchId,
        isPublished: true,
        ...(req.childSectionId ? { sectionId: req.childSectionId } : {}),
      },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        hall: { select: { name: true, location: true } },
        invigilator: { select: { name: true } },
      },
      orderBy: { examDate: 'asc' },
    });

    return res.json({
      success: true,
      timetableSlots: timetableSlots.map((slot) => ({
        id: slot.id,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        type: slot.type,
        title: slot.title || slot.subject?.name || 'Class Period',
        subjectName: slot.subject?.name || null,
        subjectCode: slot.subject?.subjectCode || null,
        teacherName: slot.teacher?.name || null,
      })),
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
    console.error('[PARENT] Get child timetable error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve timetable slots.' });
  }
}
