const assert = require('node:assert/strict');
require('dotenv').config();

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function testStudentBranchIsolation() {
  console.log('\n========================================================================');
  console.log('--- [INTEGRATION TEST] Student Branch Context & Tenant Isolation ---');
  console.log('========================================================================\n');

  const timestamp = Date.now();

  // 1. Provision School A: Canaan Gate Educational Centre
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
  assert.equal(regCanaanRes.status, 201, `Canaan registration should succeed (got ${regCanaanRes.status})`);
  const canaanData = await regCanaanRes.json();
  const canaanAdminToken = canaanData.token;
  const canaanBranchId = canaanData.user.branch.id;
  const canaanAdminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${canaanAdminToken}`,
  };
  console.log(`✓ School Branch A created! (Branch ID: ${canaanBranchId}, Name: "${canaanData.user.branch.name}")`);

  // 2. Provision School B: Eking International School
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
  const ekingBranchId = ekingData.user.branch.id;
  console.log(`✓ School Branch B created! (Branch ID: ${ekingBranchId}, Name: "${ekingData.user.branch.name}")`);

  // 2.5 Create Class & Section in Canaan Gate Educational Centre
  const classRes = await fetch(`${BASE_URL}/admin/classes`, {
    method: 'POST',
    headers: canaanAdminHeaders,
    body: JSON.stringify({ name: 'JSS 1', nameNumeric: '1' }),
  });
  assert.equal(classRes.status, 201);
  const classData = await classRes.json();
  const createdClassId = classData.class.id;

  const sectionRes = await fetch(`${BASE_URL}/admin/sections`, {
    method: 'POST',
    headers: canaanAdminHeaders,
    body: JSON.stringify({ name: 'Gold', classId: createdClassId }),
  });
  assert.equal(sectionRes.status, 201);
  const sectionData = await sectionRes.json();
  const createdSectionId = sectionData.section.id;

  // 3. Onboard a Student in Canaan Gate Educational Centre
  console.log('\n3. Onboarding Student "Brume Ebor" in Canaan Gate Educational Centre...');
  const studentPayload = {
    firstName: 'Brume',
    lastName: 'Ebor',
    gender: 'MALE',
    classId: createdClassId,
    sectionId: createdSectionId,
    birthday: '2012-05-15',
    admissionDate: '2026-09-01',
    parentName: 'Mr. Ebor Senior',
    parentPhone: '+2348033221199',
    parentEmail: `parent_${timestamp}@canaangate.edu.ng`,
    studentPassword: 'StudentPassword123!',
  };

  const studentOnboardRes = await fetch(`${BASE_URL}/admin/students/onboard`, {
    method: 'POST',
    headers: canaanAdminHeaders,
    body: JSON.stringify(studentPayload),
  });
  if (studentOnboardRes.status !== 201) {
    const errText = await studentOnboardRes.text();
    console.error('Student onboarding failed response:', studentOnboardRes.status, errText);
  }
  assert.equal(studentOnboardRes.status, 201, `Student onboarding should return 201 (got ${studentOnboardRes.status})`);
  const studentOnboardData = await studentOnboardRes.json();
  assert.equal(studentOnboardData.success, true);

  const studentUsername = studentOnboardData.data.credentials.student.username;
  const studentPassword = studentOnboardData.data.credentials.student.password;
  console.log(`✓ Student onboarded successfully! (Username: ${studentUsername}, Password: ${studentPassword})`);

  // 4. LOG IN with Student Credentials
  console.log('\n4. Logging in as Student "Brume Ebor"...');
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: studentUsername, password: studentPassword }),
  });
  assert.equal(loginRes.status, 200, `Student login should return 200 (got ${loginRes.status})`);
  const loginData = await loginRes.json();
  assert.equal(loginData.success, true);

  const studentToken = loginData.token;
  const studentHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${studentToken}`,
  };

  console.log(`✓ Login successful! Token branchId: ${loginData.user.branchId}, Branch Name: "${loginData.user.branch?.name}"`);
  assert.equal(loginData.user.branchId, canaanBranchId, 'Login user branchId MUST be Canaan Gate Educational Centre');
  assert.equal(loginData.user.branch?.name, `Canaan Gate Educational Centre ${timestamp}`);

  // 5. Query Student Dashboard Overview (`GET /api/student/dashboard-overview`)
  console.log('\n5. Querying Student Dashboard Overview with Student Bearer token...');
  const dashRes = await fetch(`${BASE_URL}/student/dashboard-overview`, { headers: studentHeaders });
  assert.equal(dashRes.status, 200);
  const dashData = await dashRes.json();
  assert.equal(dashData.success, true);
  console.log(`✓ Dashboard overview branch name: "${dashData.profile.branchName}"`);
  assert.equal(dashData.profile.branchName, `Canaan Gate Educational Centre ${timestamp}`);

  // 6. Query Public School Info (`GET /api/public/tenant/school-info`) with Student Bearer token
  console.log('\n6. Querying Public School Info with Student Bearer token...');
  const pubInfoRes = await fetch(`${BASE_URL}/public/tenant/school-info`, { headers: studentHeaders });
  assert.equal(pubInfoRes.status, 200);
  const pubInfoData = await pubInfoRes.json();
  assert.equal(pubInfoData.success, true);
  console.log(`✓ Public School Info return: Branch ID #${pubInfoData.data.branchId}, School Name: "${pubInfoData.data.schoolName}"`);
  assert.equal(pubInfoData.data.branchId, canaanBranchId, 'Public tenant endpoint must resolve to Canaan Gate Educational Centre');
  assert.equal(pubInfoData.data.schoolName, `Canaan Gate Educational Centre ${timestamp}`);
  assert.notEqual(pubInfoData.data.branchId, ekingBranchId, 'Must NOT resolve to Eking International School');

  console.log('\n========================================================================');
  console.log('🎉 ALL STUDENT BRANCH ISOLATION TESTS PASSED 100%! FLAW RESOLVED.');
  console.log('========================================================================\n');
}

testStudentBranchIsolation().catch(err => {
  console.error('\n❌ INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
