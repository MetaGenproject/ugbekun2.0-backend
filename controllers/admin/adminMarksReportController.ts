import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import gamificationService from '../../lib/gamificationService';
import {
  generateReportCardPdf,
  generateMontessoriReportCardPdf,
  generateBatchClassReportCardsPdf,
} from '../../lib/pdfService';
import { generateBatchClassCommentary } from '../../lib/commentaryService';

/**
 * GET /api/admin/marks-entry
 */
export async function getMarksEntry(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, subjectId, sessionId } = req.query;

    if (!classId || !subjectId) {
      return res.status(400).json({ success: false, message: 'classId and subjectId are required.' });
    }

    const cId = Number(classId);
    const subId = Number(subjectId);
    const secId = sectionId ? Number(sectionId) : undefined;

    const classData = await prisma.class.findFirst({
      where: { id: cId, branchId },
      include: { evaluationMatrix: true },
    });

    if (!classData) {
      return res.status(404).json({ success: false, message: 'Class not found.' });
    }

    let matrix = classData.evaluationMatrix;
    if (!matrix) {
      matrix = await prisma.evaluationMatrix.findFirst({
        where: { branchId, isDefault: true },
      });
    }
    if (!matrix) {
      matrix = await prisma.evaluationMatrix.findFirst({
        where: { branchId },
      });
    }

    const enrollWhere: any = { classId: cId };
    if (secId) enrollWhere.sectionId = secId;

    const enrolls = await prisma.enroll.findMany({
      where: enrollWhere,
      include: {
        student: {
          select: { id: true, firstName: true, lastName: true, registerNo: true, gender: true },
        },
        section: { select: { id: true, name: true } },
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

    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSession = sessionId ? Number(sessionId) : globalSetting?.sessionId || 1;

    const existingMarks = await prisma.mark.findMany({
      where: {
        branchId,
        classId: cId,
        subjectId: subId,
        sessionId: activeSession,
        ...(secId ? { sectionId: secId } : {}),
      },
    });

    const marksMap: Record<number, any> = {};
    existingMarks.forEach((m) => {
      let parsedComponents = {};
      try {
        if (m.mark && m.mark.startsWith('{')) {
          parsedComponents = JSON.parse(m.mark);
        }
      } catch (err) {
        // fallback
      }

      marksMap[m.studentId] = {
        id: m.id,
        mark: m.mark,
        cbtMark: m.cbtMark,
        absent: m.absent === '1' || m.absent === 'true',
        components: parsedComponents,
      };
    });

    return res.json({
      success: true,
      matrix,
      students,
      marksMap,
      classData: { id: classData.id, name: classData.name, evaluationMatrixId: classData.evaluationMatrixId },
    });
  } catch (error: any) {
    console.error('[ADMIN] Fetch marks entry error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch marks entry data.' });
  }
}

/**
 * POST /api/admin/marks-entry/batch-save
 */
export async function saveMarksEntryBatch(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { classId, sectionId, subjectId, sessionId, examId, marks } = req.body;

    if (!classId || !subjectId || !Array.isArray(marks)) {
      return res.status(400).json({ success: false, message: 'Invalid batch save payload.' });
    }

    const cId = Number(classId);
    const subId = Number(subjectId);
    const secId = sectionId ? Number(sectionId) : 1;
    const exId = examId ? Number(examId) : 1;
    const globalSetting = await prisma.globalSettings.findFirst();
    const activeSession = sessionId ? Number(sessionId) : globalSetting?.sessionId || 1;

    let savedCount = 0;

    for (const item of marks) {
      if (!item.studentId) continue;

      const sId = Number(item.studentId);
      const isAbsentStr = item.absent ? '1' : '0';
      const markValue = item.components ? JSON.stringify(item.components) : String(item.mark || '0');

      const existing = await prisma.mark.findFirst({
        where: {
          branchId,
          classId: cId,
          subjectId: subId,
          studentId: sId,
          sessionId: activeSession,
        },
      });

      if (existing) {
        await prisma.mark.update({
          where: { id: existing.id },
          data: {
            mark: markValue,
            absent: isAbsentStr,
          },
        });
      } else {
        await prisma.mark.create({
          data: {
            branchId,
            classId: cId,
            sectionId: secId,
            subjectId: subId,
            studentId: sId,
            examId: exId,
            sessionId: activeSession,
            mark: markValue,
            absent: isAbsentStr,
          },
        });
      }
      savedCount++;
    }

    return res.json({
      success: true,
      savedCount,
      message: `Batch marks save completed (${savedCount} student records updated).`,
    });
  } catch (error: any) {
    console.error('[ADMIN] Batch save marks error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to batch save marks.' });
  }
}

/**
 * POST /api/admin/marks-entry/ai-distribute
 */
export async function aiDistributeMarks(req: Request, res: Response): Promise<Response | void> {
  try {
    const { matrixComponents, studentTotals } = req.body;

    if (!Array.isArray(matrixComponents) || matrixComponents.length === 0) {
      return res.status(400).json({ success: false, message: 'Matrix components are required.' });
    }

    if (!Array.isArray(studentTotals) || studentTotals.length === 0) {
      return res.status(400).json({ success: false, message: 'Student totals array is required.' });
    }

    const matrixTotalMax =
      matrixComponents.reduce((sum: number, c: any) => sum + (Number(c.maxMarks) || 0), 0) || 100;

    const distributedMarksMap: Record<number, any> = {};

    studentTotals.forEach((st: any) => {
      const studentId = st.studentId;
      const totalScore = Math.min(Math.max(Number(st.totalScore) || 0, 0), matrixTotalMax);

      const components: Record<string, number> = {};
      let allocatedSum = 0;

      matrixComponents.forEach((comp: any, idx: number) => {
        const compMax = Number(comp.maxMarks) || 0;
        const isLast = idx === matrixComponents.length - 1;

        if (isLast) {
          components[comp.name] = Math.max(0, Math.round(totalScore - allocatedSum));
        } else {
          const ratio = compMax / matrixTotalMax;
          const assigned = Math.round(totalScore * ratio);
          components[comp.name] = assigned;
          allocatedSum += assigned;
        }
      });

      distributedMarksMap[studentId] = {
        totalScore,
        components,
      };
    });

    return res.json({
      success: true,
      distributedMarksMap,
      message: `Proportionally distributed scores across ${matrixComponents.length} assessment categories.`,
    });
  } catch (error: any) {
    console.error('[ADMIN] AI marks distribution error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to distribute marks.' });
  }
}

/**
 * GET /api/admin/commentary/pending
 */
export async function getPendingCommentary(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const commentaries = await prisma.studentCommentary.findMany({
      where: {
        branchId,
        sessionId,
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
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    return res.json({ success: true, commentaries });
  } catch (error) {
    console.error('[ADMIN] Fetch pending commentaries error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch commentaries.' });
  }
}

/**
 * POST /api/admin/commentary/review
 */
export async function reviewCommentary(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { commentaryId, status, reviewNotes } = req.body;

  if (!commentaryId || !status) {
    return res.status(400).json({ success: false, message: 'commentaryId and status are required.' });
  }

  if (!['PRINCIPAL_SIGNED_OFF', 'REJECTED'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status. Must be PRINCIPAL_SIGNED_OFF or REJECTED.' });
  }

  try {
    const existing = await prisma.studentCommentary.findUnique({
      where: { id: Number(commentaryId) },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Commentary record not found.' });
    }

    if (existing.branchId !== branchId) {
      return res.status(403).json({ success: false, message: 'Access denied: commentary belongs to another branch.' });
    }

    await prisma.studentCommentary.update({
      where: { id: existing.id },
      data: {
        status,
        reviewerId: req.userId,
        reviewNotes: reviewNotes || null,
      },
    });

    gamificationService
      .checkStudentCommentaryApproval(prisma, existing.id, status, branchId!)
      .catch((err: any) => console.error('[Gamification] Error in commentary review trigger:', err.message));

    return res.json({ success: true, message: `Commentary ${status.toLowerCase()} successfully.` });
  } catch (error) {
    console.error('[ADMIN] Review commentary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to review commentary.' });
  }
}

/**
 * GET /api/admin/report-cards/classes
 */
export async function getReportCardClasses(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const classes = await prisma.class.findMany({
      where: { branchId },
      include: {
        sections: {
          select: {
            section: { select: { id: true, name: true } },
          },
        },
        enrolls: {
          where: { sessionId, branchId },
          select: { studentId: true, sectionId: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    const formatted = classes.map((c) => {
      const secMap: Record<number, any> = {};
      c.sections.forEach((s) => {
        if (s.section) {
          secMap[s.section.id] = {
            id: s.section.id,
            name: s.section.name,
            studentCount: 0,
          };
        }
      });

      c.enrolls.forEach((e) => {
        if (secMap[e.sectionId]) {
          secMap[e.sectionId].studentCount += 1;
        }
      });

      return {
        id: c.id,
        name: c.name,
        isEcd: c.isEcd || false,
        totalEnrolled: c.enrolls.length,
        sections: Object.values(secMap),
      };
    });

    return res.json({ success: true, classes: formatted });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Get classes error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch classes.' });
  }
}

/**
 * GET /api/admin/report-cards/students
 */
export async function getReportCardStudents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId } = (req.query || {}) as any;

  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    const parsedClassId = Number(classId);
    const parsedSectionId = Number(sectionId);

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const cls = await prisma.class.findUnique({
      where: { id: parsedClassId },
      select: { name: true, isEcd: true },
    });

    const enrolls = await prisma.enroll.findMany({
      where: {
        classId: parsedClassId,
        sectionId: parsedSectionId,
        sessionId,
        branchId,
      },
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            registerNo: true,
            gender: true,
            photo: true,
          },
        },
      },
      orderBy: { student: { lastName: 'asc' } },
    });

    const studentIds = enrolls.map((e) => e.studentId);

    const marks = await prisma.mark.findMany({
      where: {
        studentId: { in: studentIds },
        sessionId,
        branchId,
      },
      include: {
        subject: { select: { id: true, name: true, subjectCode: true } },
        exam: { select: { id: true, name: true } },
      },
    });

    const commentaries = await prisma.studentCommentary.findMany({
      where: {
        studentId: { in: studentIds },
        sessionId,
        branchId,
      },
    });
    const commMap: Record<number, any> = {};
    commentaries.forEach((c) => {
      commMap[c.studentId] = c;
    });

    const montessoriList = await prisma.montessoriAssessment.findMany({
      where: {
        studentId: { in: studentIds },
        sessionId,
        branchId,
      },
    });
    const montMap: Record<number, any> = {};
    montessoriList.forEach((m) => {
      montMap[m.studentId] = m;
    });

    const attendanceRecords = await prisma.attendance.findMany({
      where: {
        studentId: { in: studentIds },
        classId: parsedClassId,
        sectionId: parsedSectionId,
        sessionId,
        branchId,
      },
      select: { studentId: true, status: true },
    });
    const attMap: Record<number, any> = {};
    studentIds.forEach((id) => {
      attMap[id] = { total: 0, present: 0, absent: 0, late: 0 };
    });
    attendanceRecords.forEach((a) => {
      if (attMap[a.studentId]) {
        attMap[a.studentId].total += 1;
        const st = (a.status || '').toLowerCase();
        if (st === 'present' || st === '1') attMap[a.studentId].present += 1;
        else if (st === 'absent' || st === '0') attMap[a.studentId].absent += 1;
        else if (st === 'late') attMap[a.studentId].late += 1;
      }
    });

    const studentMarksMap: Record<number, any[]> = {};
    const studentAggregates: Record<number, any> = {};
    studentIds.forEach((id) => {
      studentMarksMap[id] = [];
      studentAggregates[id] = { sum: 0, count: 0, totalMarks: 0 };
    });

    marks.forEach((m) => {
      const testVal = m.cbtMark ? parseFloat(m.cbtMark) : 0;
      const examVal = m.mark ? parseFloat(m.mark) : 0;
      const totalVal = testVal + examVal;
      if (studentMarksMap[m.studentId]) {
        studentMarksMap[m.studentId].push({
          id: m.id,
          examName: m.exam?.name || 'Evaluation',
          subjectName: m.subject?.name || 'Subject',
          subjectCode: m.subject?.subjectCode || 'N/A',
          cbtMark: m.cbtMark !== null ? String(testVal) : null,
          theoryMark: m.mark !== null ? String(examVal) : null,
          mark: String(totalVal),
          absent: m.absent === '1' || m.absent === 'true',
        });
        studentAggregates[m.studentId].sum += totalVal;
        studentAggregates[m.studentId].count += 1;
        studentAggregates[m.studentId].totalMarks += totalVal;
      }
    });

    const scores = studentIds.map((id) => ({
      id,
      avg: studentAggregates[id].count > 0 ? studentAggregates[id].sum / studentAggregates[id].count : 0,
    }));
    scores.sort((a, b) => b.avg - a.avg);

    const rankMap: Record<number, number> = {};
    scores.forEach((item, idx) => {
      rankMap[item.id] = idx + 1;
    });

    const studentList = enrolls.map((e) => {
      const st = e.student;
      const agg = studentAggregates[st.id] || { sum: 0, count: 0, totalMarks: 0 };
      const avg = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(1)) : 0;
      const rk = rankMap[st.id] || null;
      const comm = commMap[st.id];
      const mont = montMap[st.id];
      const att = attMap[st.id] || { total: 0, present: 0, absent: 0, late: 0 };

      let grade = 'F';
      if (avg >= 70) grade = 'A';
      else if (avg >= 60) grade = 'B';
      else if (avg >= 50) grade = 'C';
      else if (avg >= 45) grade = 'D';
      else if (avg >= 40) grade = 'E';

      const getOrdinal = (n: number) => {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
      };

      return {
        id: st.id,
        studentName: `${st.lastName}, ${st.firstName}`,
        firstName: st.firstName,
        lastName: st.lastName,
        admissionNo: st.registerNo || 'N/A',
        registerNo: st.registerNo,
        className: cls?.name || 'Classroom',
        gender: st.gender || 'N/A',
        totalMarks: agg.totalMarks,
        average: avg,
        grade,
        position: rk ? `${getOrdinal(rk)} out of ${studentIds.length}` : 'N/A',
        rank: rk,
        attendanceDays: att.total > 0 ? `${att.present} / ${att.total} Days` : '0 Days Logged',
        presentCount: att.present,
        absentCount: att.absent,
        totalAttendanceDays: att.total,
        teacherComment: comm?.remark || mont?.narrativeComment || '',
        principalComment:
          comm?.reviewNotes ||
          (avg >= 70
            ? 'Promoted with distinction.'
            : avg >= 50
            ? 'Good progress. Promoted.'
            : 'Needs improvement.'),
        commentStatus: comm?.status || 'PENDING',
        isAiGenerated: comm?.isAiGenerated || false,
        psychomotor: {
          writingMastery: mont?.writingMastery || 'AC',
          drawingCapability: mont?.drawingCapability || 'AC',
          physicalCoordination: mont?.physicalCoordination || 'AC',
          motorSkillProgression: mont?.motorSkillProgression || 'AC',
        },
        affective: {
          generalPunctuality: mont?.generalPunctuality || 'AC',
          peerRespect: mont?.peerRespect || 'AC',
          aestheticNeatness: mont?.aestheticNeatness || 'AC',
          activeGroupParticipation: mont?.activeGroupParticipation || 'AC',
        },
        isEcd: cls?.isEcd || false,
        subjectsCount: studentMarksMap[st.id]?.length || 0,
        reportCard: studentMarksMap[st.id] || [],
      };
    });

    return res.json({
      success: true,
      className: cls?.name || 'Classroom',
      isEcd: cls?.isEcd || false,
      totalStudents: studentList.length,
      students: studentList,
    });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Get students error:', error);
    return res.status(500).json({ success: false, message: 'Failed to compile student report cards.' });
  }
}

/**
 * GET /api/admin/report-cards/export-pdf
 */
export async function exportReportCardPdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId, studentId, rankingType = 'full', rankingLimit = 3 } = (req.query || {}) as any;

  if (!classId || !sectionId || !studentId) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and studentId are required.' });
  }

  try {
    const parsedStudentId = Number(studentId);
    const parsedClassId = Number(classId);
    const parsedSectionId = Number(sectionId);

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const student = await prisma.student.findUnique({
      where: { id: parsedStudentId },
      include: { branch: { select: { name: true, code: true } } },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const cls = await prisma.class.findUnique({ where: { id: parsedClassId }, select: { name: true, isEcd: true } });
    const sec = await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } });
    const sess = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } });

    const className = cls?.name || 'Classroom';
    const sectionName = sec?.name || 'Main';
    const sessionName = sess?.schoolYear || 'Active Session';

    let formTeacherName = 'Form Teacher';
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
      include: { teacher: { select: { name: true } } },
    });
    if (formAllocation?.teacher) formTeacherName = formAllocation.teacher.name;

    if (cls?.isEcd) {
      const assessment = await prisma.montessoriAssessment.findFirst({
        where: {
          studentId: parsedStudentId,
          classId: parsedClassId,
          sectionId: parsedSectionId,
          sessionId,
          branchId,
        },
        include: { exam: { select: { name: true, resumptionDate: true } } },
      });

      const pdfBuffer = await generateMontessoriReportCardPdf({
        schoolName: student.branch?.name || 'Ugbekun Schools',
        branchCode: student.branch?.code || 'GEN',
        studentName: `${student.lastName}, ${student.firstName}`,
        registerNo: student.registerNo,
        className,
        sectionName,
        sessionName,
        examName: assessment?.exam?.name || 'Term Evaluation',
        assessment: assessment || {},
        resumptionDate: assessment?.exam?.resumptionDate || null,
        formTeacherName,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="report_card_${student.lastName}_${student.firstName}.pdf"`
      );
      return res.send(pdfBuffer);
    }

    const marks = await prisma.mark.findMany({
      where: { studentId: parsedStudentId, sessionId, branchId },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } },
      },
    });

    const allClassMarks = await prisma.mark.findMany({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
      select: { examId: true, subjectId: true, mark: true, cbtMark: true, studentId: true },
    });
    const avgMap: Record<string, any> = {};
    allClassMarks.forEach((m) => {
      const k = `${m.examId}-${m.subjectId}`;
      if (!avgMap[k]) avgMap[k] = { sum: 0, count: 0 };
      const tot = parseFloat(m.cbtMark || '0') + parseFloat(m.mark || '0');
      avgMap[k].sum += tot;
      avgMap[k].count += 1;
    });

    let totalSum = 0;
    let marksCount = 0;
    const reportCard = marks.map((m) => {
      const testScore = m.cbtMark ? parseFloat(m.cbtMark) : 0;
      const examScore = m.mark ? parseFloat(m.mark) : 0;
      const totalScore = testScore + examScore;
      totalSum += totalScore;
      marksCount += 1;

      const k = `${m.examId}-${m.subjectId}`;
      const cAvg =
        avgMap[k] && avgMap[k].count > 0 ? Number((avgMap[k].sum / avgMap[k].count).toFixed(1)) : totalScore;

      return {
        id: m.id,
        examName: m.exam?.name || 'Term Evaluation',
        subjectName: m.subject?.name || 'Subject',
        subjectCode: m.subject?.subjectCode || 'N/A',
        cbtMark: String(testScore),
        theoryMark: String(examScore),
        mark: String(totalScore),
        absent: m.absent === '1' || m.absent === 'true',
        classAverage: cAvg,
      };
    });

    const overallAverage = marksCount > 0 ? Number((totalSum / marksCount).toFixed(1)) : 0;

    const enrolls = await prisma.enroll.findMany({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
      select: { studentId: true },
    });
    const studentIds = enrolls.map((e) => e.studentId);
    const aggMap: Record<number, any> = {};
    studentIds.forEach((id) => {
      aggMap[id] = { sum: 0, count: 0 };
    });
    allClassMarks.forEach((m) => {
      if (aggMap[m.studentId]) {
        aggMap[m.studentId].sum += parseFloat(m.cbtMark || '0') + parseFloat(m.mark || '0');
        aggMap[m.studentId].count += 1;
      }
    });
    const scoreRankList = studentIds
      .map((id) => ({
        id,
        avg: aggMap[id]?.count > 0 ? aggMap[id].sum / aggMap[id].count : 0,
      }))
      .sort((a, b) => b.avg - a.avg);

    const rankIdx = scoreRankList.findIndex((s) => s.id === parsedStudentId);
    const rank = rankIdx !== -1 ? rankIdx + 1 : null;

    const comm = await prisma.studentCommentary.findFirst({
      where: { studentId: parsedStudentId, sessionId, branchId },
    });

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
      commentary: comm?.remark || '',
      rank,
      totalClassStudents: studentIds.length,
      rankingType,
      rankingLimit: Number(rankingLimit),
      resumptionDate: marks[0]?.exam?.resumptionDate || null,
      formTeacherName,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report_card_${student.lastName}_${student.firstName}.pdf"`
    );
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Single PDF export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate report card PDF.' });
  }
}

/**
 * GET /api/admin/report-cards/export-batch-pdf
 */
export async function exportBatchReportCardsPdf(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId, rankingType = 'full', rankingLimit = 3 } = (req.query || {}) as any;

  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    const parsedClassId = Number(classId);
    const parsedSectionId = Number(sectionId);

    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true, code: true },
    });

    const cls = await prisma.class.findUnique({ where: { id: parsedClassId }, select: { name: true, isEcd: true } });
    const sec = await prisma.section.findUnique({ where: { id: parsedSectionId }, select: { name: true } });
    const sess = await prisma.schoolYear.findUnique({ where: { id: sessionId }, select: { schoolYear: true } });

    const className = cls?.name || 'Classroom';
    const sectionName = sec?.name || 'Main';
    const sessionName = sess?.schoolYear || 'Active Session';

    let formTeacherName = 'Form Teacher';
    const formAllocation = await prisma.teacherAllocation.findFirst({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
      include: { teacher: { select: { name: true } } },
    });
    if (formAllocation?.teacher) formTeacherName = formAllocation.teacher.name;

    const enrolls = await prisma.enroll.findMany({
      where: { classId: parsedClassId, sectionId: parsedSectionId, sessionId, branchId },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, registerNo: true } },
      },
      orderBy: { student: { lastName: 'asc' } },
    });

    const studentIds = enrolls.map((e) => e.studentId);

    if (studentIds.length === 0) {
      return res.status(404).json({ success: false, message: 'No enrolled students found in this class/section.' });
    }

    const allMarks = await prisma.mark.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId },
      include: {
        subject: { select: { name: true, subjectCode: true } },
        exam: { select: { name: true, resumptionDate: true } },
      },
    });

    const avgMap: Record<string, any> = {};
    allMarks.forEach((m) => {
      const k = `${m.examId}-${m.subjectId}`;
      if (!avgMap[k]) avgMap[k] = { sum: 0, count: 0 };
      const tot = parseFloat(m.cbtMark || '0') + parseFloat(m.mark || '0');
      avgMap[k].sum += tot;
      avgMap[k].count += 1;
    });

    const studentAggregates: Record<number, any> = {};
    const studentMarksMap: Record<number, any[]> = {};
    studentIds.forEach((id) => {
      studentAggregates[id] = { sum: 0, count: 0 };
      studentMarksMap[id] = [];
    });

    allMarks.forEach((m) => {
      const testScore = m.cbtMark ? parseFloat(m.cbtMark) : 0;
      const examScore = m.mark ? parseFloat(m.mark) : 0;
      const totalScore = testScore + examScore;

      if (studentMarksMap[m.studentId]) {
        const k = `${m.examId}-${m.subjectId}`;
        const cAvg =
          avgMap[k] && avgMap[k].count > 0 ? Number((avgMap[k].sum / avgMap[k].count).toFixed(1)) : totalScore;

        studentMarksMap[m.studentId].push({
          id: m.id,
          examName: m.exam?.name || 'Evaluation',
          subjectName: m.subject?.name || 'Subject',
          subjectCode: m.subject?.subjectCode || 'N/A',
          cbtMark: String(testScore),
          theoryMark: String(examScore),
          mark: String(totalScore),
          absent: m.absent === '1' || m.absent === 'true',
          classAverage: cAvg,
        });

        studentAggregates[m.studentId].sum += totalScore;
        studentAggregates[m.studentId].count += 1;
      }
    });

    const rankList = studentIds
      .map((id) => ({
        id,
        avg: studentAggregates[id].count > 0 ? studentAggregates[id].sum / studentAggregates[id].count : 0,
      }))
      .sort((a, b) => b.avg - a.avg);

    const rankMap: Record<number, number> = {};
    rankList.forEach((item, idx) => {
      rankMap[item.id] = idx + 1;
    });

    const commentaries = await prisma.studentCommentary.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId },
    });
    const commMap: Record<number, any> = {};
    commentaries.forEach((c) => {
      commMap[c.studentId] = c;
    });

    const montessoriList = await prisma.montessoriAssessment.findMany({
      where: { studentId: { in: studentIds }, sessionId, branchId },
      include: { exam: { select: { name: true, resumptionDate: true } } },
    });
    const montMap: Record<number, any> = {};
    montessoriList.forEach((m) => {
      montMap[m.studentId] = m;
    });

    const batchStudents = enrolls.map((e) => {
      const st = e.student;
      const agg = studentAggregates[st.id] || { sum: 0, count: 0 };
      const avg = agg.count > 0 ? Number((agg.sum / agg.count).toFixed(1)) : 0;
      const rk = rankMap[st.id] || null;
      const comm = commMap[st.id];
      const mont = montMap[st.id];

      return {
        studentName: `${st.lastName}, ${st.firstName}`,
        registerNo: st.registerNo || 'N/A',
        isEcd: cls?.isEcd || false,
        reportCard: studentMarksMap[st.id] || [],
        overallAverage: avg,
        commentary: comm?.remark || '',
        rank: rk,
        totalClassStudents: studentIds.length,
        rankingType,
        rankingLimit: Number(rankingLimit),
        resumptionDate: allMarks[0]?.exam?.resumptionDate || null,
        formTeacherName,
        examName: mont?.exam?.name || 'Term Evaluation',
        assessment: mont || {},
      };
    });

    const pdfBuffer = await generateBatchClassReportCardsPdf({
      schoolName: branch?.name || 'Ugbekun Schools',
      branchCode: branch?.code || 'GEN',
      className,
      sectionName,
      sessionName,
      students: batchStudents,
    });

    const safeClassName = className.replace(/\s+/g, '_');
    const safeSectionName = sectionName.replace(/\s+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="batch_report_cards_${safeClassName}_${safeSectionName}.pdf"`
    );
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Batch PDF export error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate batch report cards PDF.' });
  }
}

/**
 * POST /api/admin/report-cards/commentary
 */
export async function saveReportCardCommentary(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { studentId, classId, sectionId, remark, principalRemark, status = 'PRINCIPAL_SIGNED_OFF' } = req.body || {};

  if (!studentId || !classId || !sectionId || !remark) {
    return res.status(400).json({ success: false, message: 'studentId, classId, sectionId, and remark are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const commentary = await prisma.studentCommentary.upsert({
      where: {
        studentId_sessionId: {
          studentId: Number(studentId),
          sessionId,
        },
      },
      update: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        remark: remark.trim(),
        reviewNotes: principalRemark ? principalRemark.trim() : undefined,
        status,
        reviewerId: req.userId,
        isEditedByHuman: true,
        branchId,
      },
      create: {
        studentId: Number(studentId),
        classId: Number(classId),
        sectionId: Number(sectionId),
        remark: remark.trim(),
        reviewNotes: principalRemark ? principalRemark.trim() : undefined,
        status,
        reviewerId: req.userId,
        sessionId,
        branchId,
      },
    });

    return res.json({ success: true, message: 'Commentary saved to student report card.', commentary });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Save commentary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save commentary.' });
  }
}

/**
 * POST /api/admin/report-cards/behavioral
 */
export async function saveReportCardBehavioral(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { studentId, classId, sectionId, psychomotor = {}, affective = {}, narrativeComment } = req.body || {};

  if (!studentId || !classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'studentId, classId, and sectionId are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const exam = await prisma.exam.findFirst({
      where: { branchId, sessionId },
      select: { id: true },
    });
    const examId = exam?.id || 1;

    const assessment = await prisma.montessoriAssessment.upsert({
      where: {
        studentId_examId_sessionId: {
          studentId: Number(studentId),
          examId,
          sessionId,
        },
      },
      update: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        writingMastery: psychomotor.writingMastery,
        drawingCapability: psychomotor.drawingCapability,
        physicalCoordination: psychomotor.physicalCoordination,
        motorSkillProgression: psychomotor.motorSkillProgression,
        generalPunctuality: affective.generalPunctuality,
        peerRespect: affective.peerRespect,
        aestheticNeatness: affective.aestheticNeatness,
        activeGroupParticipation: affective.activeGroupParticipation,
        narrativeComment: narrativeComment ? narrativeComment.trim() : undefined,
        branchId,
      },
      create: {
        studentId: Number(studentId),
        classId: Number(classId),
        sectionId: Number(sectionId),
        examId,
        sessionId,
        writingMastery: psychomotor.writingMastery || 'AC',
        drawingCapability: psychomotor.drawingCapability || 'AC',
        physicalCoordination: psychomotor.physicalCoordination || 'AC',
        motorSkillProgression: psychomotor.motorSkillProgression || 'AC',
        generalPunctuality: affective.generalPunctuality || 'AC',
        peerRespect: affective.peerRespect || 'AC',
        aestheticNeatness: affective.aestheticNeatness || 'AC',
        activeGroupParticipation: affective.activeGroupParticipation || 'AC',
        narrativeComment: narrativeComment ? narrativeComment.trim() : undefined,
        branchId,
      },
    });

    return res.json({ success: true, message: 'Behavioral and psychomotor ratings saved successfully.', assessment });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] Save behavioral error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save behavioral ratings.' });
  }
}

/**
 * POST /api/admin/report-cards/ai-comments
 */
export async function generateAiComments(req: Request, res: Response): Promise<Response | void> {
  const { studentName = 'The student', averageScore = 75 } = req.body || {};

  try {
    const avg = Number(averageScore) || 75;
    let teacherComment = '';
    let principalComment = '';

    if (avg >= 80) {
      teacherComment = `${studentName} has demonstrated exceptional intellectual mastery, intellectual curiosity, and exemplary discipline throughout this academic term. A stellar role model for classmates.`;
      principalComment = `An outstanding academic distinction. Commended for scholastic excellence and promoted with honors!`;
    } else if (avg >= 70) {
      teacherComment = `${studentName} exhibits strong analytical capability and steady academic commitment. Consistently puts in commendable effort across all subjects.`;
      principalComment = `Very good academic performance. Promoted with praise. Keep up the high standard!`;
    } else if (avg >= 60) {
      teacherComment = `${studentName} is a hardworking and attentive pupil who shows solid understanding of core concepts. Encouraged to participate more actively in classroom discussions.`;
      principalComment = `Satisfactory terminal result. Has the capability to achieve even higher grades next session. Promoted.`;
    } else if (avg >= 50) {
      teacherComment = `${studentName} has made fair progress this term. Regular study revision and attention to homework assignments will yield stronger attainment.`;
      principalComment = `Pass grade achieved. Advised to focus diligently on foundational subjects during the upcoming term.`;
    } else {
      teacherComment = `${studentName} requires closer academic guidance and targeted remedial assistance to improve overall comprehension and performance.`;
      principalComment = `Performance falls below the expected benchmark. Recommended for structured holiday remedial support.`;
    }

    return res.json({
      success: true,
      teacherComment,
      principalComment,
      isAiGenerated: true,
    });
  } catch (error) {
    console.error('[ADMIN REPORT CARDS] AI comments error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate comments.' });
  }
}

/**
 * POST /api/admin/report-cards/batch-generate-commentary
 */
export async function batchGenerateCommentary(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId, tone = 'constructive', behavioralTags = [] } = req.body || {};

  if (!classId || !sectionId) {
    return res.status(400).json({ success: false, message: 'classId and sectionId are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const enrollments = await prisma.enroll.findMany({
      where: {
        classId: Number(classId),
        sectionId: Number(sectionId),
        branchId,
        sessionId,
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
    });

    const studentsData: any[] = [];

    for (const enr of enrollments) {
      const st = enr.student;
      if (!st) continue;

      const marks = await prisma.mark.findMany({
        where: { studentId: st.id, sessionId, branchId },
        include: { subject: { select: { name: true } } },
      });

      const marksBySubject: any = {};
      for (const m of marks) {
        if (!m.mark || m.absent === '1') continue;
        const score = parseFloat(m.mark);
        if (!isNaN(score)) {
          marksBySubject[m.subject.name] = score;
        }
      }

      const scoresList: number[] = Object.values(marksBySubject) as any;
      const avg =
        scoresList.length > 0
          ? Math.round(scoresList.reduce((a: number, b: number) => a + b, 0) / scoresList.length)
          : 70;

      const att = await prisma.attendance.findMany({
        where: { studentId: st.id, sessionId, branchId },
      });
      const totalDays = att.length;
      const presentDays = att.filter(
        (a) => String(a.status || '').toLowerCase() === 'present' || String(a.status || '').toLowerCase() === 'late'
      ).length;
      const attendanceRate = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 100;

      const existingComm = await prisma.studentCommentary.findUnique({
        where: {
          studentId_sessionId: {
            studentId: st.id,
            sessionId,
          },
        },
      });

      studentsData.push({
        studentId: st.id,
        studentName: `${st.firstName} ${st.lastName}`,
        registerNo: st.registerNo || '',
        averageScore: avg,
        attendanceRate,
        marksBySubject,
        behavioralTags,
        existingRemark: existingComm?.remark || null,
      });
    }

    const batchGenerated = await generateBatchClassCommentary(studentsData, tone);

    return res.json({
      success: true,
      count: batchGenerated.length,
      commentaries: batchGenerated,
    });
  } catch (err) {
    console.error('[ADMIN] Batch commentary generate error:', err);
    return res.status(500).json({ success: false, message: 'Failed to batch generate commentary.' });
  }
}

/**
 * POST /api/admin/report-cards/batch-save-commentary
 */
export async function batchSaveCommentary(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { classId, sectionId, commentaries = [], status = 'APPROVED_BY_PRINCIPAL' } = req.body || {};

  if (!classId || !sectionId || !Array.isArray(commentaries)) {
    return res.status(400).json({ success: false, message: 'classId, sectionId, and commentaries array required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    let savedCount = 0;

    for (const item of commentaries) {
      if (!item.studentId || !item.remark) continue;

      await prisma.studentCommentary.upsert({
        where: {
          studentId_sessionId: {
            studentId: Number(item.studentId),
            sessionId,
          },
        },
        update: {
          classId: Number(classId),
          sectionId: Number(sectionId),
          remark: item.remark.trim(),
          reviewNotes: item.principalRemark ? item.principalRemark.trim() : undefined,
          status,
          reviewerId: req.userId,
          isEditedByHuman: true,
          branchId,
        },
        create: {
          studentId: Number(item.studentId),
          classId: Number(classId),
          sectionId: Number(sectionId),
          remark: item.remark.trim(),
          reviewNotes: item.principalRemark ? item.principalRemark.trim() : undefined,
          status,
          reviewerId: req.userId,
          sessionId,
          branchId,
        },
      });
      savedCount++;
    }

    return res.json({
      success: true,
      savedCount,
      message: `Batch commentary saved for ${savedCount} students.`,
    });
  } catch (err) {
    console.error('[ADMIN] Batch save commentary error:', err);
    return res.status(500).json({ success: false, message: 'Failed to batch save commentary.' });
  }
}
