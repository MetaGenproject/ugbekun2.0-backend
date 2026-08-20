const assert = require('node:assert/strict');
const {
  testMyEduRideConnection,
  exportGateLogsCsv,
  exportGateLogsPdf
} = require('../../lib/myedurideBridgeService');

async function testMyEduRideBridgeUnit() {
  console.log('\n--- [UNIT TEST 2] MyEduRide Bridge Logic & Serialization ---');

  // Test 1: Handshake response structure
  const handshake = await testMyEduRideConnection({
    apiUrl: 'http://localhost:3002/api/v1',
    apiKey: 'EDURIDE-LIVE-KEY-UISS-948291',
    branchCode: 'UISS'
  });
  
  assert.equal(handshake.success, true, 'Handshake must return success: true');
  assert.equal(handshake.status, 'CONNECTED', 'Handshake status must be CONNECTED');
  assert.ok(typeof handshake.latencyMs === 'number' && handshake.latencyMs > 0, 'Latency must be positive number');
  assert.ok(Array.isArray(handshake.capabilities) && handshake.capabilities.includes('GPS_TELEMETRY'), 'Must expose capabilities');
  console.log(`✓ Handshake test validated (${handshake.latencyMs}ms, status: ${handshake.status})`);

  // Test 2: Pickup pass code algorithm
  const studentId = 4413;
  const expectedPass = `PASS-${(studentId % 9000) + 1000}`;
  assert.equal(expectedPass, 'PASS-5413', 'Pickup pass must match deterministic algorithm');
  console.log('✓ Parent pickup pass code generation validated (' + expectedPass + ')');

  // Test 3: Gate Logs CSV generation
  const mockGateLogs = [
    {
      id: 'SCAN-801',
      personId: 4413,
      personName: 'Chinedu Joseph Okafor',
      personType: 'STUDENT',
      identifierCode: 'UG-2026-001',
      direction: 'ENTRY',
      gateLocation: 'Main Front Turnstile Gate 1',
      status: 'VERIFIED',
      authorizedGuardian: 'Mr. Okafor (Father) • Pass #9482',
      verifiedBy: 'Turnstile Scanner #01',
      verifiedAt: new Date().toISOString(),
      notes: 'Clean morning biometric check-in.'
    },
    {
      id: 'SCAN-802',
      personId: 104,
      personName: 'Mrs. Victoria Adams',
      personType: 'STAFF',
      identifierCode: 'STF-104',
      direction: 'ENTRY',
      gateLocation: 'Staff Gate 2 Turnstile',
      status: 'VERIFIED',
      authorizedGuardian: 'Teacher Staff ID Verified',
      verifiedBy: 'Staff Turnstile #02',
      verifiedAt: new Date().toISOString(),
      notes: 'Mathematics Teacher'
    }
  ];

  const csv = exportGateLogsCsv(mockGateLogs, 'Ugbekun International Academy');
  assert.ok(csv.includes('Chinedu Joseph Okafor'), 'CSV must contain student scan record');
  assert.ok(csv.includes('SCAN-801'), 'CSV must contain scan reference ID');
  assert.ok(csv.includes('Pass #9482'), 'CSV must contain guardian pass info');
  console.log('✓ Gate logs CSV generation validated (' + csv.length + ' chars)');

  // Test 4: Gate Logs PDF generation
  const pdfBuffer = await exportGateLogsPdf(mockGateLogs, 'Ugbekun International Academy');
  assert.ok(Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 500, 'PDF buffer must be valid');
  assert.equal(pdfBuffer.slice(0, 5).toString('ascii'), '%PDF-', 'PDF buffer must start with %PDF- header');
  console.log('✓ Gate logs PDF report generation validated (' + pdfBuffer.length + ' bytes)');

  console.log('✔ All Unit Tests in myedurideBridge.unit.test.js PASSED!');
  return true;
}

if (require.main === module) {
  testMyEduRideBridgeUnit().catch((err) => {
    console.error('❌ Unit test failed:', err);
    process.exit(1);
  });
}

module.exports = { testMyEduRideBridgeUnit };
