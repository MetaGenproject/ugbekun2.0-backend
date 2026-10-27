import 'dotenv/config';
import prisma from '../lib/prisma';

async function verify() {
  console.log('--- [Phase 1 Verification] Testing CBT & Exam Matrix Schema Invariants ---');

  // 1. Verify ExamSetup model & relations
  const examSetupCount = await prisma.examSetup.count();
  console.log('✅ ExamSetup model accessible. Existing count:', examSetupCount);

  // 2. Verify AssessmentComponent model & relations
  const componentCount = await prisma.assessmentComponent.count();
  console.log('✅ AssessmentComponent model accessible. Existing count:', componentCount);

  // 3. Verify StudentComponentScore model & relations
  const scoreCount = await prisma.studentComponentScore.count();
  console.log('✅ StudentComponentScore model accessible. Existing count:', scoreCount);

  // 4. Verify CbtDistribution targetSlot & assessmentComponentId
  const cbtDist = await prisma.cbtDistribution.findFirst({
    select: {
      id: true,
      title: true,
      targetSlot: true,
      assessmentComponentId: true,
    },
  });
  console.log('✅ CbtDistribution targetSlot & assessmentComponentId fields verified:', cbtDist ? cbtDist : 'No distribution record yet, but fields exist in schema');

  // 5. Verify ClassReportCardPublication releaseCombinedCa
  const pub = await prisma.classReportCardPublication.findFirst({
    select: {
      id: true,
      releaseCa1: true,
      releaseCa2: true,
      releaseCombinedCa: true,
      releaseExam: true,
    },
  });
  console.log('✅ ClassReportCardPublication.releaseCombinedCa verified:', pub ? pub : 'No publication record yet, but field exists in schema');

  console.log('--- [Phase 1 Verification] ALL INVARIANTS PASSED! 🚀 ---');
}

verify()
  .catch((err) => {
    console.error('❌ Phase 1 verification failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
