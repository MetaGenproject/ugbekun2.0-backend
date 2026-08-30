const assert = require('node:assert/strict');
require('dotenv').config();

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function testAdminUserCredentialsManagement() {
  console.log('\n========================================================================');
  console.log('--- [INTEGRATION TEST] Admin User Raw Credentials & Reset Security ---');
  console.log('========================================================================\n');

  const timestamp = Date.now();

  // 1. Provision School A (Canaan Gate Educational Centre)
  console.log('1. Provisioning School Branch A (Canaan Gate Educational Centre)...');
  const canaanPayload = {
    planSlug: 'starter',
    schoolName: `Canaan Gate Educational Centre ${timestamp}`,
    schoolAddress: '15 Canaan Way, Benin City',
    adminName: 'Admin Canaan',
    contactNumber: '+2348033221144',
    contactEmail: `admin_canaan_${timestamp}@canaangate.edu.ng`,
    username: `admin_canaan_${timestamp}`,
    password: 'SecurePassword123!',
    confirmPassword: 'SecurePassword123!',
    termsAccepted: true,
  };

  const regCanaanRes = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(canaanPayload),
  });
  if (regCanaanRes.status !== 201) {
    console.error('regCanaanRes failed:', regCanaanRes.status, await regCanaanRes.text());
  }
  assert.equal(regCanaanRes.status, 201);
  const canaanData = await regCanaanRes.json();
  const canaanAdminToken = canaanData.token;
  const canaanBranchId = canaanData.user.branch.id;
  const canaanAdminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${canaanAdminToken}`,
  };
  console.log(`✓ School Branch A created! (Branch ID: ${canaanBranchId})`);

  // 2. Provision School B (Eking International School)
  console.log('\n2. Provisioning School Branch B (Eking International School)...');
  const ekingPayload = {
    planSlug: 'starter',
    schoolName: `Eking International School ${timestamp}`,
    schoolAddress: '99 Royal Avenue, Lagos',
    adminName: 'Admin Eking',
    contactNumber: '+2348055667788',
    contactEmail: `admin_eking_${timestamp}@eking.edu.ng`,
    username: `admin_eking_${timestamp}`,
    password: 'SecurePassword123!',
    confirmPassword: 'SecurePassword123!',
    termsAccepted: true,
  };

  const regEkingRes = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ekingPayload),
  });
  assert.equal(regEkingRes.status, 201);
  const ekingData = await regEkingRes.json();
  const ekingAdminToken = ekingData.token;
  const ekingBranchId = ekingData.user.branch.id;
  const ekingAdminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ekingAdminToken}`,
  };
  console.log(`✓ School Branch B created! (Branch ID: ${ekingBranchId})`);

  // 3. Create Academic Structure & Onboard Student A in School Branch A
  console.log('\n3. Onboarding Student A in Canaan Gate Educational Centre...');
  const classARes = await fetch(`${BASE_URL}/admin/classes`, {
    method: 'POST',
    headers: canaanAdminHeaders,
    body: JSON.stringify({ name: 'JSS 1', nameNumeric: '1' }),
  });
  const classAData = await classARes.json();
  const classAId = classAData.class.id;

  const sectionARes = await fetch(`${BASE_URL}/admin/sections`, {
    method: 'POST',
    headers: canaanAdminHeaders,
    body: JSON.stringify({ name: 'Gold', classId: classAId }),
  });
  const sectionAData = await sectionARes.json();
  const sectionAId = sectionAData.section.id;

  const studentAPayload = {
    firstName: 'Student',
    lastName: 'Canaan',
    gender: 'MALE',
    classId: classAId,
    sectionId: sectionAId,
    birthday: '2012-05-15',
    admissionDate: '2026-09-01',
    parentName: 'Parent Canaan',
    parentPhone: '+2348033221199',
    parentEmail: `parent_canaan_${timestamp}@canaangate.edu.ng`,
  };

  const studentAOnboardRes = await fetch(`${BASE_URL}/admin/students/onboard`, {
    method: 'POST',
    headers: canaanAdminHeaders,
    body: JSON.stringify(studentAPayload),
  });
  assert.equal(studentAOnboardRes.status, 201);
  const studentAData = await studentAOnboardRes.json();
  const studentAUserId = studentAData.data.credentials.student.userId || studentAData.data.student.userId;
  const studentAInitialUsername = studentAData.data.credentials.student.username;
  const studentAInitialRawPassword = studentAData.data.credentials.student.password;
  console.log(`✓ Student A onboarded! (User ID: ${studentAUserId}, Username: ${studentAInitialUsername}, Initial Raw Password: ${studentAInitialRawPassword})`);

  // 4. Create Academic Structure & Onboard Student B in School Branch B
  console.log('\n4. Onboarding Student B in Eking International School...');
  const classBRes = await fetch(`${BASE_URL}/admin/classes`, {
    method: 'POST',
    headers: ekingAdminHeaders,
    body: JSON.stringify({ name: 'SS 1', nameNumeric: '10' }),
  });
  const classBData = await classBRes.json();
  const classBId = classBData.class.id;

  const sectionBRes = await fetch(`${BASE_URL}/admin/sections`, {
    method: 'POST',
    headers: ekingAdminHeaders,
    body: JSON.stringify({ name: 'Diamond', classId: classBId }),
  });
  const sectionBData = await sectionBRes.json();
  const sectionBId = sectionBData.section.id;

  const studentBPayload = {
    firstName: 'Student',
    lastName: 'Eking',
    gender: 'FEMALE',
    classId: classBId,
    sectionId: sectionBId,
    birthday: '2010-02-20',
    admissionDate: '2026-09-01',
    parentName: 'Parent Eking',
    parentPhone: '+2348055667799',
    parentEmail: `parent_eking_${timestamp}@eking.edu.ng`,
  };

  const studentBOnboardRes = await fetch(`${BASE_URL}/admin/students/onboard`, {
    method: 'POST',
    headers: ekingAdminHeaders,
    body: JSON.stringify(studentBPayload),
  });
  assert.equal(studentBOnboardRes.status, 201);
  const studentBData = await studentBOnboardRes.json();
  const studentBUserId = studentBData.data.credentials.student.userId || studentBData.data.student.userId;
  console.log(`✓ Student B onboarded in School B! (User ID: ${studentBUserId})`);

  // 5. School A Admin views Student A credentials
  console.log('\n5. Testing GET /api/admin/users/:userId/credentials as School A Admin...');
  const viewCredsARes = await fetch(`${BASE_URL}/admin/users/${studentAUserId}/credentials`, {
    headers: canaanAdminHeaders,
  });
  assert.equal(viewCredsARes.status, 200, `School A Admin should view Student A credentials (got ${viewCredsARes.status})`);
  const viewCredsAData = await viewCredsARes.json();
  assert.equal(viewCredsAData.success, true);
  assert.equal(viewCredsAData.user.username, studentAInitialUsername);
  assert.equal(viewCredsAData.user.rawPassword, studentAInitialRawPassword);
  console.log(`✓ Credentials retrieved successfully! Raw Password matches: "${viewCredsAData.user.rawPassword}"`);

  // 6. School A Admin attempts to view Student B credentials (belonging to School B) -> MUST RETURN 403
  console.log('\n6. Testing Multi-Tenant Security: School A Admin attempts to view Student B credentials...');
  const crossTenantViewRes = await fetch(`${BASE_URL}/admin/users/${studentBUserId}/credentials`, {
    headers: canaanAdminHeaders,
  });
  assert.equal(crossTenantViewRes.status, 403, `Cross-tenant viewing must return 403 Forbidden (got ${crossTenantViewRes.status})`);
  const crossTenantViewData = await crossTenantViewRes.json();
  assert.equal(crossTenantViewData.success, false);
  console.log(`✓ Cross-tenant access blocked successfully! Response: "${crossTenantViewData.message}"`);

  // 7. School A Admin resets Student A password globally
  console.log('\n7. Testing POST /api/admin/users/:userId/reset-password for Student A...');
  const newPasswordValue = 'GlobalResetPass2026!';
  const resetPassARes = await fetch(`${BASE_URL}/admin/users/${studentAUserId}/reset-password`, {
    method: 'POST',
    headers: canaanAdminHeaders,
    body: JSON.stringify({ newPassword: newPasswordValue }),
  });
  assert.equal(resetPassARes.status, 200, `Password reset should return 200 (got ${resetPassARes.status})`);
  const resetPassAData = await resetPassARes.json();
  assert.equal(resetPassAData.success, true);
  assert.equal(resetPassAData.credentials.newPassword, newPasswordValue);
  console.log(`✓ Password reset successful! New credentials: Username "${resetPassAData.credentials.username}", Password "${newPasswordValue}"`);

  // 8. School A Admin attempts to reset Student B password -> MUST RETURN 403
  console.log('\n8. Testing Multi-Tenant Security: School A Admin attempts to reset Student B password...');
  const crossTenantResetRes = await fetch(`${BASE_URL}/admin/users/${studentBUserId}/reset-password`, {
    method: 'POST',
    headers: canaanAdminHeaders,
    body: JSON.stringify({ newPassword: 'UnauthorizedPass123!' }),
  });
  assert.equal(crossTenantResetRes.status, 403, `Cross-tenant reset must return 403 Forbidden (got ${crossTenantResetRes.status})`);
  const crossTenantResetData = await crossTenantResetRes.json();
  assert.equal(crossTenantResetData.success, false);
  console.log(`✓ Cross-tenant reset blocked successfully! Response: "${crossTenantResetData.message}"`);

  // 9. LOG IN with Student A's NEW RESET PASSWORD to verify global effect
  console.log('\n9. Verifying global login effect: Logging in as Student A with NEW RESET PASSWORD...');
  const studentLoginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: studentAInitialUsername,
      password: newPasswordValue,
    }),
  });
  assert.equal(studentLoginRes.status, 200, `Student A login with reset password should return 200 (got ${studentLoginRes.status})`);
  const studentLoginData = await studentLoginRes.json();
  assert.equal(studentLoginData.success, true);
  assert.equal(studentLoginData.user.branchId, canaanBranchId);
  console.log(`✓ Student A logged in successfully with new reset password! Enrolled Branch: "${studentLoginData.user.branch.name}"`);

  console.log('\n========================================================================');
  console.log('🎉 ALL ADMIN CREDENTIALS & GLOBAL RESET SECURITY TESTS PASSED 100%!');
  console.log('========================================================================\n');
}

testAdminUserCredentialsManagement().catch((err) => {
  console.error('\n❌ INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
