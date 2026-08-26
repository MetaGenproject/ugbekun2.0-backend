const assert = require('node:assert/strict');
require('dotenv').config();

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function testSchoolRegistrationLifecycle() {
  console.log('\n--- [INTEGRATION TEST] New School Registration & Onboarding Lifecycle ---');

  const timestamp = Date.now();
  const testSchool = {
    planSlug: 'starter',
    schoolName: `Crown Heights Academy ${timestamp}`,
    schoolAddress: '14 Unity Boulevard, Victoria Island, Lagos',
    adminName: 'Chief Dr. Adebayo Adeleke',
    contactNumber: '+2348012345678',
    contactEmail: `adebayo_${timestamp}@crownheights.edu.ng`,
    username: `admin_crown_${timestamp}`,
    password: 'SecurePassword123!',
    confirmPassword: 'SecurePassword123!',
    motto: 'Knowledge is Power and Light',
    state: 'Lagos',
    lga: 'Eti-Osa',
    schoolType: 'Co-educational',
    schoolCategory: 'combined_k12',
    termsAccepted: true,
  };

  // 1. Test POST /api/onboarding/register
  console.log('1. Submitting New School Registration request...');
  const regRes = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testSchool),
  });

  const regData = await regRes.json();
  if (regRes.status !== 201) {
    console.error('Registration failed payload:', regData);
  }
  assert.equal(regRes.status, 201, `Registration should return HTTP 201 Created (got ${regRes.status})`);
  assert.equal(regData.success, true, 'Registration response should have success: true');
  assert.ok(regData.token, 'Registration response MUST return a valid JWT token');
  assert.ok(regData.user, 'Registration response MUST return the user session object');
  assert.equal(regData.user.username, testSchool.username, 'Returned username must match');
  assert.equal(regData.user.role, 2, 'Admin user must have role 2 (Branch Admin)');
  assert.ok(regData.user.branch, 'User object must include branch info');
  assert.ok(regData.user.branch.id, 'Branch ID must be present');
  console.log(`✓ School registered successfully! (Branch ID: ${regData.user.branch.id}, Code: ${regData.user.branch.code})`);
  console.log(`✓ Immediate JWT Session Token generated and verified`);

  const authToken = regData.token;
  const branchId = regData.user.branch.id;
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
  };

  // 2. Test GET /api/admin/stats with the newly issued token
  console.log('\n2. Fetching Admin Dashboard Stats for newly registered school...');
  const statsRes = await fetch(`${BASE_URL}/admin/stats`, { headers: authHeaders });
  assert.equal(statsRes.status, 200, `Admin stats should return 200 OK (got ${statsRes.status})`);
  const statsData = await statsRes.json();
  assert.equal(statsData.success, true, 'Stats must be success: true');
  assert.equal(statsData.data.branchId, branchId, 'Stats branchId must match');
  assert.equal(statsData.data.students, 0, 'Initial student count should be 0');
  assert.equal(statsData.data.teachers, 0, 'Initial teacher count should be 0');
  assert.equal(statsData.data.classes, 0, 'Initial classes count should be 0 (Clean Provisioning)');
  assert.equal(statsData.data.subjects, 0, 'Initial subjects count should be 0 (Clean Provisioning)');
  console.log(`✓ Dashboard Stats verified clean state (Classes: ${statsData.data.classes}, Subjects: ${statsData.data.subjects})`);

  // 3. Test creating a Class and Section for the newly registered school
  console.log('\n3. Creating clean academic structure via API (Class & Section)...');
  const classCreateRes = await fetch(`${BASE_URL}/admin/classes`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Primary 1', nameNumeric: '1' }),
  });
  assert.equal(classCreateRes.status, 201, 'Class creation should return 201 Created');
  const classCreateData = await classCreateRes.json();
  assert.equal(classCreateData.success, true);
  const targetClass = classCreateData.class;

  const sectionCreateRes = await fetch(`${BASE_URL}/admin/sections`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Diamond', classId: targetClass.id }),
  });
  assert.equal(sectionCreateRes.status, 201, 'Section creation should return 201 Created');
  const sectionCreateData = await sectionCreateRes.json();
  const targetSection = sectionCreateData.section;
  console.log(`✓ Academic structure created: Class "${targetClass.name}" (ID: ${targetClass.id}), Section "${targetSection?.name || 'Diamond'}"`);

  // 4. Test Teacher / Staff Onboarding for this new branch
  console.log('\n4. Testing Staff & Teacher Onboarding...');
  const teacherPayload = {
    name: 'Mr. Emmanuel Nwosu',
    email: `nwosu_${timestamp}@crownheights.edu.ng`,
    phone: '+2348099887766',
    gender: 'Male',
    designation: 'Senior Mathematics Teacher',
    qualification: 'B.Sc Ed Mathematics',
    roleCode: 3, // Teacher
    classIds: [targetClass.id],
    subjectIds: [],
  };

  const teacherRes = await fetch(`${BASE_URL}/admin/teachers/onboard`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(teacherPayload),
  });
  assert.equal(teacherRes.status, 201, `Teacher creation should return 201 Created (got ${teacherRes.status})`);
  const teacherData = await teacherRes.json();
  assert.equal(teacherData.success, true);
  assert.ok(teacherData.data.teacher?.id || teacherData.data.id, 'Teacher ID must be present');
  console.log(`✓ Teacher onboarding successful (Teacher ID: ${teacherData.data.teacher?.id || teacherData.data.id}, Name: ${teacherData.data.teacher?.name || teacherData.data.name})`);

  // 5. Test Student Onboarding for this new branch
  console.log('\n5. Testing Student Admission & Enrollment...');
  const studentPayload = {
    firstName: 'Chidinma',
    lastName: 'Adeleke',
    gender: 'Female',
    dob: '2015-05-14',
    classId: targetClass.id,
    sectionId: targetSection?.id || null,
    parentName: 'Chief Adebayo Adeleke',
    parentEmail: `parent_${timestamp}@gmail.com`,
    parentPhone: '+2348011223344',
    parentRelation: 'Father',
    address: '14 Unity Boulevard, Victoria Island',
  };

  const studentRes = await fetch(`${BASE_URL}/admin/students/onboard`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(studentPayload),
  });
  const studentData = await studentRes.json();
  assert.equal(studentRes.status, 201, `Student enrollment should return 201 Created (got ${studentRes.status}: ${studentData.message})`);
  assert.equal(studentData.success, true);
  assert.ok(studentData.data.student.id, 'Student ID must be present');
  console.log(`✓ Student admission successful (Student ID: ${studentData.data.student.id}, RegNo: ${studentData.data.student.registerNo})`);

  // 6. Test POST /api/auth/login with the new school credentials
  console.log('\n6. Testing Direct Sign-In with new School Admin credentials...');
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: testSchool.username,
      password: testSchool.password,
    }),
  });
  assert.equal(loginRes.status, 200, `Login should return 200 OK (got ${loginRes.status})`);
  const loginData = await loginRes.json();
  assert.equal(loginData.success, true);
  assert.ok(loginData.token);
  assert.equal(loginData.user.username, testSchool.username);
  assert.equal(loginData.user.role, 2);
  assert.ok(loginData.user.branch);
  assert.equal(loginData.user.branch.id, branchId);
  console.log(`✓ Direct Login validated with correct role and branch metadata!`);

  console.log('\n🎉 ALL NEW SCHOOL REGISTRATION & ONBOARDING LIFECYCLE TESTS PASSED PERFECTLY!\n');
}

testSchoolRegistrationLifecycle().catch((err) => {
  console.error('\n❌ School Registration Lifecycle Test FAILED:', err);
  process.exit(1);
});
