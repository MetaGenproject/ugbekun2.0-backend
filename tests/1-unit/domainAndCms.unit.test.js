const assert = require('node:assert/strict');
const {
  formatDomainSlug,
  generateDomainVerificationToken,
  normalizeHostname,
  verifyDomainDns
} = require('../../lib/domainService');
const {
  getDefaultBanners,
  getDefaultAcademicPrograms,
  getDefaultGallery,
  getDefaultAnnouncements
} = require('../../lib/schoolCmsService');

async function testDomainAndCmsUnit() {
  console.log('\n--- [UNIT TEST: DOMAIN & FRONT-CMS ENGINE] ---');

  // Test 1: Subdomain Slug Formatter
  const slug1 = formatDomainSlug('Greenwood International Academy');
  const slug2 = formatDomainSlug('U.I.S.S. Model School (Benin)');
  const slug3 = formatDomainSlug('---Leading-Light-Schools---');

  assert.equal(slug1, 'greenwood-international-academy', 'Slug should convert to lowercase hyphenated');
  assert.equal(slug2, 'u-i-s-s-model-school-benin', 'Special characters should be stripped and normalized');
  assert.equal(slug3, 'leading-light-schools', 'Leading/trailing dashes must be trimmed');
  console.log('✓ Subdomain slug formatting validated');

  // Test 2: Verification Challenge Token Entropy
  const token1 = generateDomainVerificationToken(32);
  const token2 = generateDomainVerificationToken(32);
  assert.ok(token1.startsWith('ugbekun-verify-32-'), 'Token must contain branch identifier');
  assert.ok(token1.length >= 25, 'Token must have strong cryptographic length');
  assert.notEqual(token1, token2, 'Generated challenge tokens must be uniquely random');
  console.log('✓ Domain verification challenge token generation validated');

  // Test 3: Hostname Normalization
  assert.equal(normalizeHostname('portal.school.com:3000'), 'portal.school.com', 'Must strip ports');
  assert.equal(normalizeHostname('  UISS.Ugbekun.Edu.NG:5001  '), 'uiss.ugbekun.edu.ng', 'Must trim and lowercase');
  console.log('✓ Hostname normalization validated');

  // Test 4: Default CMS Content Structures
  const banners = getDefaultBanners('Apex Academy');
  assert.ok(Array.isArray(banners) && banners.length >= 3, 'Must return at least 3 default hero banner slides');
  assert.ok(banners[0].caption.includes('Apex Academy'), 'Default banner caption should reference school name');

  const gallery = getDefaultGallery();
  assert.ok(Array.isArray(gallery) && gallery.length >= 6, 'Must return default categorized gallery photos');
  assert.ok(gallery[0].url.startsWith('https://'), 'Gallery images must have valid HTTPS URLs');

  const programs = getDefaultAcademicPrograms();
  assert.equal(programs.length, 4, 'Must define 4 standard academic stages (Early Years, Primary, JSS, SSS)');

  const announcements = getDefaultAnnouncements();
  assert.ok(announcements.length >= 3, 'Must return default announcements');
  console.log('✓ Front-CMS default content builders validated');

  // Test 5: Live DNS Probe Parser (Mocking empty/invalid domain)
  const probeEmpty = await verifyDomainDns('', token1);
  assert.equal(probeEmpty.verified, false, 'Empty domain must not verify');
  console.log('✓ DNS probe error handling validated');

  console.log('✔ All Unit Tests for Domain & Front-CMS PASSED!');
  return true;
}

if (require.main === module) {
  testDomainAndCmsUnit().catch((err) => {
    console.error('❌ Unit test failed:', err);
    process.exit(1);
  });
}

module.exports = { testDomainAndCmsUnit };
