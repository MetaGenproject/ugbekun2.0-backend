import 'dotenv/config';
import prisma from '../lib/prisma';
import {
  getEvaluationMatrices,
  createEvaluationMatrix,
  updateEvaluationMatrix,
  createExam,
} from '../controllers/admin/adminExamCbtController';

// Helper mock request and response
function createMockReqRes(body: any = {}, branchId: number = 1, params: any = {}, query: any = {}) {
  let responseData: any = null;
  let statusCode: number = 200;

  const req: any = {
    body,
    branchId,
    params,
    query,
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

async function runPhase3Tests() {
  console.log('=================================================================');
  console.log('🧪 Starting Phase 3 Test Suite: Evaluation Matrix & Component Rollup');
  console.log('=================================================================\n');

  // 1. Create a dedicated Isolated Branch for Hard Gate Testing (0 Exams)
  const isolatedBranch = await prisma.branch.create({
    data: { name: `Isolated Phase 3 Branch ${Date.now()}` },
  });
  const emptyBranchId = isolatedBranch.id;

  // 2. Setup standard test branch for rollup testing
  let activeBranch = await prisma.branch.findFirst({ where: { name: { not: isolatedBranch.name } } });
  if (!activeBranch) {
    activeBranch = await prisma.branch.create({ data: { name: 'Phase 3 Standard Branch' } });
  }
  const activeBranchId = activeBranch.id;

  let schoolYear = await prisma.schoolYear.findFirst();
  if (!schoolYear) {
    schoolYear = await prisma.schoolYear.create({
      data: { schoolYear: '2026/2027', createdBy: 1 },
    });
  }
  const sessionId = schoolYear.id;
  const termId = 1;

  let testClass = await prisma.class.findFirst({ where: { branchId: activeBranchId } });
  if (!testClass) {
    testClass = await prisma.class.create({
      data: { name: 'Primary 5 Gold', branchId: activeBranchId, usesScores: true },
    });
  }

  // =========================================================================
  // TEST 1: Hard Dependency Gate Enforced (Scenario A - 412 Precondition Failed)
  // =========================================================================
  console.log('--- Test 1: Hard Gate Verification on Branch with Zero Exams (HTTP 412) ---');

  // Attempt GET matrices on empty branch
  const mockGetGate = createMockReqRes({}, emptyBranchId);
  await getEvaluationMatrices(mockGetGate.req, mockGetGate.res);
  const getGateRes = mockGetGate.getResult();

  console.log('GET empty branch response:', getGateRes.statusCode, getGateRes.responseData);
  if (getGateRes.statusCode !== 412) {
    throw new Error(`Expected HTTP 412 for GET evaluation matrices without Exam Master, got ${getGateRes.statusCode}`);
  }
  if (getGateRes.responseData?.code !== 'EXAM_MASTER_REQUIRED') {
    throw new Error(`Expected error code "EXAM_MASTER_REQUIRED", got "${getGateRes.responseData?.code}"`);
  }

  // Attempt POST matrix on empty branch
  const mockPostGate = createMockReqRes({
    name: 'Blocked Scheme',
    code: 'BLOCKED',
    components: [{ name: 'CA1', code: 'CA1', maxMarks: 40, passMarks: 16 }],
  }, emptyBranchId);
  await createEvaluationMatrix(mockPostGate.req, mockPostGate.res);
  const postGateRes = mockPostGate.getResult();

  console.log('POST empty branch response:', postGateRes.statusCode, postGateRes.responseData);
  if (postGateRes.statusCode !== 412) {
    throw new Error(`Expected HTTP 412 for POST evaluation matrix without Exam Master, got ${postGateRes.statusCode}`);
  }
  console.log('✅ Scenario A Verified: Hard Gate correctly blocked access with HTTP 412 EXAM_MASTER_REQUIRED.');

  // =========================================================================
  // Setup Exam Masters on Active Branch
  // =========================================================================
  console.log('\n--- Setting up CBT Exam Masters for Scenario B Rollup ---');
  const mockExam1 = createMockReqRes({
    name: 'CBT 1',
    examCategory: 'CBT',
    cbtTotalMarks: 10,
    totalQuestionCount: 20,
    termId,
    sessionId,
  }, activeBranchId);
  await createExam(mockExam1.req, mockExam1.res);
  const examMaster1 = mockExam1.getResult().responseData.exam;

  const mockExam2 = createMockReqRes({
    name: 'CBT 2',
    examCategory: 'CBT',
    cbtTotalMarks: 10,
    totalQuestionCount: 20,
    termId,
    sessionId,
  }, activeBranchId);
  await createExam(mockExam2.req, mockExam2.res);
  const examMaster2 = mockExam2.getResult().responseData.exam;

  const mockExamTerminal = createMockReqRes({
    name: 'CBT Terminal Exam',
    examCategory: 'CBT',
    cbtTotalMarks: 40,
    totalQuestionCount: 50,
    termId,
    sessionId,
  }, activeBranchId);
  await createExam(mockExamTerminal.req, mockExamTerminal.res);
  const examMasterTerminal = mockExamTerminal.getResult().responseData.exam;

  console.log('✅ Created CBT Exam Masters:', {
    cbt1: examMaster1.id,
    cbt2: examMaster2.id,
    terminal: examMasterTerminal.id,
  });

  // =========================================================================
  // TEST 2: Multi-Component Rollup Matrix Creation (Scenario B)
  // =========================================================================
  console.log('\n--- Test 2: Create Multi-Component Rollup Matrix (Scenario B: 100 Marks) ---');
  const matrixCode = `HYB-${Date.now().toString().slice(-4)}`;
  const rollupPayload = {
    name: 'Primary 5 Gold Hybrid Assessment Scheme',
    code: matrixCode,
    description: 'CA1 (10 CBT + 10 Theory), CA2 (10 CBT + 10 Theory), Exam (40 CBT + 20 Written)',
    classId: testClass.id,
    columns: [
      {
        columnKey: 'CA1',
        columnLabel: 'Continuous Assessment 1',
        maxMarks: 20,
        passMarks: 8,
        displayOrder: 1,
        feedItems: [
          { componentName: 'CBT 1', componentType: 'CBT', weightMarks: 10, examMasterId: examMaster1.id },
          { componentName: 'Manual Theory 1', componentType: 'MANUAL', weightMarks: 10 },
        ],
      },
      {
        columnKey: 'CA2',
        columnLabel: 'Continuous Assessment 2',
        maxMarks: 20,
        passMarks: 8,
        displayOrder: 2,
        feedItems: [
          { componentName: 'CBT 2', componentType: 'CBT', weightMarks: 10, examMasterId: examMaster2.id },
          { componentName: 'Manual Theory 2', componentType: 'MANUAL', weightMarks: 10 },
        ],
      },
      {
        columnKey: 'EXAM',
        columnLabel: 'Terminal Examination',
        maxMarks: 60,
        passMarks: 24,
        displayOrder: 3,
        feedItems: [
          { componentName: 'CBT Terminal Exam', componentType: 'CBT', weightMarks: 40, examMasterId: examMasterTerminal.id },
          { componentName: 'Written Theory Exam', componentType: 'MANUAL', weightMarks: 20 },
        ],
      },
    ],
  };

  const mockCreateRollup = createMockReqRes(rollupPayload, activeBranchId);
  await createEvaluationMatrix(mockCreateRollup.req, mockCreateRollup.res);
  const rollupRes = mockCreateRollup.getResult();

  if (rollupRes.statusCode !== 201 || !rollupRes.responseData?.success) {
    throw new Error(`Failed to create multi-component rollup matrix: ${JSON.stringify(rollupRes.responseData)}`);
  }

  const createdMatrix = rollupRes.responseData.matrix;
  console.log(`✅ Multi-Component Rollup Matrix created: ID=${createdMatrix.id}, TotalMarks=${createdMatrix.totalMarks}`);
  console.log(`   Columns Count: ${createdMatrix.columns?.length}`);

  if (createdMatrix.columns?.length !== 3) {
    throw new Error(`Expected 3 columns (CA1, CA2, EXAM), got ${createdMatrix.columns?.length}`);
  }

  const ca1Col = createdMatrix.columns.find((c: any) => c.columnKey === 'CA1');
  if (!ca1Col || ca1Col.feedItems?.length !== 2) {
    throw new Error(`Expected CA1 to have 2 feed items (CBT 1 + Manual Theory 1), got ${ca1Col?.feedItems?.length}`);
  }
  const ca1CbtItem = ca1Col.feedItems.find((fi: any) => fi.componentType === 'CBT');
  console.log(`   CA1 CBT Feed Item: Name="${ca1CbtItem.componentName}", Weight=${ca1CbtItem.weightMarks}, LinkedExam=${ca1CbtItem.examMasterId}`);

  // Check Class Assignment
  const updatedClass = await prisma.class.findUnique({ where: { id: testClass.id } });
  if (updatedClass?.evaluationMatrixId !== createdMatrix.id) {
    throw new Error(`Expected class evaluationMatrixId to be ${createdMatrix.id}, got ${updatedClass?.evaluationMatrixId}`);
  }
  console.log(`✅ Class assignment verified: Class "${updatedClass.name}" linked to Matrix ${createdMatrix.id}`);

  // =========================================================================
  // TEST 3: Paper-Only / Non-CBT School Isolation (Scenario C)
  // =========================================================================
  console.log('\n--- Test 3: Create Non-CBT Paper-Only Scheme (Scenario C) ---');
  const paperCode = `PAPER-${Date.now().toString().slice(-4)}`;
  const paperPayload = {
    name: 'St. Jude Academy Paper-Only Scheme',
    code: paperCode,
    columns: [
      {
        columnKey: 'CA1',
        columnLabel: 'Continuous Assessment 1',
        maxMarks: 20,
        feedItems: [
          { componentName: 'Written Test 1', componentType: 'MANUAL', weightMarks: 20 },
        ],
      },
      {
        columnKey: 'CA2',
        columnLabel: 'Continuous Assessment 2',
        maxMarks: 20,
        feedItems: [
          { componentName: 'Written Test 2', componentType: 'MANUAL', weightMarks: 20 },
        ],
      },
      {
        columnKey: 'EXAM',
        columnLabel: 'Terminal Theory Exam',
        maxMarks: 60,
        feedItems: [
          { componentName: 'Theory Examination', componentType: 'MANUAL', weightMarks: 60 },
        ],
      },
    ],
  };

  const mockPaper = createMockReqRes(paperPayload, activeBranchId);
  await createEvaluationMatrix(mockPaper.req, mockPaper.res);
  const paperRes = mockPaper.getResult();

  if (paperRes.statusCode !== 201 || !paperRes.responseData?.success) {
    throw new Error(`Failed to create paper-only matrix: ${JSON.stringify(paperRes.responseData)}`);
  }
  const paperMatrix = paperRes.responseData.matrix;
  console.log(`✅ Paper-Only Matrix created: ID=${paperMatrix.id}, Code=${paperMatrix.code}`);

  const hasAnyCbt = paperMatrix.columns.some((c: any) =>
    c.feedItems?.some((fi: any) => fi.componentType === 'CBT' || fi.examMasterId !== null)
  );
  if (hasAnyCbt) {
    throw new Error('Paper-only matrix contains unexpected CBT components!');
  }
  console.log('✅ Scenario C Verified: Paper-only isolation has zero CBT components.');

  // =========================================================================
  // Clean up Test Fixtures
  // =========================================================================
  await prisma.class.update({ where: { id: testClass.id }, data: { evaluationMatrixId: null } });
  await prisma.evaluationMatrix.deleteMany({ where: { id: { in: [createdMatrix.id, paperMatrix.id] } } });
  await prisma.exam.deleteMany({ where: { id: { in: [examMaster1.id, examMaster2.id, examMasterTerminal.id] } } });
  await prisma.branch.delete({ where: { id: emptyBranchId } });

  console.log('\n=================================================================');
  console.log('🎉 ALL PHASE 3 TESTS PASSED! Evaluation Matrix & Rollup Gate Verified!');
  console.log('=================================================================\n');
}

runPhase3Tests()
  .catch((err) => {
    console.error('❌ Phase 3 Test Error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
