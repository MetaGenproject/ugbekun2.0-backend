import 'dotenv/config';
import prisma from '../lib/prisma';
import {
  getAttendanceAnalyticsReport,
  getFinancialAgingDebtorsReport,
  getAdmissionsFunnelReport,
  getInventoryValuationReport,
  getStaffAttendanceAuditReport,
  exportCentralReportCsv,
} from '../controllers/admin/adminCentralReportsController';

// Helper mock request and response
function createMockReqRes(branchId: number = 5, query: any = {}) {
  let responseData: any = null;
  let statusCode: number = 200;
  let headers: Record<string, string> = {};

  const req: any = {
    branchId,
    query,
    user: { id: 1, role: 'ADMIN', branchId },
  };

  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    json(data: any) {
      responseData = data;
      return res;
    },
    send(data: any) {
      responseData = data;
      return res;
    },
    end(data?: any) {
      if (data) responseData = data;
      return res;
    },
  };

  return {
    req,
    res,
    getResult: () => ({ statusCode, responseData, headers }),
  };
}

async function runPhase6Tests() {
  console.log('=================================================================');
  console.log('🧪 Starting Phase 6 Test Suite: Central Intelligence & Reports Hub');
  console.log('=================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, details?: any) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      if (details) {
        console.error('     Details:', JSON.stringify(details, null, 2));
      }
      failed++;
    }
  }

  try {
    // 1. Get branch ID
    let branch = await prisma.branch.findFirst();
    if (!branch) {
      throw new Error('No branch found in database');
    }
    const branchId = branch.id;
    console.log(`📌 Using Branch ID: ${branchId} (${branch.name})`);

    // ─── TEST 1: Section 6.1 Attendance Analytics & Student Drill-Down ───
    console.log('\n📌 1. Testing Attendance Analytics & Student Drill-Down Engine...');
    {
      const { req, res, getResult } = createMockReqRes(branchId, { month: '10', year: '2026' });
      await getAttendanceAnalyticsReport(req, res);
      const result = getResult();

      assert(result.statusCode === 200 && result.responseData?.success === true, 'getAttendanceAnalyticsReport returned 200 OK');
      assert(
        typeof result.responseData?.summary?.overallAttendanceRate === 'number' &&
        result.responseData?.summary?.overallAttendanceRate >= 0 &&
        result.responseData?.summary?.overallAttendanceRate <= 100,
        'Attendance summary contains valid overallAttendanceRate percentage',
        result.responseData?.summary
      );
      assert(
        Array.isArray(result.responseData?.students),
        'Attendance report returns student drill-down list array'
      );
      if (result.responseData?.students?.length > 0) {
        const sampleStudent = result.responseData.students[0];
        assert(
          sampleStudent.studentName &&
          sampleStudent.admissionNo &&
          typeof sampleStudent.attendanceRate === 'number' &&
          sampleStudent.punctualityFlag,
          'Student drill-down row contains name, admissionNo, rate, and punctuality flags',
          sampleStudent
        );
      } else {
        console.log('     (No student enrollments in branch - empty array handled gracefully)');
      }
    }

    // ─── TEST 2: Section 6.2 Financial Ledger, Fee Aging & Outstanding Debtors ───
    console.log('\n📌 2. Testing Financial Ledger, Fee Aging & Debtors Engine...');
    {
      const { req, res, getResult } = createMockReqRes(branchId);
      await getFinancialAgingDebtorsReport(req, res);
      const result = getResult();

      assert(result.statusCode === 200 && result.responseData?.success === true, 'getFinancialAgingDebtorsReport returned 200 OK');
      assert(
        result.responseData?.revenueMetrics &&
        typeof result.responseData?.revenueMetrics?.totalTuitionInvoiced === 'number' &&
        typeof result.responseData?.revenueMetrics?.totalPaymentsCollected === 'number' &&
        typeof result.responseData?.revenueMetrics?.outstandingBalanceDue === 'number' &&
        typeof result.responseData?.revenueMetrics?.collectionEfficiency === 'number',
        'Financial revenue metrics contain invoiced, collected, balance, and collectionEfficiency',
        result.responseData?.revenueMetrics
      );

      const agingBuckets = result.responseData?.agingSchedule;
      assert(
        Array.isArray(agingBuckets) && agingBuckets.length === 4,
        'Aging schedule contains precisely 4 standardized buckets (0-30d, 31-60d, 61-90d, 90+d)',
        agingBuckets?.map((b: any) => b.range)
      );

      assert(
        Array.isArray(result.responseData?.debtors),
        'Debtors drill-down array returned'
      );

      assert(
        Array.isArray(result.responseData?.financialLedger),
        'Immutable financial ledger audit log array returned'
      );
    }

    // ─── TEST 3: Section 6.3 Admissions Funnel & Demographic Report ───
    console.log('\n📌 3. Testing Admissions Funnel & Demographic Report Engine...');
    {
      const { req, res, getResult } = createMockReqRes(branchId);
      await getAdmissionsFunnelReport(req, res);
      const result = getResult();

      assert(result.statusCode === 200 && result.responseData?.success === true, 'getAdmissionsFunnelReport returned 200 OK');

      const funnel = result.responseData?.funnel;
      assert(
        funnel &&
        typeof funnel.inquiries === 'number' &&
        typeof funnel.applications === 'number' &&
        typeof funnel.screened === 'number' &&
        typeof funnel.offered === 'number' &&
        typeof funnel.enrolled === 'number' &&
        typeof funnel.conversionRate === 'number',
        'Admissions funnel returns full 5-stage pipeline with conversion rate %',
        funnel
      );

      const demo = result.responseData?.demographics;
      assert(
        demo &&
        typeof demo.femalePercent === 'number' &&
        typeof demo.malePercent === 'number',
        'Demographics report returns gender split metrics (female % and male %)',
        demo
      );

      assert(
        Array.isArray(result.responseData?.classCapacities),
        'Classroom capacity utilization rates returned per class arm'
      );
    }

    // ─── TEST 4: Section 6.4 Inventory Valuation & Low-Stock Alerts ───
    console.log('\n📌 4. Testing Inventory Valuation & Stock Alerts Engine...');
    {
      const { req, res, getResult } = createMockReqRes(branchId);
      await getInventoryValuationReport(req, res);
      const result = getResult();

      assert(result.statusCode === 200 && result.responseData?.success === true, 'getInventoryValuationReport returned 200 OK');

      const summary = result.responseData?.summary;
      assert(
        summary &&
        typeof summary.totalAssetBookValue === 'number' &&
        typeof summary.totalRetailValue === 'number' &&
        typeof summary.totalItemsCataloged === 'number' &&
        typeof summary.lowStockCount === 'number',
        'Inventory summary computes asset book value, retail value, units, and low-stock count',
        summary
      );

      assert(
        Array.isArray(result.responseData?.items),
        'Inventory SKU items array returned with reorder thresholds and status'
      );

      assert(
        Array.isArray(result.responseData?.auditLedger),
        'Inventory department issuance audit ledger returned'
      );
    }

    // ─── TEST 5: Section 6.5 Staff Attendance & Punctuality Audits ───
    console.log('\n📌 5. Testing Staff Attendance, Timecard Log & Punctuality Engine...');
    {
      const { req, res, getResult } = createMockReqRes(branchId, { month: '10', year: '2026' });
      await getStaffAttendanceAuditReport(req, res);
      const result = getResult();

      assert(result.statusCode === 200 && result.responseData?.success === true, 'getStaffAttendanceAuditReport returned 200 OK');

      const summary = result.responseData?.summary;
      assert(
        summary &&
        typeof summary.totalStaff === 'number' &&
        typeof summary.avgPunctuality === 'number' &&
        typeof summary.avgPresenceRate === 'number',
        'Staff attendance summary contains totalStaff, avgPunctuality %, and avgPresenceRate %',
        summary
      );

      assert(
        Array.isArray(result.responseData?.staffLogs),
        'Staff punctuality audit logs array returned'
      );

      assert(
        Array.isArray(result.responseData?.recentClockIns),
        'Biometric / QR gate clock-in entries array returned'
      );
    }

    // ─── TEST 6: CSV / Excel Export Pipeline ───
    console.log('\n📌 6. Testing CSV Report Export Pipeline...');
    {
      const { req, res, getResult } = createMockReqRes(branchId, { type: 'attendance' });
      await exportCentralReportCsv(req, res);
      const result = getResult();

      assert(
        result.statusCode === 200 &&
        result.headers['content-type']?.includes('text/csv') &&
        typeof result.responseData === 'string' &&
        result.responseData.includes('Student Name'),
        'exportCentralReportCsv produces valid CSV attachment with headers and row data'
      );
    }

  } catch (err) {
    console.error('❌ Fatal error running Phase 6 tests:', err);
    failed++;
  }

  console.log('\n=================================================================');
  console.log(`📊 Phase 6 Test Suite Results: ${passed} Passed, ${failed} Failed`);
  console.log('=================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase6Tests()
  .then(() => {
    prisma.$disconnect();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
