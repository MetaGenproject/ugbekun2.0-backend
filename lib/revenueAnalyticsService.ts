import PDFDocument from 'pdfkit';

/**
 * Service to aggregate multi-branch SaaS and institutional revenue analytics.
 */

export interface RevenueAnalyticsFilters {
  sessionId?: number | string;
  branchId?: number | string;
  period?: string;
}

export async function getMultiBranchRevenueAnalytics(prisma: any, { sessionId, branchId, period = 'all' }: RevenueAnalyticsFilters) {
  const branchFilter = branchId && !isNaN(parseInt(branchId as string, 10)) ? { id: parseInt(branchId as string, 10) } : {};
  const sessionFilter = sessionId && !isNaN(parseInt(sessionId as string, 10)) ? { sessionId: parseInt(sessionId as string, 10) } : {};

  // 1. Fetch all branches with student count
  const branches = await prisma.branch.findMany({
    where: branchFilter,
    include: {
      students: {
        where: { active: true },
        select: { id: true }
      },
      subscriptions: {
        include: { plan: true },
        orderBy: { createdAt: 'desc' }
      }
    },
    orderBy: { name: 'asc' }
  });

  // 2. Fetch subscription plans
  const subscriptionPlans = await prisma.subscriptionPlan.findMany({
    include: {
      subscriptions: {
        where: { paymentStatus: 'paid' }
      }
    }
  });

  // 3. Fetch Invoices matching filters
  const invoiceWhere = {
    ...sessionFilter,
    ...(branchId && !isNaN(parseInt(branchId as string, 10)) ? { branchId: parseInt(branchId as string, 10) } : {})
  };

  const invoices = await prisma.invoice.findMany({
    where: invoiceWhere,
    select: {
      id: true,
      invoiceNo: true,
      totalAmount: true,
      paidAmount: true,
      balanceAmount: true,
      status: true,
      issuedAt: true,
      branchId: true,
      sessionId: true,
      studentId: true,
    }
  });

  // 4. Fetch Payments matching filters
  const paymentWhere = {
    ...(branchId && !isNaN(parseInt(branchId as string, 10)) ? { branchId: parseInt(branchId as string, 10) } : {})
  };

  const payments = await prisma.payment.findMany({
    where: paymentWhere,
    select: {
      id: true,
      amount: true,
      method: true,
      paidAt: true,
      branchId: true,
      invoiceId: true
    },
    orderBy: { paidAt: 'asc' }
  });

  // 5. Fetch Office Transactions & Payroll runs for expenses
  const officeTransactions = await prisma.officeTransaction.findMany({
    where: {
      type: 'EXPENSE',
      ...(branchId && !isNaN(parseInt(branchId as string, 10)) ? { branchId: parseInt(branchId as string, 10) } : {})
    },
    select: {
      id: true,
      amount: true,
      transactionDate: true,
      branchId: true
    }
  });

  const payrollRuns = await prisma.payrollRun.findMany({
    where: {
      status: { in: ['APPROVED', 'PAID'] },
      ...(branchId && !isNaN(parseInt(branchId as string, 10)) ? { branchId: parseInt(branchId as string, 10) } : {})
    },
    select: {
      id: true,
      totalNet: true,
      totalGross: true,
      createdAt: true,
      branchId: true
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // A. CALCULATE SAAS SUBSCRIPTION METRICS
  // ─────────────────────────────────────────────────────────────────────────────
  let totalSaasRevenue = 0;
  let saasMrr = 0;
  let activeSubscribedBranches = 0;

  const now = new Date();

  // Track latest active subscription per branch
  const branchSubMap: Record<number, any> = {};
  branches.forEach((b: any) => {
    const activePaidSub = b.subscriptions.find(
      (s: any) => s.paymentStatus === 'paid' && new Date(s.expiryDate) >= now
    );
    const latestSub = b.subscriptions[0] || null;

    if (activePaidSub) {
      activeSubscribedBranches++;
      if (activePaidSub.plan?.priceMonthly) {
        saasMrr += parseFloat(activePaidSub.plan.priceMonthly.toString());
      }
    }

    branchSubMap[b.id] = {
      activePaidSub,
      latestSub,
      planName: (activePaidSub || latestSub)?.plan?.name || 'No Plan Active',
      status: activePaidSub ? 'active' : latestSub ? latestSub.paymentStatus : 'none',
      cost: parseFloat((activePaidSub || latestSub)?.totalCost?.toString() || '0'),
      expiryDate: (activePaidSub || latestSub)?.expiryDate || null
    };
  });

  // Total paid subscriptions revenue across the platform
  subscriptionPlans.forEach((plan: any) => {
    plan.subscriptions.forEach((sub: any) => {
      totalSaasRevenue += parseFloat(sub.totalCost.toString());
    });
  });

  const saasArr = saasMrr * 12;

  // ─────────────────────────────────────────────────────────────────────────────
  // B. CALCULATE INSTITUTIONAL SCHOOL FEES METRICS
  // ─────────────────────────────────────────────────────────────────────────────
  let totalSchoolInvoiced = 0;
  let totalSchoolCollected = 0;
  let totalSchoolOutstanding = 0;

  // Per-branch aggregation maps
  const branchMetrics: Record<number, any> = {};
  branches.forEach((b: any) => {
    branchMetrics[b.id] = {
      branchId: b.id,
      branchName: b.name,
      branchCode: b.code || 'N/A',
      active: b.active,
      studentsCount: b.students.length,
      adminName: b.adminName || '—',
      email: b.email || '—',
      phone: b.phone || '—',
      city: b.city || '',
      state: b.state || '',
      planName: branchSubMap[b.id]?.planName || 'No Plan Active',
      subscriptionStatus: branchSubMap[b.id]?.status || 'none',
      subscriptionCost: branchSubMap[b.id]?.cost || 0,
      expiryDate: branchSubMap[b.id]?.expiryDate || null,
      invoicedAmount: 0,
      collectedAmount: 0,
      outstandingAmount: 0,
      expensesAmount: 0,
      paymentCount: 0,
      lastPaymentDate: null
    };
  });

  invoices.forEach((inv: any) => {
    const total = parseFloat(inv.totalAmount.toString());
    const paid = parseFloat(inv.paidAmount.toString());
    const balance = parseFloat(inv.balanceAmount.toString());

    totalSchoolInvoiced += total;
    totalSchoolCollected += paid;
    totalSchoolOutstanding += balance;

    if (branchMetrics[inv.branchId]) {
      branchMetrics[inv.branchId].invoicedAmount += total;
      branchMetrics[inv.branchId].collectedAmount += paid;
      branchMetrics[inv.branchId].outstandingAmount += balance;
    }
  });

  payments.forEach((p: any) => {
    const amt = parseFloat(p.amount.toString());
    if (branchMetrics[p.branchId]) {
      branchMetrics[p.branchId].paymentCount += 1;
      if (
        !branchMetrics[p.branchId].lastPaymentDate ||
        new Date(p.paidAt) > new Date(branchMetrics[p.branchId].lastPaymentDate)
      ) {
        branchMetrics[p.branchId].lastPaymentDate = p.paidAt;
      }
    }
  });

  // Expenses per branch
  let totalExpenses = 0;
  officeTransactions.forEach((tx: any) => {
    const amt = parseFloat(tx.amount.toString());
    totalExpenses += amt;
    if (branchMetrics[tx.branchId]) {
      branchMetrics[tx.branchId].expensesAmount += amt;
    }
  });

  payrollRuns.forEach((pr: any) => {
    const amt = parseFloat(pr.totalGross?.toString() || pr.totalNet?.toString() || '0');
    totalExpenses += amt;
    if (branchMetrics[pr.branchId]) {
      branchMetrics[pr.branchId].expensesAmount += amt;
    }
  });

  // Compute rates and net surplus for each branch
  const branchLeaderboard = Object.values(branchMetrics).map((b: any) => {
    const rate = b.invoicedAmount > 0 ? (b.collectedAmount / b.invoicedAmount) * 100 : 0;
    const netSurplus = b.collectedAmount - b.expensesAmount;
    let statusRating = 'MODERATE';
    if (rate >= 80 || (b.invoicedAmount === 0 && b.collectedAmount > 0)) {
      statusRating = 'OPTIMAL';
    } else if (rate < 50 && b.outstandingAmount > 100000) {
      statusRating = 'ARREARS_RISK';
    }

    return {
      ...b,
      collectionRate: Number(rate.toFixed(1)),
      netSurplus,
      statusRating
    };
  });

  // Sort leaderboard by collected revenue descending
  branchLeaderboard.sort((a, b) => b.collectedAmount - a.collectedAmount);

  const globalCollectionRate =
    totalSchoolInvoiced > 0 ? Number(((totalSchoolCollected / totalSchoolInvoiced) * 100).toFixed(1)) : 0;
  const netOperatingSurplus = totalSchoolCollected - totalExpenses;

  // ─────────────────────────────────────────────────────────────────────────────
  // C. PAYMENT METHODS BREAKDOWN
  // ─────────────────────────────────────────────────────────────────────────────
  const methodMap: Record<string, { name: string; amount: number; count: number }> = {
    bank_transfer: { name: 'Bank Transfer', amount: 0, count: 0 },
    pos: { name: 'POS Terminal', amount: 0, count: 0 },
    cash: { name: 'Cash', amount: 0, count: 0 },
    online: { name: 'Online Gateway', amount: 0, count: 0 },
    other: { name: 'Other', amount: 0, count: 0 }
  };

  payments.forEach((p: any) => {
    const amt = parseFloat(p.amount.toString());
    const normMethod = (p.method || 'other').toLowerCase();
    const targetKey = methodMap[normMethod] ? normMethod : 'other';
    methodMap[targetKey].amount += amt;
    methodMap[targetKey].count += 1;
  });

  const paymentMethodBreakdown = Object.values(methodMap)
    .filter((m) => m.amount > 0 || m.count > 0)
    .map((m) => ({
      ...m,
      percentage: totalSchoolCollected > 0 ? Number(((m.amount / totalSchoolCollected) * 100).toFixed(1)) : 0
    }));

  if (paymentMethodBreakdown.length === 0) {
    paymentMethodBreakdown.push(
      { name: 'Bank Transfer', amount: 0, count: 0, percentage: 0 },
      { name: 'POS Terminal', amount: 0, count: 0, percentage: 0 },
      { name: 'Cash', amount: 0, count: 0, percentage: 0 }
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // D. PLAN DISTRIBUTION & REVENUE BREAKDOWN
  // ─────────────────────────────────────────────────────────────────────────────
  const planRevenueBreakdown = subscriptionPlans.map((p: any) => {
    const rev = p.subscriptions.reduce((sum: number, s: any) => sum + parseFloat(s.totalCost.toString()), 0);
    return {
      name: p.name,
      slug: p.slug,
      activeSubscriptions: p.subscriptions.length,
      revenue: rev,
      percentage: totalSaasRevenue > 0 ? Number(((rev / totalSaasRevenue) * 100).toFixed(1)) : 0
    };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // E. 6-MONTH MONTHLY CASHFLOW TIMELINE
  // ─────────────────────────────────────────────────────────────────────────────
  const monthsArr: any[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthLabel = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthsArr.push({ month: monthLabel, monthKey, saasRevenue: 0, feeCollections: 0, expenses: 0, netSurplus: 0 });
  }

  // Populate payments
  payments.forEach((p: any) => {
    const pDate = new Date(p.paidAt);
    const key = `${pDate.getFullYear()}-${String(pDate.getMonth() + 1).padStart(2, '0')}`;
    const target = monthsArr.find((m) => m.monthKey === key);
    if (target) {
      target.feeCollections += parseFloat(p.amount.toString());
    }
  });

  // Populate SaaS subscription revenues
  subscriptionPlans.forEach((plan: any) => {
    plan.subscriptions.forEach((sub: any) => {
      const sDate = new Date(sub.createdAt || sub.startDate);
      const key = `${sDate.getFullYear()}-${String(sDate.getMonth() + 1).padStart(2, '0')}`;
      const target = monthsArr.find((m) => m.monthKey === key);
      if (target) {
        target.saasRevenue += parseFloat(sub.totalCost.toString());
      }
    });
  });

  // Populate expenses
  officeTransactions.forEach((tx: any) => {
    const tDate = new Date(tx.transactionDate);
    const key = `${tDate.getFullYear()}-${String(tDate.getMonth() + 1).padStart(2, '0')}`;
    const target = monthsArr.find((m) => m.monthKey === key);
    if (target) {
      target.expenses += parseFloat(tx.amount.toString());
    }
  });

  payrollRuns.forEach((pr: any) => {
    const prDate = new Date(pr.createdAt);
    const key = `${prDate.getFullYear()}-${String(prDate.getMonth() + 1).padStart(2, '0')}`;
    const target = monthsArr.find((m) => m.monthKey === key);
    if (target) {
      target.expenses += parseFloat(pr.totalGross?.toString() || pr.totalNet?.toString() || '0');
    }
  });

  monthsArr.forEach((m) => {
    m.netSurplus = m.feeCollections - m.expenses;
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // F. EXECUTIVE NARRATIVE & STRATEGIC HIGHLIGHTS
  // ─────────────────────────────────────────────────────────────────────────────
  const topPerformers = branchLeaderboard.filter((b) => b.collectedAmount > 0).slice(0, 3);
  const arrearsWatchlist = branchLeaderboard.filter((b) => b.outstandingAmount > 0).slice(0, 3);

  const executiveNarrative = {
    headline: `Multi-Branch Consolidated Revenue Performance (${branches.length} Branches)`,
    summary: `Gross fee collection across monitored branches is ₦${totalSchoolCollected.toLocaleString()} against an invoiced portfolio of ₦${totalSchoolInvoiced.toLocaleString()} (${globalCollectionRate}% collection rate). SaaS platform ARR stands at ₦${saasArr.toLocaleString()} with ${activeSubscribedBranches} active subscribed school locations.`,
    topCampusText:
      topPerformers.length > 0
        ? `Leading revenue contributor is "${topPerformers[0].branchName}" with ₦${topPerformers[0].collectedAmount.toLocaleString()} collected.`
        : 'No branch collections recorded in this window yet.',
    arrearsRiskText:
      arrearsWatchlist.length > 0
        ? `Arrears backlog currently totals ₦${totalSchoolOutstanding.toLocaleString()}. Focus follow-ups on "${arrearsWatchlist[0].branchName}" (₦${arrearsWatchlist[0].outstandingAmount.toLocaleString()} outstanding).`
        : 'All active invoices are completely settled with zero arrears backlog.',
    strategicRecommendation:
      globalCollectionRate < 70
        ? 'Superadmin recommendation: Deploy automated SMS fee reminders across branches with <70% collection efficiency to accelerate term cashflows.'
        : 'Superadmin recommendation: Financial health across branches is performing within optimal parameters.'
  };

  return {
    summary: {
      totalSaasRevenue,
      saasMrr,
      saasArr,
      activeSubscribedBranches,
      totalBranches: branches.length,
      totalSchoolInvoiced,
      totalSchoolCollected,
      totalSchoolOutstanding,
      globalCollectionRate,
      totalExpenses,
      netOperatingSurplus
    },
    branchLeaderboard,
    timeTrends: monthsArr,
    paymentMethodBreakdown,
    planRevenueBreakdown,
    topPerformers,
    arrearsWatchlist,
    executiveNarrative
  };
}

/**
 * Generates CSV Export for Multi-Branch Revenue Analytics
 */
export function exportRevenueReportCsv(analyticsData: any): string {
  const headers = [
    'Branch ID',
    'Branch Name',
    'Branch Code',
    'Status',
    'Subscribed Plan',
    'Sub Status',
    'Sub Expiry',
    'Enrolled Students',
    'Total Invoiced (NGN)',
    'Total Collected (NGN)',
    'Outstanding Balance (NGN)',
    'Collection Rate (%)',
    'Operating Expenses (NGN)',
    'Net Operating Surplus (NGN)',
    'Health Rating',
    'Contact Email',
    'Contact Phone'
  ];

  const escapeCsv = (val: any) => {
    const s = val == null ? '' : String(val);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const rows = analyticsData.branchLeaderboard.map((b: any) => [
    b.branchId,
    escapeCsv(b.branchName || b.name || ''),
    escapeCsv(b.branchCode || b.code || ''),
    b.active ? 'Active' : 'Inactive',
    escapeCsv(b.planName || 'Standard'),
    escapeCsv(b.subscriptionStatus || 'Active'),
    b.expiryDate ? new Date(b.expiryDate).toISOString().slice(0, 10) : '—',
    b.studentsCount || 0,
    Number(b.invoicedAmount || 0).toFixed(2),
    Number(b.collectedAmount || 0).toFixed(2),
    Number(b.outstandingAmount || 0).toFixed(2),
    Number(b.collectionRate || 0).toFixed(1),
    Number(b.expensesAmount || b.totalExpenses || 0).toFixed(2),
    Number(b.netSurplus || b.netMargin || 0).toFixed(2),
    b.statusRating || b.health || 'OPTIMAL',
    escapeCsv(b.email || ''),
    escapeCsv(b.phone || '')
  ]);

  // Add Summary Header lines
  const summaryLines = [
    `"UGBEKUN 2.0 MULTI-BRANCH CONSOLIDATED REVENUE AUDIT"`,
    `"Generated At: ${new Date().toUTCString()}"`,
    `"Total SaaS Platform Revenue: NGN ${analyticsData.summary.totalSaasRevenue.toFixed(2)}"`,
    `"Gross School Invoiced Volume: NGN ${analyticsData.summary.totalSchoolInvoiced.toFixed(2)}"`,
    `"Total School Fees Collected: NGN ${analyticsData.summary.totalSchoolCollected.toFixed(2)}"`,
    `"Total Outstanding Arrears: NGN ${analyticsData.summary.totalSchoolOutstanding.toFixed(2)}"`,
    `"Global Collection Efficiency: ${analyticsData.summary.globalCollectionRate.toFixed(1)}%"`,
    `"Net Operating Surplus: NGN ${analyticsData.summary.netOperatingSurplus.toFixed(2)}"`,
    ''
  ];

  const csvContent = summaryLines.join('\n') + headers.join(',') + '\n' + rows.map((r: any) => r.join(',')).join('\n');

  return csvContent;
}

/**
 * Generates Executive PDF Export for Multi-Branch Revenue Analytics
 */
export function exportRevenueReportPdf(analyticsData: any, title = 'Multi-Branch Superadmin Revenue Audit Report'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        info: {
          Title: title,
          Author: 'Ugbekun SaaS Platform Superadmin Engine'
        }
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const navyColor = '#003da5';
      const tealColor = '#009ca6';
      const darkColor = '#0f172a';
      const greenColor = '#15803d';
      const redColor = '#b91c1c';
      const grayLight = '#f8fafc';
      const grayBorder = '#e2e8f0';

      // Top Header Banner
      doc.rect(36, 36, 523, 64).fill(navyColor);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text('UGBEKUN 2.0 SAAS PLATFORM', 50, 48);
      doc
        .font('Helvetica')
        .fontSize(9.5)
        .fillColor('#cbd5e1')
        .text('EXECUTIVE MULTI-BRANCH REVENUE & INSTITUTIONAL FINANCIAL AUDIT', 50, 68)
        .text(`Audit Date: ${new Date().toLocaleDateString('en-US', { dateStyle: 'full' })}`, 350, 68, {
          align: 'right',
          width: 195
        });

      let yPos = 115;

      // 4 Main KPI Cards
      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(11).text('Consolidated Financial Key Metrics', 36, yPos);
      yPos += 16;

      const cardW = 124;
      const cardH = 50;
      const cardGap = 9;

      const arrearsCount = Array.isArray(analyticsData.arrearsWatchlist) ? analyticsData.arrearsWatchlist.length : 0;
      const kpis = [
        {
          label: 'SAAS PLATFORM REV',
          val: `NGN ${Number(analyticsData.summary.totalSaasRevenue || 0).toLocaleString(undefined, { minimumFractionDigits: 0 })}`,
          sub: `MRR: ₦${Number(analyticsData.summary.saasMrr || 0).toLocaleString()}`,
          color: navyColor
        },
        {
          label: 'FEES COLLECTED',
          val: `NGN ${Number(analyticsData.summary.totalSchoolCollected || 0).toLocaleString(undefined, { minimumFractionDigits: 0 })}`,
          sub: `${analyticsData.summary.globalCollectionRate || 0}% Coll. Rate`,
          color: greenColor
        },
        {
          label: 'TOTAL OUTSTANDING',
          val: `NGN ${Number(analyticsData.summary.totalSchoolOutstanding || 0).toLocaleString(undefined, { minimumFractionDigits: 0 })}`,
          sub: `${arrearsCount} at-risk schools`,
          color: redColor
        },
        {
          label: 'NET OPERATING SURPLUS',
          val: `NGN ${Number(analyticsData.summary.netOperatingSurplus || 0).toLocaleString(undefined, { minimumFractionDigits: 0 })}`,
          sub: `Exp: ₦${Number(analyticsData.summary.totalExpenses || 0).toLocaleString()}`,
          color: tealColor
        }
      ];

      kpis.forEach((kpi, idx) => {
        const xPos = 36 + idx * (cardW + cardGap);
        doc.rect(xPos, yPos, cardW, cardH).fill(grayLight).stroke(grayBorder);
        doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(6.5).text(kpi.label, xPos + 8, yPos + 8);
        doc.fillColor(kpi.color).font('Helvetica-Bold').fontSize(9.5).text(kpi.val, xPos + 8, yPos + 20, { width: cardW - 16, ellipsis: true });
        doc.fillColor('#475569').font('Helvetica').fontSize(6.5).text(kpi.sub, xPos + 8, yPos + 34);
      });

      yPos += cardH + 16;

      // Executive Insight Callout Box
      const narrative = analyticsData.executiveNarrative || {
        summary: 'Overall multi-branch financial collection metrics remain healthy across participating campuses.',
        topCampusText: 'All operational parameters within expected margins.',
        arrearsRiskText: ''
      };
      doc.rect(36, yPos, 523, 44).fill('#f0fdf4').stroke('#bbf7d0');
      doc.fillColor('#166534').font('Helvetica-Bold').fontSize(8.5).text('Executive Narrative & Strategic Takeaways', 46, yPos + 8);
      doc
        .fillColor('#15803d')
        .font('Helvetica')
        .fontSize(7.5)
        .text(
          `${narrative.summary} ${narrative.topCampusText} ${narrative.arrearsRiskText}`.trim(),
          46,
          yPos + 21,
          { width: 503, lineGap: 1.5 }
        );

      yPos += 58;

      // Multi-Branch Performance Table
      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(11).text('Branch Financial Performance Matrix', 36, yPos);
      yPos += 14;

      // Table Header Bar
      const tableHeaders = [
        { label: 'SCHOOL / BRANCH', x: 42, w: 140 },
        { label: 'PLAN', x: 185, w: 55 },
        { label: 'STUDENTS', x: 243, w: 45 },
        { label: 'INVOICED (₦)', x: 290, w: 65 },
        { label: 'COLLECTED (₦)', x: 360, w: 65 },
        { label: 'ARREARS (₦)', x: 430, w: 65 },
        { label: 'RATE %', x: 500, w: 45 }
      ];

      doc.rect(36, yPos, 523, 18).fill(navyColor);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7);
      tableHeaders.forEach((th) => {
        doc.text(th.label, th.x, yPos + 5, { width: th.w, align: th.x >= 290 ? 'right' : 'left' });
      });

      yPos += 18;

      // Table Rows
      analyticsData.branchLeaderboard.forEach((branch: any, index: number) => {
        if (yPos > 740) {
          doc.addPage();
          yPos = 36;

          // Redraw Header
          doc.rect(36, yPos, 523, 18).fill(navyColor);
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7);
          tableHeaders.forEach((th) => {
            doc.text(th.label, th.x, yPos + 5, { width: th.w, align: th.x >= 290 ? 'right' : 'left' });
          });
          yPos += 18;
        }

        const rowHeight = 16;
        if (index % 2 === 1) {
          doc.rect(36, yPos, 523, rowHeight).fill('#f8fafc');
        }

        doc.font('Helvetica').fontSize(7).fillColor(darkColor);

        // School Name & Code
        doc.font('Helvetica-Bold').text(branch.branchName, 42, yPos + 4, { width: 140, ellipsis: true });
        doc.font('Helvetica').fillColor('#64748b').text(branch.planName, 185, yPos + 4, { width: 55, ellipsis: true });
        doc.fillColor(darkColor).text(branch.studentsCount.toString(), 243, yPos + 4);

        // Amounts
        doc.text(branch.invoicedAmount.toLocaleString(undefined, { minimumFractionDigits: 0 }), 290, yPos + 4, {
          width: 65,
          align: 'right'
        });
        doc.fillColor(greenColor).text(branch.collectedAmount.toLocaleString(undefined, { minimumFractionDigits: 0 }), 360, yPos + 4, {
          width: 65,
          align: 'right'
        });
        doc
          .fillColor(branch.outstandingAmount > 0 ? redColor : darkColor)
          .text(branch.outstandingAmount.toLocaleString(undefined, { minimumFractionDigits: 0 }), 430, yPos + 4, {
            width: 65,
            align: 'right'
          });

        // Collection Rate
        doc.fillColor(branch.collectionRate >= 75 ? greenColor : branch.collectionRate >= 50 ? '#d97706' : redColor);
        doc.font('Helvetica-Bold').text(`${branch.collectionRate}%`, 500, yPos + 4, { width: 45, align: 'right' });

        yPos += rowHeight;
      });

      // Footer Note
      doc.moveDown(2);
      doc
        .fillColor('#94a3b8')
        .font('Helvetica')
        .fontSize(7)
        .text('© Ugbekun 2.0 SaaS Platform • Confidential Internal Superadmin Audit Document • Generated via Automated Engine', 36, 780, {
          align: 'center',
          width: 523
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  getMultiBranchRevenueAnalytics,
  exportRevenueReportCsv,
  exportRevenueReportPdf
};
