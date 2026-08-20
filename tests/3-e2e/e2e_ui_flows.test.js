const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';
const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function testE2EUIFlows() {
  console.log('\n--- [E2E / WORKFLOW TEST] End-to-End User Journeys ---');

  // Journey 1: Superadmin Financial Intelligence Workflow
  console.log('\n▶ Flow 1: Superadmin Multi-Branch Revenue Analytics Workflow');
  const superadminToken = jwt.sign({ id: 1, username: 'superadmin', role: 1 }, JWT_SECRET, { expiresIn: '1h' });

  // Step 1: Initial query
  const flow1Step1 = await fetch(`${BASE_URL}/superadmin/revenue-analytics`, {
    headers: { Authorization: `Bearer ${superadminToken}` }
  });
  assert.equal(flow1Step1.status, 200, 'Superadmin initial load must succeed');
  const initialAnalytics = await flow1Step1.json();
  assert.ok(initialAnalytics.data.summary.totalSaasRevenue >= 0, 'Must expose SaaS platform revenue');

  // Step 2: Time horizon filter simulation (90 days)
  const flow1Step2 = await fetch(`${BASE_URL}/superadmin/revenue-analytics?period=90d`, {
    headers: { Authorization: `Bearer ${superadminToken}` }
  });
  assert.equal(flow1Step2.status, 200, 'Superadmin period filter must succeed');

  // Step 3: Trigger executive PDF report download
  const flow1Step3 = await fetch(`${BASE_URL}/superadmin/revenue-analytics/export/pdf?period=90d`, {
    headers: { Authorization: `Bearer ${superadminToken}` }
  });
  assert.equal(flow1Step3.status, 200, 'Superadmin PDF export trigger must succeed');
  const pdfBytes = await flow1Step3.arrayBuffer();
  assert.ok(pdfBytes.byteLength > 1000, 'Exported PDF must contain complete document');
  console.log('✓ Superadmin Revenue Analytics Journey (Query -> Filter -> PDF Export) COMPLETED successfully');

  // Journey 2: Branch Admin MyEduRide Gate Turnstile & Bus Logistics Workflow
  console.log('\n▶ Flow 2: Branch Admin MyEduRide Gate Turnstile & Bus Logistics Workflow');
  const branchAdminToken = jwt.sign({ id: 2, username: 'admin_ebor', role: 2, legacyUserId: 32 }, JWT_SECRET, { expiresIn: '1h' });

  // Step 1: Check MyEduRide API Connection Handshake
  const flow2Step1 = await fetch(`${BASE_URL}/admin/myeduride/test-connection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${branchAdminToken}` },
    body: JSON.stringify({ apiUrl: 'http://localhost:3002/api/v1' })
  });
  assert.equal(flow2Step1.status, 200, 'Handshake must succeed');
  const handshakeResult = await flow2Step1.json();
  assert.equal(handshakeResult.data.status, 'CONNECTED', 'Connection must be live');

  // Step 2: Synchronize Student & Parent Guardian Rosters
  const flow2Step2 = await fetch(`${BASE_URL}/admin/myeduride/sync-roster`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${branchAdminToken}` }
  });
  assert.equal(flow2Step2.status, 200, 'Roster sync must succeed');
  const syncResult = await flow2Step2.json();
  assert.ok(syncResult.syncedCount >= 0, 'Must report synchronized count');

  // Step 3: Process Real-time Student Turnstile Scan
  const flow2Step3 = await fetch(`${BASE_URL}/admin/myeduride/gate-logs/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${branchAdminToken}` },
    body: JSON.stringify({ code: 'UG-2026-001', direction: 'ENTRY', gateLocation: 'Main Turnstile 1' })
  });
  assert.equal(flow2Step3.status, 200, 'Student scan must succeed');
  const scanResult = await flow2Step3.json();
  assert.equal(scanResult.log.status, 'VERIFIED', 'Scan must be verified');

  // Step 4: Record Bus Boarding & Parent SMS Alert
  const flow2Step4 = await fetch(`${BASE_URL}/admin/myeduride/manifest/board`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${branchAdminToken}` },
    body: JSON.stringify({ studentId: 4413, busId: 'BUS-01', status: 'BOARDED_MORNING' })
  });
  assert.equal(flow2Step4.status, 200, 'Boarding action must succeed');
  const boardResult = await flow2Step4.json();
  assert.equal(boardResult.smsDispatched, true, 'Guardian SMS alert must be dispatched');
  console.log('✓ MyEduRide Gate & Transit Journey (Handshake -> Sync -> Scan -> SMS) COMPLETED successfully');

  console.log('\n✔ All End-to-End User Journeys PASSED!');
  return true;
}

if (require.main === module) {
  testE2EUIFlows().catch((err) => {
    console.error('❌ E2E workflow test failed:', err);
    process.exit(1);
  });
}

module.exports = { testE2EUIFlows };
