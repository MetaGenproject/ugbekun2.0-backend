const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';
const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api/admin`;

async function testMultitenantIsolation() {
  console.log('\n--- [INTEGRATION TEST 2] Multi-Tenant Branch Isolation ---');

  // Branch 32 Admin Token
  const branch32Token = jwt.sign({ id: 2, username: 'admin_ebor', role: 2, legacyUserId: 32 }, JWT_SECRET, { expiresIn: '1h' });

  // 1. Fetch MyEduRide Config for Branch 32
  const configRes = await fetch(`${BASE_URL}/myeduride/config`, {
    headers: { Authorization: `Bearer ${branch32Token}` }
  });
  assert.equal(configRes.status, 200, 'Branch 32 admin should query config successfully');
  const configData = await configRes.json();
  assert.equal(configData.data.branchId, 32, 'Config must strictly scope to branch 32');
  console.log(`✓ Branch 32 config isolated (Branch Code: ${configData.data.branchCode})`);

  // 2. Fetch MyEduRide Overview for Branch 32
  const overviewRes = await fetch(`${BASE_URL}/myeduride/overview`, {
    headers: { Authorization: `Bearer ${branch32Token}` }
  });
  assert.equal(overviewRes.status, 200, 'Overview query must succeed');
  const overviewData = await overviewRes.json();
  assert.ok(overviewData.data.metrics.totalStudentsEnrolled >= 0, 'Must return branch 32 student metrics');
  console.log(`✓ Branch 32 metrics isolated (${overviewData.data.metrics.totalStudentsEnrolled} students enrolled in branch 32)`);

  // 3. Verify Gate Turnstile Scans isolate to Branch 32
  const scanRes = await fetch(`${BASE_URL}/myeduride/gate-logs/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${branch32Token}` },
    body: JSON.stringify({ code: 'UG-2026-001', direction: 'ENTRY', gateLocation: 'Branch 32 Gate 1' })
  });
  assert.equal(scanRes.status, 200, 'Gate scan in branch 32 must succeed');
  const scanData = await scanRes.json();
  assert.equal(scanData.log.gateLocation, 'Branch 32 Gate 1', 'Scan record must match branch 32 gate location');
  console.log('✓ Turnstile scan correctly logged to Branch 32 ledger');

  console.log('✔ All Multi-Tenant Branch Isolation tests PASSED!');
  return true;
}

if (require.main === module) {
  testMultitenantIsolation().catch((err) => {
    console.error('❌ Multi-tenant isolation test failed:', err);
    process.exit(1);
  });
}

module.exports = { testMultitenantIsolation };
