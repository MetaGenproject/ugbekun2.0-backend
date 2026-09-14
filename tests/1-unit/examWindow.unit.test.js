const assert = require('node:assert/strict');
const { examWindowStatus, parseMaybeDate } = require('../../lib/examWindow');

async function testExamWindowUnit() {
  console.log('\n--- [UNIT TEST] Exam sitting window ---');

  const now = new Date('2026-09-11T10:00:00.000Z');
  assert.equal(examWindowStatus('2026-09-11T12:00:00.000Z', '2026-09-11T14:00:00.000Z', now), 'upcoming');
  assert.equal(examWindowStatus('2026-09-11T08:00:00.000Z', '2026-09-11T14:00:00.000Z', now), 'open');
  assert.equal(examWindowStatus('2026-09-11T08:00:00.000Z', '2026-09-11T09:00:00.000Z', now), 'ended');
  assert.equal(examWindowStatus(null, null, now), 'open');
  assert.equal(parseMaybeDate('not-a-date'), null);
  console.log('✓ Sitting windows classify as upcoming / open / ended without creating a new exam');
}

module.exports = { testExamWindowUnit };

if (require.main === module) {
  testExamWindowUnit()
    .then(() => {
      console.log('\nAll exam window unit tests passed.');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
