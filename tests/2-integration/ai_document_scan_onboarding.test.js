const assert = require('node:assert/strict');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

function createMockRegistrationFormPdf(formDetails) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.fontSize(18).text('UGBEKUN MODEL ACADEMY', { align: 'center', underline: true });
    doc.moveDown(0.5);
    doc.fontSize(14).text('STUDENT ADMISSION & REGISTRATION FORM', { align: 'center' });
    doc.moveDown(1);

    doc.fontSize(11).text(`Student Name: ${formDetails.studentName}`);
    doc.text(`Date of Birth: ${formDetails.dob}`);
    doc.text(`Gender: ${formDetails.gender}`);
    doc.text(`Blood Group: ${formDetails.bloodGroup}`);
    doc.text(`Religion: ${formDetails.religion}`);
    doc.text(`Target Class: ${formDetails.targetClass}`);
    doc.text(`Home Address: ${formDetails.homeAddress}`);
    doc.text(`Previous School / Historical Performance: ${formDetails.history}`);
    doc.moveDown(1);

    doc.fontSize(12).text('PARENT / GUARDIAN CONTACT DETAILS', { underline: true });
    doc.fontSize(11).text(`Parent Name: ${formDetails.parentName}`);
    doc.text(`Relationship: ${formDetails.parentRelation}`);
    doc.text(`Parent Mobile Phone: ${formDetails.parentPhone}`);
    doc.text(`Parent Email: ${formDetails.parentEmail}`);
    doc.text(`Occupation: ${formDetails.parentOccupation}`);

    doc.end();
  });
}

async function testAiDocumentScanOnboarding() {
  console.log('\n--- [INTEGRATION TEST] AI-Assisted Document Scanning & Physical Form Onboarding ---');

  const timestamp = Date.now();

  // 1. Provision an isolated school branch
  console.log('1. Setting up clean test school branch...');
  const schoolPayload = {
    planSlug: 'starter',
    schoolName: `Crown Heights Academy ${timestamp}`,
    schoolAddress: '10 Victoria Garden City, Lekki, Lagos',
    adminName: 'Dr. Stella Maris',
    contactNumber: '+2348022114455',
    contactEmail: `stella_${timestamp}@crownheights.edu.ng`,
    username: `admin_crown_${timestamp}`,
    password: 'SecureAdminPassword123!',
    confirmPassword: 'SecureAdminPassword123!',
    termsAccepted: true,
  };

  const regRes = await fetch(`${BASE_URL}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schoolPayload),
  });
  if (regRes.status !== 201) {
    const errText = await regRes.text();
    console.error('School registration failed:', regRes.status, errText);
  }
  assert.equal(regRes.status, 201, `School registration should succeed (got ${regRes.status})`);
  const regData = await regRes.json();
  const adminToken = regData.token;
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };

  const clsRes = await fetch(`${BASE_URL}/admin/classes-sections`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const clsData = await clsRes.json();
  const primaryClass = clsData.classes.find(c => c.name.includes('Primary 2')) || clsData.classes[0];
  const sectionObj = primaryClass.sections[0]?.section || clsData.sections[0];
  console.log(`✓ School branch ready (Class: ${primaryClass.name}, Section: ${sectionObj.name})`);

  // 2. Generate and upload Mock Physical Registration Form 1 (PDF)
  console.log('\n2. Scanning Physical Admission Form 1 (Kamsiyochukwu Okonkwo)...');
  const parentPhone = `+23480${Math.floor(10000000 + Math.random() * 90000000)}`;
  const parentEmail = `okonkwo_${timestamp}@lawfirm.ng`;
  const parentName = 'Barrister Emeka Okonkwo';

  const pdfBuffer1 = await createMockRegistrationFormPdf({
    studentName: 'Kamsiyochukwu Okonkwo',
    dob: '2016-08-14',
    gender: 'Male',
    bloodGroup: 'B+',
    religion: 'Christianity',
    targetClass: primaryClass.name,
    homeAddress: '14 Victoria Island, Lagos',
    history: 'Greenfield Primary Grade 1 - 92% aggregate average, exemplary character.',
    parentName,
    parentRelation: 'Father',
    parentPhone,
    parentEmail,
    parentOccupation: 'Senior Legal Counsel',
  });

  const blob1 = new Blob([pdfBuffer1], { type: 'application/pdf' });
  const formData1 = new FormData();
  formData1.append('file', blob1, 'registration_form_kamsi.pdf');

  const parseRes1 = await fetch(`${BASE_URL}/admin/students/parse-document`, {
    method: 'POST',
    headers: adminHeaders,
    body: formData1,
  });
  assert.equal(parseRes1.status, 200, `AI document parsing should succeed (got ${parseRes1.status})`);
  const parseData1 = await parseRes1.json();
  assert.equal(parseData1.success, true);
  assert.ok(parseData1.extractedData, 'Must return extracted data');
  assert.ok(parseData1.documentPreview?.dataUrl, 'Must return document preview data URL');

  console.log(`✓ AI Extraction succeeded:`);
  console.log(`  - Student: ${parseData1.extractedData.firstName} ${parseData1.extractedData.lastName}`);
  console.log(`  - DOB: ${parseData1.extractedData.birthday}`);
  console.log(`  - Parent: ${parseData1.extractedData.parentName} (${parseData1.extractedData.parentPhone})`);

  // 3. Confirm and Enroll Student 1 from Extracted Data
  console.log('\n3. Admin verifies, corrects, and confirms Student 1 enrollment...');
  const student1Payload = {
    firstName: parseData1.extractedData.firstName || 'Kamsiyochukwu',
    lastName: parseData1.extractedData.lastName || 'Okonkwo',
    gender: parseData1.extractedData.gender || 'Male',
    birthday: parseData1.extractedData.birthday || '2016-08-14',
    classId: primaryClass.id,
    sectionId: sectionObj.id,
    bloodGroup: parseData1.extractedData.bloodGroup || 'B+',
    religion: parseData1.extractedData.religion || 'Christianity',
    currentAddress: parseData1.extractedData.homeAddress || '14 Victoria Island, Lagos',
    parentName,
    parentPhone,
    parentEmail,
    parentRelation: 'Father',
    birthCertificate: parseData1.documentPreview.dataUrl, // Retains scanned form as archive
  };

  const onboardRes1 = await fetch(`${BASE_URL}/admin/students/onboard`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(student1Payload),
  });
  assert.equal(onboardRes1.status, 201, `Student 1 onboarding should succeed (got ${onboardRes1.status})`);
  const onboardData1 = await onboardRes1.json();
  assert.equal(onboardData1.success, true);
  assert.equal(onboardData1.isExistingParent, false);
  const student1Id = onboardData1.data.student.id;
  const parent1Id = onboardData1.data.parent.id;
  console.log(`✓ Student 1 enrolled into database (Student ID: ${student1Id}, Parent ID: ${parent1Id})`);

  // 4. Scan Sibling's Physical Form (Chisom Okonkwo) & Verify Automatic Parent Matching
  console.log('\n4. Scanning Physical Form 2 for Sibling (Chisom Okonkwo) with matching parent phone...');
  const pdfBuffer2 = await createMockRegistrationFormPdf({
    studentName: 'Chisom Okonkwo',
    dob: '2018-11-25',
    gender: 'Female',
    bloodGroup: 'B+',
    religion: 'Christianity',
    targetClass: primaryClass.name,
    homeAddress: '14 Victoria Island, Lagos',
    history: 'Early years Montessori Nursery 2 graduate.',
    parentName,
    parentRelation: 'Father',
    parentPhone,
    parentEmail,
    parentOccupation: 'Senior Legal Counsel',
  });

  const blob2 = new Blob([pdfBuffer2], { type: 'application/pdf' });
  const formData2 = new FormData();
  formData2.append('file', blob2, 'registration_form_chisom.pdf');

  const parseRes2 = await fetch(`${BASE_URL}/admin/students/parse-document`, {
    method: 'POST',
    headers: adminHeaders,
    body: formData2,
  });
  assert.equal(parseRes2.status, 200);
  const parseData2 = await parseRes2.json();
  assert.equal(parseData2.success, true);
  assert.ok(parseData2.matchedExistingParent, 'Backend OCR pipeline MUST auto-detect existing parent from phone/email');
  assert.equal(parseData2.matchedExistingParent.id, parent1Id, 'Matched parent ID must equal parent 1 ID');
  assert.equal(parseData2.matchedExistingParent.enrolledChildrenCount, 1, 'Should indicate 1 already enrolled sibling');
  console.log(`✓ Existing Parent Auto-Detected during OCR scan! Linked to Parent: "${parseData2.matchedExistingParent.name}" (1 child enrolled)`);

  // 5. Admin Confirms Sibling Admission (Reusing Existing Parent Account)
  console.log('\n5. Admin confirms Sibling 2 admission with Existing Parent Protection...');
  const student2Payload = {
    firstName: parseData2.extractedData.firstName || 'Chisom',
    lastName: parseData2.extractedData.lastName || 'Okonkwo',
    gender: parseData2.extractedData.gender || 'Female',
    birthday: parseData2.extractedData.birthday || '2018-11-25',
    classId: primaryClass.id,
    sectionId: sectionObj.id,
    bloodGroup: 'B+',
    religion: 'Christianity',
    existingParentId: parseData2.matchedExistingParent.id,
    parentName,
    parentPhone,
    parentEmail,
    parentRelation: 'Father',
    birthCertificate: parseData2.documentPreview.dataUrl,
  };

  const onboardRes2 = await fetch(`${BASE_URL}/admin/students/onboard`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(student2Payload),
  });
  assert.equal(onboardRes2.status, 201);
  const onboardData2 = await onboardRes2.json();
  assert.equal(onboardData2.success, true);
  assert.equal(onboardData2.isExistingParent, true, 'isExistingParent must be true');
  assert.equal(onboardData2.data.parent.id, parent1Id, 'Student 2 must link to existing parent');
  assert.equal(onboardData2.credentials.parent, null, 'Duplicate parent credentials MUST NOT be generated');
  console.log(`✓ Sibling 2 successfully admitted and linked without creating duplicate accounts!`);

  console.log('\n🎉 ALL AI-ASSISTED DOCUMENT SCANNING & ONBOARDING TESTS PASSED PERFECTLY!\n');
}

testAiDocumentScanOnboarding().catch((err) => {
  console.error('\n❌ AI Document Scan Onboarding Test FAILED:', err);
  process.exit(1);
});
