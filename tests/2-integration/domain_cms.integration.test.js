const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';
const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function testDomainCmsIntegration() {
  console.log('\n--- [INTEGRATION TEST: DOMAIN & FRONT-CMS REST APIS] ---');

  const superadminToken = jwt.sign(
    { id: 1, username: 'superadmin', role: 1 },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const branchAdminToken = jwt.sign(
    { id: 2, username: 'admin_ebor', role: 2, legacyUserId: 32 },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // 1. Test Public Tenant Homepage Endpoint (Unauthenticated)
  const pubHomeRes = await fetch(`${BASE_URL}/public/tenant/homepage?branchId=32`);
  assert.equal(pubHomeRes.status, 200, 'GET /public/tenant/homepage must return 200');
  const pubHomeJson = await pubHomeRes.json();
  assert.ok(pubHomeJson.success, 'Response must be success: true');
  assert.ok(pubHomeJson.data && pubHomeJson.data.heroBanners.length > 0, 'Must return hero banners array');
  assert.ok(pubHomeJson.data.photoGallery.length > 0, 'Must return photo gallery array');
  console.log(`✓ Public School Homepage API validated (${pubHomeJson.data.schoolName}, ${pubHomeJson.data.heroBanners.length} banners, ${pubHomeJson.data.photoGallery.length} gallery photos)`);

  // 2. Test Public Tenant Branding Endpoint (Lightweight for white-label login)
  const pubBrandRes = await fetch(`${BASE_URL}/public/tenant/branding?branchId=32`);
  assert.equal(pubBrandRes.status, 200, 'GET /public/tenant/branding must return 200');
  const pubBrandJson = await pubBrandRes.json();
  assert.ok(pubBrandJson.success && pubBrandJson.data.schoolName, 'Must return school branding');
  console.log(`✓ Public School Branding API validated (${pubBrandJson.data.schoolName}, Primary Color: ${pubBrandJson.data.primaryColor})`);

  // 3. Test Superadmin Fetch School Landing Page Config
  const saGetCmsRes = await fetch(`${BASE_URL}/superadmin/branches/32/landing-page`, {
    headers: { Authorization: `Bearer ${superadminToken}` }
  });
  assert.equal(saGetCmsRes.status, 200, 'Superadmin GET /branches/:branchId/landing-page must return 200');
  const saGetCmsJson = await saGetCmsRes.json();
  assert.ok(saGetCmsJson.success && saGetCmsJson.data.heroHeadline, 'Must return landing page layout');
  console.log(`✓ Superadmin School Landing Page fetch validated`);

  // 4. Test Superadmin Update School Landing Page (Front-CMS mutation)
  const customHeadline = 'Innovating Tomorrow Through Holistic Education 2026';
  const saPutCmsRes = await fetch(`${BASE_URL}/superadmin/branches/32/landing-page`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${superadminToken}`
    },
    body: JSON.stringify({
      heroHeadline: customHeadline,
      welcomeTitle: 'Principal Message: Academic Distinction',
      welcomeMessage: 'We welcome all parents, scholars, and educators to the new session.',
      primaryColor: '#003da5',
      secondaryColor: '#009ca6',
      showGallery: true
    })
  });
  assert.equal(saPutCmsRes.status, 200, 'Superadmin PUT /branches/:branchId/landing-page must return 200');
  const saPutCmsJson = await saPutCmsRes.json();
  assert.equal(saPutCmsJson.data.heroHeadline, customHeadline, 'Hero headline must be updated');
  console.log(`✓ Superadmin School Landing Page CMS publishing validated`);

  // 5. Test Superadmin Domains Directory
  const saDomainsRes = await fetch(`${BASE_URL}/superadmin/domains`, {
    headers: { Authorization: `Bearer ${superadminToken}` }
  });
  assert.equal(saDomainsRes.status, 200, 'Superadmin GET /domains must return 200');
  const saDomainsJson = await saDomainsRes.json();
  assert.ok(saDomainsJson.success && Array.isArray(saDomainsJson.data), 'Must return domain list');
  console.log(`✓ Superadmin Multi-Branch Domain Registry validated (${saDomainsJson.count} branches mapped)`);

  // 6. Test Branch Admin Domain Config & DNS instructions
  const adminDomainRes = await fetch(`${BASE_URL}/admin/domain/config`, {
    headers: { Authorization: `Bearer ${branchAdminToken}` }
  });
  assert.equal(adminDomainRes.status, 200, 'Branch Admin GET /domain/config must return 200');
  const adminDomainJson = await adminDomainRes.json();
  assert.ok(adminDomainJson.data.dnsInstructions?.cname, 'Must return CNAME instructions');
  assert.ok(adminDomainJson.data.dnsInstructions?.txt, 'Must return TXT challenge instructions');
  console.log(`✓ Branch Admin Self-Service Domain Configuration validated (Subdomain: ${adminDomainJson.data.subdomain})`);

  // 7. Test Branch Admin Landing Page Update
  const adminLandingRes = await fetch(`${BASE_URL}/admin/landing-page`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${branchAdminToken}`
    },
    body: JSON.stringify({
      heroHeadline: customHeadline,
      welcomeTitle: 'Welcome to Ugbekun Campus'
    })
  });
  assert.equal(adminLandingRes.status, 200, 'Branch Admin PUT /landing-page must return 200');
  console.log(`✓ Branch Admin Landing Page customization validated`);

  console.log('✔ All Integration Tests for Domain & Front-CMS PASSED!');
  return true;
}

if (require.main === module) {
  testDomainCmsIntegration().catch((err) => {
    console.error('❌ Integration test failed:', err);
    process.exit(1);
  });
}

module.exports = { testDomainCmsIntegration };
