const assert = require('node:assert/strict');
require('dotenv').config();

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

const samplePhoto1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const samplePhoto2 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

async function testStaffCreationAndPhotos() {
  console.log('\n--- [INTEGRATION TEST] Staff Creation & Staff Photograph Lifecycle ---');

  const timestamp = Date.now();

  // 1. Register a fresh test school to operate in an isolated branch
  console.log('1. Setting up clean test school branch...');
  const schoolPayload = {
    planSlug: 'starter',
    schoolName: `Staff Academy ${timestamp}`,
    schoolAddress: '100 Broad Street, Lagos Island',
    adminName: 'Principal Johnson',
    contactNumber: '+2348011223344',
    contactEmail: `principal_${timestamp}@staffacademy.edu.ng`,
    username: `admin_staff_${timestamp}`,
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

  console.log(`✓ School branch provisioned (Branch ID: ${branchId})`);

  // 2. Admin creates a Teacher with an optional initial photograph
  console.log('\n2. Creating Teacher with initial photograph...');
  const teacherEmail = `teacher_photo_${timestamp}@staffacademy.edu.ng`;
  const teacherPayload = {
    name: 'Mrs. Folashade Adeleke',
    email: teacherEmail,
    phone: '+2348035551122',
    role: 3, // Teacher
    qualifications: 'B.Sc Ed Physics, M.Ed Educational Management',
    department: 'Sciences',
    photo: samplePhoto1,
  };

  const onboardRes1 = await fetch(`${BASE_URL}/admin/teachers/onboard`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(teacherPayload),
  });
  assert.equal(onboardRes1.status, 201, `Teacher creation with photo should return 201 (got ${onboardRes1.status})`);
  const onboardData1 = await onboardRes1.json();
  assert.equal(onboardData1.success, true);
  assert.ok(onboardData1.credentials.username, 'Should generate a unique username');
  assert.ok(onboardData1.credentials.password, 'Should generate a secure password');
  assert.ok(onboardData1.pdfBase64, 'Should generate credential PDF slip');
  const teacher1 = onboardData1.data.teacher;
  const teacher1Username = onboardData1.credentials.username;
  const teacher1Password = onboardData1.credentials.password;
  assert.ok(teacher1.photo, 'Teacher record should contain photo');
  console.log(`✓ Teacher created with photo (Teacher ID: ${teacher1.id}, Username: ${teacher1Username})`);

  // 3. Admin creates a Non-Teaching Staff (Accountant/Bursar) without a photograph initially
  console.log('\n3. Creating Non-Teaching Staff (Bursar) without photo (optional photograph verification)...');
  const bursarEmail = `bursar_${timestamp}@staffacademy.edu.ng`;
  const bursarPayload = {
    name: 'Mr. Chukwuma Obi',
    email: bursarEmail,
    phone: '+2348098884433',
    role: 4, // Accountant / Bursar
    department: 'Bursary & Accounts',
  };

  const onboardRes2 = await fetch(`${BASE_URL}/admin/teachers/onboard`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(bursarPayload),
  });
  assert.equal(onboardRes2.status, 201, `Non-teaching staff creation should return 201 (got ${onboardRes2.status})`);
  const onboardData2 = await onboardRes2.json();
  assert.equal(onboardData2.success, true);
  const bursarUser = onboardData2.data.user;
  const bursarUsername = onboardData2.credentials.username;
  const bursarPassword = onboardData2.credentials.password;
  assert.equal(bursarUser.photo, null, 'Photo should be null initially');
  console.log(`✓ Non-teaching staff created without photo (User ID: ${bursarUser.id}, Username: ${bursarUsername})`);

  // 4. Admin uploads/updates photograph for the Non-Teaching Staff later
  console.log('\n4. Admin uploading photograph for Non-Teaching Staff...');
  const uploadBursarPhotoRes = await fetch(`${BASE_URL}/admin/staff/${bursarUser.id}/upload-photo`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ photo: samplePhoto2 }),
  });
  assert.equal(uploadBursarPhotoRes.status, 200, `Admin staff photo upload should return 200 (got ${uploadBursarPhotoRes.status})`);
  const uploadBursarPhotoData = await uploadBursarPhotoRes.json();
  assert.equal(uploadBursarPhotoData.success, true);
  assert.ok(uploadBursarPhotoData.photo, 'Photo URL should be returned');
  console.log(`✓ Admin successfully uploaded photo for Bursar (Photo length: ${uploadBursarPhotoData.photo.length})`);

  // 5. Admin updates Teacher details including photo via PUT /teachers/:id
  console.log('\n5. Admin updating teacher details and replacing photo via PUT /api/admin/teachers/:id...');
  const updateTeacherRes = await fetch(`${BASE_URL}/admin/teachers/${teacher1.id}`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'Dr. (Mrs.) Folashade Adeleke',
      email: teacherEmail,
      phone: '+2348035551122',
      qualifications: 'Ph.D Physics Education',
      photo: samplePhoto2,
    }),
  });
  assert.equal(updateTeacherRes.status, 200, `Teacher update should succeed (got ${updateTeacherRes.status})`);
  const updateTeacherData = await updateTeacherRes.json();
  assert.equal(updateTeacherData.success, true);
  console.log(`✓ Teacher details and photo successfully updated`);

  // 6. Teacher logs in with generated credentials and uploads their own photograph (Self-Service)
  console.log('\n6. Teacher authenticating and performing self-service photo upload...');
  const teacherLoginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: teacher1Username,
      password: teacher1Password,
    }),
  });
  assert.equal(teacherLoginRes.status, 200, `Teacher login should succeed (got ${teacherLoginRes.status})`);
  const teacherLoginData = await teacherLoginRes.json();
  assert.equal(teacherLoginData.success, true);
  const teacherToken = teacherLoginData.token;
  const teacherHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${teacherToken}`,
  };

  const selfPhotoRes = await fetch(`${BASE_URL}/teacher/profile/upload-photo`, {
    method: 'POST',
    headers: teacherHeaders,
    body: JSON.stringify({ photo: samplePhoto1 }),
  });
  assert.equal(selfPhotoRes.status, 200, `Teacher self-service photo upload should return 200 (got ${selfPhotoRes.status})`);
  const selfPhotoData = await selfPhotoRes.json();
  assert.equal(selfPhotoData.success, true);
  assert.ok(selfPhotoData.photo, 'Updated photo should be returned');
  console.log(`✓ Teacher successfully performed self-service photo upload`);

  // 7. Verify Teacher Profile Endpoint returns updated photo
  console.log('\n7. Verifying Teacher Profile GET /api/teacher/profile...');
  const teacherProfileRes = await fetch(`${BASE_URL}/teacher/profile`, {
    headers: teacherHeaders,
  });
  assert.equal(teacherProfileRes.status, 200);
  const teacherProfileData = await teacherProfileRes.json();
  assert.equal(teacherProfileData.success, true);
  assert.ok(teacherProfileData.photo, 'Teacher profile must have photograph');
  console.log(`✓ Teacher Profile contains active photograph: ${teacherProfileData.photo.slice(0, 30)}...`);

  // 8. Verify Admin Staff Directory Endpoint returns photographs for both Teacher and Non-Teaching staff
  console.log('\n8. Verifying Admin Staff Directory GET /api/admin/teachers-staff...');
  const directoryRes = await fetch(`${BASE_URL}/admin/teachers-staff`, {
    headers: adminHeaders,
  });
  assert.equal(directoryRes.status, 200);
  const directoryData = await directoryRes.json();
  assert.equal(directoryData.success, true);
  
  const foundTeacher = directoryData.data.teachers.find(t => t.id === teacher1.id);
  assert.ok(foundTeacher, 'Teacher must appear in directory');
  assert.ok(foundTeacher.photo, 'Teacher in directory must have photograph');

  const foundBursar = directoryData.data.staff.find(s => s.id === bursarUser.id);
  assert.ok(foundBursar, 'Bursar must appear in non-teaching staff directory');
  assert.ok(foundBursar.photo, 'Bursar in directory must have photograph');

  console.log(`✓ Staff directory verified: Teacher photo (${foundTeacher.photo.slice(0, 25)}...), Bursar photo (${foundBursar.photo.slice(0, 25)}...)`);

  console.log('\n🎉 ALL STAFF CREATION & PHOTOGRAPH TESTS PASSED SUCCESSFULLY! (100% Verified)\n');
}

testStaffCreationAndPhotos().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
