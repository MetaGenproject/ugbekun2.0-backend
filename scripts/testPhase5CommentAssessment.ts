import 'dotenv/config';
import prisma from '../lib/prisma';
import {
  toggleUsesScores,
  createClass,
  updateClass,
} from '../controllers/admin/adminAcademicsController';
import {
  getMarksEntry,
  saveSubjectCommentsBatch,
  getSubjectComments,
  getReportCardStudents,
} from '../controllers/admin/adminMarksReportController';
import {
  getChildGrades,
} from '../controllers/parent/parentAcademicsController';
import {
  generateCommentBasedReportCardPdf,
} from '../lib/pdfService';

// Helper mock request and response
function createMockReqRes(body: any = {}, branchId: number = 5, params: any = {}, query: any = {}, extra: any = {}) {
  let responseData: any = null;
  let statusCode: number = 200;
  let headers: Record<string, string> = {};

  const req: any = {
    body,
    branchId,
    params,
    query,
    user: { id: 1, role: 'ADMIN', branchId },
    ...extra,
  };

  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    json(data: any) {
      responseData = data;
      return res;
    },
    send(data: any) {
      responseData = data;
      return res;
    },
    end(data?: any) {
      if (data) responseData = data;
      return res;
    },
  };

  return {
    req,
    res,
    getResult: () => ({ statusCode, responseData, headers }),
  };
}

async function runPhase5Tests() {
  console.log('=================================================================');
  console.log('🧪 Starting Phase 5 Test Suite: Comment-Based Qualitative System');
  console.log('=================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, details?: any) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      if (details) {
        console.error('     Details:', JSON.stringify(details, null, 2));
      }
      failed++;
    }
  }

  try {
    // 1. Setup prerequisite test data
    console.log('📌 1. Finding or seeding test branch, session, term, subject, and student...');
    let branch = await prisma.branch.findFirst();
    if (!branch) {
      branch = await prisma.branch.create({
        data: { name: 'Montessori Test Branch' },
      });
    }
    const branchId = branch.id;
    const sessionId = 4;
    const termId = 1;

    let subject = await prisma.subject.findFirst({
      where: { branchId },
    });
    if (!subject) {
      subject = await prisma.subject.findFirst();
    }
    if (!subject) {
      subject = await prisma.subject.create({
        data: {
          name: 'Sensory & Motor Skills',
          subjectCode: 'SMS-101',
          branchId,
        },
      });
    }
    const subjectId = subject.id;

    // Create an ECD class with usesScores: false
    const testClassName = `Nursery Alpha ECD ${Date.now()}`;
    const testClass = await prisma.class.create({
      data: {
        name: testClassName,
        nameNumeric: '1',
        isEcd: true,
        usesScores: false,
        branchId,
      },
    });
    const classId = testClass.id;

    const testSection = await prisma.section.create({
      data: {
        name: 'A',
        branchId,
      },
    });
    const sectionId = testSection.id;

    await prisma.sectionsAllocation.create({
      data: {
        classId,
        sectionId,
      },
    });

    const testStudent = await prisma.student.findFirst({
      where: { branchId },
    }) || await prisma.student.findFirst();

    if (!testStudent) {
      throw new Error('No student found in DB for test');
    }
    const studentId = testStudent.id;

    const maxEnroll = await prisma.enroll.findFirst({ orderBy: { id: 'desc' } });
    const nextEnrollId = (maxEnroll?.id || 1000) + 1;

    await prisma.enroll.create({
      data: {
        id: nextEnrollId,
        studentId,
        classId,
        sectionId,
        sessionId,
        branchId,
      },
    });

    // 2. Test Toggle usesScores
    console.log('\n📌 2. Testing Class toggleUsesScores controller endpoint...');
    {
      const { req, res, getResult } = createMockReqRes(
        { classId, usesScores: true },
        branchId
      );
      await toggleUsesScores(req, res);
      const result = getResult();
      assert(
        result.statusCode === 200 && result.responseData.class?.usesScores === true,
        'toggleUsesScores toggles class to true'
      );

      // Toggle back to false (Comment-Based)
      const { req: req2, res: res2, getResult: getResult2 } = createMockReqRes(
        { classId, usesScores: false },
        branchId
      );
      await toggleUsesScores(req2, res2);
      const result2 = getResult2();
      assert(
        result2.statusCode === 200 && result2.responseData.class?.usesScores === false,
        'toggleUsesScores toggles class back to false'
      );
    }

    // 3. Test Save Subject Comments Batch
    console.log('\n📌 3. Testing saveSubjectCommentsBatch endpoint...');
    {
      const { req, res, getResult } = createMockReqRes(
        {
          classId,
          sectionId,
          subjectId,
          termId,
          sessionId,
          assessments: [
            {
              studentId,
              comment: 'Chidinma exhibits remarkable coordination in fine motor activities and engages enthusiastically in group roleplay.',
              rating: 4,
            },
          ],
        },
        branchId
      );

      await saveSubjectCommentsBatch(req, res);
      const result = getResult();
      assert(
        result.statusCode === 200 && result.responseData.success === true && result.responseData.savedCount === 1,
        'saveSubjectCommentsBatch successfully saved 1 developmental observation and rating',
        result.responseData
      );

      // Verify in DB directly
      const savedComment = await prisma.subjectCommentAssessment.findFirst({
        where: { studentId, subjectId, classId, termId, sessionId },
      });
      assert(
        savedComment !== null && savedComment.rating === 4 && savedComment.comment.includes('Chidinma'),
        'SubjectCommentAssessment persisted in PostgreSQL with rating 4 and narrative text'
      );
    }

    // 4. Test getMarksEntry endpoint for comment-based class
    console.log('\n📌 4. Testing getMarksEntry with usesScores: false...');
    {
      const { req, res, getResult } = createMockReqRes(
        {},
        branchId,
        {},
        { classId: String(classId), subjectId: String(subjectId), sessionId: String(sessionId) }
      );

      await getMarksEntry(req, res);
      const result = getResult();
      assert(
        result.statusCode === 200 &&
        result.responseData.usesScores === false &&
        result.responseData.isCommentBased === true,
        'getMarksEntry returns usesScores: false and isCommentBased: true',
        result.responseData
      );

      assert(
        result.responseData.commentsMap &&
        result.responseData.commentsMap[studentId]?.rating === 4 &&
        result.responseData.commentsMap[studentId]?.ratingLabel?.includes('Proficient'),
        'getMarksEntry commentsMap contains rating 4 with ratingLabel containing "Proficient"'
      );
    }

    // 5. Test getReportCardStudents Strict Zero-Score Invariant
    console.log('\n📌 5. Testing getReportCardStudents Server-Enforced Zero-Score Redaction...');
    {
      const { req, res, getResult } = createMockReqRes(
        {},
        branchId,
        {},
        { classId: String(classId), sectionId: String(sectionId), sessionId: String(sessionId), termId: String(termId) }
      );

      await getReportCardStudents(req, res);
      const result = getResult();
      const studentPreview = result.responseData?.students?.[0];

      assert(
        result.statusCode === 200 && studentPreview !== undefined,
        'getReportCardStudents successfully loads comment-based student preview'
      );

      assert(
        studentPreview.usesScores === false &&
        studentPreview.isCommentBased === true &&
        studentPreview.totalMarks === null &&
        studentPreview.average === null &&
        studentPreview.grade === null &&
        studentPreview.position === null &&
        studentPreview.rank === null,
        'Strict Zero-Score Invariant: totalMarks, average, grade, position, and rank are server-redacted (null)',
        studentPreview
      );

      assert(
        Array.isArray(studentPreview.subjectComments) &&
        studentPreview.subjectComments.length > 0 &&
        studentPreview.subjectComments[0].rating === 4 &&
        studentPreview.subjectComments[0].ratingLabel?.includes('Proficient'),
        'getReportCardStudents returns populated subjectComments array with 1-5 rating',
        studentPreview.subjectComments
      );
    }

    // 6. Test Parent Academics View getChildGrades Data Redaction
    console.log('\n📌 6. Testing Parent getChildGrades Zero-Score Invariant...');
    {
      const existingParent = await prisma.parent.findFirst({
        where: { branchId },
      }) || await prisma.parent.findFirst();

      if (!existingParent) {
        throw new Error('No parent found in DB');
      }

      const originalParentId = testStudent.parentId;
      await prisma.student.update({
        where: { id: studentId },
        data: { parentId: existingParent.id },
      });

      // Create publication record so parent can view published report card
      await prisma.classReportCardPublication.create({
        data: {
          classId,
          sectionId,
          sessionId,
          termId,
          branchId,
          isPublished: true,
          releaseFull: true,
        },
      });

      const { req, res, getResult } = createMockReqRes(
        {},
        branchId,
        { studentId: String(studentId) },
        {},
        {
          user: { id: 1, role: 'PARENT', branchId },
          parentRecord: { id: existingParent.id, branchId },
          studentId,
          childClassId: classId,
          childSessionId: sessionId,
          childSectionId: sectionId,
          studentBranchId: branchId,
        }
      );

      await getChildGrades(req, res);
      const result = getResult();

      assert(
        result.statusCode === 200 && result.responseData?.success === true,
        'Parent getChildGrades successfully loads child data'
      );

      assert(
        result.responseData.usesScores === false &&
        result.responseData.isCommentBased === true &&
        result.responseData.totalMarks === null &&
        result.responseData.overallAverage === null &&
        result.responseData.rank === null,
        'Parent view enforces Zero-Score Invariant: zero numerical mark leakage for parents',
        result.responseData
      );

      assert(
        Array.isArray(result.responseData.subjectComments) &&
        result.responseData.subjectComments.length > 0 &&
        result.responseData.subjectComments[0].rating === 4 &&
        result.responseData.subjectComments[0].ratingLabel?.includes('Proficient'),
        'Parent view successfully includes qualitative subjectComments and 1-5 ratings',
        result.responseData.subjectComments
      );

      // Restore original parentId
      await prisma.student.update({ where: { id: studentId }, data: { parentId: originalParentId } });
    }

    // 7. Test PDF Engine generateCommentBasedReportCardPdf
    console.log('\n📌 7. Testing PDF Service generateCommentBasedReportCardPdf...');
    {
      const pdfBuffer = await generateCommentBasedReportCardPdf({
        student: {
          id: studentId,
          studentName: `${testStudent.firstName} ${testStudent.lastName}`,
          admissionNo: testStudent.registerNo,
          className: testClassName,
          sectionName: 'A',
          gender: 'Female',
          attendance: {
            present: 60,
            totalDays: 62,
            rate: 96.8,
          },
          teacherRemark: 'Chidinma demonstrates exceptional developmental milestone progression.',
          headTeacherRemark: 'Outstanding qualitative growth this academic term. Commended!',
          psychomotor: {
            writingMastery: '4',
            drawingCapability: '5',
            physicalCoordination: '4',
            motorSkillProgression: '5',
          },
          affective: {
            generalPunctuality: '5',
            peerRespect: '5',
            aestheticNeatness: '4',
            activeGroupParticipation: '5',
          },
        },
        subjectComments: [
          {
            id: 1,
            subjectId,
            subjectName: 'Sensory & Motor Development',
            subjectCode: 'SMS-101',
            comment: 'Fine motor control is well established with precision handling of Montessori blocks.',
            rating: 5,
            ratingLabel: 'Advanced',
          },
          {
            id: 2,
            subjectId,
            subjectName: 'Language & Early Phonics',
            subjectCode: 'LEP-102',
            comment: 'Expressive vocabulary is expanding; recites rhymes clearly and identifies letters.',
            rating: 4,
            ratingLabel: 'Proficient',
          },
        ],
        branch: {
          name: 'Ugbekun Montessori Early Childhood Academy',
          address: 'Benin City, Edo State',
          phone: '+234800000000',
          email: 'earlyyears@ugbekun.edu.ng',
        },
        sessionName: '2025/2026 Academic Session',
        termName: 'First Term',
        reportDate: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
      });

      assert(
        Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 500,
        'generateCommentBasedReportCardPdf produced a non-empty Buffer'
      );

      const header = pdfBuffer.toString('utf8', 0, 5);
      assert(
        header === '%PDF-',
        `PDF buffer has valid PDF binary signature ("${header}")`
      );
      console.log(`     Generated PDF size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);
    }

    // Clean up test data
    console.log('\n🧹 Cleaning up test records...');
    await prisma.classReportCardPublication.deleteMany({ where: { classId } });
    await prisma.subjectCommentAssessment.deleteMany({ where: { classId } });
    await prisma.enroll.deleteMany({ where: { classId } });
    await prisma.sectionsAllocation.deleteMany({ where: { classId } });
    await prisma.section.delete({ where: { id: sectionId } });
    await prisma.class.delete({ where: { id: classId } });
    console.log('     Cleanup complete.');

  } catch (err) {
    console.error('❌ Fatal error running Phase 5 tests:', err);
    failed++;
  }

  console.log('\n=================================================================');
  console.log(`📊 Phase 5 Test Suite Results: ${passed} Passed, ${failed} Failed`);
  console.log('=================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase5Tests()
  .then(() => {
    prisma.$disconnect();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
