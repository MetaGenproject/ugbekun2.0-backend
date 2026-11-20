import assert from 'node:assert/strict';
import {
  buildResolvedMatrixFromDbRecord,
  classifyMatrixComponent,
  mapStudentMarkToMatrix,
  parseMarkScore,
  resolveActiveMatrixColumnsForStage,
} from '../../lib/markParser';
import { buildReportCardRowsForStudent } from '../../lib/reportCardHelper';

export async function testMatrixClassificationUnit() {
  console.log('\n--- [UNIT TEST] Matrix Component Classification & COMBINED_CA Max Marks ---');

  // 1. Delivery mode 'CBT' on EXAM column must NOT misclassify EXAM as CA
  const examCat = classifyMatrixComponent({
    code: 'EXAM',
    key: 'EXAM',
    label: 'Terminal Examination',
    name: 'Terminal Examination',
    examCategory: 'CBT',
  });
  assert.equal(examCat, 'EXAM');

  // 2. Delivery mode 'CBT' on CA column stays CA
  const caCat = classifyMatrixComponent({
    code: 'CA1',
    key: 'CA1',
    label: 'Continuous Assessment 1',
    name: 'Continuous Assessment 1',
    examCategory: 'CBT',
  });
  assert.equal(caCat, 'CA');

  // 3. Matrix with CA1(20) + CA2(20) + CBT-fed EXAM(60) resolves caMaxMarks=40, examMaxMarks=60
  const resolved = buildResolvedMatrixFromDbRecord({
    id: 24,
    name: 'TERMLY REPORT CBT',
    code: 'CBT-001',
    totalMarks: '100',
    columns: [
      {
        columnKey: 'CA1',
        columnLabel: 'Continuous Assessment 1',
        maxMarks: 20,
        passMarks: 8,
        displayOrder: 1,
        feedItems: [{ examMaster: { examCategory: 'CBT' } }],
      },
      {
        columnKey: 'CA2',
        columnLabel: 'Continuous Assessment 2',
        maxMarks: 20,
        passMarks: 8,
        displayOrder: 2,
        feedItems: [{ examMaster: { examCategory: 'CBT' } }],
      },
      {
        columnKey: 'EXAM',
        columnLabel: 'Terminal Examination',
        maxMarks: 60,
        passMarks: 24,
        displayOrder: 3,
        feedItems: [{ examMaster: { examCategory: 'CBT' } }],
      },
    ],
  });

  assert.equal(resolved.caMaxMarks, 40);
  assert.equal(resolved.examMaxMarks, 60);
  assert.equal(resolved.fullMaxMarks, 100);

  const combinedCa = resolveActiveMatrixColumnsForStage(resolved, 'COMBINED_CA');
  assert.equal(combinedCa.activeStage, 'COMBINED_CA');
  assert.equal(combinedCa.activeMaxMarks, 40);
  assert.equal(combinedCa.activeColumns.length, 2);

  // 4. Unentered matrix scores must NEVER fall back to standalone cbtMark on report cards
  const emptyMatrixWithCbt = mapStudentMarkToMatrix(
    { mark: '{"CA1":"","CA2":"","EXAM":""}', cbtMark: '18', absent: '0' },
    resolved,
    'FULL'
  );
  assert.equal(emptyMatrixWithCbt.hasValidScore, false);
  assert.equal(emptyMatrixWithCbt.caTotal, 0);
  assert.equal(emptyMatrixWithCbt.fullTotal, 0);
  assert.equal(emptyMatrixWithCbt.componentScores.CA1, null);

  const parsedEmptyWithCbt = parseMarkScore('{"CA1":"","CA2":"","EXAM":""}', '18');
  assert.equal(parsedEmptyWithCbt.hasValidScore, false);
  assert.equal(parsedEmptyWithCbt.total, 0);

  // 5. Report card rows must include ONLY assigned subjects that have teacher/admin-filled scores
  const built = buildReportCardRowsForStudent({
    assignedSubjects: [
      { subjectId: 1, subjectName: 'Literacy', subjectCode: 'LIT' },
      { subjectId: 2, subjectName: 'Numeracy', subjectCode: 'NUM' },
      { subjectId: 3, subjectName: 'Basic Science', subjectCode: 'BSC' },
    ],
    studentMarks: [
      { id: 101, subjectId: 1, mark: '{"CA1":"18","CA2":"","EXAM":""}', cbtMark: '18', absent: '0' },
      { id: 102, subjectId: 2, mark: '{"CA1":"","CA2":"","EXAM":""}', cbtMark: '15', absent: '0' }, // unentered CBT-only
      { id: 103, subjectId: 99, mark: '{"CA1":"19","CA2":"","EXAM":""}', cbtMark: null, absent: '0' }, // unassigned subject
    ],
    dbMatrix: resolved,
    activeStage: 'COMBINED_CA',
    activeMaxMarks: 40,
    isCombinedCaScope: true,
    classSubjectTotals: { '1': { sum: 18, count: 1 } },
  });
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0].subjectName, 'Literacy');
  assert.equal(built.rows[0].mark, '18');
  assert.equal(built.count, 1);
  assert.equal(built.sum, 18);

  console.log('✔ Matrix classification & COMBINED_CA unit validations passed.');
}

if (require.main === module) {
  testMatrixClassificationUnit()
    .then(() => {
      console.log('\nAll matrix classification unit tests passed.');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

