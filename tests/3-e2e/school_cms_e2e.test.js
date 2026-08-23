const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'ugbekun_dev_secret_change_in_prod';
const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function testSchoolCmsE2E() {
  console.log('\n--- [E2E WORKFLOW TEST: SCHOOL HOMEPAGE CMS & DOMAIN LIFECYCLE] ---');

  const superadminToken = jwt.sign(
    { id: 1, username: 'superadmin', role: 1 },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  console.log('▶ Step 1: Superadmin loads multi-branch domain registry & selects Branch 32');
  const domainsRes = await fetch(`${BASE_URL}/superadmin/domains`, {
    headers: { Authorization: `Bearer ${superadminToken}` }
  });
  const domainsJson = await domainsRes.json();
  assert.ok(domainsJson.success, 'Domain registry must load');
  const branch32 = domainsJson.data.find((b) => b.branchId === 32);
  assert.ok(branch32, 'Branch 32 must exist in registry');
  console.log(`✓ Branch 32 resolved (School: "${branch32.schoolName}", Subdomain: "${branch32.subdomain}")`);

  console.log('▶ Step 2: Superadmin customizes hero banners, principal note & campus photos in Front-CMS Studio');
  const updatedBanners = [
    {
      id: 101,
      url: 'https://images.unsplash.com/photo-1580582932707-520aed937b7b?auto=format&fit=crop&w=1600&q=80',
      caption: 'Ugbekun International Model School — 2026 Academic Frontier',
      subcaption: 'Pioneering excellence in STEM, arts, robotics, and character.',
      ctaText: 'Apply for Admission',
      ctaLink: '/subscribe'
    },
    {
      id: 102,
      url: 'https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1600&q=80',
      caption: 'Ultra-Modern Science & Artificial Intelligence Laboratories',
      subcaption: 'Empowering future scientists, engineers, and digital pioneers.',
      ctaText: 'Explore Academics',
      ctaLink: '#academics'
    }
  ];

  const updateRes = await fetch(`${BASE_URL}/superadmin/branches/32/landing-page`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${superadminToken}`
    },
    body: JSON.stringify({
      isEnabled: true,
      heroHeadline: 'Ugbekun International Model School — 2026 Academic Frontier',
      heroSubheadline: 'Pioneering excellence in STEM, arts, robotics, and character.',
      heroBanners: updatedBanners,
      welcomeTitle: 'A Message of Welcome from the Executive Principal',
      welcomeMessage: 'Welcome to Ugbekun Model School. We are dedicated to providing a world-class standard education.',
      welcomeAuthor: 'Prof. A. Ebor, Ph.D. — Executive Principal',
      primaryColor: '#003da5',
      secondaryColor: '#009ca6',
      showGallery: true,
      showAnnouncements: true
    })
  });

  const updateJson = await updateRes.json();
  assert.ok(updateJson.success, 'Homepage publishing must succeed');
  console.log(`✓ Front-CMS customization published live for Branch 32`);

  console.log('▶ Step 3: Public unauthenticated visitor navigates to school custom landing page');
  const publicRes = await fetch(`${BASE_URL}/public/tenant/homepage?branchId=32`);
  const publicJson = await publicRes.json();
  assert.ok(publicJson.success, 'Public homepage must load');
  assert.equal(publicJson.data.heroHeadline, 'Ugbekun International Model School — 2026 Academic Frontier');
  assert.equal(publicJson.data.welcomeAuthor, 'Prof. A. Ebor, Ph.D. — Executive Principal');
  assert.equal(publicJson.data.heroBanners.length, 2);
  console.log(`✓ Public visitor successfully received live updated school banners and principal message`);

  console.log('✔ E2E School Homepage CMS & Domain Lifecycle Workflow PASSED!');
  return true;
}

if (require.main === module) {
  testSchoolCmsE2E().catch((err) => {
    console.error('❌ E2E test failed:', err);
    process.exit(1);
  });
}

module.exports = { testSchoolCmsE2E };
