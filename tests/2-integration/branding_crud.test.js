const assert = require('node:assert/strict');
require('dotenv').config();

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

const sampleLogoBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sampleSignatureBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function testBrandingCrud() {
  console.log('\n========================================================================');
  console.log('--- [INTEGRATION TEST] Branding (Logo, Signature & Colors) CRUD Lifecycle ---');
  console.log('========================================================================\n');

  const timestamp = Date.now();

  // 1. Provision a clean test school branch
  console.log('1. Provisioning test school branch...');
  const schoolPayload = {
    planSlug: 'starter',
    schoolName: `Apex Crest Academy ${timestamp}`,
    schoolAddress: '500 Crest Boulevard, Ikeja',
    adminName: 'Principal Branding',
    contactNumber: '+2348099887766',
    contactEmail: `admin_${timestamp}@apexcrest.edu.ng`,
    username: `admin_brand_${timestamp}`,
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
  console.log('\n2. Testing READ initial branding settings...');
  const getRes1 = await fetch(`${BASE_URL}/admin/settings`, { headers: adminHeaders });
  assert.equal(getRes1.status, 200);
  const getData1 = await getRes1.json();
  assert.equal(getData1.success, true);
  console.log(`✓ Initial branding loaded: Theme: "${getData1.data.idCardTheme}", PrimaryColor: "${getData1.data.primaryColor || '#0f172a'}"`);

  // 3. CREATE / UPDATE Branding (POST /api/admin/settings)
  console.log('\n3. Testing CREATE / UPDATE Logo, Signature & Theme Colors...');
  const updatePayload = {
    logoBase64: sampleLogoBase64,
    logoFileName: 'school_crest.png',
    signatureBase64: sampleSignatureBase64,
    signatureFileName: 'principal_sig.png',
    primaryColor: '#064e3b',
    secondaryColor: '#059669',
    idCardTheme: 'EMERALD_MODERN',
  };

  const updateRes = await fetch(`${BASE_URL}/admin/settings`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(updatePayload),
  });
  assert.equal(updateRes.status, 200, `POST settings update should return 200 (got ${updateRes.status})`);
  const updateData = await updateRes.json();
  assert.equal(updateData.success, true);
  assert.ok(updateData.data.logoUrl, 'logoUrl should be populated after upload');
  assert.ok(updateData.data.principalSignatureUrl, 'principalSignatureUrl should be populated after upload');
  assert.equal(updateData.data.primaryColor, '#064e3b');
  assert.equal(updateData.data.secondaryColor, '#059669');
  assert.equal(updateData.data.idCardTheme, 'EMERALD_MODERN');
  console.log(`✓ Logo, Signature & Theme Colors created & updated successfully!`);

  // 4. VERIFY READ BACK
  console.log('\n4. Verifying branding persistence with GET /api/admin/settings...');
  const getRes2 = await fetch(`${BASE_URL}/admin/settings`, { headers: adminHeaders });
  assert.equal(getRes2.status, 200);
  const getData2 = await getRes2.json();
  assert.equal(getData2.data.primaryColor, '#064e3b');
  assert.equal(getData2.data.secondaryColor, '#059669');
  assert.ok(getData2.data.logoUrl.length > 0);
  assert.ok(getData2.data.principalSignatureUrl.length > 0);
  console.log(`✓ Branding properties verified in DB!`);

  // 5. DELETE / REMOVE LOGO (DELETE /api/admin/settings/branding/assets/logo)
  console.log('\n5. Testing DELETE Logo (DELETE /api/admin/settings/branding/assets/logo)...');
  const delLogoRes = await fetch(`${BASE_URL}/admin/settings/branding/assets/logo`, {
    method: 'DELETE',
    headers: adminHeaders,
  });
  assert.equal(delLogoRes.status, 200);
  const delLogoData = await delLogoRes.json();
  assert.equal(delLogoData.success, true);
  assert.equal(delLogoData.data.logoUrl, null);
  console.log(`✓ Logo removed successfully!`);

  // 6. DELETE / REMOVE SIGNATURE (DELETE /api/admin/settings/branding/assets/signature)
  console.log('\n6. Testing DELETE Signature (DELETE /api/admin/settings/branding/assets/signature)...');
  const delSigRes = await fetch(`${BASE_URL}/admin/settings/branding/assets/signature`, {
    method: 'DELETE',
    headers: adminHeaders,
  });
  assert.equal(delSigRes.status, 200);
  const delSigData = await delSigRes.json();
  assert.equal(delSigData.success, true);
  assert.equal(delSigData.data.principalSignatureUrl, null);
  console.log(`✓ Signature removed successfully!`);

  // 7. RESET THEME COLORS (DELETE /api/admin/settings/branding/assets/colors)
  console.log('\n7. Testing RESET Colors (DELETE /api/admin/settings/branding/assets/colors)...');
  const delColorsRes = await fetch(`${BASE_URL}/admin/settings/branding/assets/colors`, {
    method: 'DELETE',
    headers: adminHeaders,
  });
  assert.equal(delColorsRes.status, 200);
  const delColorsData = await delColorsRes.json();
  assert.equal(delColorsData.success, true);
  assert.equal(delColorsData.data.primaryColor, '#0f172a');
  assert.equal(delColorsData.data.secondaryColor, '#0284c7');
  console.log(`✓ Theme colors reset to system default!`);

  console.log('\n========================================================================');
  console.log('🎉 ALL BRANDING CRUD TESTS PASSED SUCCESSFULLY! (100%)');
  console.log('========================================================================\n');
}

testBrandingCrud().catch(err => {
  console.error('\n❌ INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
