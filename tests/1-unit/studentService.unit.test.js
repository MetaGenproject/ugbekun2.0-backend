const assert = require('node:assert/strict');
const {
  generateSecurePassword,
  generateRegistrationNumber,
  wipeEvaluationMatrix
} = require('../../lib/studentService');

async function testStudentServiceUnit() {
  console.log('\n--- [UNIT TEST 3] Student Services, Registration & Credentials ---');

  // Test 1: Secure password generator
  const pwd1 = generateSecurePassword(10);
  const pwd2 = generateSecurePassword(12);
  
  assert.equal(pwd1.length, 10, 'Password length should be exactly 10 characters');
  assert.equal(pwd2.length, 12, 'Password length should be exactly 12 characters');
  assert.notEqual(pwd1, pwd2, 'Generated passwords should be random and distinct');
  console.log('✓ Secure random password generation validated');

  // Test 2: Evaluation matrix wipe function with mock transaction
  let deletedCount = 0;
  const mockTx = {
    mark: {
      deleteMany: async ({ where }) => {
        assert.equal(where.studentId, 4413);
        assert.equal(where.sessionId, 5);
        deletedCount = 4;
        return { count: deletedCount };
      }
    }
  };

  await wipeEvaluationMatrix(mockTx, { studentId: 4413, sessionId: 5 });
  assert.equal(deletedCount, 4, 'Wipe evaluation matrix must invoke deleteMany with studentId & sessionId');
  console.log('✓ Evaluation matrix wipe function validated with mock transaction');

  // Test 3: Registration number generator logic with mock transaction
  const mockRegTx = {
    branch: {
      findUnique: async () => ({ code: 'UISS' })
    },
    student: {
      findFirst: async () => ({ registerNo: 'REG/UISS/2026/0003' }),
      findUnique: async () => null
    }
  };

  const nextRegNo = await generateRegistrationNumber(mockRegTx, 32);
  assert.ok(nextRegNo.includes('UISS'), 'Generated regNo must include branch code');
  assert.ok(nextRegNo.includes('0004'), 'Generated regNo sequence must increment to 0004');
  console.log('✓ Registration number generator validated (Generated: ' + nextRegNo + ')');

  console.log('✔ All Unit Tests in studentService.unit.test.js PASSED!');
  return true;
}

if (require.main === module) {
  testStudentServiceUnit().catch((err) => {
    console.error('❌ Unit test failed:', err);
    process.exit(1);
  });
}

module.exports = { testStudentServiceUnit };
