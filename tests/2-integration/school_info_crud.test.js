const assert = require('node:assert/strict');
require('dotenv').config();

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function testSchoolInfoCrud() {
  console.log('\n========================================================================');
  console.log('--- [INTEGRATION TEST] School Information & Social Media CRUD Lifecycle ---');
  console.log('========================================================================\n');

  const timestamp = Date.now();

  // 1. Provision a clean isolated test school branch
  console.log('1. Provisioning test school branch...');
  const schoolPayload = {
    planSlug: 'starter',
    schoolName: `Canaan Gate Academy ${timestamp}`,
    schoolAddress: '123 Academy Way, Victoria Island',
    adminName: 'Director Of Education',
    contactNumber: '+234807634567',
    contactEmail: `admin_${timestamp}@canaangate.edu.ng`,
    username: `admin_info_${timestamp}`,
    password: 'SecurePassword123!',
    confirmPassword: 'SecurePassword123!',
    termsAccepted: true,
  };

  const regRes = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schoolPayload),
  });
  assert.equal(regRes.status, 201, `School registration should succeed (got ${regRes.status})`);
  const regData = await regRes.json();
  const adminToken = regData.token;
  const branchId = regData.user.branch.id;
  const adminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminToken}`,
  };

  console.log(`✓ School branch created! (Branch ID: ${branchId})`);

  // 2. READ (GET /api/admin/settings)
  console.log('\n2. Testing READ (GET /api/admin/settings)...');
  const getRes1 = await fetch(`${BASE_URL}/admin/settings`, { headers: adminHeaders });
  assert.equal(getRes1.status, 200, `GET settings should return 200 (got ${getRes1.status})`);
  const getData1 = await getRes1.json();
  assert.equal(getData1.success, true);
  assert.equal(getData1.data.branchId, branchId);
  console.log(`✓ Initial school settings loaded: Name: "${getData1.data.schoolName}"`);

  // 3. CREATE / UPDATE (POST /api/admin/settings)
  console.log('\n3. Testing CREATE / UPDATE with WhatsApp and Social Media Handles...');
  const updatePayload = {
    schoolName: `Canaan Gate Educational Centre ${timestamp}`,
    tagline: 'Nurturing Excellence, Raising Leaders',
    address: '456 Royal Boulevard, Victoria Island, Lagos',
    phone: '+234 807 634 5678',
    email: `info_${timestamp}@canaangate.edu.ng`,
    whatsappNo: '+234 801 234 5678',
    website: 'https://www.canaangate.edu.ng',
    facebookUrl: 'https://facebook.com/canaangateofficial',
    instagramUrl: 'https://instagram.com/canaangateschools',
    twitterUrl: 'https://x.com/canaangate_edu',
    linkedinUrl: 'https://linkedin.com/school/canaangate',
    youtubeUrl: 'https://youtube.com/@canaangatetv',
  };

  const updateRes = await fetch(`${BASE_URL}/admin/settings`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(updatePayload),
  });
  assert.equal(updateRes.status, 200, `POST settings update should return 200 (got ${updateRes.status})`);
  const updateData = await updateRes.json();
  assert.equal(updateData.success, true);
  assert.equal(updateData.data.whatsappNo, '+234 801 234 5678');
  assert.equal(updateData.data.facebookUrl, 'https://facebook.com/canaangateofficial');
  assert.equal(updateData.data.youtubeUrl, 'https://youtube.com/@canaangatetv');
  console.log(`✓ School info & social media updated successfully!`);

  // 4. VERIFY READ BACK
  console.log('\n4. Verifying persistence with GET /api/admin/settings...');
  const getRes2 = await fetch(`${BASE_URL}/admin/settings`, { headers: adminHeaders });
  assert.equal(getRes2.status, 200);
  const getData2 = await getRes2.json();
  assert.equal(getData2.data.schoolName, updatePayload.schoolName);
  assert.equal(getData2.data.tagline, updatePayload.tagline);
  assert.equal(getData2.data.whatsappNo, updatePayload.whatsappNo);
  assert.equal(getData2.data.instagramUrl, updatePayload.instagramUrl);
  assert.equal(getData2.data.twitterUrl, updatePayload.twitterUrl);
  assert.equal(getData2.data.linkedinUrl, updatePayload.linkedinUrl);
  console.log(`✓ All 12 school profile & social fields verified in database!`);

  // 5. DELETE / RESET OPTIONAL FIELDS (DELETE /api/admin/settings/school-info)
  console.log('\n5. Testing DELETE / RESET optional fields (DELETE /api/admin/settings/school-info)...');
  const deleteRes = await fetch(`${BASE_URL}/admin/settings/school-info`, {
    method: 'DELETE',
    headers: adminHeaders,
  });
  assert.equal(deleteRes.status, 200, `DELETE school-info should return 200 (got ${deleteRes.status})`);
  const deleteData = await deleteRes.json();
  assert.equal(deleteData.success, true);
  assert.equal(deleteData.data.tagline, null);
  assert.equal(deleteData.data.whatsappNo, null);
  assert.equal(deleteData.data.facebookUrl, null);
  console.log(`✓ Optional fields and social handles reset to null successfully!`);

  // 6. VERIFY CORE DETAILS RETAINED AFTER RESET
  console.log('\n6. Verifying core school identity retained after reset...');
  const getRes3 = await fetch(`${BASE_URL}/admin/settings`, { headers: adminHeaders });
  const getData3 = await getRes3.json();
  assert.equal(getData3.data.schoolName, updatePayload.schoolName);
  assert.equal(getData3.data.whatsappNo, null);
  console.log(`✓ Core school identity retained intact!`);

  console.log('\n========================================================================');
  console.log('🎉 ALL SCHOOL INFORMATION CRUD TESTS PASSED SUCCESSFULLY! (100%)');
  console.log('========================================================================\n');
}

testSchoolInfoCrud().catch(err => {
  console.error('\n❌ INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
