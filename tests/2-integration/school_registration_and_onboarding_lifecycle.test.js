const assert = require('node:assert/strict');
require('dotenv').config();

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

const sampleLogo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sampleSignature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function testSchoolRegistrationAndOnboardingLifecycle() {
  console.log('\n========================================================================');
  console.log('--- [INTEGRATION TEST] School Registration & Onboarding Lifecycle ---');
  console.log('========================================================================\n');

  const timestamp = Date.now();

  // 1. Discover Plans & Plan Summary
  console.log('1. Fetching available subscription plans...');
  const plansRes = await fetch(`${BASE_URL}/onboarding/plans`);
  assert.equal(plansRes.status, 200, `Should fetch plans with 200 (got ${plansRes.status})`);
  const plansData = await plansRes.json();
  assert.equal(plansData.success, true);
  assert.ok(plansData.plans.length > 0, 'Should return at least 1 plan');
  console.log(`✓ Loaded ${plansData.plans.length} subscription plans (${plansData.plans.map(p => p.name).join(', ')})`);

  console.log('\n2. Fetching starter plan summary...');
  const summaryRes = await fetch(`${BASE_URL}/onboarding/plans/starter/summary`);
  assert.equal(summaryRes.status, 200);
  const summaryData = await summaryRes.json();
  assert.equal(summaryData.success, true);
  assert.ok(summaryData.summary.startDate);
  assert.ok(summaryData.summary.expiryDate);
  console.log(`✓ Plan summary verified (Plan: ${summaryData.summary.planName}, Cost: ${summaryData.summary.totalCost} ${summaryData.summary.currency})`);

  // 2. Test Form Validation & Edge Cases
  console.log('\n3. Testing registration validation rules...');

  // Missing required fields
  const invalidRes1 = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schoolName: '',
      contactEmail: 'invalid-email',
    }),
  });
  assert.equal(invalidRes1.status, 400, 'Should reject missing fields');
  console.log('✓ Rejected missing required fields (HTTP 400)');

  // Invalid email
  const invalidRes2 = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      planSlug: 'starter',
      schoolName: 'Test Academy',
      schoolAddress: 'Campus Address',
      contactNumber: '08000000000',
      contactEmail: 'not-an-email',
      username: `admin_val_${timestamp}`,
      password: 'Password123!',
      confirmPassword: 'Password123!',
      termsAccepted: true,
    }),
  });
  assert.equal(invalidRes2.status, 400);
  const valData2 = await invalidRes2.json();
  assert.ok(valData2.message.includes('valid contact email'));
  console.log('✓ Rejected invalid email format (HTTP 400)');

  // Password mismatch
  const invalidRes3 = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      planSlug: 'starter',
      schoolName: 'Test Academy',
      schoolAddress: 'Campus Address',
      contactNumber: '08000000000',
      contactEmail: `admin_${timestamp}@val.ng`,
      username: `admin_val_${timestamp}`,
      password: 'Password123!',
      confirmPassword: 'MismatchPassword123!',
      termsAccepted: true,
    }),
  });
  assert.equal(invalidRes3.status, 400);
  const valData3 = await invalidRes3.json();
  assert.ok(valData3.message.includes('Passwords do not match'));
  console.log('✓ Rejected password mismatch (HTTP 400)');

  // 3. Successful Full School Registration with Logo & Signature
  console.log('\n4. Executing complete New School Registration with Logo & Signature...');
  const schoolName = `Apex Horizon International College ${timestamp}`;
  const schoolEmail = `info_${timestamp}@apexhorizon.edu.ng`;
  const adminUsername = `apexadmin_${timestamp}`;
  const adminPassword = 'ApexSecurePassword2026!';

  const fullPayload = {
    planSlug: 'starter',
    schoolName,
    motto: 'Leadership, Knowledge & Excellence',
    schoolAddress: '42 Knowledge Boulevard, Victoria Island, Lagos',
    adminName: 'Dr. Chidi Okafor',
    contactNumber: '+2348039998877',
    contactEmail: schoolEmail,
    username: adminUsername,
    password: adminPassword,
    confirmPassword: adminPassword,
    state: 'Lagos',
    lga: 'Eti-Osa',
    schoolType: 'Combined (K-12)',
    schoolCategory: 'Private School',
    yearEstablished: '2015',
    totalStudents: '450',
    termsAccepted: true,
    logoBase64: sampleLogo,
    logoFileName: 'apex-crest.png',
    signatureBase64: sampleSignature,
    signatureFileName: 'dr-okafor-sig.png',
  };

  const regRes = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fullPayload),
  });

  assert.equal(regRes.status, 201, `School registration should return 201 Created (got ${regRes.status})`);
  const regData = await regRes.json();
  assert.equal(regData.success, true);
  assert.ok(regData.token, 'Should return active JWT token');
  assert.ok(regData.user, 'Should return user object');
  assert.equal(regData.user.role, 2, 'User role must be 2 (Branch Admin)');
  assert.equal(regData.user.username, adminUsername);
  assert.ok(regData.user.branch, 'User should contain branch payload');
  assert.equal(regData.user.branch.name, schoolName);

  const token = regData.token;
  const branchId = regData.user.branch.id;
  const adminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  console.log(`✓ School created successfully! Branch ID: ${branchId}, Code: ${regData.user.branch.code}, Admin ID: ${regData.user.id}`);

  // 4. Duplicate Prevention Verification
  console.log('\n5. Testing duplicate school and username prevention...');
  // Same username
  const dupUserRes = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...fullPayload,
      schoolName: `Another School ${timestamp}`,
      contactEmail: `different_${timestamp}@school.ng`,
    }),
  });
  assert.equal(dupUserRes.status, 400);
  const dupUserData = await dupUserRes.json();
  assert.ok(dupUserData.message.includes('Admin username already exists'));
  console.log('✓ Duplicate username prevented (HTTP 400)');

  // Same school name & email
  const dupSchoolRes = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...fullPayload,
      username: `unique_user_${timestamp}`,
    }),
  });
  assert.equal(dupSchoolRes.status, 400);
  const dupSchoolData = await dupSchoolRes.json();
  assert.ok(dupSchoolData.message.includes('already exists'));
  console.log('✓ Duplicate school registration prevented (HTTP 400)');

  // 5. Query Dashboard Stats & Settings Under Newly Registered School
  console.log('\n6. Verifying live admin stats and system settings...');
  const statsRes = await fetch(`${BASE_URL}/admin/stats`, { headers: adminHeaders });
  assert.equal(statsRes.status, 200, `Admin stats should return 200 (got ${statsRes.status})`);
  const statsData = await statsRes.json();
  assert.equal(statsData.success, true);
  assert.equal(statsData.data.branchName, schoolName);
  console.log(`✓ Admin stats verified: Students: ${statsData.data.students}, Teachers: ${statsData.data.teachers}, Classes: ${statsData.data.classes}`);

  const settingsRes = await fetch(`${BASE_URL}/admin/settings`, { headers: adminHeaders });
  assert.equal(settingsRes.status, 200);
  const settingsData = await settingsRes.json();
  assert.equal(settingsData.success, true);
  assert.equal(settingsData.data.schoolName, schoolName);
  assert.ok(settingsData.data.regNoPrefix, 'Should have regNoPrefix configured');
  console.log(`✓ System settings verified: Motto: "${settingsData.data.tagline}", RegPrefix: "${settingsData.data.regNoPrefix}", Term: "${settingsData.data.currentTerm}"`);

  // 6. Verify Auto-Seeded Classes, Sections & Subjects
  console.log('\n7. Verifying automatically seeded academic classes, sections, and subjects...');
  const classesRes = await fetch(`${BASE_URL}/admin/classes-sections`, { headers: adminHeaders });
  assert.equal(classesRes.status, 200);
  const classesData = await classesRes.json();
  assert.equal(classesData.success, true);
  assert.ok(classesData.classes.length >= 8, `Should have seeded classes (found ${classesData.classes.length})`);
  assert.ok(classesData.sections.length >= 2, `Should have seeded sections (found ${classesData.sections.length})`);

  const subjectsRes = await fetch(`${BASE_URL}/admin/subjects`, { headers: adminHeaders });
  assert.equal(subjectsRes.status, 200);
  const subjectsData = await subjectsRes.json();
  assert.equal(subjectsData.success, true);
  assert.ok(subjectsData.subjects.length >= 5, `Should have seeded core subjects (found ${subjectsData.subjects.length})`);
  console.log(`✓ Auto-seeded academic structure: ${classesData.classes.length} Classes, ${classesData.sections.length} Sections, ${subjectsData.subjects.length} Core Subjects`);

  // 7. Proceed to Staff Onboarding Under New School
  console.log('\n8. Onboarding first Teacher under new school...');
  const teacherPayload = {
    name: 'Mr. Emmanuel Babatunde',
    email: `emmanuel_${timestamp}@apexhorizon.edu.ng`,
    phone: '+2348021112233',
    role: 3, // Teacher
    qualifications: 'B.Sc Mathematics, PGDE',
    department: 'Mathematics & STEM',
  };

  const onboardTeacherRes = await fetch(`${BASE_URL}/admin/teachers/onboard`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(teacherPayload),
  });
  assert.equal(onboardTeacherRes.status, 201);
  const onboardTeacherData = await onboardTeacherRes.json();
  assert.equal(onboardTeacherData.success, true);
  assert.ok(onboardTeacherData.credentials.username);
  assert.ok(onboardTeacherData.credentials.password);
  console.log(`✓ Teacher onboarded: ${teacherPayload.name} (Username: ${onboardTeacherData.credentials.username})`);

  // 8. Proceed to Student Onboarding Under New School
  console.log('\n9. Onboarding first Student into auto-seeded Class...');
  const targetClass = classesData.classes[0];
  const targetSection = classesData.sections[0];

  const studentPayload = {
    firstName: 'David',
    lastName: 'Okafor',
    gender: 'Male',
    dob: '2015-05-12',
    classId: targetClass.id,
    sectionId: targetSection.id,
    parentName: 'Chief Okafor',
    parentPhone: '+2348039998877',
    parentEmail: `parent_${timestamp}@gmail.com`,
    address: '42 Knowledge Boulevard, Victoria Island, Lagos',
    previousSchool: 'Sunrise Preparatory',
  };

  const onboardStudentRes = await fetch(`${BASE_URL}/admin/students/onboard-with-photo`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(studentPayload),
  });
  assert.equal(onboardStudentRes.status, 201);
  const onboardStudentData = await onboardStudentRes.json();
  assert.equal(onboardStudentData.success, true);
  assert.ok(onboardStudentData.data.student.registerNo);
  console.log(`✓ Student enrolled: ${studentPayload.firstName} ${studentPayload.lastName} (Reg No: ${onboardStudentData.data.student.registerNo})`);

  // 9. Update School Settings / Branding
  console.log('\n10. Updating School Settings and academic term...');
  const updateSettingsRes = await fetch(`${BASE_URL}/admin/settings`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      schoolName: `${schoolName} (Main Campus)`,
      currentTerm: 'Second Term',
      aiAssistanceEnabled: true,
    }),
  });
  assert.equal(updateSettingsRes.status, 200);
  const updatedSettingsData = await updateSettingsRes.json();
  assert.equal(updatedSettingsData.success, true);
  assert.equal(updatedSettingsData.data.currentTerm, 'Second Term');
  console.log('✓ Settings updated and synchronized successfully');

  // 10. Re-Authenticate / Login with Newly Registered Admin Credentials
  console.log('\n11. Authenticating afresh with newly registered School Admin credentials...');
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: adminUsername,
      password: adminPassword,
    }),
  });
  assert.equal(loginRes.status, 200, `Login should return 200 OK (got ${loginRes.status})`);
  const loginData = await loginRes.json();
  assert.equal(loginData.success, true);
  assert.ok(loginData.token);
  assert.equal(loginData.user.role, 2);
  assert.ok(loginData.user.branch);
  console.log(`✓ Login successful! Token received for branch: "${loginData.user.branch.name}"`);

  console.log('\n========================================================================');
  console.log('🎉 ALL SCHOOL REGISTRATION & ONBOARDING LIFECYCLE TESTS PASSED (100%)');
  console.log('========================================================================\n');
}

testSchoolRegistrationAndOnboardingLifecycle().catch((err) => {
  console.error('\n❌ INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
