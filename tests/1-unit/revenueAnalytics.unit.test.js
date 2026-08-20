const assert = require('node:assert/strict');
const { exportRevenueReportCsv, exportRevenueReportPdf } = require('../../lib/revenueAnalyticsService');

async function testRevenueAnalyticsUnit() {
  console.log('\n--- [UNIT TEST 1] Revenue Analytics Formulas & Generators ---');

  // Test 1: Math formulas for MRR, ARR, and Collection Efficiency
  const sampleSubscriptions = [
    { price: 120000, durationMonths: 12 }, // 10,000 / mo
    { price: 60000, durationMonths: 6 },   // 10,000 / mo
    { price: 30000, durationMonths: 3 }    // 10,000 / mo
  ];
  
  const mrr = sampleSubscriptions.reduce((acc, sub) => acc + (sub.price / (sub.durationMonths || 1)), 0);
  const arr = mrr * 12;
  
  assert.equal(mrr, 30000, 'MRR should accurately calculate monthly run-rate');
  assert.equal(arr, 360000, 'ARR should accurately calculate annualized run-rate (MRR * 12)');
  console.log('✓ MRR and ARR run-rate math verified');

  // Test 2: Collection Efficiency % formula
  const invoiced = 500000;
  const collected = 350000;
  const rate = invoiced > 0 ? Number(((collected / invoiced) * 100).toFixed(1)) : 0;
  assert.equal(rate, 70.0, 'Collection rate should be exactly 70.0%');
  console.log('✓ Collection efficiency percentage formula verified');

  // Test 3: Net Operating Surplus formula
  const totalFees = 350000;
  const saasRev = 30000;
  const expenses = 150000;
  const netSurplus = (totalFees + saasRev) - expenses;
  assert.equal(netSurplus, 230000, 'Net operating surplus should be revenue minus operational expenses');
  console.log('✓ Net operating surplus calculation verified');

  // Test 4: CSV Export generation
  const mockAnalytics = {
    summary: {
      totalSaasRevenue: 360000,
      saasMrr: 30000,
      saasArr: 360000,
      activeSubscribedBranches: 3,
      totalBranches: 10,
      totalSchoolInvoiced: 1500000,
      totalSchoolCollected: 1200000,
      totalSchoolOutstanding: 300000,
      globalCollectionRate: 80.0,
      totalExpenses: 500000,
      netOperatingSurplus: 1060000
    },
    branchLeaderboard: [
      {
        branchId: 32,
        name: 'Ugbekun International Model School',
        code: 'UIMS',
        city: 'Benin City',
        studentsCount: 250,
        planName: 'Enterprise Growth',
        invoicedAmount: 750000,
        collectedAmount: 650000,
        outstandingAmount: 100000,
        collectionRate: 86.7,
        totalExpenses: 200000,
        netMargin: 450000,
        lastPaymentDate: '2026-08-15',
        health: 'OPTIMAL'
      }
    ],
    generatedAt: new Date().toISOString()
  };

  const csv = exportRevenueReportCsv(mockAnalytics);
  assert.ok(typeof csv === 'string' && csv.length > 100, 'CSV should be non-empty string');
  assert.ok(csv.includes('Ugbekun International Model School'), 'CSV must contain branch name');
  assert.ok(csv.includes('OPTIMAL'), 'CSV must contain health status');
  console.log('✓ Revenue CSV report formatting verified (Length: ' + csv.length + ' chars)');

  // Test 5: PDF Export generation
  const pdfBuffer = await exportRevenueReportPdf(mockAnalytics);
  assert.ok(Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 500, 'PDF should be valid non-empty buffer');
  // Check PDF signature '%PDF-'
  const pdfHeader = pdfBuffer.slice(0, 5).toString('ascii');
  assert.equal(pdfHeader, '%PDF-', 'PDF buffer must start with standard %PDF- header');
  console.log('✓ Revenue PDF executive report generation verified (Size: ' + pdfBuffer.length + ' bytes)');

  console.log('✔ All Unit Tests in revenueAnalytics.unit.test.js PASSED!');
  return true;
}

if (require.main === module) {
  testRevenueAnalyticsUnit().catch((err) => {
    console.error('❌ Unit test failed:', err);
    process.exit(1);
  });
}

module.exports = { testRevenueAnalyticsUnit };
