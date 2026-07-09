const PDFDocument = require('pdfkit');

/**
 * Generates a unique invoice number for a branch.
 * Format: INV/<BRANCH_CODE>/<YEAR>/<SEQUENCE> (e.g., INV/MTGA/2026/0001)
 */
async function generateInvoiceNumber(prisma, branchId) {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { code: true }
  });
  
  const branchCode = (branch?.code || 'GEN').toUpperCase();
  const year = new Date().getFullYear();
  const prefix = `INV/${branchCode}/${year}/`;
  
  const highestInvoice = await prisma.invoice.findFirst({
    where: {
      invoiceNo: {
        startsWith: prefix
      }
    },
    orderBy: {
      invoiceNo: 'desc'
    },
    select: {
      invoiceNo: true
    }
  });
  
  let nextSequence = 1;
  if (highestInvoice?.invoiceNo) {
    const parts = highestInvoice.invoiceNo.split('/');
    const lastPart = parts[parts.length - 1];
    const currentSequence = parseInt(lastPart, 10);
    if (!isNaN(currentSequence)) {
      nextSequence = currentSequence + 1;
    }
  }
  
  const paddedSequence = String(nextSequence).padStart(4, '0');
  return `${prefix}${paddedSequence}`;
}

/**
 * Generates an invoice for a student based on fee types.
 */
async function generateInvoice(prisma, { studentId, termLabel, feeTypeIds, branchId, sessionId, dueDate }) {
  const student = await prisma.student.findUnique({
    where: { id: studentId }
  });
  if (!student) throw new Error('Student not found');
  
  const feeTypes = await prisma.feeType.findMany({
    where: {
      id: { in: feeTypeIds },
      branchId
    }
  });
  
  if (feeTypes.length === 0) throw new Error('No valid fee types selected');
  
  const invoiceNo = await generateInvoiceNumber(prisma, branchId);
  const totalAmount = feeTypes.reduce((acc, curr) => acc + parseFloat(curr.amount.toString()), 0);
  
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        invoiceNo,
        termLabel,
        totalAmount,
        paidAmount: 0,
        balanceAmount: totalAmount,
        status: 'unpaid',
        dueDate: dueDate ? new Date(dueDate) : null,
        studentId,
        branchId,
        sessionId
      }
    });
    
    const itemsData = feeTypes.map(ft => ({
      description: ft.name,
      amount: parseFloat(ft.amount.toString()),
      invoiceId: invoice.id,
      feeTypeId: ft.id
    }));
    
    await tx.invoiceItem.createMany({
      data: itemsData
    });
    
    return tx.invoice.findUnique({
      where: { id: invoice.id },
      include: { items: true }
    });
  });
}

/**
 * Records a payment against an invoice and updates invoice status.
 */
async function recordPayment(prisma, { invoiceId, amount, method, reference, receivedBy, notes, branchId }) {
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) throw new Error('Invalid payment amount');
  
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId }
  });
  if (!invoice) throw new Error('Invoice not found');
  
  return prisma.$transaction(async (tx) => {
    // Insert payment
    const payment = await tx.payment.create({
      data: {
        amount: amt,
        method,
        reference,
        receivedBy,
        notes,
        invoiceId,
        branchId
      }
    });
    
    // Update invoice status
    const currentPaid = parseFloat(invoice.paidAmount.toString());
    const total = parseFloat(invoice.totalAmount.toString());
    
    const newPaid = currentPaid + amt;
    const newBalance = Math.max(0, total - newPaid);
    
    let status = 'partial';
    if (newBalance <= 0) {
      status = 'paid';
    } else if (newPaid === 0) {
      status = 'unpaid';
    }
    
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paidAmount: newPaid,
        balanceAmount: newBalance,
        status
      }
    });
    
    return payment;
  });
}

/**
 * Gets aggregated financial reports for dashboard.
 */
async function getFinancialOverview(prisma, { branchId, sessionId }) {
  const invoices = await prisma.invoice.findMany({
    where: { branchId, sessionId },
    select: {
      totalAmount: true,
      paidAmount: true,
      balanceAmount: true,
      status: true
    }
  });
  
  let totalInvoiced = 0;
  let totalRevenue = 0;
  let totalOutstanding = 0;
  
  invoices.forEach(inv => {
    totalInvoiced += parseFloat(inv.totalAmount.toString());
    totalRevenue += parseFloat(inv.paidAmount.toString());
    totalOutstanding += parseFloat(inv.balanceAmount.toString());
  });
  
  const collectionRate = totalInvoiced > 0 ? (totalRevenue / totalInvoiced) * 100 : 0;
  
  // Payment trend (grouped by day for last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const payments = await prisma.payment.findMany({
    where: {
      branchId,
      paidAt: { gte: thirtyDaysAgo }
    },
    orderBy: { paidAt: 'asc' },
    select: {
      amount: true,
      paidAt: true
    }
  });
  
  const trendMap = {};
  payments.forEach(p => {
    const day = p.paidAt.toISOString().split('T')[0];
    trendMap[day] = (trendMap[day] || 0) + parseFloat(p.amount.toString());
  });
  
  const paymentTrend = Object.keys(trendMap).map(date => ({
    date,
    amount: trendMap[date]
  }));
  
  // Outstanding balances by student
  const outstandingStudents = await prisma.invoice.findMany({
    where: {
      branchId,
      sessionId,
      balanceAmount: { gt: 0 }
    },
    include: {
      student: {
        select: {
          firstName: true,
          lastName: true,
          registerNo: true
        }
      }
    },
    orderBy: { balanceAmount: 'desc' },
    take: 10
  });
  
  const mappedOutstanding = outstandingStudents.map(inv => ({
    invoiceId: inv.id,
    invoiceNo: inv.invoiceNo,
    studentName: `${inv.student.firstName} ${inv.student.lastName}`,
    registerNo: inv.student.registerNo,
    total: parseFloat(inv.totalAmount.toString()),
    paid: parseFloat(inv.paidAmount.toString()),
    balance: parseFloat(inv.balanceAmount.toString())
  }));
  
  return {
    summary: {
      totalInvoiced,
      totalRevenue,
      totalOutstanding,
      collectionRate
    },
    paymentTrend,
    outstandingStudents: mappedOutstanding
  };
}

/**
 * Exports financial outstanding status to CSV format.
 */
async function exportFinancialReportCsv(prisma, { branchId, sessionId }) {
  const invoices = await prisma.invoice.findMany({
    where: { branchId, sessionId },
    include: {
      student: {
        select: {
          firstName: true,
          lastName: true,
          registerNo: true
        }
      }
    },
    orderBy: { invoiceNo: 'asc' }
  });
  
  let csv = 'Invoice No,Register No,Student Name,Term,Total Invoiced,Total Paid,Outstanding Balance,Status,Issue Date\n';
  
  invoices.forEach(inv => {
    const name = `"${inv.student.firstName} ${inv.student.lastName}"`;
    const term = `"${inv.termLabel || 'N/A'}"`;
    const total = parseFloat(inv.totalAmount.toString()).toFixed(2);
    const paid = parseFloat(inv.paidAmount.toString()).toFixed(2);
    const balance = parseFloat(inv.balanceAmount.toString()).toFixed(2);
    const date = inv.issuedAt.toLocaleDateString();
    
    csv += `${inv.invoiceNo},${inv.student.registerNo || 'N/A'},${name},${term},${total},${paid},${balance},${inv.status},${date}\n`;
  });
  
  return csv;
}

/**
 * Exports financial report to PDF.
 */
async function exportFinancialReportPdf(prisma, { branchId, sessionId, schoolName }) {
  return new Promise(async (resolve, reject) => {
    try {
      const overview = await getFinancialOverview(prisma, { branchId, sessionId });
      const invoices = await prisma.invoice.findMany({
        where: { branchId, sessionId },
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              registerNo: true
            }
          }
        },
        orderBy: { balanceAmount: 'desc' },
        take: 30
      });
      
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: 'Financial Overview Report',
          Author: 'Ugbekun Schools Platform'
        }
      });
      
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      
      const primaryColor = '#1b5e20';
      const darkColor = '#1e293b';
      const lightBg = '#f8fafc';
      
      // Header
      doc.rect(40, 40, 515, 60).fill(primaryColor);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16)
         .text(schoolName.toUpperCase(), 55, 52, { width: 485, align: 'left' });
      doc.font('Helvetica').fontSize(10).fillColor('#e8f5e9')
         .text(`CONSOLIDATED FINANCIAL REPORT • ACADEMIC SESSION`, 55, 76);
         
      let yPos = 120;
      
      // Summary boxes
      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(12).text('Financial Position Summary', 40, yPos);
      yPos += 20;
      
      // Draw 3 boxes side-by-side
      const boxW = 160;
      const boxH = 50;
      
      // Invoiced Box
      doc.rect(40, yPos, boxW, boxH).fill(lightBg).stroke('#e2e8f0');
      doc.fillColor('#64748b').font('Helvetica').fontSize(8).text('TOTAL INVOICED', 50, yPos + 10);
      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(11)
         .text(`NGN ${overview.summary.totalInvoiced.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 50, yPos + 25);
         
      // Collected Box
      doc.rect(215, yPos, boxW, boxH).fill(lightBg).stroke('#e2e8f0');
      doc.fillColor('#64748b').font('Helvetica').fontSize(8).text('TOTAL REVENUE / PAID', 225, yPos + 10);
      doc.fillColor('#15803d').font('Helvetica-Bold').fontSize(11)
         .text(`NGN ${overview.summary.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 225, yPos + 25);
         
      // Outstanding Box
      doc.rect(390, yPos, boxW, boxH).fill(lightBg).stroke('#e2e8f0');
      doc.fillColor('#64748b').font('Helvetica').fontSize(8).text('OUTSTANDING BALANCE', 400, yPos + 10);
      doc.fillColor('#b91c1c').font('Helvetica-Bold').fontSize(11)
         .text(`NGN ${overview.summary.totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 400, yPos + 25);
         
      yPos += boxH + 20;
      
      doc.fillColor(darkColor).font('Helvetica').fontSize(9)
         .text(`Overall Fee Collection Rate: `, 40, yPos, { continued: true })
         .font('Helvetica-Bold').text(`${overview.summary.collectionRate.toFixed(2)}%`);
         
      yPos += 25;
      
      // Outstanding students list table
      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(12).text('Outstanding Student Accounts (Top Balances)', 40, yPos);
      yPos += 18;
      
      // Table Header
      doc.rect(40, yPos, 515, 20).fill(primaryColor);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
         .text('INVOICE NO', 45, yPos + 6)
         .text('STUDENT NAME', 130, yPos + 6)
         .text('TOTAL INVOICED', 300, yPos + 6)
         .text('TOTAL PAID', 380, yPos + 6)
         .text('OUTSTANDING', 460, yPos + 6);
         
      yPos += 20;
      
      // Table Rows
      doc.font('Helvetica').fontSize(8.5).fillColor(darkColor);
      invoices.forEach((inv, index) => {
        if (yPos > 720) {
          doc.addPage();
          yPos = 40;
          
          // Redraw header on new page
          doc.rect(40, yPos, 515, 20).fill(primaryColor);
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
             .text('INVOICE NO', 45, yPos + 6)
             .text('STUDENT NAME', 130, yPos + 6)
             .text('TOTAL INVOICED', 300, yPos + 6)
             .text('TOTAL PAID', 380, yPos + 6)
             .text('OUTSTANDING', 460, yPos + 6);
          yPos += 20;
          doc.font('Helvetica').fontSize(8.5).fillColor(darkColor);
        }
        
        // Alternating bg
        if (index % 2 === 1) {
          doc.rect(40, yPos, 515, 18).fill('#f8fafc');
          doc.fillColor(darkColor);
        }
        
        const name = `${inv.student.firstName} ${inv.student.lastName}`;
        const total = parseFloat(inv.totalAmount.toString()).toLocaleString(undefined, { minimumFractionDigits: 2 });
        const paid = parseFloat(inv.paidAmount.toString()).toLocaleString(undefined, { minimumFractionDigits: 2 });
        const balance = parseFloat(inv.balanceAmount.toString()).toLocaleString(undefined, { minimumFractionDigits: 2 });
        
        doc.text(inv.invoiceNo, 45, yPos + 5)
           .text(name, 130, yPos + 5, { width: 160, ellipsis: true })
           .text(total, 300, yPos + 5)
           .text(paid, 380, yPos + 5)
           .fillColor(parseFloat(inv.balanceAmount.toString()) > 0 ? '#b91c1c' : darkColor)
           .text(balance, 460, yPos + 5)
           .fillColor(darkColor);
           
        yPos += 18;
      });
      
      // Footer
      const pageCount = doc.bufferedPageRange().count;
      for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(i);
        doc.moveTo(40, 755).lineTo(555, 755).stroke('#cbd5e1');
        doc.fillColor('#64748b').font('Helvetica').fontSize(7.5)
           .text('Ugbekun 2.0 Consolidated Financial Audit System', 40, 765)
           .text(`Page ${i + 1} of ${pageCount}`, 40, 765, { align: 'right', width: 515 });
      }
      
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateInvoice,
  recordPayment,
  getFinancialOverview,
  exportFinancialReportCsv,
  exportFinancialReportPdf
};
