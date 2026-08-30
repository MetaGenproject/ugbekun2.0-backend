const assert = require('node:assert/strict');
require('dotenv').config();

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

const sampleLogoBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sampleSignatureBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function testSystemWideBrandingSync() {
  console.log('\n========================================================================');
  console.log('--- [INTEGRATION TEST] System-Wide Branding & School Info Sync ---');
  console.log('========================================================================\n');

  const timestamp = Date.now();

  // 1. Provision a clean test school branch
  console.log('1. Provisioning test school branch...');
  const schoolPayload = {
    planSlug: 'starter',
    schoolName: `Global Horizon Academy ${timestamp}`,
    schoolAddress: '100 Heritage Way, Victoria Island',
    adminName: 'Principal SystemWide',
    contactNumber: '+2348112233445',
    contactEmail: `admin_${timestamp}@globalhorizon.edu.ng`,
    username: `admin_sync_${timestamp}`,
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

  console.log(`✓ School branch provisioned! (Branch ID: ${branchId})`);

  // 2. Fetch Public Tenant Info BEFORE update
  console.log('\n2. Fetching public tenant school info BEFORE branding update...');
  const pubRes1 = await fetch(`${BASE_URL}/public/tenant/school-info?branchId=${branchId}`);
  assert.equal(pubRes1.status, 200);
  const pubData1 = await pubRes1.json();
  assert.equal(pubData1.success, true);
  console.log(`✓ Initial Public Tenant Info: "${pubData1.data.schoolName}"`);

  // 3. ADMIN Updates Branding, Theme Colors, WhatsApp & Social Media Handles
  console.log('\n3. Admin updating Branding, Colors, WhatsApp & Social Media Handles...');
  const updatePayload = {
    schoolName: `Global Horizon International ${timestamp}`,
    tagline: 'Leading the Future of Education',
    address: '100 Heritage Way, V.I., Lagos',
    phone: '+2348112233445',
    email: `contact_${timestamp}@globalhorizon.edu.ng`,
    whatsappNo: '+2348112233445',
    website: 'https://globalhorizon.edu.ng',
    facebookUrl: 'https://facebook.com/globalhorizon',
    instagramUrl: 'https://instagram.com/globalhorizon',
    twitterUrl: 'https://x.com/globalhorizon',
    linkedinUrl: 'https://linkedin.com/company/globalhorizon',
    youtubeUrl: 'https://youtube.com/@globalhorizon',
    logoBase64: sampleLogoBase64,
    logoFileName: 'school_logo.png',
    signatureBase64: sampleSignatureBase64,
    signatureFileName: 'principal_sig.png',
    primaryColor: '#083344',
    secondaryColor: '#06b6d4',
    idCardTheme: 'CYAN_DYNAMIC',
  };

  const updateRes = await fetch(`${BASE_URL}/admin/settings`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(updatePayload),
  });
  assert.equal(updateRes.status, 200);
  const updateData = await updateRes.json();
  assert.equal(updateData.success, true);
  console.log(`✓ Admin settings saved & updated!`);

  // 4. Fetch Public Tenant Info AFTER update and verify system-wide sync
  console.log('\n4. Verifying Public Tenant Info reflects branding system-wide...');
  const pubRes2 = await fetch(`${BASE_URL}/public/tenant/school-info?branchId=${branchId}`);
  assert.equal(pubRes2.status, 200);
  const pubData2 = await pubRes2.json();
  assert.equal(pubData2.success, true);

  const data = pubData2.data;
  assert.equal(data.schoolName, `Global Horizon International ${timestamp}`);
  assert.equal(data.tagline, 'Leading the Future of Education');
  assert.equal(data.address, '100 Heritage Way, V.I., Lagos');
  assert.equal(data.phone, '+2348112233445');
  assert.equal(data.email, `contact_${timestamp}@globalhorizon.edu.ng`);
  assert.equal(data.whatsappNo, '+2348112233445');
  assert.equal(data.website, 'https://globalhorizon.edu.ng');
  assert.equal(data.facebookUrl, 'https://facebook.com/globalhorizon');
  assert.equal(data.instagramUrl, 'https://instagram.com/globalhorizon');
  assert.equal(data.twitterUrl, 'https://x.com/globalhorizon');
  assert.equal(data.linkedinUrl, 'https://linkedin.com/company/globalhorizon');
  assert.equal(data.youtubeUrl, 'https://youtube.com/@globalhorizon');
  assert.equal(data.primaryColor, '#083344');
  assert.equal(data.secondaryColor, '#06b6d4');
  assert.equal(data.idCardTheme, 'CYAN_DYNAMIC');
  assert.ok(data.logoUrl, 'logoUrl must be present in public tenant response');
  assert.ok(data.principalSignatureUrl, 'principalSignatureUrl must be present in public tenant response');

  console.log(`✓ Verified: School Name, Tagline, Address, Phone, Email, WhatsApp, Social Links, Logo, Signature, PrimaryColor (${data.primaryColor}), and SecondaryColor (${data.secondaryColor}) are synced system-wide across all user roles!`);

  console.log('\n========================================================================');
  console.log('🎉 ALL SYSTEM-WIDE BRANDING SYNC TESTS PASSED! (100%)');
  console.log('========================================================================\n');
}

testSystemWideBrandingSync().catch(err => {
  console.error('\n❌ INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
