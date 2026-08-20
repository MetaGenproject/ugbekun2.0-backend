const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';
const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function testAuthRbacIntegration() {
  console.log('\n--- [INTEGRATION TEST 1] RBAC & Multi-Role Authorization Boundaries ---');

  // Generate role tokens
  const superadminToken = jwt.sign({ id: 1, username: 'superadmin', role: 1 }, JWT_SECRET, { expiresIn: '1h' });
  const branchAdminToken = jwt.sign({ id: 2, username: 'admin_ebor', role: 2, legacyUserId: 32 }, JWT_SECRET, { expiresIn: '1h' });
  const teacherToken = jwt.sign({ id: 3, username: 'teacher_jane', role: 3, legacyUserId: 32 }, JWT_SECRET, { expiresIn: '1h' });
  const studentToken = jwt.sign({ id: 4, username: 'student_john', role: 4 }, JWT_SECRET, { expiresIn: '1h' });

  // 1. Test Unauthenticated access to protected route
  const unauthRes = await fetch(`${BASE_URL}/superadmin/revenue-analytics`);
  assert.equal(unauthRes.status, 401, 'Unauthenticated request must return 401');
  console.log('✓ Unauthenticated request rejected with 401 Unauthorized');

  // 2. Test Role 1 (Superadmin) accessing Superadmin Revenue Analytics
  const superadminRes = await fetch(`${BASE_URL}/superadmin/revenue-analytics`, {
    headers: { Authorization: `Bearer ${superadminToken}` }
  });
  assert.equal(superadminRes.status, 200, 'Superadmin must have access to revenue analytics (200 OK)');
  const superadminData = await superadminRes.json();
  assert.equal(superadminData.success, true, 'Response must return success: true');
  console.log('✓ Role 1 (Superadmin) authorized for Revenue Analytics (200 OK)');

  // 3. Test Role 2 (Branch Admin) attempting to access Superadmin Revenue Analytics
  const branchAdminOnSuperadminRes = await fetch(`${BASE_URL}/superadmin/revenue-analytics`, {
    headers: { Authorization: `Bearer ${branchAdminToken}` }
  });
  assert.equal(branchAdminOnSuperadminRes.status, 403, 'Branch Admin must be forbidden from Superadmin route (403)');
  console.log('✓ Role 2 (Branch Admin) correctly blocked from Superadmin routes (403 Forbidden)');

  // 4. Test Role 2 (Branch Admin) accessing Branch Admin MyEduRide API
  const branchAdminRes = await fetch(`${BASE_URL}/admin/myeduride/overview`, {
    headers: { Authorization: `Bearer ${branchAdminToken}` }
  });
  assert.equal(branchAdminRes.status, 200, 'Branch Admin must have access to MyEduRide overview (200 OK)');
  console.log('✓ Role 2 (Branch Admin) authorized for Branch Admin MyEduRide routes (200 OK)');

  // 5. Test Role 3 (Teacher) attempting to modify Admin MyEduRide Config
  const teacherOnAdminRes = await fetch(`${BASE_URL}/admin/myeduride/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${teacherToken}` },
    body: JSON.stringify({ apiUrl: 'http://malicious.com' })
  });
  assert.equal(teacherOnAdminRes.status, 403, 'Teacher must be forbidden from Branch Admin config modifications (403)');
  console.log('✓ Role 3 (Teacher) correctly blocked from Branch Admin config mutations (403 Forbidden)');

  // 6. Test Role 4 (Student) attempting to access Admin Gate Logs
  const studentOnAdminRes = await fetch(`${BASE_URL}/admin/myeduride/gate-logs`, {
    headers: { Authorization: `Bearer ${studentToken}` }
  });
  assert.equal(studentOnAdminRes.status, 403, 'Student must be forbidden from Branch Admin gate logs (403)');
  console.log('✓ Role 4 (Student) correctly blocked from Admin routes (403 Forbidden)');

  console.log('✔ All RBAC & Multi-Role Authorization tests PASSED!');
  return true;
}

if (require.main === module) {
  testAuthRbacIntegration().catch((err) => {
    console.error('❌ RBAC Integration test failed:', err);
    process.exit(1);
  });
}

module.exports = { testAuthRbacIntegration };
