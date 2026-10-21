import 'dotenv/config';
import prisma from '../lib/prisma';
import { createExam, createCbtDistribution } from '../controllers/admin/adminExamCbtController';

// Mock Express Request & Response
function createMockReqRes(body: any, branchId: number = 1, params: any = {}) {
  let responseData: any = null;
  let statusCode: number = 200;

  const req: any = {
    body,
    branchId,
    params,
    query: {},
  };

  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      responseData = data;
      return res;
    },
    sendStatus(code: number) {
      statusCode = code;
      return res;
    },
  };

  return {
    req,
    res,
    getResult: () => ({ statusCode, responseData }),
  };
}

async function runPhase2Tests() {
  console.log('=================================================================');
  console.log('🧪 Starting Phase 2 Test Suite: Exam Master & Question Cap Gate');
  console.log('=================================================================\n');

  // 1. Get or create test Branch
  let branch = await prisma.branch.findFirst();
  if (!branch) {
    branch = await prisma.branch.create({
      data: { name: 'Test Branch Phase 2' }
    });
  }
  const branchId = branch.id;

  // 2. Get or create School Year (Session)
  let schoolYear = await prisma.schoolYear.findFirst();
  if (!schoolYear) {
    schoolYear = await prisma.schoolYear.create({
      data: { schoolYear: '2026/2027', createdBy: 1 }
    });
  }
  const sessionId = schoolYear.id;
  const termId = 1;
  const termName = 'First Term';

  // 3. Get or create Class & Subject
  let testClass = await prisma.class.findFirst({ where: { branchId } });
  if (!testClass) {
    testClass = await prisma.class.create({
      data: { name: 'JSS 1 Test', branchId, usesScores: true }
    });
  }

  let testSubject = await prisma.subject.findFirst({ where: { branchId } });
  if (!testSubject) {
    testSubject = await prisma.subject.create({
      data: { name: 'Mathematics Test', branchId, subjectCode: 'MTH-TEST' }
    });
  }

  console.log('✅ Baseline Test Fixtures initialized successfully.');

  // =========================================================================
  // TEST 1: Create CBT Exam Master (Cap: 5 Questions, CBT Total Marks: 25)
  // =========================================================================
  console.log('\n--- Test 1: Create CBT Exam Master Definition ---');
  const cbtTitle = `CBT Phase 2 Master ${Date.now()}`;
  const mockCbt = createMockReqRes({
    name: cbtTitle,
    examCategory: 'CBT',
    cbtTotalMarks: 25,
    totalQuestionCount: 5,
    termId,
    sessionId,
    term: termName,
  }, branchId);

  await createExam(mockCbt.req, mockCbt.res);
  const cbtRes = mockCbt.getResult();

  if (![200, 201].includes(cbtRes.statusCode) || !cbtRes.responseData?.success) {
    throw new Error(`Failed to create CBT Exam Master: ${JSON.stringify(cbtRes.responseData)}`);
  }
  const cbtExam = cbtRes.responseData.exam;
  console.log(`✅ CBT Exam Master created: ID=${cbtExam.id}, Title="${cbtExam.name}", Cap=${cbtExam.totalQuestionCount}, Marks=${cbtExam.cbtTotalMarks}`);

  // =========================================================================
  // TEST 2: Create Manual Paper Exam Master with Marks Breakdown
  // =========================================================================
  console.log('\n--- Test 2: Create Manual Paper Exam Master with Breakdown ---');
  const manualTitle = `Manual Paper Phase 2 ${Date.now()}`;
  const mockManual = createMockReqRes({
    name: manualTitle,
    examCategory: 'MANUAL',
    termId,
    sessionId,
    term: termName,
    manualMarksBreakdown: [
      { name: 'Section A - Objective', maxMark: 20 },
      { name: 'Section B - Theory & Essay', maxMark: 40 },
    ],
  }, branchId);

  await createExam(mockManual.req, mockManual.res);
  const manualRes = mockManual.getResult();

  if (![200, 201].includes(manualRes.statusCode) || !manualRes.responseData?.success) {
    throw new Error(`Failed to create Manual Exam Master: ${JSON.stringify(manualRes.responseData)}`);
  }
  const manualExam = manualRes.responseData.exam;
  console.log(`✅ Manual Exam Master created: ID=${manualExam.id}, Title="${manualExam.name}", Breakdown=`, manualExam.manualMarksBreakdown);

  // =========================================================================
  // TEST 3: Question Cap Hard Enforcement (Over-cap attempt -> 400 Bad Request)
  // =========================================================================
  console.log('\n--- Test 3: Attempt CBT Distribution exceeding Question Cap (Cap: 5, Bundle: 8) ---');
  // Create Question Group with 8 questions
  const overCapGroup = await prisma.questionGroup.create({
    data: {
      branchId,
      title: 'Over-Cap Bundle (8 Questions)',
      groupCode: `QG-OVER-${Date.now().toString().slice(-4)}`,
      subjectId: testSubject.id,
      classId: testClass.id,
      questionIds: [101, 102, 103, 104, 105, 106, 107, 108],
      totalMarks: 40,
    }
  });

  const mockOverCapDist = createMockReqRes({
    title: cbtTitle,
    examMasterId: cbtExam.id,
    classId: testClass.id,
    subjectId: testSubject.id,
    groupId: overCapGroup.id,
    duration: 45,
    passingMark: 50,
  }, branchId);

  await createCbtDistribution(mockOverCapDist.req, mockOverCapDist.res);
  const overCapRes = mockOverCapDist.getResult();

  console.log('Over-Cap response:', overCapRes.statusCode, overCapRes.responseData);
  if (overCapRes.statusCode !== 400) {
    throw new Error(`Expected HTTP 400 for over-cap distribution, got ${overCapRes.statusCode}`);
  }
  if (!overCapRes.responseData?.message?.includes('Maximum of 5 questions approved for this exam.')) {
    throw new Error(`Expected exact error message "Maximum of 5 questions approved for this exam.", got: "${overCapRes.responseData?.message}"`);
  }
  console.log('✅ Hard Invariant Verified: Distribution correctly blocked with message:', `"${overCapRes.responseData.message}"`);

  // =========================================================================
  // TEST 4: Successful CBT Distribution within Question Cap (Cap: 5, Bundle: 4)
  // =========================================================================
  console.log('\n--- Test 4: CBT Distribution within Question Cap (Cap: 5, Bundle: 4) ---');
  // Create 4 approved questions
  const qb1 = await prisma.questionBank.create({
    data: {
      questionText: 'What is 2 + 2?',
      questionType: 'mcq',
      marks: 5,
      subjectId: testSubject.id,
      classId: testClass.id,
      branchId,
      status: 'APPROVED',
    }
  });
  const qb2 = await prisma.questionBank.create({
    data: {
      questionText: 'What is 5 x 5?',
      questionType: 'mcq',
      marks: 5,
      subjectId: testSubject.id,
      classId: testClass.id,
      branchId,
      status: 'APPROVED',
    }
  });
  const qb3 = await prisma.questionBank.create({
    data: {
      questionText: 'What is 10 / 2?',
      questionType: 'mcq',
      marks: 5,
      subjectId: testSubject.id,
      classId: testClass.id,
      branchId,
      status: 'APPROVED',
    }
  });
  const qb4 = await prisma.questionBank.create({
    data: {
      questionText: 'What is 100 - 50?',
      questionType: 'mcq',
      marks: 5,
      subjectId: testSubject.id,
      classId: testClass.id,
      branchId,
      status: 'APPROVED',
    }
  });
  const qbIds = [qb1.id, qb2.id, qb3.id, qb4.id];

  const validGroup = await prisma.questionGroup.create({
    data: {
      branchId,
      title: 'Valid Bundle (4 Questions)',
      groupCode: `QG-VALID-${Date.now().toString().slice(-4)}`,
      subjectId: testSubject.id,
      classId: testClass.id,
      questionIds: qbIds,
      totalMarks: 20,
    }
  });

  const mockValidDist = createMockReqRes({
    title: cbtTitle,
    examMasterId: cbtExam.id,
    classId: testClass.id,
    subjectId: testSubject.id,
    groupId: validGroup.id,
    duration: 30,
    passingMark: 50,
  }, branchId);

  await createCbtDistribution(mockValidDist.req, mockValidDist.res);
  const validRes = mockValidDist.getResult();

  if (validRes.statusCode !== 200 || !validRes.responseData?.success) {
    throw new Error(`Expected HTTP 200 for valid distribution, got: ${validRes.statusCode} - ${JSON.stringify(validRes.responseData)}`);
  }
  console.log('✅ Valid Distribution succeeded:', validRes.responseData?.distribution?.id, validRes.responseData?.distribution?.title);

  // Clean up test groups, distribution, and question bank items
  if (validRes.responseData?.distribution?.id) {
    await prisma.cbtDistribution.delete({ where: { id: validRes.responseData.distribution.id } });
  }
  await prisma.questionGroup.deleteMany({ where: { id: { in: [overCapGroup.id, validGroup.id] } } });
  await prisma.questionBank.deleteMany({ where: { id: { in: qbIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: [cbtExam.id, manualExam.id] } } });

  console.log('\n=================================================================');
  console.log('🎉 ALL PHASE 2 TESTS PASSED! Exam Master & Question Cap Gate is 100% Verified!');
  console.log('=================================================================\n');
}

runPhase2Tests()
  .catch((err) => {
    console.error('❌ Phase 2 Test Error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
