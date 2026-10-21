import 'dotenv/config';
import prisma from '../lib/prisma';

async function verify() {
  console.log('--- [Phase 1 Verification] Starting Model & Database Invariant Checks ---');

  // 1. Verify Class uses_scores
  const classCheck = await prisma.class.findFirst({
    select: { id: true, name: true, usesScores: true, isEcd: true }
  });
  console.log('✅ Class.usesScores is accessible:', classCheck ? { name: classCheck.name, usesScores: classCheck.usesScores } : 'No class record found, but schema validated');

  // 2. Verify Exam new fields
  const examCheck = await prisma.exam.findFirst({
    select: {
      id: true,
      name: true,
      examCategory: true,
      cbtTotalMarks: true,
      totalQuestionCount: true,
      manualMarksBreakdown: true,
      matrixMappings: true
    }
  });
  console.log('✅ Exam Phase 1 fields accessible:', examCheck ? { name: examCheck.name, category: examCheck.examCategory } : 'No exam records yet, but schema validated');

  // 3. Verify EvaluationMatrixColumn & ItemMapping
  const columnCount = await prisma.evaluationMatrixColumn.count();
  const mappingCount = await prisma.evaluationMatrixItemMapping.count();
  console.log('✅ EvaluationMatrixColumn & ItemMapping models accessible:', { columnCount, mappingCount });

  // 4. Verify SubjectCommentAssessment
  const commentAssessmentCount = await prisma.subjectCommentAssessment.count();
  console.log('✅ SubjectCommentAssessment model accessible:', { commentAssessmentCount });

  // 5. Verify ClassReportCardPublication multi-stage release fields
  const pubCheck = await prisma.classReportCardPublication.findFirst({
    select: {
      id: true,
      termId: true,
      releaseCa1: true,
      releaseCa2: true,
      releaseExam: true,
      releaseFull: true,
      isPublished: true
    }
  });
  console.log('✅ ClassReportCardPublication multi-stage fields accessible:', pubCheck ? pubCheck : 'No publication record yet, but schema validated');

  console.log('--- [Phase 1 Verification] All Invariant Checks PASSED! ---');
}

verify()
  .catch((err) => {
    console.error('❌ Verification failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
