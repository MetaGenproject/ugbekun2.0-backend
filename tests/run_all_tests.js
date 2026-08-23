const { testRevenueAnalyticsUnit } = require('./1-unit/revenueAnalytics.unit.test');
const { testMyEduRideBridgeUnit } = require('./1-unit/myedurideBridge.unit.test');
const { testStudentServiceUnit } = require('./1-unit/studentService.unit.test');
const { testDomainAndCmsUnit } = require('./1-unit/domainAndCms.unit.test');
const { testAuthRbacIntegration } = require('./2-integration/auth_rbac.integration.test');
const { testMultitenantIsolation } = require('./2-integration/multitenant_isolation.test');
const { testFullEndpointsIntegration } = require('./2-integration/endpoints_full.integration.test');
const { testDomainCmsIntegration } = require('./2-integration/domain_cms.integration.test');
const { testE2EUIFlows } = require('./3-e2e/e2e_ui_flows.test');
const { testSchoolCmsE2E } = require('./3-e2e/school_cms_e2e.test');
const { runAllPerformanceScenarios } = require('./4-performance/stress_scenarios.test');

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║       UGBEKUN 2.0 ENTERPRISE QUALITY ASSURANCE & TEST SUITE             ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');

  const startTime = Date.now();
  const results = [];

  async function recordStep(name, fn) {
    const stepStart = Date.now();
    try {
      await fn();
      const dur = ((Date.now() - stepStart) / 1000).toFixed(2);
      results.push({ name, status: 'PASSED', durationSec: dur });
    } catch (err) {
      const dur = ((Date.now() - stepStart) / 1000).toFixed(2);
      results.push({ name, status: 'FAILED', durationSec: dur, error: err.message });
      console.error(`❌ ${name} failed:`, err);
    }
  }

  // TIER 1: UNIT TESTS
  console.log('\n======================================================');
  console.log(' [TIER 1] UNIT TESTING (Formulas, Services & Logic)    ');
  console.log('======================================================');
  await recordStep('Unit: Revenue Analytics Formulas & Generators', testRevenueAnalyticsUnit);
  await recordStep('Unit: MyEduRide Bridge Logic & Serialization', testMyEduRideBridgeUnit);
  await recordStep('Unit: Student Service & Evaluation Matrices', testStudentServiceUnit);
  await recordStep('Unit: Domain Engine & Front-CMS Serialization', testDomainAndCmsUnit);

  // TIER 2: INTEGRATION TESTS
  console.log('\n======================================================');
  console.log(' [TIER 2] INTEGRATION TESTING (RBAC, Multi-Tenant API) ');
  console.log('======================================================');
  await recordStep('Integration: RBAC & Multi-Role Authorization', testAuthRbacIntegration);
  await recordStep('Integration: Multi-Tenant Branch Isolation', testMultitenantIsolation);
  await recordStep('Integration: Full Endpoints & Streaming APIs', testFullEndpointsIntegration);
  await recordStep('Integration: Domain Routing & Front-CMS APIs', testDomainCmsIntegration);

  // TIER 3: E2E WORKFLOW TESTS
  console.log('\n======================================================');
  console.log(' [TIER 3] E2E TESTING (Full User Journey Workflows)   ');
  console.log('======================================================');
  await recordStep('E2E: Superadmin & Branch Admin User Journeys', testE2EUIFlows);
  await recordStep('E2E: School Homepage CMS & Custom Domain Lifecycle', testSchoolCmsE2E);

  // TIER 4: PERFORMANCE & LOAD STRESS SCENARIOS
  console.log('\n======================================================');
  console.log(' [TIER 4] PERFORMANCE & CONCURRENT LOAD STRESS TESTING');
  console.log('======================================================');
  await recordStep('Performance: Gate Surge, Heavy Aggregation & Telemetry Load', runAllPerformanceScenarios);

  const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(2);
  const passedCount = results.filter((r) => r.status === 'PASSED').length;
  const failedCount = results.filter((r) => r.status === 'FAILED').length;

  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║                   FINAL QA SCORECARD & SUMMARY REPORT                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  console.table(results);

  console.log(`\nResults: ${passedCount}/${results.length} Test Suites PASSED (${failedCount} Failed) in ${totalTimeSec}s`);

  if (failedCount > 0) {
    process.exit(1);
  } else {
    console.log('🎉 ALL 4 TEST TIERS PASSED WITH 100% SUCCESS RATE!\n');
  }
}

main();
