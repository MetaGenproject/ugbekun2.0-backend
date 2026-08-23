const assert = require('node:assert/strict');
require('dotenv').config();

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function testStudentAdmissionParentProtection() {
  console.log('\n--- [INTEGRATION TEST] Student Admission, Existing Parent Protection & Photos ---');

  const timestamp = Date.now();

  // 1. Register a fresh test school to operate in an isolated branch
  console.log('1. Setting up clean test school branch...');
  const schoolPayload = {
    planSlug: 'starter',
    schoolName: `St. Jude International School ${timestamp}`,
    schoolAddress: '25 Admiralty Way, Lekki Phase 1, Lagos',
    adminName: 'Rev. Sister Catherine',
    contactNumber: '+2348033221100',
    contactEmail: `catherine_${timestamp}@stjude.edu.ng`,
    username: `admin_stjude_${timestamp}`,
    password: 'SecureAdminPassword123!',
    confirmPassword: 'SecureAdminPassword123!',
    termsAccepted: true,
  };

  const regRes = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schoolPayload),
  });
  assert.equal(regRes.status, 201, `School registration should succeed (got ${regRes.status})`);
  const regData = await regRes.json();
  assert.equal(regData.success, true);
  const adminToken = regData.token;
  const branchId = regData.user.branch.id;
  const adminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminToken}`,
  };

  // Fetch pre-seeded class & section
  const clsRes = await fetch(`${BASE_URL}/admin/classes-sections`, { headers: adminHeaders });
  const clsData = await clsRes.json();
  const testClass = clsData.classes[0];
  const testSection = clsData.sections[0];
  console.log(`✓ School branch provisioned (Branch ID: ${branchId}, Class: ${testClass.name})`);

  // 2. Enroll First Student with a New Parent (Photos omitted)
  console.log('\n2. Onboarding Student 1 (Initial registration with new parent, photos omitted)...');
  const parentPhone = `+23480${Math.floor(10000000 + Math.random() * 90000000)}`;
  const parentEmail = `parent_${timestamp}@gmail.com`;
  const parentName = 'Dr. Babatunde Fashola';

  const student1Payload = {
    firstName: 'Tobi',
    lastName: 'Fashola',
    gender: 'Male',
    birthday: '2016-04-12',
    classId: testClass.id,
    sectionId: testSection.id,
    bloodGroup: 'O+',
    religion: 'Christianity',
    parentName,
    parentPhone,
    parentEmail,
    parentRelation: 'Father',
    currentAddress: '12 Bourdillon Road, Ikoyi',
  };

  const s1Res = await fetch(`${BASE_URL}/admin/students/onboard`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(student1Payload),
  });
  if (s1Res.status !== 201) {
    const errText = await s1Res.text();
    console.error('Student 1 onboarding failed response:', s1Res.status, errText);
  }
  assert.equal(s1Res.status, 201, `Student 1 onboarding should succeed (got ${s1Res.status})`);
  const s1Data = await s1Res.json();
  assert.equal(s1Data.success, true);
  assert.equal(s1Data.isExistingParent, false, 'Student 1 parent should be a newly created parent');
  assert.ok(s1Data.credentials.parent, 'New parent credentials must be generated');
  assert.ok(s1Data.credentials.student, 'Student 1 credentials must be generated');
  
  const student1Id = s1Data.data.student.id;
  const parentId = s1Data.data.parent.id;
  const parentUsername = s1Data.credentials.parent.username;
  const parentPassword = s1Data.credentials.parent.password;
  console.log(`✓ Student 1 enrolled (Student ID: ${student1Id}, Parent ID: ${parentId})`);

  // 3. Test Parent Autocomplete / Search endpoint
  console.log('\n3. Testing GET /api/admin/parents/search (Live parent autocomplete)...');
  const searchRes = await fetch(`${BASE_URL}/admin/parents/search?query=${encodeURIComponent(parentPhone.slice(-6))}`, {
    headers: adminHeaders,
  });
  assert.equal(searchRes.status, 200, `Parent search should return 200 OK (got ${searchRes.status})`);
  const searchData = await searchRes.json();
  assert.equal(searchData.success, true);
  assert.ok(searchData.parents.length >= 1, 'Search query should find the existing parent');
  const matchedParent = searchData.parents.find((p) => p.id === parentId);
  assert.ok(matchedParent, 'Matched parent must have matching ID');
  assert.equal(matchedParent.name, parentName);
  assert.equal(matchedParent.enrolledChildrenCount, 1);
  console.log(`✓ Parent Autocomplete verified: Found "${matchedParent.name}" with 1 child enrolled (${matchedParent.children[0].name})`);

  // 4. Test Existing Parent Protection (Enroll Student 2 / Sibling)
  console.log('\n4. Onboarding Student 2 (Sibling) using Existing Parent Protection...');
  const student2Payload = {
    firstName: 'Simisola',
    lastName: 'Fashola',
    gender: 'Female',
    birthday: '2018-09-20',
    classId: testClass.id,
    sectionId: testSection.id,
    bloodGroup: 'O+',
    existingParentId: parentId, // Explicit link to existing parent
    parentName,
    parentPhone,
    parentEmail,
    parentRelation: 'Father',
    currentAddress: '12 Bourdillon Road, Ikoyi',
  };

  const s2Res = await fetch(`${BASE_URL}/admin/students/onboard`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(student2Payload),
  });
  assert.equal(s2Res.status, 201, `Student 2 onboarding should return 201 Created (got ${s2Res.status})`);
  const s2Data = await s2Res.json();
  assert.equal(s2Data.success, true);
  assert.equal(s2Data.isExistingParent, true, 'Existing Parent Protection should flag isExistingParent: true');
  assert.equal(s2Data.data.parent.id, parentId, 'Student 2 must link to existing parent record');
  assert.equal(s2Data.credentials.parent, null, 'Duplicate parent credentials should NOT be created');
  const student2Id = s2Data.data.student.id;
  console.log(`✓ Existing Parent Protection validated! Student 2 linked to Parent ID ${parentId} without duplicate account creation.`);

  // 5. Test Late Photo Upload by Admin
  console.log('\n5. Testing late photograph upload by School Admin...');
  const mockStudentPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const mockParentPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const uploadStudRes = await fetch(`${BASE_URL}/admin/students/${student1Id}/upload-photo`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ photoBase64: mockStudentPhoto }),
  });
  assert.equal(uploadStudRes.status, 200, `Student photo upload should return 200 (got ${uploadStudRes.status})`);
  const uploadStudData = await uploadStudRes.json();
  assert.equal(uploadStudData.success, true);
  assert.ok(uploadStudData.photo, 'Updated student photo must be returned');

  const uploadParRes = await fetch(`${BASE_URL}/admin/parents/${parentId}/upload-photo`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ photoBase64: mockParentPhoto }),
  });
  assert.equal(uploadParRes.status, 200, `Parent photo upload should return 200 (got ${uploadParRes.status})`);
  const uploadParData = await uploadParRes.json();
  assert.equal(uploadParData.success, true);
  assert.ok(uploadParData.photo, 'Updated parent photo must be returned');
  console.log(`✓ Admin late photo upload validated for both student and parent!`);

  // 6. Test Parent Portal Direct Login & Multi-Child Dashboard
  console.log('\n6. Testing Parent Portal sign-in and cross-portal photo visibility...');
  const parentLoginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: parentUsername,
      password: parentPassword,
    }),
  });
  assert.equal(parentLoginRes.status, 200, `Parent login should succeed (got ${parentLoginRes.status})`);
  const parentLoginData = await parentLoginRes.json();
  assert.equal(parentLoginData.success, true);
  assert.equal(parentLoginData.user.role, 6, 'User must be authenticated with role 6 (Parent)');
  const parentToken = parentLoginData.token;
  const parentHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${parentToken}`,
  };

  // Fetch Parent Children
  const parentDashRes = await fetch(`${BASE_URL}/parent/children`, { headers: parentHeaders });
  assert.equal(parentDashRes.status, 200, `Parent children endpoint should return 200 (got ${parentDashRes.status})`);
  const parentDashData = await parentDashRes.json();
  assert.equal(parentDashData.success, true);
  assert.equal(parentDashData.children.length, 2, 'Parent must see both enrolled children in unified dashboard');
  const enrolledNames = parentDashData.children.map((c) => c.firstName);
  assert.ok(enrolledNames.includes('Tobi'), 'Must list Tobi');
  assert.ok(enrolledNames.includes('Simisola'), 'Must list Simisola');
  console.log(`✓ Parent Dashboard verified: 2 siblings unified under single parent login.`);

  // 7. Test Parent Updating Child Photo via Parent Portal
  console.log('\n7. Testing Child photo upload by authenticated Parent...');
  const parentChildUploadRes = await fetch(`${BASE_URL}/parent/child/${student2Id}/upload-photo`, {
    method: 'POST',
    headers: parentHeaders,
    body: JSON.stringify({ photoBase64: mockStudentPhoto }),
  });
  assert.equal(parentChildUploadRes.status, 200, `Parent child photo upload should return 200 (got ${parentChildUploadRes.status})`);
  const parentChildUploadData = await parentChildUploadRes.json();
  assert.equal(parentChildUploadData.success, true);
  console.log(`✓ Parent successfully uploaded photo for Simisola!`);

  // 8. Test Parent Updating Profile Photo via Parent Portal
  console.log('\n8. Testing Profile photo upload by authenticated Parent...');
  const parentProfileUploadRes = await fetch(`${BASE_URL}/parent/profile/upload-photo`, {
    method: 'POST',
    headers: parentHeaders,
    body: JSON.stringify({ photoBase64: mockParentPhoto }),
  });
  assert.equal(parentProfileUploadRes.status, 200, `Parent profile photo upload should return 200 (got ${parentProfileUploadRes.status})`);
  const parentProfileUploadData = await parentProfileUploadRes.json();
  assert.equal(parentProfileUploadData.success, true);
  console.log(`✓ Parent successfully uploaded profile photo!`);

  console.log('\n🎉 ALL STUDENT ADMISSION & EXISTING PARENT PROTECTION TESTS PASSED PERFECTLY!\n');
}

testStudentAdmissionParentProtection().catch((err) => {
  console.error('\n❌ Student Admission & Parent Protection Test FAILED:', err);
  process.exit(1);
});
