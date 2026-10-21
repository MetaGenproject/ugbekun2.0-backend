import 'dotenv/config';
import prisma from '../lib/prisma';
import {
  getReportCardStudents,
  togglePublishReportCards,
  getReportCardPublishStatus,
} from '../controllers/admin/adminMarksReportController';
import {
  getChildGrades,
  exportChildReportPdf,
} from '../controllers/parent/parentAcademicsController';

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

async function runPhase4Tests() {
  console.log('=================================================================');
  console.log('🧪 Starting Phase 4 Test Suite: Report Card & Granular Release');
  console.log('=================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, details?: any) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
      if (details) console.error('     Details:', JSON.stringify(details, null, 2));
      throw new Error(`Assertion failed: ${testName}`);
    }
  }

  // Find an active enrolled student with marks in session 4
  const targetMark = await prisma.mark.findFirst({
    where: { sessionId: 4 },
    include: {
      student: true,
      class: true,
      section: true,
      exam: true,
    },
  });

  if (!targetMark || !targetMark.studentId || !targetMark.classId) {
    throw new Error('No enrolled student with mark records found in the database for Phase 4 testing.');
  }

  const studentId = targetMark.studentId;
  const classId = targetMark.classId;
  const sectionId = targetMark.sectionId;
  const sessionId = targetMark.sessionId;
  const branchId = targetMark.branchId || 5;
  const termId = 1;

  console.log(`Testing with Student: ${targetMark.student?.firstName} ${targetMark.student?.lastName} (ID: ${studentId})`);
  console.log(`Class: ${targetMark.class?.name} (ID: ${classId}), Section ID: ${sectionId}, Session ID: ${sessionId}, Branch ID: ${branchId}\n`);

  // Ensure clean starting publication state
  await prisma.classReportCardPublication.deleteMany({
    where: { classId, sectionId, sessionId, termId },
  });

  try {
    // -------------------------------------------------------------
    // TEST 1: Admin Granular Publication - Release CA1 Only
    // -------------------------------------------------------------
    console.log('--- Test 1: Admin Granular Release (CA1 Only) ---');
    {
      const { req, res, getResult } = createMockReqRes(
        {
          classId,
          sectionId,
          sessionId,
          termId,
          publish: true,
          releaseCa1: true,
          releaseCa2: false,
          releaseExam: false,
          releaseFull: false,
        },
        branchId
      );

      await togglePublishReportCards(req, res);
      const { statusCode, responseData } = getResult();

      assert(statusCode === 200 && responseData.success, 'togglePublishReportCards returns 200 with success');
      assert(responseData.releaseCa1 === true, 'Response confirms releaseCa1 is true');
      assert(responseData.releaseExam === false, 'Response confirms releaseExam is false');
      assert(responseData.releaseFull === false, 'Response confirms releaseFull is false');

      const pubInDb = await prisma.classReportCardPublication.findFirst({
        where: { classId, sectionId, sessionId, termId },
      });
      assert(Boolean(pubInDb?.releaseCa1), 'Database record persisted releaseCa1 === true');
      assert(!pubInDb?.releaseExam, 'Database record persisted releaseExam === false');
      assert(!pubInDb?.releaseFull, 'Database record persisted releaseFull === false');
    }

    // -------------------------------------------------------------
    // TEST 2: Zero Data Leakage Invariant (Parent API Payload Sanitization)
    // -------------------------------------------------------------
    console.log('\n--- Test 2: Zero Data Leakage Invariant in getChildGrades ---');
    {
      const { req, res, getResult } = createMockReqRes(
        {},
        branchId,
        {},
        {},
        {
          studentId,
          childClassId: classId,
          childSectionId: sectionId,
          childSessionId: sessionId,
          studentBranchId: branchId,
        }
      );

      await getChildGrades(req, res);
      const { statusCode, responseData } = getResult();

      assert(statusCode === 200 && responseData.success, 'getChildGrades returns 200');
      assert(responseData.stage === 'MID_TERM', 'Sanitized stage is MID_TERM');
      assert(responseData.overallAverage === null, 'CRITICAL: overallAverage is STRICTLY NULL (zero leakage)');
      assert(responseData.rank === null, 'CRITICAL: rank is STRICTLY NULL (zero leakage)');

      assert(responseData.reportCard.length > 0, 'Report card contains subjects');
      const item = responseData.reportCard[0];
      assert(item.theoryMark === null, 'CRITICAL: theoryMark is sanitized to null');
      assert(item.mark === null, 'CRITICAL: cumulative total mark is sanitized to null');
      assert(item.classAverage === null, 'CRITICAL: classAverage is sanitized to null');
      assert(responseData.visibleStages?.includes('CA1'), 'visibleStages contains CA1');
      assert(typeof responseData.nextTermFees === 'string', 'Next term fees correctly resolved');
    }

    // -------------------------------------------------------------
    // TEST 3: Admin Marks Report Controller Stage Filtering
    // -------------------------------------------------------------
    console.log('\n--- Test 3: Admin Class Students Stage Filter ---');
    {
      // Query CA1 stage
      const { req: reqCa1, res: resCa1, getResult: getResCa1 } = createMockReqRes(
        {},
        branchId,
        {},
        { classId, sectionId, sessionId, stage: 'CA1', termId }
      );
      await getReportCardStudents(reqCa1, resCa1);
      const resCa1Data = getResCa1().responseData;
      assert(resCa1Data.success, 'getReportCardStudents returns success for CA1 stage');
      assert(resCa1Data.stage === 'CA1', 'Response confirms stage is CA1');
      assert(resCa1Data.students.length > 0, 'Students returned for CA1 stage');

      // Query FULL stage
      const { req: reqFull, res: resFull, getResult: getResFull } = createMockReqRes(
        {},
        branchId,
        {},
        { classId, sectionId, sessionId, stage: 'FULL', termId }
      );
      await getReportCardStudents(reqFull, resFull);
      const resFullData = getResFull().responseData;
      assert(resFullData.success, 'getReportCardStudents returns success for FULL stage');
      assert(resFullData.stage === 'FULL', 'Response confirms stage is FULL');
      assert(resFullData.students.length > 0, 'Students returned for FULL stage');
    }

    // -------------------------------------------------------------
    // TEST 4: Full Terminal Composite Release
    // -------------------------------------------------------------
    console.log('\n--- Test 4: Full Terminal Release Unlocks Scores and Rank ---');
    {
      const { req, res, getResult } = createMockReqRes(
        {
          classId,
          sectionId,
          sessionId,
          termId,
          publish: true,
          releaseCa1: true,
          releaseCa2: true,
          releaseExam: true,
          releaseFull: true,
        },
        branchId
      );

      await togglePublishReportCards(req, res);
      const { statusCode, responseData } = getResult();
      assert(statusCode === 200 && responseData.releaseFull === true, 'Admin released full composite report');

      // Verify Parent API now returns full grades and rank
      const { req: pReq, res: pRes, getResult: pResult } = createMockReqRes(
        {},
        branchId,
        {},
        {},
        {
          studentId,
          childClassId: classId,
          childSectionId: sectionId,
          childSessionId: sessionId,
          studentBranchId: branchId,
        }
      );

      await getChildGrades(pReq, pRes);
      const parentData = pResult().responseData;

      assert(parentData.stage === 'FULL', 'Parent API now reports stage === FULL');
      assert(parentData.overallAverage !== null, 'overallAverage is now computed and visible');
      assert(parentData.rank !== null, 'Cohort class rank is now computed and visible');

      const fullItem = parentData.reportCard[0];
      assert(fullItem.mark !== null, 'total composite mark is now unlocked in payload');
    }

    // -------------------------------------------------------------
    // TEST 5: PDF Export Generates Valid PDF Stream with Invariants
    // -------------------------------------------------------------
    console.log('\n--- Test 5: Report Card PDF Generation ---');
    {
      const { req, res, getResult } = createMockReqRes(
        {},
        branchId,
        {},
        { rankingType: 'full' },
        {
          studentId,
          childClassId: classId,
          childSectionId: sectionId,
          childSessionId: sessionId,
          studentBranchId: branchId,
        }
      );

      await exportChildReportPdf(req, res);
      const { headers } = getResult();
      assert(headers['Content-Type'] === 'application/pdf', 'PDF generation responds with application/pdf Content-Type');
      assert(headers['Content-Disposition']?.toLowerCase().includes('report_card'), 'Content-Disposition includes valid filename');
    }

    console.log('\n=================================================================');
    console.log(`🎉 Phase 4 Test Suite Complete: All ${passedTests}/${totalTests} tests passed!`);
    console.log('=================================================================\n');
  } finally {
    // Teardown test publication records
    await prisma.classReportCardPublication.deleteMany({
      where: { classId, sectionId, sessionId, termId },
    }).catch(() => {});
  }
}

runPhase4Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test Suite Failed:', err);
    process.exit(1);
  });
