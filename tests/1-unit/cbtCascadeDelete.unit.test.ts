import assert from 'node:assert/strict';
import { companionExamKey, companionExamWhere } from '../../lib/cbtCompanionExam';

export async function testCbtCascadeDeleteUnit() {
  console.log('\n--- [UNIT TEST] CBT Cascade Deletion & Key Resolution ---');

  // 1. Validate companion key generation
  const key1 = companionExamKey('Term 1 Physics Midterm', 10, 4);
  assert.equal(key1, 'Term 1 Physics Midterm::10::4');
  console.log('✓ CBT companion key formatting verified');

  // 2. Validate companion where clause
  const where = companionExamWhere({
    title: 'SS2 Biology Assessment',
    classId: 12,
    subjectId: 8,
    branchId: 2,
  });
  assert.deepEqual(where, {
    title: 'SS2 Biology Assessment',
    classId: 12,
    subjectId: 8,
    branchId: 2,
  });
  console.log('✓ CBT companion where clause scoping verified');

  console.log('✔ CBT cascade delete unit validations passed.');
}

if (require.main === module) {
  testCbtCascadeDeleteUnit()
    .then(() => {
      console.log('\nAll CBT cascade delete unit tests passed.');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
