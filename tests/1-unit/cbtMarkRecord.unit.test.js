const assert = require('node:assert/strict');
const { scaleCbtPercentage, parseCbtScore } = require('../../lib/cbtMarkRecord');

async function testCbtMarkRecordUnit() {
  console.log('\n--- [UNIT TEST] CBT marksheet scaling ---');
  assert.equal(scaleCbtPercentage(100, 40), 40);
  assert.equal(scaleCbtPercentage(50, 40), 20);
  assert.equal(scaleCbtPercentage(0, 40), 0);
  assert.equal(scaleCbtPercentage(110, 40), 40);
  assert.equal(parseCbtScore('18.5'), 18.5);
  assert.equal(parseCbtScore(''), null);
  console.log('✓ CBT percentage scales onto the report-card CBT component without touching theory marks');
}

module.exports = { testCbtMarkRecordUnit };

if (require.main === module) {
  testCbtMarkRecordUnit()
    .then(() => {
      console.log('\nAll CBT mark record unit tests passed.');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
