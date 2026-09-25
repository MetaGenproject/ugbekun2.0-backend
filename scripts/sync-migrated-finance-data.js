#!/usr/bin/env node
/**
 * Finance Ingestion & Synchronization Script
 * Resolves student enrollments for fee_allocation, syncs all invoices, invoice items,
 * fee_payments, derives fee_groups classIds, and generates fee_assignments.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const { mapRows, parseDate } = require('../dist/lib/parseMysqlInsert');

const sqlFileCandidates = [
  path.resolve(__dirname, '../../../database /ugbekunc_Saas_23rd_sept_2026.sql (1)'),
  path.resolve(__dirname, '../../database /ugbekunc_Saas_23rd_sept_2026.sql (1)'),
  path.resolve(__dirname, '../../../database/ugbekunc_Saas_23rd_sept_2026.sql (1)'),
];

let sqlFile = null;
for (const cand of sqlFileCandidates) {
  if (fs.existsSync(cand)) {
    sqlFile = cand;
    break;
  }
}

if (!sqlFile) {
  console.error('SQL dump file not found!');
  process.exit(1);
}

console.log('Using SQL Dump:', sqlFile);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const BATCH = 300;

async function batchCreate(model, rows, label) {
  if (!rows || !rows.length) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const result = await prisma[model].createMany({ data: chunk, skipDuplicates: true });
    inserted += result.count;
    process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length} processed (newly created: ${inserted})`);
  }
  process.stdout.write('\n');
  return inserted;
}

async function main() {
  const sql = fs.readFileSync(sqlFile, 'utf8');

  console.log('-> Fetching valid branches, students and fee types from database...');
  const [branches, students, existingFeeTypes, existingClasses] = await Promise.all([
    prisma.branch.findMany({ select: { id: true } }),
    prisma.student.findMany({ select: { id: true, branchId: true } }),
    prisma.feeType.findMany({ select: { id: true, name: true, branchId: true } }),
    prisma.class.findMany({ select: { id: true, branchId: true } }),
  ]);

  const branchIds = new Set(branches.map(b => b.id));
  const validStudentIds = new Set(students.map(s => s.id));
  const validFeeTypeIds = new Set(existingFeeTypes.map(f => f.id));
  const feeTypeNameById = new Map(existingFeeTypes.map(f => [f.id, f.name]));
  const validClassIds = new Set(existingClasses.map(c => c.id));

  // Enroll map to resolve student_id from enroll.id
  console.log('-> Parsing Enroll records...');
  const rawEnroll = mapRows(sql, 'enroll', ['id', 'student_id', 'class_id', 'section_id', 'session_id', 'branch_id']);
  const enrollStudentMap = new Map();
  const enrollClassMap = new Map();
  for (const e of rawEnroll) {
    const eid = Number(e.id);
    const sid = Number(e.student_id);
    const cid = Number(e.class_id);
    enrollStudentMap.set(eid, sid);
    enrollClassMap.set(eid, cid);
  }

  // Derive class allocations for fee groups from fee_allocation
  console.log('-> Deriving class allocations for Fee Groups...');
  const rawAlloc = mapRows(sql, 'fee_allocation', ['id', 'student_id', 'group_id', 'branch_id', 'session_id', 'prev_due', 'created_at']);
  const groupClassesMap = new Map();
  for (const fa of rawAlloc) {
    const rawSid = Number(fa.student_id);
    const gid = Number(fa.group_id);
    const cid = enrollClassMap.get(rawSid);
    if (cid && validClassIds.has(cid)) {
      if (!groupClassesMap.has(gid)) groupClassesMap.set(gid, new Set());
      groupClassesMap.get(gid).add(cid);
    }
  }

  // Update Fee Groups with derived class IDs
  console.log('-> Updating Fee Groups with linked class IDs...');
  const dbFeeGroups = await prisma.feeGroup.findMany();
  let updatedGroupsCount = 0;
  for (const fg of dbFeeGroups) {
    const derivedClasses = groupClassesMap.get(fg.id);
    if (derivedClasses && derivedClasses.size > 0) {
      const classIdsArr = Array.from(derivedClasses);
      await prisma.feeGroup.update({
        where: { id: fg.id },
        data: { classIds: JSON.stringify(classIdsArr) },
      });
      updatedGroupsCount++;
    }
  }
  console.log(`  Updated ${updatedGroupsCount} Fee Groups with active class links.`);

  // Fee Group Details
  const rawFeeGroupDetails = mapRows(sql, 'fee_groups_details', ['id', 'fee_groups_id', 'fee_type_id', 'amount', 'due_date', 'created_at']);
  const feeGroupDetailsByGroupId = new Map();
  for (const fgd of rawFeeGroupDetails) {
    const gid = Number(fgd.fee_groups_id);
    if (!feeGroupDetailsByGroupId.has(gid)) feeGroupDetailsByGroupId.set(gid, []);
    feeGroupDetailsByGroupId.get(gid).push(fgd);
  }

  const rawFeeGroups = mapRows(sql, 'fee_groups', ['id', 'name', 'description', 'session_id', 'system', 'branch_id', 'created_at']);
  const feeGroupNameById = new Map(rawFeeGroups.map(g => [Number(g.id), g.name]));

  // Payments map
  const rawFeePayments = mapRows(sql, 'fee_payment_history', [
    'id', 'allocation_id', 'type_id', 'transport_fee_details_id', 'collect_by', 'amount', 'discount', 'fine', 'pay_via', 'remarks', 'date'
  ]);
  const paymentsByAllocId = new Map();
  for (const p of rawFeePayments) {
    const aid = Number(p.allocation_id);
    if (!paymentsByAllocId.has(aid)) paymentsByAllocId.set(aid, []);
    paymentsByAllocId.get(aid).push(p);
  }

  // Prepare Invoices and Invoice Items
  console.log('-> Resolving and compiling invoices...');
  const invoiceRows = [];
  const invoiceItemRows = [];
  const validInvoiceIds = new Set();
  const invoiceBranchMap = new Map();

  for (const fa of rawAlloc) {
    const bId = Number(fa.branch_id);
    if (!branchIds.has(bId)) continue;

    const rawSid = Number(fa.student_id);
    const resolvedSid = validStudentIds.has(rawSid) ? rawSid : enrollStudentMap.get(rawSid);
    if (!resolvedSid || !validStudentIds.has(resolvedSid)) continue;

    const allocId = Number(fa.id);
    const gid = Number(fa.group_id);
    const gDetails = feeGroupDetailsByGroupId.get(gid) || [];
    const groupTotal = gDetails.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
    const prevDue = Number(fa.prev_due) || 0;
    const totalAmount = Math.max(0, groupTotal + prevDue);

    const allocPayments = paymentsByAllocId.get(allocId) || [];
    const paidAmount = allocPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const balanceAmount = Math.max(0, totalAmount - paidAmount);
    const status = paidAmount >= totalAmount && totalAmount > 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'unpaid');

    invoiceRows.push({
      id: allocId,
      invoiceNo: `INV-${String(allocId).padStart(6, '0')}`,
      termLabel: feeGroupNameById.get(gid) || 'Term Fee',
      totalAmount,
      paidAmount,
      balanceAmount,
      status,
      dueDate: gDetails[0]?.due_date ? parseDate(gDetails[0].due_date) : null,
      issuedAt: parseDate(fa.created_at) || new Date(),
      createdAt: parseDate(fa.created_at) || new Date(),
      updatedAt: null,
      studentId: resolvedSid,
      branchId: bId,
      sessionId: Number(fa.session_id) || 4,
    });
    validInvoiceIds.add(allocId);
    invoiceBranchMap.set(allocId, bId);

    for (const d of gDetails) {
      const ftId = Number(d.fee_type_id);
      if (!validFeeTypeIds.has(ftId)) continue;
      invoiceItemRows.push({
        invoiceId: allocId,
        feeTypeId: ftId,
        description: feeTypeNameById.get(ftId) || 'Fee Item',
        amount: Number(d.amount) || 0,
        createdAt: parseDate(d.created_at) || new Date(),
      });
    }
  }

  console.log(`Total valid invoices to sync: ${invoiceRows.length}`);
  const createdInvoices = await batchCreate('invoice', invoiceRows, 'Invoices');

  console.log(`Total invoice items to sync: ${invoiceItemRows.length}`);
  const createdItems = await batchCreate('invoiceItem', invoiceItemRows, 'Invoice Items');

  // Payments
  console.log('-> Compiling payments...');
  const paymentRows = [];
  for (const p of rawFeePayments) {
    const aid = Number(p.allocation_id);
    if (!validInvoiceIds.has(aid)) continue;
    const amt = Math.abs(Number(p.amount) || 0);
    if (amt === 0) continue;
    const method = p.pay_via === '15' ? 'pos' : (p.pay_via === '1' ? 'cash' : 'bank_transfer');
    paymentRows.push({
      id: Number(p.id),
      invoiceId: aid,
      branchId: invoiceBranchMap.get(aid),
      amount: amt,
      method,
      reference: p.remarks ? String(p.remarks).slice(0, 100) : null,
      receivedBy: Number(p.collect_by) || null,
      notes: p.remarks || null,
      paidAt: parseDate(p.date) || new Date(),
      createdAt: parseDate(p.date) || new Date(),
    });
  }

  console.log(`Total payments to sync: ${paymentRows.length}`);
  const createdPayments = await batchCreate('payment', paymentRows, 'Payments');

  // Fee Assignments (for the Fee Types / Fee Assignments matrix)
  console.log('-> Building Fee Assignments from Fee Groups & Classes...');
  const feeAssignmentRows = [];
  for (const fg of dbFeeGroups) {
    const typeIds = typeof fg.feeTypeIds === 'string' ? JSON.parse(fg.feeTypeIds || '[]') : (fg.feeTypeIds || []);
    const derivedClasses = groupClassesMap.get(fg.id);
    const classIdsArr = derivedClasses ? Array.from(derivedClasses) : [];

    for (const cId of classIdsArr) {
      for (const tId of typeIds) {
        if (!validFeeTypeIds.has(tId) || !validClassIds.has(cId)) continue;
        feeAssignmentRows.push({
          feeTypeId: tId,
          branchId: fg.branchId,
          classId: cId,
          sessionId: 4,
          active: true,
          isOptional: false,
          createdAt: fg.createdAt || new Date(),
        });
      }
    }
  }

  console.log(`Total Fee Assignments to create: ${feeAssignmentRows.length}`);
  const createdAssignments = await batchCreate('feeAssignment', feeAssignmentRows, 'Fee Assignments');

  // Reset Sequences
  console.log('-> Resetting PostgreSQL Sequences...');
  await pool.query(`
    SELECT setval('invoices_id_seq', COALESCE((SELECT MAX(id) FROM invoices), 1), true);
    SELECT setval('invoice_items_id_seq', COALESCE((SELECT MAX(id) FROM invoice_items), 1), true);
    SELECT setval('payments_id_seq', COALESCE((SELECT MAX(id) FROM payments), 1), true);
    SELECT setval('fee_assignments_id_seq', COALESCE((SELECT MAX(id) FROM fee_assignments), 1), true);
  `);
  console.log('  Sequences reset successfully.');

  console.log('\n======================================================');
  console.log(`SUCCESS:`);
  console.log(`- Invoices Synced: ${invoiceRows.length} (New: ${createdInvoices})`);
  console.log(`- Invoice Items Synced: ${invoiceItemRows.length} (New: ${createdItems})`);
  console.log(`- Payments Synced: ${paymentRows.length} (New: ${createdPayments})`);
  console.log(`- Fee Assignments Created: ${feeAssignmentRows.length} (New: ${createdAssignments})`);
  console.log('======================================================\n');

  await pool.end();
}

main().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
