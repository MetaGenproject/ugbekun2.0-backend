const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';
const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function testFullEndpointsIntegration() {
  console.log('\n--- [INTEGRATION TEST 3] Full Endpoints & Streaming APIs ---');

  const superadminToken = jwt.sign({ id: 1, username: 'superadmin', role: 1 }, JWT_SECRET, { expiresIn: '1h' });
  const branchAdminToken = jwt.sign({ id: 2, username: 'admin_ebor', role: 2, legacyUserId: 32 }, JWT_SECRET, { expiresIn: '1h' });

  // 1. Test Superadmin Revenue Analytics JSON endpoint
  const revRes = await fetch(`${BASE_URL}/superadmin/revenue-analytics`, {
    headers: { Authorization: `Bearer ${superadminToken}` }
  });
  assert.equal(revRes.status, 200, 'GET /revenue-analytics must return 200');
  const revData = await revRes.json();
  assert.ok(revData.data.summary, 'Must contain financial summary object');
  assert.ok(Array.isArray(revData.data.branchLeaderboard), 'Must contain branch leaderboard array');
  console.log(`✓ Superadmin Revenue Analytics JSON endpoint validated (${revData.data.branchLeaderboard.length} branches aggregated)`);

  // 2. Test Superadmin Revenue Analytics CSV stream
  const revCsvRes = await fetch(`${BASE_URL}/superadmin/revenue-analytics/export/csv`, {
    headers: { Authorization: `Bearer ${superadminToken}` }
  });
  assert.equal(revCsvRes.status, 200, 'GET /revenue-analytics/export/csv must return 200');
  assert.ok(revCsvRes.headers.get('content-type')?.includes('text/csv'), 'Content-Type must be text/csv');
  const csvBody = await revCsvRes.text();
  assert.ok(csvBody.length > 500, 'CSV stream must be non-empty');
  console.log(`✓ Superadmin Revenue Analytics CSV stream validated (${csvBody.length} bytes)`);

  // 3. Test Superadmin Revenue Analytics PDF stream
  const revPdfRes = await fetch(`${BASE_URL}/superadmin/revenue-analytics/export/pdf`, {
    headers: { Authorization: `Bearer ${superadminToken}` }
  });
  assert.equal(revPdfRes.status, 200, 'GET /revenue-analytics/export/pdf must return 200');
  assert.ok(revPdfRes.headers.get('content-type')?.includes('application/pdf'), 'Content-Type must be application/pdf');
  const pdfBytes = await revPdfRes.arrayBuffer();
  assert.ok(pdfBytes.byteLength > 1000, 'PDF stream must be non-empty');
  console.log(`✓ Superadmin Revenue Analytics PDF report stream validated (${pdfBytes.byteLength} bytes)`);

  // 4. Test MyEduRide Gate Turnstile CSV export
  const gateCsvRes = await fetch(`${BASE_URL}/admin/myeduride/export/csv`, {
    headers: { Authorization: `Bearer ${branchAdminToken}` }
  });
  assert.equal(gateCsvRes.status, 200, 'GET /myeduride/export/csv must return 200');
  const gateCsvText = await gateCsvRes.text();
  assert.ok(gateCsvText.includes('MYEDURIDE'), 'CSV header must include MYEDURIDE brand');
  console.log(`✓ MyEduRide Gate Logs CSV export stream validated (${gateCsvText.length} chars)`);

  // 5. Test MyEduRide Gate Turnstile PDF export
  const gatePdfRes = await fetch(`${BASE_URL}/admin/myeduride/export/pdf`, {
    headers: { Authorization: `Bearer ${branchAdminToken}` }
  });
  assert.equal(gatePdfRes.status, 200, 'GET /myeduride/export/pdf must return 200');
  const gatePdfBytes = await gatePdfRes.arrayBuffer();
  assert.ok(gatePdfBytes.byteLength > 500, 'Gate PDF stream must be non-empty');
  console.log(`✓ MyEduRide Gate Logs PDF export stream validated (${gatePdfBytes.byteLength} bytes)`);

  // 6. Test Branch Admin Stats endpoint
  const statsRes = await fetch(`${BASE_URL}/admin/stats`, {
    headers: { Authorization: `Bearer ${branchAdminToken}` }
  });
  assert.equal(statsRes.status, 200, 'GET /admin/stats must return 200');
  const statsData = await statsRes.json();
  assert.ok(statsData.data && (statsData.data.students !== undefined || statsData.data.branchName !== undefined), 'Must expose branch stats');
  console.log(`✓ Branch Admin Dashboard Stats validated (${statsData.data.students || 0} students, ${statsData.data.teachers || 0} teachers)`);

  console.log('✔ All Full Endpoints & Streaming API tests PASSED!');
  return true;
}

if (require.main === module) {
  testFullEndpointsIntegration().catch((err) => {
    console.error('❌ Full endpoints integration test failed:', err);
    process.exit(1);
  });
}

module.exports = { testFullEndpointsIntegration };
