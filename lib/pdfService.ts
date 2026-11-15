import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { generateQrBuffer, buildVerificationUrl } from './qrService';
import { calculateGradeFromRanges } from './gradingService';

/**
 * PDF Service
 *
 * Generates beautifully formatted, printable PDF credential slips
 * for newly onboarded students and parents.
 */

/**
 * Generates a credential slip PDF as a Buffer.
 *
 * @param {object} params
 * @param {string} params.schoolName - Name of the school branch
 * @param {string} params.branchCode - Code of the school branch
 * @param {string} params.studentName - Full name of the student
 * @param {string} params.registerNo - Student registration number
 * @param {string} params.studentUsername - Student portal username
 * @param {string} params.studentPassword - Student portal plaintext password
 * @param {string} [params.parentName] - Full name of the parent
 * @param {string} [params.parentUsername] - Parent portal username (null if existing)
 * @param {string} [params.parentPassword] - Parent portal plaintext password (null if existing)
 * @param {boolean} [params.isExistingParent] - Whether the parent already had an account
 * @param {string} [params.loginUrl] - Portal login URL
 * @returns {Promise<Buffer>} Resolves to PDF file buffer
 */
function generateCredentialSlipPdf(params) {
  return new Promise((resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun School',
        branchCode = '',
        studentName,
        registerNo = '',
        studentUsername,
        studentPassword,
        parentName = '',
        parentUsername = null,
        parentPassword = null,
        isExistingParent = false,
        loginUrl = 'http://localhost:3000',
      } = params

      // Create a letter/A4 sized document with margins
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Credential Slip - ${studentName}`,
          Author: 'Ugbekun Schools Platform',
        },
      })

      const chunks = []
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // Theme Colors
      const primaryColor = '#1b5e20'   // Forest Green
      const secondaryColor = '#2e7d32' // Medium Green
      const darkColor = '#212121'      // Charcoal
      const lightBg = '#f5f5f5'        // Soft grey
      const alertBg = '#fff8e1'        // Soft yellow/amber
      const alertBorder = '#f9a825'    // Yellow/amber border
      const textMuted = '#666666'

      // ─── Header ──────────────────────────────────────────────────────────
      doc.rect(40, 40, 515, 65).fill(primaryColor)

      doc.fillColor('#ffffff')
         .font('Helvetica-Bold')
         .fontSize(18)
         .text(schoolName.toUpperCase(), 55, 52, { width: 485, align: 'left' })

      doc.font('Helvetica')
         .fontSize(10)
         .fillColor('#e8f5e9')
         .text(`PORTAL ACCESS SLIP ${branchCode ? `• BRANCH CODE: ${branchCode}` : ''}`, 55, 78)

      doc.font('Helvetica')
         .fontSize(8)
         .text(`Date Issued: ${new Date().toLocaleDateString()}`, 55, 90, { align: 'right', width: 485 })

      let yPos = 125

      // ─── Student Information ─────────────────────────────────────────────
      doc.fillColor(darkColor)
         .font('Helvetica-Bold')
         .fontSize(12)
         .text('Student Profile Details:', 40, yPos)
      yPos += 18

      doc.font('Helvetica')
         .fontSize(10)
         .fillColor(darkColor)
         .text(`Name: `, 40, yPos, { continued: true })
         .font('Helvetica-Bold')
         .text(studentName)

      doc.font('Helvetica')
         .text(`Registration No: `, 300, yPos, { continued: true })
         .font('Helvetica-Bold')
         .text(registerNo || 'Pending')
      yPos += 22

      // ─── Student Credentials Card ────────────────────────────────────────
      doc.rect(40, yPos, 515, 75).fill(lightBg)

      // Green left border accent
      doc.rect(40, yPos, 4, 75).fill(primaryColor)

      doc.fillColor(primaryColor)
         .font('Helvetica-Bold')
         .fontSize(10)
         .text('STUDENT PORTAL LOGIN CREDENTIALS', 55, yPos + 10)

      doc.fillColor(darkColor)
         .font('Helvetica')
         .text('Username:', 55, yPos + 30, { width: 100 })
         .font('Courier-Bold')
         .fontSize(11)
         .text(studentUsername, 130, yPos + 30)

      doc.fillColor(darkColor)
         .font('Helvetica')
         .fontSize(10)
         .text('Password:', 55, yPos + 50, { width: 100 })
         .font('Courier-Bold')
         .fontSize(11)
         .text(studentPassword, 130, yPos + 50)

      yPos += 90

      // ─── Parent Information & Credentials ────────────────────────────────
      if (parentName) {
        doc.fillColor(darkColor)
           .font('Helvetica-Bold')
           .fontSize(12)
           .text('Parent Profile Details:', 40, yPos)
        yPos += 18

        doc.font('Helvetica')
           .fontSize(10)
           .fillColor(darkColor)
           .text(`Parent/Guardian Name: `, 40, yPos, { continued: true })
           .font('Helvetica-Bold')
           .text(parentName)
        yPos += 22

        if (!isExistingParent && parentUsername && parentPassword) {
          doc.rect(40, yPos, 515, 75).fill(lightBg)
          doc.rect(40, yPos, 4, 75).fill(secondaryColor)

          doc.fillColor(secondaryColor)
             .font('Helvetica-Bold')
             .fontSize(10)
             .text('PARENT PORTAL LOGIN CREDENTIALS', 55, yPos + 10)

          doc.fillColor(darkColor)
             .font('Helvetica')
             .text('Username:', 55, yPos + 30, { width: 100 })
             .font('Courier-Bold')
             .fontSize(11)
             .text(parentUsername, 130, yPos + 30)

          doc.fillColor(darkColor)
             .font('Helvetica')
             .fontSize(10)
             .text('Password:', 55, yPos + 50, { width: 100 })
             .font('Courier-Bold')
             .fontSize(11)
             .text(parentPassword, 130, yPos + 50)

          yPos += 90
        } else {
          // Existing parent message
          doc.rect(40, yPos, 515, 40).fill(lightBg)
          doc.rect(40, yPos, 4, 40).fill(textMuted)

          doc.fillColor(darkColor)
             .font('Helvetica-Bold')
             .fontSize(9)
             .text('PARENT PORTAL ACCESS', 55, yPos + 8)
             .font('Helvetica')
             .fontSize(9)
             .fillColor(textMuted)
             .text('An existing parent account was detected. Please use your existing login credentials.', 55, yPos + 22)

          yPos += 55
        }
      }

      // ─── Login Instructions & Security Alert ─────────────────────────────
      doc.rect(40, yPos, 515, 50).fill(alertBg)
      doc.rect(40, yPos, 4, 50).fill(alertBorder)

      doc.fillColor('#795600')
         .font('Helvetica-Bold')
         .fontSize(9)
         .text('⚠️ SECURITY WARNING & REQUIREMENT', 55, yPos + 10)
         .font('Helvetica')
         .fontSize(8.5)
         .text('Please change these passwords immediately upon logging in for the first time.', 55, yPos + 24)
         .text('Do not share login credentials with anyone. Keep this slip secure.', 55, yPos + 35)

      yPos += 65

      // ─── Action Steps ───────────────────────────────────────────────────
      doc.fillColor(darkColor)
         .font('Helvetica-Bold')
         .fontSize(10)
         .text('How to access the Portal:', 40, yPos)
      yPos += 15

      doc.font('Helvetica')
         .fontSize(9)
         .fillColor(darkColor)
         .text(`1. Open your web browser and navigate to: `, 40, yPos, { continued: true })
         .fillColor(primaryColor)
         .font('Helvetica-Bold')
         .text(loginUrl)
      yPos += 14

      doc.fillColor(darkColor)
         .font('Helvetica')
         .text('2. Enter your respective Username and Password generated above.', 40, yPos)
      yPos += 14

      doc.text('3. If you encounter issues, please contact the admin team at your school branch.', 40, yPos)

      // ─── Footer ──────────────────────────────────────────────────────────
      doc.moveTo(40, 750)
         .lineTo(555, 750)
         .stroke('#e0e0e0')

      doc.fillColor(textMuted)
         .font('Helvetica')
         .fontSize(8)
         .text('This is an automated system credential slip generated by Ugbekun Schools Platform.', 40, 760, { align: 'center', width: 515 })
         .text(`© ${new Date().getFullYear()} Ugbekun. All rights reserved.`, 40, 770, { align: 'center', width: 515 })

      // Finalize the PDF document
      doc.end()

    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Generates a Class-by-Class Batch Credential Slips PDF as a Buffer.
 * Contains printable student & parent credential slips with cut-out dashed lines.
 *
 * @param {object} params
 * @param {string} params.schoolName - Name of the school branch
 * @param {string} params.branchCode - Branch Code
 * @param {string} params.className - Name of the class
 * @param {string} [params.sectionName] - Name of the section
 * @param {Array<object>} params.slips - List of student credential slip data
 * @returns {Promise<Buffer>}
 */
function generateBatchClassCredentialSlipsPdf(params) {
  return new Promise((resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun School',
        branchCode = '',
        className = 'Classroom',
        sectionName = '',
        slips = [],
        loginUrl = 'http://localhost:3000',
      } = params

      const doc = new PDFDocument({
        size: 'A4',
        margin: 35,
        info: {
          Title: `Batch Login Slips - ${className} ${sectionName}`,
          Author: 'Ugbekun Schools Platform',
        },
      })

      const chunks = []
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      const primaryColor = '#003da5'
      const darkColor = '#1e293b'
      const lightBg = '#f8fafc'
      const borderLine = '#cbd5e1'
      const mutedText = '#64748b'

      if (slips.length === 0) {
        doc.fontSize(16).fillColor(darkColor).text('No student credential records found for this class selection.', 50, 100)
        doc.end()
        return
      }

      slips.forEach((slip, idx) => {
        if (idx > 0) {
          doc.addPage()
        }

        // Header Banner
        doc.rect(35, 35, 525, 55).fill(primaryColor)
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text(schoolName.toUpperCase(), 50, 47)
        doc.font('Helvetica').fontSize(9).fillColor('#e2e8f0').text(`CLASSROOM BATCH LOGIN SLIP • CLASS: ${className} ${sectionName ? `(${sectionName})` : ''} ${branchCode ? `• BRANCH: ${branchCode}` : ''}`, 50, 68)

        let yPos = 105

        // Student Profile Header
        doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(12).text(`Student: ${slip.studentName}`, 35, yPos)
        doc.font('Helvetica').fontSize(10).text(`Reg No: ${slip.registerNo || 'N/A'}`, 380, yPos, { align: 'right', width: 180 })
        yPos += 20

        // Student Login Details Box
        doc.rect(35, yPos, 525, 65).fill(lightBg)
        doc.rect(35, yPos, 4, 65).fill(primaryColor)

        doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(10).text('STUDENT PORTAL LOGIN CREDENTIALS', 50, yPos + 10)
        doc.fillColor(darkColor).font('Helvetica').fontSize(9).text('Username:', 50, yPos + 28)
        doc.font('Courier-Bold').fontSize(11).text(slip.studentUsername || 'N/A', 120, yPos + 27)

        doc.fillColor(darkColor).font('Helvetica').fontSize(9).text('Password:', 50, yPos + 46)
        doc.font('Courier-Bold').fontSize(11).text(slip.studentPassword || 'Pass@123', 120, yPos + 45)

        yPos += 80

        // Parent Login Details Box
        if (slip.parentName) {
          doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(11).text(`Parent/Guardian: ${slip.parentName} (${slip.parentRelation || 'Parent'})`, 35, yPos)
          yPos += 18

          doc.rect(35, yPos, 525, 60).fill('#f1f5f9')
          doc.rect(35, yPos, 4, 60).fill('#475569')

          if (!slip.isExistingParent && slip.parentUsername) {
            doc.fillColor('#334155').font('Helvetica-Bold').fontSize(9.5).text('PARENT PORTAL LOGIN CREDENTIALS', 50, yPos + 8)
            doc.fillColor(darkColor).font('Helvetica').fontSize(9).text('Username:', 50, yPos + 24)
            doc.font('Courier-Bold').fontSize(10.5).text(slip.parentUsername, 120, yPos + 23)

            doc.fillColor(darkColor).font('Helvetica').fontSize(9).text('Password:', 50, yPos + 40)
            doc.font('Courier-Bold').fontSize(10.5).text(slip.parentPassword || 'Pass@123', 120, yPos + 39)
          } else {
            doc.fillColor('#334155').font('Helvetica-Bold').fontSize(9.5).text('PARENT PORTAL ACCESS', 50, yPos + 12)
            doc.fillColor(mutedText).font('Helvetica').fontSize(9).text('Existing parent profile linked. Log in with your existing parent credentials.', 50, yPos + 30)
          }
          yPos += 75
        }

        // Security Notice & Instructions
doc.rect(35, yPos, 525, 45).fill('#fffbeeb0')
        doc.rect(35, yPos, 4, 45).fill('#d97706')

        doc.fillColor('#92400e').font('Helvetica-Bold').fontSize(8.5).text('SECURITY NOTICE & INSTRUCTIONS:', 48, yPos + 8)
        doc.font('Helvetica').fontSize(8).fillColor('#78350f')
           .text(`1. Access Portal at ${loginUrl}   2. Sign in with the respective credentials above.   3. Change default password on first login.`, 48, yPos + 24)

        yPos += 60

        // Printable Cut-Out Line at bottom
        doc.moveTo(35, 780).lineTo(560, 780).dash(4, { space: 4 }).stroke(borderLine).undash()
        doc.fillColor(mutedText).font('Helvetica').fontSize(7.5).text('✂ - - - - - - - - - - - - - - - - - - - - - - - - - - - CUT HERE - - - - - - - - - - - - - - - - - - - - - - - - - - ✂', 35, 785, { align: 'center', width: 525 })
      })

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

function getOrdinalSuffix(i) {
  const j = i % 10, k = i % 100;
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}

function sanitizeHexColor(color, fallback = '#1e3a8a') {
  if (!color || typeof color !== 'string') return fallback;
  const trimmed = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed) || /^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

function formatResumptionDisplay(resumptionDate) {
  if (!resumptionDate) return 'To Be Announced';
  if (resumptionDate instanceof Date) {
    if (Number.isNaN(resumptionDate.getTime())) return 'To Be Announced';
    return resumptionDate.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  const raw = String(resumptionDate).trim();
  if (!raw || raw === 'To Be Announced') return 'To Be Announced';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
    }
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime()) && raw.includes('-') && raw.length >= 8) {
    return parsed.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  return raw;
}

function safeDrawPdfImage(doc, buffer, x, y, options) {
  if (!buffer) return false;
  try {
    doc.image(buffer, x, y, options);
    return true;
  } catch {
    return false;
  }
}

function formatCompactRemark(rawRemark) {
  const str = String(rawRemark || '-').trim();
  if (!str) return '-';
  if (/needs\s*improvement\s*\/\s*fail/i.test(str)) return 'Needs Improvement';
  if (/very\s*good/i.test(str) && str.length > 14) return 'Very Good';
  return str;
}

function deduplicateReportCardSubjects(reportCard, resolvedComponents) {
  if (!Array.isArray(reportCard) || reportCard.length <= 1) return reportCard || [];
  const map = new Map();

  for (const row of reportCard) {
    const key = String(row.subjectId || row.subjectCode || row.subjectName || row.id || '')
      .trim()
      .toUpperCase();
    if (!key) {
      map.set(Symbol(), row);
      continue;
    }

    if (!map.has(key)) {
      map.set(key, {
        ...row,
        componentScores: row.componentScores ? { ...row.componentScores } : {},
      });
    } else {
      const existing = map.get(key);
      const mergedScores = { ...(existing.componentScores || {}) };
      const incomingScores = row.componentScores || {};

      for (const [k, v] of Object.entries(incomingScores)) {
        if (v !== null && v !== undefined && !isNaN(Number(v))) {
          const prev = mergedScores[k];
          if (prev === null || prev === undefined || isNaN(Number(prev)) || Number(v) > Number(prev)) {
            mergedScores[k] = Number(v);
          }
        }
      }

      const prevTotal = parseFloat(String(existing.stageScore ?? existing.mark ?? existing.totalScore ?? 0)) || 0;
      const incomingTotal = parseFloat(String(row.stageScore ?? row.mark ?? row.totalScore ?? 0)) || 0;

      let recomputedTotal = Math.max(prevTotal, incomingTotal);
      if (Array.isArray(resolvedComponents) && resolvedComponents.length > 0) {
        let compSum = 0;
        let foundAny = false;
        for (const comp of resolvedComponents) {
          const cVal = mergedScores[comp.code] ?? mergedScores[comp.key];
          if (cVal !== null && cVal !== undefined && !isNaN(Number(cVal))) {
            compSum += Number(cVal);
            foundAny = true;
          }
        }
        if (foundAny && compSum > recomputedTotal) {
          recomputedTotal = compSum;
        }
      }

      const prevAvg = parseFloat(String(existing.classAverage ?? 0)) || 0;
      const incAvg = parseFloat(String(row.classAverage ?? 0)) || 0;

      map.set(key, {
        ...existing,
        ...(incomingTotal > prevTotal ? row : {}),
        componentScores: mergedScores,
        stageScore: recomputedTotal,
        mark: String(recomputedTotal),
        totalScore: recomputedTotal,
        classAverage: Math.max(prevAvg, incAvg, recomputedTotal),
        absent: Boolean(existing.absent && row.absent && recomputedTotal === 0),
      });
    }
  }

  return Array.from(map.values());
}

function drawBrandedReportHeader(doc, params, colors) {
  const {
    schoolName = 'Ugbekun Schools',
    branchCode = 'GEN',
    tagline = '',
    schoolAddress = '',
    schoolPhone = '',
    schoolEmail = '',
    schoolWebsite = '',
    sessionName = '2025/2026',
    termName = 'First Term',
    reportSubtitle = 'OFFICIAL STUDENT TERMINAL REPORT CARD',
    logoBuffer = null,
  } = params;

  const { primaryColor, secondaryColor } = colors;

  // Institutional A4 Header Banner (Y: 16 to 84, Height: 68pt, X: 24, W: 547)
  const headerY = 16;
  const headerH = 68;
  doc.rect(24, headerY, 547, headerH).fill(primaryColor);
  doc.rect(24, headerY + headerH - 3, 547, 3).fill(secondaryColor);

  // Left: School Logo Box (X: 31, Y: 22, W: 52, H: 52)
  doc.roundedRect(31, 22, 52, 52, 5).fill('#ffffff');
  const drewLogo = safeDrawPdfImage(doc, logoBuffer, 33, 24, {
    fit: [48, 48],
    align: 'center',
    valign: 'center',
  });
  if (!drewLogo) {
    const initials = String(schoolName || 'S')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('');
    doc.fillColor(primaryColor)
       .font('Helvetica-Bold')
       .fontSize(14)
       .text(initials || 'SCH', 31, 41, { width: 52, height: 16, align: 'center', lineBreak: false });
  }

  // Center: School Name, Motto, Address, Contact & Report Subtitle (strictly non-overlapping Y slots)
  const centerX = 91;
  const centerW = 340;

  // Slot 1 (Y: 20): School Name
  doc.fillColor('#ffffff')
     .font('Helvetica-Bold')
     .fontSize(12)
     .text(String(schoolName).toUpperCase(), centerX, 20, {
       width: centerW,
       height: 14,
       align: 'left',
       lineBreak: false,
       ellipsis: true,
     });

  // Slot 2 (Y: 34): Tagline / Motto
  if (tagline) {
    doc.fillColor('#e0f2fe')
       .font('Helvetica-Oblique')
       .fontSize(7.5)
       .text(`"${tagline}"`, centerX, 34, {
         width: centerW,
         height: 10,
         align: 'left',
         lineBreak: false,
         ellipsis: true,
       });
  }

  // Slot 3 (Y: 45): Physical Address
  const contactItems = [];
  if (schoolPhone) contactItems.push(`Tel: ${schoolPhone}`);
  if (schoolEmail) contactItems.push(schoolEmail);
  if (schoolWebsite) contactItems.push(schoolWebsite);
  const contactLine = contactItems.join('  •  ');

  if (schoolAddress && contactLine) {
    doc.fillColor('#f1f5f9')
       .font('Helvetica')
       .fontSize(6.8)
       .text(String(schoolAddress), centerX, 45, {
         width: centerW,
         height: 9,
         align: 'left',
         lineBreak: false,
         ellipsis: true,
       });
    // Slot 4 (Y: 55): Phone / Email / Website on its own dedicated line
    doc.fillColor('#e2e8f0')
       .font('Helvetica')
       .fontSize(6.6)
       .text(contactLine, centerX, 55, {
         width: centerW,
         height: 9,
         align: 'left',
         lineBreak: false,
         ellipsis: true,
       });
  } else if (schoolAddress || contactLine) {
    doc.fillColor('#f1f5f9')
       .font('Helvetica')
       .fontSize(6.8)
       .text(String(schoolAddress || contactLine), centerX, 46, {
         width: centerW,
         height: 9,
         align: 'left',
         lineBreak: false,
         ellipsis: true,
       });
  }

  // Slot 5 (Y: 67): Official Report Subtitle
  doc.fillColor('#ffffff')
     .font('Helvetica-Bold')
     .fontSize(7.3)
     .text(reportSubtitle, centerX, 67, {
       width: centerW,
       height: 10,
       align: 'left',
       lineBreak: false,
       ellipsis: true,
     });

  // Right: Term, Session, Branch & Issue Date Metadata (X: 435, W: 129)
  doc.fillColor('#ffffff')
     .font('Helvetica-Bold')
     .fontSize(8.5)
     .text(String(termName || 'Term Report').toUpperCase(), 435, 22, {
       width: 129,
       height: 11,
       align: 'right',
       lineBreak: false,
       ellipsis: true,
     });

  doc.font('Helvetica')
     .fontSize(7.2)
     .fillColor('#e2e8f0')
     .text(`Session: ${sessionName || 'Active'}`, 435, 36, { width: 129, height: 10, align: 'right', lineBreak: false })
     .text(`Branch: ${branchCode || 'MAIN'}`, 435, 48, { width: 129, height: 10, align: 'right', lineBreak: false })
     .text(`Issued: ${new Date().toLocaleDateString('en-GB')}`, 435, 60, { width: 129, height: 10, align: 'right', lineBreak: false });

  return headerY + headerH;
}

function drawStudentBioWithPhoto(doc, params, y, colors) {
  const {
    studentName = 'Student',
    registerNo = '',
    className = '',
    sectionName = '',
    gender = '',
    birthday = '',
    attendance = null,
    overallAverage = 0,
    gpaRating = '-',
    rankString = '-',
    isProgressSlip = false,
    stage = 'FULL',
    stageLabel = '',
    studentPhotoBuffer = null,
    boxHeight = 62,
  } = params;

  const { primaryColor, secondaryColor, darkColor, textMuted, lightBorder, lightBg } = colors;

  doc.rect(24, y, 547, boxHeight).fill('#ffffff').stroke(lightBorder);
  doc.rect(24, y, 4, boxHeight).fill(secondaryColor);

  // Student Passport Photo Frame on the far right (X: 512, W: 52, H: boxHeight - 10)
  const photoW = 52;
  const photoH = Math.min(52, boxHeight - 10);
  const photoX = 512;
  const photoY = y + Math.floor((boxHeight - photoH) / 2);
  doc.roundedRect(photoX, photoY, photoW, photoH, 4).fill(lightBg).stroke(lightBorder);

  const drewStudentPhoto = safeDrawPdfImage(doc, studentPhotoBuffer, photoX + 2, photoY + 2, {
    fit: [photoW - 4, photoH - 4],
    align: 'center',
    valign: 'center',
  });

  if (!drewStudentPhoto) {
    const initials = String(studentName || 'ST')
      .split(/[\s,]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('');
    doc.fillColor(primaryColor)
       .font('Helvetica-Bold')
       .fontSize(12)
       .text(initials || 'ST', photoX, photoY + 14, { width: photoW, height: 14, align: 'center', lineBreak: false });
    doc.fillColor(textMuted)
       .font('Helvetica')
       .fontSize(5.5)
       .text('PHOTO', photoX, photoY + 31, { width: photoW, height: 8, align: 'center', lineBreak: false });
  }

  const r1 = y + 8;
  const r2 = y + 21.5;
  const r3 = y + 35;
  const r4 = y + 48.5;

  // Column 1 (X: 34 to 275): Name, Admission No, Class & Arm, Gender/DOB
  doc.fillColor(textMuted).font('Helvetica').fontSize(7.4)
     .text('Student Name:', 34, r1, { lineBreak: false })
     .text('Admission No:', 34, r2, { lineBreak: false })
     .text('Class & Arm:', 34, r3, { lineBreak: false })
     .text('Gender / DOB:', 34, r4, { lineBreak: false });

  const dobDisplay = birthday
    ? (() => {
        const d = new Date(birthday);
        return !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-GB') : String(birthday);
      })()
    : 'N/A';
  const genderDisplay = gender ? String(gender).charAt(0).toUpperCase() + String(gender).slice(1).toLowerCase() : 'N/A';

  doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(8.2)
     .text(studentName, 98, r1, { width: 174, height: 11, lineBreak: false, ellipsis: true })
     .text(registerNo || 'Assigned', 98, r2, { width: 174, height: 11, lineBreak: false })
     .text(`${className}${sectionName ? ` (${sectionName})` : ''}`, 98, r3, { width: 174, height: 11, lineBreak: false, ellipsis: true })
     .font('Helvetica').fontSize(7.6)
     .text(`${genderDisplay}  •  ${dobDisplay}`, 98, r4, { width: 174, height: 11, lineBreak: false });

  // Vertical divider between Column 1 and Column 2
  doc.moveTo(278, y + 6).lineTo(278, y + boxHeight - 6).stroke('#e2e8f0');

  // Column 2 (X: 288 to 506): Academic & Attendance Summary
  const attPresent = attendance?.present ?? null;
  const attTotal = attendance?.totalDays ?? null;
  const attText =
    attPresent !== null && attTotal !== null && attTotal > 0
      ? `${attPresent} / ${attTotal} Days (${Math.round((attPresent / attTotal) * 100)}%)`
      : 'Recorded';

  if (isProgressSlip) {
    doc.fillColor(textMuted).font('Helvetica').fontSize(7.4)
       .text('Assessment Stage:', 288, r1, { lineBreak: false })
       .text('Report Status:', 288, r2, { lineBreak: false })
       .text('Attendance:', 288, r3, { lineBreak: false })
       .text('Overall Score:', 288, r4, { lineBreak: false });

    doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(8.2)
       .text(stageLabel || (stage === 'COMBINED_CA' || stage === 'CA_ONLY' ? 'Continuous Assessment' : stage), 366, r1, { width: 140, height: 11, lineBreak: false, ellipsis: true })
       .text('Live Progress Report', 366, r2, { width: 140, height: 11, lineBreak: false })
       .text(attText, 366, r3, { width: 140, height: 11, lineBreak: false })
       .fillColor(primaryColor)
       .text(`${overallAverage}%`, 366, r4, { width: 140, height: 11, lineBreak: false });
  } else {
    doc.fillColor(textMuted).font('Helvetica').fontSize(7.4)
       .text('Overall Average:', 288, r1, { lineBreak: false })
       .text('Final Grade:', 288, r2, { lineBreak: false })
       .text('Class Position:', 288, r3, { lineBreak: false })
       .text('Attendance:', 288, r4, { lineBreak: false });

    doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(8.8)
       .text(`${overallAverage}%`, 364, r1, { width: 142, height: 11, lineBreak: false })
       .fillColor(darkColor).fontSize(8.2)
       .text(gpaRating, 364, r2, { width: 142, height: 11, lineBreak: false, ellipsis: true })
       .text(rankString, 364, r3, { width: 142, height: 11, lineBreak: false })
       .font('Helvetica').fontSize(7.6)
       .text(attText, 364, r4, { width: 142, height: 11, lineBreak: false });
  }

  return y + boxHeight;
}

function resolveTraitRatingMeta(rawVal) {
  const norm = String(rawVal || 'AC').trim().toUpperCase();
  if (norm === 'MS' || norm === '5' || norm === 'A' || norm === 'EXCELLENT' || norm === 'MASTERED') {
    return { code: 'MS', score: 5, label: 'Excellent' };
  }
  if (norm === 'AC' || norm === '4' || norm === 'B' || norm === 'VERY GOOD' || norm === 'ACHIEVED') {
    return { code: 'AC', score: 4, label: 'Very Good' };
  }
  if (norm === 'DV' || norm === '3' || norm === 'C' || norm === 'GOOD' || norm === 'DEVELOPING') {
    return { code: 'DV', score: 3, label: 'Good' };
  }
  if (norm === 'EM' || norm === '2' || norm === 'D' || norm === 'FAIR' || norm === 'EMERGING') {
    return { code: 'EM', score: 2, label: 'Fair' };
  }
  if (norm === 'NT' || norm === '1' || norm === 'E' || norm === 'F' || norm === 'NEEDS HELP') {
    return { code: 'NT', score: 1, label: 'Needs Help' };
  }
  return { code: 'AC', score: 4, label: 'Very Good' };
}

function drawPsychomotorAndAffectiveGrid(doc, params, y, colors, options: any = {}) {
  const { primaryColor, secondaryColor, darkColor, textMuted, lightBorder, lightBg } = colors;
  const psychomotor = params.psychomotor || params.assessment || {};
  const affective = params.affective || params.assessment || {};
  const gradingRanges = Array.isArray(params.gradingRanges) && params.gradingRanges.length > 0
    ? params.gradingRanges
    : [
        { grade: 'A', minPercentage: 70, maxPercentage: 100, remark: 'Excellent' },
        { grade: 'B', minPercentage: 60, maxPercentage: 69, remark: 'Very Good' },
        { grade: 'C', minPercentage: 50, maxPercentage: 59, remark: 'Credit' },
        { grade: 'D', minPercentage: 45, maxPercentage: 49, remark: 'Pass' },
        { grade: 'E', minPercentage: 40, maxPercentage: 44, remark: 'Fair' },
        { grade: 'F', minPercentage: 0, maxPercentage: 39, remark: 'Fail' },
      ];

  const leftX = 24;
  const rightX = 301;
  const tableW = 270;
  const headerH = options.headerH || 15;
  const rowH = options.rowH || 16;
  const legendH = options.legendH || 15;

  // Section 2 Header Title
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(8.5).text(
    '2. PSYCHOMOTOR & AFFECTIVE DOMAIN ASSESSMENT',
    24,
    y,
    { width: 320, height: 11, lineBreak: false }
  );
  doc.fillColor(textMuted).font('Helvetica').fontSize(7).text(
    'Behavioral & Practical Skill Evaluation (Scale 1–5)',
    330,
    y + 1,
    { width: 241, height: 10, align: 'right', lineBreak: false }
  );
  y += 12;

  // Left Table Header: Psychomotor Assessment
  doc.rect(leftX, y, tableW, headerH).fill(primaryColor);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
     .text('PSYCHOMOTOR SKILLS ASSESSMENT', leftX + 6, y + (headerH - 7) / 2, { width: 152, height: 9, lineBreak: false })
     .text('SCALE (1-5) & RATING', leftX + 160, y + (headerH - 7) / 2, { width: 104, height: 9, align: 'right', lineBreak: false });

  // Right Table Header: Affective & Behavioral Assessment
  doc.rect(rightX, y, tableW, headerH).fill(secondaryColor);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
     .text('AFFECTIVE & BEHAVIORAL TRAITS', rightX + 6, y + (headerH - 7) / 2, { width: 152, height: 9, lineBreak: false })
     .text('SCALE (1-5) & RATING', rightX + 160, y + (headerH - 7) / 2, { width: 104, height: 9, align: 'right', lineBreak: false });

  y += headerH;

  const psychomotorTraits = [
    { key: 'writingMastery', label: 'Handwriting & Neatness' },
    { key: 'drawingCapability', label: 'Drawing & Artistic Skill' },
    { key: 'physicalCoordination', label: 'Sports & Physical Coordination' },
    { key: 'motorSkillProgression', label: 'Practical & Motor Dexterity' },
  ];

  const affectiveTraits = [
    { key: 'generalPunctuality', label: 'Punctuality & Regularity' },
    { key: 'peerRespect', label: 'Politeness & Peer Respect' },
    { key: 'aestheticNeatness', label: 'Personal & Uniform Neatness' },
    { key: 'activeGroupParticipation', label: 'Teamwork & Class Participation' },
  ];

  const drawTraitRow = (tableX, rowY, idx, label, rawRating, accentColor) => {
    const bg = idx % 2 === 0 ? lightBg : '#ffffff';
    doc.rect(tableX, rowY, tableW, rowH).fill(bg).stroke(lightBorder);
    const textY = rowY + Math.max(2.5, (rowH - 7.2) / 2 - 0.5);
    doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(7.2)
       .text(label, tableX + 6, textY, { width: 138, height: 9.5, lineBreak: false, ellipsis: true });

    const meta = resolveTraitRatingMeta(rawRating);
    // Draw 1..5 mini score boxes
    const boxesStartX = tableX + 146;
    const boxW = 11;
    const boxH = Math.min(10.5, rowH - 3.5);
    const boxY = rowY + (rowH - boxH) / 2;
    for (let s = 1; s <= 5; s++) {
      const bx = boxesStartX + (s - 1) * (boxW + 2);
      const isFilled = s === meta.score;
      doc.save();
      if (isFilled) {
        doc.roundedRect(bx, boxY, boxW, boxH, 1.5).fill(accentColor);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6.2)
           .text(String(s), bx, boxY + (boxH - 6) / 2, { width: boxW, height: boxH, align: 'center', lineBreak: false });
      } else {
        doc.roundedRect(bx, boxY, boxW, boxH, 1.5).stroke('#cbd5e1');
        doc.fillColor('#94a3b8').font('Helvetica').fontSize(6)
           .text(String(s), bx, boxY + (boxH - 6) / 2, { width: boxW, height: boxH, align: 'center', lineBreak: false });
      }
      doc.restore();
    }

    doc.fillColor(accentColor).font('Helvetica-Bold').fontSize(6.8)
       .text(meta.label, tableX + 212, textY, { width: 53, height: 9.5, align: 'right', lineBreak: false });
  };

  for (let i = 0; i < 4; i++) {
    const pTrait = psychomotorTraits[i];
    const aTrait = affectiveTraits[i];
    const pVal = psychomotor[pTrait.key] || (params.assessment && params.assessment[pTrait.key]) || 'AC';
    const aVal = affective[aTrait.key] || (params.assessment && params.assessment[aTrait.key]) || 'AC';

    drawTraitRow(leftX, y, i, pTrait.label, pVal, primaryColor);
    drawTraitRow(rightX, y, i, aTrait.label, aVal, secondaryColor);
    y += rowH;
  }

  y += 4;

  // Compact Grading & Behavioral Rubric Legend Strip (Strictly single-line)
  doc.rect(24, y, 547, legendH).fill(lightBg).stroke(lightBorder);
  const scaleSummary = gradingRanges
    .slice(0, 6)
    .map((r) => `${r.grade}:${r.minPercentage ?? r.minScore ?? 0}-${r.maxPercentage ?? r.maxScore ?? 100}%`)
    .join(' | ');
  const legendTextY = y + Math.max(3, (legendH - 6.5) / 2);
  doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(6.3)
     .text(`GRADING KEY: ${scaleSummary}`, 30, legendTextY, {
       width: 262,
       height: 9,
       lineBreak: false,
       ellipsis: true,
     });
  doc.fillColor(textMuted).font('Helvetica-Bold').fontSize(6.2)
     .text('TRAIT KEY: 5(MS)=Excellent | 4(AC)=Very Good | 3(DV)=Good | 2(EM)=Fair | 1=Needs Help', 295, legendTextY, {
       width: 270,
       height: 9,
       align: 'right',
       lineBreak: false,
       ellipsis: true,
     });

  return y + legendH;
}

function drawBrandedRemarksAndSignatures(doc, params, y, colors) {
  const {
    schoolName = 'Ugbekun Schools',
    commentary = '',
    teacherComment = '',
    principalComment = '',
    resumptionDate = null,
    nextTermFees = '',
    formTeacherName = 'Class Teacher',
    principalName = 'The Principal',
    teacherSignatureBuffer = null,
    principalSignatureBuffer = null,
    isProgressSlip = false,
  } = params;

  const { primaryColor, secondaryColor, darkColor, textMuted, lightBorder, lightBg } = colors;

  // Ensure the bottom endorsement + footer section covers the bottom of the A4 page cleanly
  // Target footer Y is 812pt on the 841.89pt A4 page.
  const targetFooterY = 812;
  const startY = Math.min(y, 700);
  const resumptionH = 20;
  const gapAfterResumption = 6;
  const boxStartY = startY + resumptionH + gapAfterResumption;
  // Dynamically stretch the endorsement cards so the report card ends right at the bottom of A4 (max 102pt, min 76pt)
  const boxHeight = Math.min(102, Math.max(76, targetFooterY - boxStartY - 6));

  // 1. Next Term Resumption & Payment Strip
  const resumptionStr = formatResumptionDisplay(resumptionDate);
  doc.rect(24, startY, 547, resumptionH).fill(lightBg).stroke(lightBorder);
  doc.rect(24, startY, 4, resumptionH).fill(primaryColor);

  doc.fillColor(textMuted).font('Helvetica-Bold').fontSize(7)
     .text('NEXT TERM BEGINS:', 34, startY + 6, { height: 10, lineBreak: false });
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(8)
     .text(resumptionStr, 114, startY + 5.5, { width: 175, height: 11, lineBreak: false, ellipsis: true });

  doc.fillColor(textMuted).font('Helvetica-Bold').fontSize(7)
     .text('NEXT TERM SCHOOL FEES:', 298, startY + 6, { height: 10, lineBreak: false });
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(8)
     .text(String(nextTermFees || '—'), 398, startY + 5.5, { width: 165, height: 11, lineBreak: false, ellipsis: true });

  // 2. Side-by-Side Combined Remarks & Signatures Boxes
  const leftBoxX = 24;
  const rightBoxX = 301;
  const colW = 270;

  doc.rect(leftBoxX, boxStartY, colW, boxHeight).fill('#ffffff').stroke(lightBorder);
  doc.rect(rightBoxX, boxStartY, colW, boxHeight).fill('#ffffff').stroke(lightBorder);

  // Header bars inside comment boxes
  const boxHeaderH = 14.5;
  doc.rect(leftBoxX, boxStartY, colW, boxHeaderH).fill(primaryColor);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
     .text("CLASS TEACHER'S REMARK & ENDORSEMENT", leftBoxX + 6, boxStartY + 3.8, { width: colW - 12, height: 9, lineBreak: false });

  doc.rect(rightBoxX, boxStartY, colW, boxHeaderH).fill(secondaryColor);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
     .text("PRINCIPAL'S / HEAD TEACHER'S ENDORSEMENT", rightBoxX + 6, boxStartY + 3.8, { width: colW - 12, height: 9, lineBreak: false });

  const resolvedTeacherRemark =
    teacherComment ||
    commentary ||
    (isProgressSlip
      ? 'Student is making steady continuous assessment progress across active subjects this term.'
      : 'Good academic effort this term. Keep striving for excellence.');

  const resolvedPrincipalRemark =
    principalComment ||
    'A commendable terminal performance. Continue to work diligently in the coming term.';

  const sigRowH = 29;
  const sigDivY = boxStartY + boxHeight - sigRowH;
  const remarkAreaH = Math.max(24, sigDivY - (boxStartY + boxHeaderH) - 6);

  doc.fillColor(darkColor).font('Helvetica-Oblique').fontSize(7.6)
     .text(`"${resolvedTeacherRemark}"`, leftBoxX + 7, boxStartY + boxHeaderH + 4, {
       width: colW - 14,
       height: remarkAreaH,
       ellipsis: true,
     });

  doc.fillColor(darkColor).font('Helvetica-Oblique').fontSize(7.6)
     .text(`"${resolvedPrincipalRemark}"`, rightBoxX + 7, boxStartY + boxHeaderH + 4, {
       width: colW - 14,
       height: remarkAreaH,
       ellipsis: true,
     });

  // Horizontal divider inside each box separating remark from signature row
  doc.moveTo(leftBoxX + 6, sigDivY).lineTo(leftBoxX + colW - 6, sigDivY).stroke('#e2e8f0');
  doc.moveTo(rightBoxX + 6, sigDivY).lineTo(rightBoxX + colW - 6, sigDivY).stroke('#e2e8f0');

  // Teacher Name & Signature on Left Box bottom row
  doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(7.2)
     .text(String(formTeacherName || 'Class Teacher').toUpperCase(), leftBoxX + 7, sigDivY + 5, { width: 138, height: 10, lineBreak: false, ellipsis: true });
  doc.fillColor(textMuted).font('Helvetica').fontSize(6.2)
     .text('FORM TEACHER', leftBoxX + 7, sigDivY + 16, { width: 138, height: 9, lineBreak: false });

  if (teacherSignatureBuffer) {
    safeDrawPdfImage(doc, teacherSignatureBuffer, leftBoxX + 160, sigDivY + 2, {
      fit: [95, 19],
      align: 'center',
      valign: 'center',
    });
  } else {
    doc.moveTo(leftBoxX + 155, sigDivY + 18).lineTo(leftBoxX + colW - 10, sigDivY + 18).stroke(lightBorder);
  }
  doc.fillColor(textMuted).font('Helvetica').fontSize(5.8)
     .text('SIGNATURE', leftBoxX + 155, sigDivY + 20, { width: 105, height: 8, align: 'center', lineBreak: false });

  // Principal Name, Official Stamp & Signature on Right Box bottom row
  doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(7.2)
     .text(String(principalName || 'The Principal').toUpperCase(), rightBoxX + 7, sigDivY + 5, { width: 138, height: 10, lineBreak: false, ellipsis: true });
  doc.fillColor(secondaryColor).font('Helvetica-Bold').fontSize(6.2)
     .text('OFFICIAL STAMP & SEAL', rightBoxX + 7, sigDivY + 16, { width: 138, height: 9, lineBreak: false });

  if (principalSignatureBuffer) {
    safeDrawPdfImage(doc, principalSignatureBuffer, rightBoxX + 160, sigDivY + 2, {
      fit: [95, 19],
      align: 'center',
      valign: 'center',
    });
  } else {
    doc.moveTo(rightBoxX + 155, sigDivY + 18).lineTo(rightBoxX + colW - 10, sigDivY + 18).stroke(lightBorder);
  }
  doc.fillColor(textMuted).font('Helvetica').fontSize(5.8)
     .text('SIGNATURE & STAMP', rightBoxX + 155, sigDivY + 20, { width: 105, height: 8, align: 'center', lineBreak: false });

  // 3. Single-Page Anchored Footer at Bottom of A4 Sheet
  const footerY = Math.min(Math.max(boxStartY + boxHeight + 6, targetFooterY), 815);
  doc.moveTo(24, footerY).lineTo(571, footerY).stroke('#e2e8f0');
  doc.fillColor(textMuted).font('Helvetica').fontSize(6.5)
     .text(
       `Official A4 Academic Dossier • ${schoolName} • Generated & Verified on ${new Date().toLocaleDateString('en-GB')}`,
       24,
       footerY + 3,
       { align: 'center', width: 547, height: 9, lineBreak: false }
     );
}

function drawStandardReportCard(doc, params) {
  const branding = params.schoolBranding || {};
  const schoolName = params.schoolName || branding.schoolName || 'Ugbekun Schools';
  const branchCode = params.branchCode || branding.branchCode || 'GEN';
  const tagline = params.tagline || branding.tagline || '';
  const schoolAddress = params.schoolAddress || params.address || branding.address || '';
  const schoolPhone = params.schoolPhone || params.phone || branding.phone || '';
  const schoolEmail = params.schoolEmail || params.email || branding.email || '';
  const schoolWebsite = params.schoolWebsite || params.website || branding.website || '';
  const termName = params.termName || params.currentTerm || branding.currentTerm || (params.reportCard?.[0]?.examName || 'First Term');

  const {
    studentName = 'Student',
    registerNo = '',
    className = '',
    sectionName = '',
    sessionName = branding.academicSession || '2025/2026',
    gender = '',
    birthday = '',
    attendance = null,
    reportCard: rawReportCard = [],
    overallAverage: rawOverallAverage = 0,
    commentary = '',
    teacherComment = '',
    principalComment = '',
    rank = null,
    totalClassStudents = null,
    rankingType = 'full',
    rankingLimit = 3,
    resumptionDate = branding.resumptionDate || null,
    nextTermFees = branding.nextTermFees || '',
    formTeacherName = branding.classTeacherName || 'Class Teacher',
    principalName = branding.principalName || 'The Principal',
    gradingRanges = null,
    isMidTerm = false,
    stage = 'FULL',
    assessmentComponents = null,
    maxTotal = null,
    logoBuffer = null,
    studentPhotoBuffer = null,
    teacherSignatureBuffer = null,
    principalSignatureBuffer = null,
  } = params;

  const isCombinedCa = stage === 'COMBINED_CA' || stage === 'CA_ONLY';
  const isProgressSlip = Boolean(isMidTerm || (stage && stage !== 'FULL'));

  // Resolve dynamic matrix columns from DB (via assessmentComponents)
  const resolvedComponents = Array.isArray(assessmentComponents) && assessmentComponents.length > 0
    ? assessmentComponents
    : [];

  // Deduplicate/consolidate subject rows so no subject appears twice on the report card
  const reportCard = deduplicateReportCardSubjects(rawReportCard, resolvedComponents);

  const resolvedMaxTotal =
    typeof maxTotal === 'number' && maxTotal > 0
      ? maxTotal
      : resolvedComponents.length > 0
        ? resolvedComponents.reduce((sum, c) => sum + (Number(c.maxMarks) || 0), 0)
        : (Number(reportCard?.[0]?.maxMarks) || 100);

  // Recompute accurate overall average when duplicate rows were consolidated
  let overallAverage = rawOverallAverage;
  if (reportCard.length > 0 && rawReportCard.length !== reportCard.length) {
    let sumPct = 0;
    let countValid = 0;
    for (const r of reportCard) {
      if (!r.absent) {
        const sc = parseFloat(String(r.stageScore ?? r.mark ?? r.totalScore ?? ''));
        if (!isNaN(sc)) {
          const rMax = Number(r.maxMarks) || resolvedMaxTotal || 100;
          sumPct += rMax > 0 ? (sc / rMax) * 100 : sc;
          countValid++;
        }
      }
    }
    if (countValid > 0) {
      overallAverage = Number((sumPct / countValid).toFixed(1));
    }
  }

  const stageLabel = isCombinedCa
    ? resolvedComponents.length === 1
      ? `${resolvedComponents[0].label || resolvedComponents[0].code} (${resolvedMaxTotal})`
      : `Continuous Assessment (${resolvedComponents.map((c) => c.code || c.label).join(' + ')})`
    : isProgressSlip
      ? (resolvedComponents[0]?.label || resolvedComponents[0]?.code || stage)
      : 'Terminal Evaluation';

  // Dynamic School Brand Colors
  const primaryColor = sanitizeHexColor(params.primaryColor || branding.primaryColor, '#1e3a8a');
  const secondaryColor = sanitizeHexColor(params.secondaryColor || branding.secondaryColor, '#0284c7');
  const darkColor = '#0f172a';
  const textMuted = '#475569';
  const lightBorder = '#e2e8f0';
  const lightBg = '#f8fafc';

  const colors = { primaryColor, secondaryColor, darkColor, textMuted, lightBorder, lightBg };

  // Compute Ranking String (only for terminal reports)
  let rankString = '-';
  if (!isProgressSlip) {
    if (rankingType === 'full' && rank && totalClassStudents) {
      rankString = `${rank}${getOrdinalSuffix(rank)} of ${totalClassStudents}`;
    } else if (rankingType === 'topn' && rank && rankingLimit) {
      if (rank <= rankingLimit) {
        rankString = `${rank}${getOrdinalSuffix(rank)} (Top ${rankingLimit})`;
      } else {
        rankString = 'Graded';
      }
    } else if (rankingType === 'hidden') {
      rankString = 'Hidden';
    }
  }

  // Compute GPA letter grade equivalent using active grading scale
  const gpaInfo = calculateGradeFromRanges(overallAverage, gradingRanges || undefined);
  const gpaRating = `${gpaInfo.grade} (${formatCompactRemark(gpaInfo.remark || 'Graded')})`;

  const reportSubtitle = isCombinedCa
    ? `CONTINUOUS ASSESSMENT REPORT (${resolvedComponents.map((c) => c.code || c.label).join(' + ') || 'CA'})`
    : isProgressSlip
      ? 'CONTINUOUS ASSESSMENT PROGRESS REPORT'
      : 'OFFICIAL STUDENT TERMINAL REPORT CARD';

  // 1. Branded Header with Logo & School Info (Y: 16 to 84)
  drawBrandedReportHeader(
    doc,
    {
      schoolName,
      branchCode,
      tagline,
      schoolAddress,
      schoolPhone,
      schoolEmail,
      schoolWebsite,
      sessionName,
      termName,
      reportSubtitle,
      logoBuffer,
    },
    colors
  );

  // 2. Student Profile Info & Photo Block (Y: 90 to 152, Height: 62pt)
  let y = drawStudentBioWithPhoto(
    doc,
    {
      studentName,
      registerNo,
      className,
      sectionName,
      gender,
      birthday,
      attendance,
      overallAverage,
      gpaRating,
      rankString,
      isProgressSlip,
      stage,
      stageLabel,
      studentPhotoBuffer,
      boxHeight: 62,
    },
    90,
    colors
  );

  // Dynamic Full-Page A4 Vertical Budgeting (Spans from Y=152 down to Y=812)
  const maxRows = 20;
  const itemsToRender = reportCard.slice(0, maxRows);
  const minDisplayRows = 8;
  const effectiveRowCount = Math.max(itemsToRender.length, minDisplayRows);

  const sectionGap = effectiveRowCount <= 12 ? 9 : effectiveRowCount <= 15 ? 7 : 5;
  const traitHeaderH = effectiveRowCount <= 14 ? 15.5 : 14;
  const traitRowH = effectiveRowCount <= 12 ? 17.5 : effectiveRowCount <= 15 ? 15.5 : 14;
  const traitLegendH = effectiveRowCount <= 14 ? 15.5 : 14;
  const band4TotalH = 12 + traitHeaderH + 4 * traitRowH + 4 + traitLegendH;
  const band5ReservedH = effectiveRowCount <= 12 ? 122 : effectiveRowCount <= 15 ? 112 : 104;

  y += sectionGap;

  // 3. Academic Scoreboard Table
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(8.5).text(
    isProgressSlip ? '1. CONTINUOUS ASSESSMENT PERFORMANCE' : '1. COGNITIVE ACADEMIC PERFORMANCE',
    24,
    y,
    { width: 280, height: 11, lineBreak: false }
  );
  doc.fillColor(textMuted).font('Helvetica').fontSize(7.2).text(
    `Subjects Evaluated: ${reportCard.length}  •  Max Score / Subject: ${resolvedMaxTotal || 100}`,
    310,
    y + 1,
    { width: 261, height: 10, align: 'right', lineBreak: false }
  );
  y += 12;

  // Table Header Row (Dynamic DB EvaluationMatrix Columns, X: 24, W: 547, H: 16.5)
  const headerRowH = 16.5;
  const sumRowH = 16;

  // Calculate remaining vertical budget for subject rows so the entire A4 page is filled cleanly
  const targetBand5StartY = 812 - band5ReservedH;
  const targetBand3EndY = targetBand5StartY - sectionGap - band4TotalH - sectionGap;
  const availableForSubjectRows = targetBand3EndY - (y + headerRowH + sumRowH);
  const rowHeight = Math.min(24.5, Math.max(12.5, availableForSubjectRows / effectiveRowCount));
  const rowFontSize = rowHeight < 13.5 ? 7 : rowHeight < 16 ? 7.5 : 8;

  doc.rect(24, y, 547, headerRowH).fill(primaryColor);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7);

  const numCompCols = resolvedComponents.length;
  const codeX = 28;
  const codeW = 42;
  const totalW = 46;
  const classAvgW = 44;
  const gradeW = 32;
  const remarkW = 74;
  const fixedRightW = totalW + classAvgW + gradeW + remarkW; // 196
  const totalUsableW = 541; // 28 to 569
  const remainingForSubAndComps = totalUsableW - codeW - fixedRightW; // 303
  const compW = numCompCols > 0
    ? Math.min(44, Math.max(28, Math.floor(156 / numCompCols)))
    : 0;
  const subjectX = codeX + codeW + 2;
  const subjectW = Math.max(110, remainingForSubAndComps - (compW * numCompCols) - 4);
  const firstCompX = subjectX + subjectW + 2;
  const totalX = firstCompX + (compW * numCompCols);
  const classAvgX = totalX + totalW;
  const gradeX = classAvgX + classAvgW;
  const remarkX = gradeX + gradeW;

  const hTextY = y + (headerRowH - 7) / 2;
  doc.text('CODE', codeX, hTextY, { width: codeW, height: 9, lineBreak: false })
     .text('SUBJECT', subjectX, hTextY, { width: subjectW, height: 9, lineBreak: false });

  resolvedComponents.forEach((comp, cIdx) => {
    const rawHeader = String(comp.label || comp.name || comp.code || comp.key || '').trim();
    const shortHeader = rawHeader.length <= 10 ? rawHeader.toUpperCase() : String(comp.code || comp.key || rawHeader).toUpperCase();
    const compHeader = comp.maxMarks ? `${shortHeader}(${comp.maxMarks})` : shortHeader;
    doc.text(compHeader, firstCompX + cIdx * compW, hTextY, {
      width: compW - 2,
      height: 9,
      align: 'right',
      lineBreak: false,
    });
  });

  const totalHeaderLabel = resolvedMaxTotal > 0 ? `TOTAL(${resolvedMaxTotal})` : 'TOTAL';
  doc.text(totalHeaderLabel, totalX, hTextY, { width: totalW - 2, height: 9, align: 'right', lineBreak: false })
     .text('CLASS AVG', classAvgX, hTextY, { width: classAvgW - 2, height: 9, align: 'right', lineBreak: false })
     .text('GRADE', gradeX, hTextY, { width: gradeW, height: 9, align: 'center', lineBreak: false })
     .text('REMARK', remarkX, hTextY, { width: remarkW, height: 9, align: 'center', lineBreak: false });

  y += headerRowH;

  // Helper to extract component score from row
  const getComponentDisplayScore = (row, comp, compIdx) => {
    if (row.absent) return '-';
    const scoresMap = row.componentScores || {};
    const candidates = [comp.code, comp.key, comp.label, comp.name].filter(Boolean);
    for (const cand of candidates) {
      if (scoresMap[cand] !== undefined && scoresMap[cand] !== null) {
        return String(scoresMap[cand]);
      }
      const upper = String(cand).toUpperCase();
      for (const [k, v] of Object.entries(scoresMap)) {
        if (k.toUpperCase() === upper && v !== undefined && v !== null) {
          return String(v);
        }
      }
    }
    const cat = String(comp.category || '').toUpperCase();
    if (cat === 'EXAM' && row.theoryMark !== undefined && row.theoryMark !== null) {
      return String(row.theoryMark);
    }
    if (cat === 'CA' && compIdx === 0 && row.cbtMark !== undefined && row.cbtMark !== null) {
      return String(row.cbtMark);
    }
    return '-';
  };

  let cumulativeObtained = 0;
  let cumulativeMax = 0;

  itemsToRender.forEach((row, idx) => {
    if (idx % 2 === 0) {
      doc.rect(24, y, 547, rowHeight).fill(lightBg);
    } else {
      doc.rect(24, y, 547, rowHeight).fill('#ffffff');
    }
    doc.rect(24, y, 547, rowHeight).stroke(lightBorder);

    const textOffsetY = y + Math.max(2.5, (rowHeight - rowFontSize) / 2 - 0.5);
    const cellTextH = rowFontSize + 2.5;

    const totalScore =
      row.stageScore !== undefined && row.stageScore !== null
        ? String(row.stageScore)
        : row.mark !== undefined && row.mark !== null
          ? String(row.mark)
          : row.totalScore !== undefined && row.totalScore !== null
            ? String(row.totalScore)
            : '-';

    const rowMax = Number(row.maxMarks) || resolvedMaxTotal || 100;
    let gradeLetter = row.grade || '-';
    let gradeRemark = row.remark || '-';
    if (!row.absent && totalScore !== '-' && !isNaN(parseFloat(totalScore))) {
      const tot = parseFloat(totalScore);
      cumulativeObtained += tot;
      cumulativeMax += rowMax;
      const pct = rowMax > 0 ? (tot / rowMax) * 100 : tot;
      const res = calculateGradeFromRanges(pct, gradingRanges || undefined);
      gradeLetter = res.grade;
      gradeRemark = res.remark || gradeLetter;
    }
    const cleanRemark = formatCompactRemark(gradeRemark);

    doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(rowFontSize - 0.3)
       .text(row.subjectCode || '-', codeX, textOffsetY, { width: codeW, height: cellTextH, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(rowFontSize)
       .text(row.subjectName || '-', subjectX, textOffsetY, { width: subjectW, height: cellTextH, lineBreak: false, ellipsis: true });

    resolvedComponents.forEach((comp, cIdx) => {
      const valStr = getComponentDisplayScore(row, comp, cIdx);
      doc.fillColor(darkColor).font('Helvetica').fontSize(rowFontSize)
         .text(valStr, firstCompX + cIdx * compW, textOffsetY, { width: compW - 2, height: cellTextH, align: 'right', lineBreak: false });
    });

    doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(rowFontSize)
       .text(row.absent ? '-' : totalScore, totalX, textOffsetY, { width: totalW - 2, height: cellTextH, align: 'right', lineBreak: false })
       .font('Helvetica')
       .text(row.absent ? '-' : `${row.classAverage ?? '-'}`, classAvgX, textOffsetY, { width: classAvgW - 2, height: cellTextH, align: 'right', lineBreak: false });
    doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(rowFontSize)
       .text(row.absent ? 'ABS' : gradeLetter, gradeX, textOffsetY, { width: gradeW, height: cellTextH, align: 'center', lineBreak: false });
    doc.fillColor(textMuted).font('Helvetica').fontSize(rowFontSize - 0.5)
       .text(row.absent ? 'Absent' : cleanRemark, remarkX, textOffsetY, { width: remarkW, height: cellTextH, align: 'center', lineBreak: false, ellipsis: true });

    y += rowHeight;
  });

  if (itemsToRender.length < minDisplayRows) {
    const fillers = minDisplayRows - itemsToRender.length;
    for (let i = 0; i < fillers; i++) {
      const idx = itemsToRender.length + i;
      doc.rect(24, y, 547, rowHeight).fill(idx % 2 === 0 ? lightBg : '#ffffff').stroke(lightBorder);
      y += rowHeight;
    }
  }

  // Summary / Aggregate Footer Row inside Subject Table
  doc.rect(24, y, 547, sumRowH).fill('#eff6ff').stroke(lightBorder);
  const sumTextY = y + (sumRowH - 7.5) / 2;
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(7.4)
     .text('CUMULATIVE PERFORMANCE SUMMARY', codeX, sumTextY, { width: 220, height: 10, lineBreak: false })
     .text(
       cumulativeMax > 0 ? `${Math.round(cumulativeObtained * 10) / 10} / ${cumulativeMax}` : `${overallAverage}%`,
       totalX - 30,
       sumTextY,
       { width: totalW + 28, height: 10, align: 'right', lineBreak: false }
     )
     .text(`AVG: ${overallAverage}%`, classAvgX - 6, sumTextY, { width: classAvgW + 4, height: 10, align: 'right', lineBreak: false })
     .text(gpaInfo.grade, gradeX, sumTextY, { width: gradeW, height: 10, align: 'center', lineBreak: false })
     .text(isProgressSlip ? 'In Progress' : rankString, remarkX, sumTextY, { width: remarkW, height: 10, align: 'center', lineBreak: false, ellipsis: true });

  y += sumRowH + sectionGap;

  // 4. Psychomotor & Affective 2-Column Assessment Grid + Grading/Trait Legend
  y = drawPsychomotorAndAffectiveGrid(doc, params, y, colors, {
    headerH: traitHeaderH,
    rowH: traitRowH,
    legendH: traitLegendH,
  });

  y += sectionGap;

  // 5. Next Term Resumption, Fees, Dual Comments & Signatures (Anchored to fill A4 bottom)
  drawBrandedRemarksAndSignatures(
    doc,
    {
      schoolName,
      commentary,
      teacherComment,
      principalComment,
      resumptionDate,
      nextTermFees,
      formTeacherName,
      principalName,
      teacherSignatureBuffer,
      principalSignatureBuffer,
      isProgressSlip,
    },
    y,
    colors
  );
}

function drawMontessoriReportCard(doc, params) {
  const branding = params.schoolBranding || {};
  const schoolName = params.schoolName || branding.schoolName || 'Ugbekun Schools';
  const branchCode = params.branchCode || branding.branchCode || 'GEN';
  const tagline = params.tagline || branding.tagline || '';
  const schoolAddress = params.schoolAddress || params.address || branding.address || '';
  const schoolPhone = params.schoolPhone || params.phone || branding.phone || '';
  const schoolEmail = params.schoolEmail || params.email || branding.email || '';
  const schoolWebsite = params.schoolWebsite || params.website || branding.website || '';

  const {
    studentName = 'Pupil',
    registerNo = '',
    className = '',
    sectionName = '',
    sessionName = branding.academicSession || '2025/2026',
    termName = branding.currentTerm || params.examName || 'Term Evaluation',
    gender = '',
    birthday = '',
    attendance = null,
    assessment = {},
    commentary = '',
    teacherComment = '',
    principalComment = '',
    resumptionDate = branding.resumptionDate || null,
    nextTermFees = branding.nextTermFees || '',
    formTeacherName = branding.classTeacherName || 'Class Teacher',
    principalName = branding.principalName || 'The Principal',
    logoBuffer = null,
    studentPhotoBuffer = null,
    teacherSignatureBuffer = null,
    principalSignatureBuffer = null,
  } = params;

  const primaryColor = sanitizeHexColor(params.primaryColor || branding.primaryColor, '#059669');
  const secondaryColor = sanitizeHexColor(params.secondaryColor || branding.secondaryColor, '#4f46e5');
  const darkColor = '#0f172a';
  const textMuted = '#475569';
  const lightBorder = '#e2e8f0';
  const lightBg = '#f8fafc';
  const colors = { primaryColor, secondaryColor, darkColor, textMuted, lightBorder, lightBg };

  const drawRatingPills = (doc, x, y, width, activeRating) => {
    const rubrics = ['EM', 'DV', 'AC', 'MS'];
    const pillWidth = (width - 15) / 4;
    const pillHeight = 14;

    rubrics.forEach((code, idx) => {
      const rx = x + idx * (pillWidth + 5);
      const isActive = activeRating === code;

      doc.save();
      if (isActive) {
        doc.roundedRect(rx, y, pillWidth, pillHeight, 3).fill(primaryColor);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
           .text(code, rx, y + 3.5, { width: pillWidth, align: 'center', lineBreak: false });
      } else {
        doc.roundedRect(rx, y, pillWidth, pillHeight, 3).stroke(lightBorder);
        doc.fillColor('#94a3b8').font('Helvetica').fontSize(7)
           .text(code, rx, y + 3.5, { width: pillWidth, align: 'center', lineBreak: false });
      }
      doc.restore();
    });
  };

  drawBrandedReportHeader(
    doc,
    {
      schoolName,
      branchCode,
      tagline,
      schoolAddress,
      schoolPhone,
      schoolEmail,
      schoolWebsite,
      sessionName,
      termName,
      reportSubtitle: 'MONTESSORI & EARLY YEARS DEVELOPMENTAL REPORT',
      logoBuffer,
    },
    colors
  );

  let y = drawStudentBioWithPhoto(
    doc,
    {
      studentName,
      registerNo,
      className,
      sectionName,
      gender,
      birthday,
      attendance,
      overallAverage: 100,
      gpaRating: 'Montessori Matrix',
      rankString: 'Developmental',
      isProgressSlip: false,
      studentPhotoBuffer,
      boxHeight: 62,
    },
    90,
    colors
  );

  y += 6;

  // Rubric Legend
  doc.rect(24, y, 547, 18).fill(lightBg).stroke(lightBorder);
  doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(7.5)
     .text('RATING KEY:  [EM] Emerging (1)     [DV] Developing (2)     [AC] Achieved (3)     [MS] Mastered (4)', 34, y + 5, {
       width: 520,
       align: 'left',
       lineBreak: false,
     });

  y += 24;

  // Domain 1: Psychomotor Skills
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(9.5).text('1. PSYCHOMOTOR DEVELOPMENT', 24, y, { lineBreak: false });
  y += 12;

  doc.rect(24, y, 547, 17).fill(primaryColor);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5)
     .text('DEVELOPMENTAL TRAIT', 36, y + 4.5, { width: 280, lineBreak: false })
     .text('ASSESSMENT RATING [EM / DV / AC / MS]', 340, y + 4.5, { width: 215, align: 'center', lineBreak: false });
  y += 17;

  const psychomotorTraits = [
    { label: 'Writing Mastery & Pencil Grip', key: 'writingMastery' },
    { label: 'Drawing & Spatial Shape Capability', key: 'drawingCapability' },
    { label: 'Physical Balance & Coordination', key: 'physicalCoordination' },
    { label: 'Fine & Gross Motor Skill Progression', key: 'motorSkillProgression' },
  ];

  psychomotorTraits.forEach((trait, idx) => {
    if (idx % 2 === 0) doc.rect(24, y, 547, 20).fill(lightBg);
    else doc.rect(24, y, 547, 20).fill('#ffffff');
    doc.rect(24, y, 547, 20).stroke(lightBorder);

    doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(8)
       .text(trait.label, 36, y + 6, { width: 280, lineBreak: false });

    const val = assessment[trait.key] || 'AC';
    drawRatingPills(doc, 345, y + 3, 210, val);
    y += 20;
  });

  y += 8;

  // Domain 2: Affective & Behavioral Domain
  doc.fillColor(secondaryColor).font('Helvetica-Bold').fontSize(9.5).text('2. AFFECTIVE & SOCIAL BEHAVIOR', 24, y, { lineBreak: false });
  y += 12;

  doc.rect(24, y, 547, 17).fill(secondaryColor);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5)
     .text('BEHAVIORAL ATTRIBUTE', 36, y + 4.5, { width: 280, lineBreak: false })
     .text('ASSESSMENT RATING [EM / DV / AC / MS]', 340, y + 4.5, { width: 215, align: 'center', lineBreak: false });
  y += 17;

  const affectiveTraits = [
    { label: 'General Punctuality & Attendance', key: 'generalPunctuality' },
    { label: 'Peer Respect & Social Courtesy', key: 'peerRespect' },
    { label: 'Aesthetic Neatness & Material Organization', key: 'aestheticNeatness' },
    { label: 'Active Group Participation & Curiosity', key: 'activeGroupParticipation' },
  ];

  affectiveTraits.forEach((trait, idx) => {
    if (idx % 2 === 0) doc.rect(24, y, 547, 20).fill(lightBg);
    else doc.rect(24, y, 547, 20).fill('#ffffff');
    doc.rect(24, y, 547, 20).stroke(lightBorder);

    doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(8)
       .text(trait.label, 36, y + 6, { width: 280, lineBreak: false });

    const val = assessment[trait.key] || 'AC';
    drawRatingPills(doc, 345, y + 3, 210, val);
    y += 20;
  });

  y += 10;

  drawBrandedRemarksAndSignatures(
    doc,
    {
      schoolName,
      commentary: assessment.narrativeComment || commentary,
      teacherComment: teacherComment || assessment.narrativeComment || commentary,
      principalComment,
      resumptionDate,
      nextTermFees,
      formTeacherName,
      principalName,
      teacherSignatureBuffer,
      principalSignatureBuffer,
      isProgressSlip: false,
    },
    y,
    colors
  );
}

function drawCommentBasedReportCard(doc, params) {
  const branding = params.schoolBranding || {};
  const schoolName = params.schoolName || branding.schoolName || 'Ugbekun Schools';
  const branchCode = params.branchCode || branding.branchCode || 'GEN';
  const tagline = params.tagline || branding.tagline || '';
  const schoolAddress = params.schoolAddress || params.address || branding.address || '';
  const schoolPhone = params.schoolPhone || params.phone || branding.phone || '';
  const schoolEmail = params.schoolEmail || params.email || branding.email || '';
  const schoolWebsite = params.schoolWebsite || params.website || branding.website || '';

  const {
    studentName = 'Pupil',
    registerNo = '',
    className = '',
    sectionName = '',
    sessionName = branding.academicSession || '2025/2026',
    termName = branding.currentTerm || params.examName || 'Developmental Evaluation',
    gender = '',
    birthday = '',
    attendance = null,
    subjectComments = [],
    teacherComment = '',
    principalComment = '',
    resumptionDate = branding.resumptionDate || null,
    nextTermFees = branding.nextTermFees || '',
    formTeacherName = branding.classTeacherName || 'Class Teacher',
    principalName = branding.principalName || 'The Principal',
    logoBuffer = null,
    studentPhotoBuffer = null,
    teacherSignatureBuffer = null,
    principalSignatureBuffer = null,
  } = params;

  const primaryColor = sanitizeHexColor(params.primaryColor || branding.primaryColor, '#0d9488');
  const secondaryColor = sanitizeHexColor(params.secondaryColor || branding.secondaryColor, '#0284c7');
  const darkColor = '#0f172a';
  const textMuted = '#475569';
  const lightBorder = '#e2e8f0';
  const lightBg = '#f8fafc';
  const colors = { primaryColor, secondaryColor, darkColor, textMuted, lightBorder, lightBg };

  drawBrandedReportHeader(
    doc,
    {
      schoolName,
      branchCode,
      tagline,
      schoolAddress,
      schoolPhone,
      schoolEmail,
      schoolWebsite,
      sessionName,
      termName,
      reportSubtitle: 'EARLY YEARS & MONTESSORI DEVELOPMENTAL REPORT',
      logoBuffer,
    },
    colors
  );

  let y = drawStudentBioWithPhoto(
    doc,
    {
      studentName,
      registerNo,
      className,
      sectionName,
      gender,
      birthday,
      attendance,
      overallAverage: 100,
      gpaRating: 'Qualitative Rubric',
      rankString: 'N/A',
      isProgressSlip: false,
      studentPhotoBuffer,
      boxHeight: 62,
    },
    90,
    colors
  );

  y += 5;

  // Learning Domains Table Header
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(8.5).text('1. LEARNING DOMAINS & QUALITATIVE OBSERVATIONS', 24, y, { lineBreak: false });
  y += 11;

  doc.rect(24, y, 547, 16).fill(primaryColor);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.2)
     .text('LEARNING DOMAIN / SUBJECT', 32, y + 4.5, { width: 145, lineBreak: false })
     .text('TEACHER QUALITATIVE OBSERVATION', 182, y + 4.5, { width: 270, lineBreak: false })
     .text('RATING (1-5)', 460, y + 4.5, { width: 100, align: 'center', lineBreak: false });
  y += 16;

  if (!subjectComments || subjectComments.length === 0) {
    doc.rect(24, y, 547, 26).stroke(lightBorder);
    doc.fillColor(textMuted).font('Helvetica-Oblique').fontSize(8)
       .text('No qualitative subject assessments recorded for this period.', 32, y + 8, { width: 525, align: 'center', lineBreak: false });
    y += 26;
  } else {
    const items = subjectComments.slice(0, 10);
    const rowHeight = items.length > 8 ? 22 : 25;
    items.forEach((item, idx) => {
      if (idx % 2 === 0) doc.rect(24, y, 547, rowHeight).fill(lightBg);
      else doc.rect(24, y, 547, rowHeight).fill('#ffffff');
      doc.rect(24, y, 547, rowHeight).stroke(lightBorder);

      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(7.8)
         .text(item.subjectName || 'Learning Domain', 32, y + 6, { width: 145, lineBreak: false, ellipsis: true });

      const obsText = item.comment || 'Pupil demonstrates active participation and positive curiosity.';
      doc.fillColor(textMuted).font('Helvetica').fontSize(7)
         .text(obsText, 182, y + 4, { width: 270, height: rowHeight - 6, ellipsis: true });

      const ratingVal = Number(item.rating) || 3;
      const ratingLabel = item.ratingLabel || `${ratingVal} / 5`;
      const pillWidth = 86;
      const pillX = 468;
      const pillY = y + Math.floor((rowHeight - 14) / 2);
      doc.roundedRect(pillX, pillY, pillWidth, 14, 3).fill(primaryColor);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
         .text(ratingLabel, pillX, pillY + 3.5, { width: pillWidth, align: 'center', lineBreak: false });

      y += rowHeight;
    });
  }

  y += 5;

  // Psychomotor & Affective Grid
  y = drawPsychomotorAndAffectiveGrid(doc, params, y, colors);

  y += 4;

  drawBrandedRemarksAndSignatures(
    doc,
    {
      schoolName,
      commentary: teacherComment,
      teacherComment,
      principalComment,
      resumptionDate,
      nextTermFees,
      formTeacherName,
      principalName,
      teacherSignatureBuffer,
      principalSignatureBuffer,
      isProgressSlip: false,
    },
    y,
    colors
  );
}

async function preloadReportCardAssetBuffers(params) {
  const branding = params.schoolBranding || {};
  const logoSrc = params.logoUrl || branding.logoUrl || null;
  const studentPhotoSrc = params.studentPhoto || params.photo || null;
  const teacherSigSrc =
    params.teacherSignatureUrl ||
    branding.classTeacherSignatureUrl ||
    branding.defaultTeacherSignatureUrl ||
    null;
  const principalSigSrc =
    params.principalSignatureUrl ||
    branding.principalSignatureUrl ||
    null;

  const [logoBuffer, studentPhotoBuffer, teacherSignatureBuffer, principalSignatureBuffer] =
    await Promise.all([
      params.logoBuffer ? Promise.resolve(params.logoBuffer) : fetchImage(logoSrc),
      params.studentPhotoBuffer ? Promise.resolve(params.studentPhotoBuffer) : fetchImage(studentPhotoSrc),
      params.teacherSignatureBuffer ? Promise.resolve(params.teacherSignatureBuffer) : fetchImage(teacherSigSrc),
      params.principalSignatureBuffer ? Promise.resolve(params.principalSignatureBuffer) : fetchImage(principalSigSrc),
    ]);

  return {
    ...params,
    logoBuffer,
    studentPhotoBuffer,
    teacherSignatureBuffer,
    principalSignatureBuffer,
  };
}

function generateCommentBasedReportCardPdf(params) {
  return new Promise(async (resolve, reject) => {
    try {
      const hydrated = await preloadReportCardAssetBuffers(params);
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 14, bottom: 10, left: 20, right: 20 },
        info: {
          Title: `Developmental Report - ${hydrated.studentName || 'Pupil'}`,
          Author: 'Ugbekun Schools Platform',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      drawCommentBasedReportCard(doc, hydrated);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function generateReportCardPdf(params) {
  return new Promise(async (resolve, reject) => {
    try {
      const hydrated = await preloadReportCardAssetBuffers(params);
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 14, bottom: 10, left: 20, right: 20 },
        info: {
          Title: `Report Card - ${hydrated.studentName || 'Student'}`,
          Author: 'Ugbekun Schools Platform',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (hydrated.usesScores === false || hydrated.isCommentBased || (hydrated.subjectComments && hydrated.subjectComments.length > 0)) {
        drawCommentBasedReportCard(doc, hydrated);
      } else if (hydrated.isEcd) {
        drawMontessoriReportCard(doc, hydrated);
      } else {
        drawStandardReportCard(doc, hydrated);
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function generateMontessoriReportCardPdf(params) {
  return new Promise(async (resolve, reject) => {
    try {
      const hydrated = await preloadReportCardAssetBuffers(params);
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 14, bottom: 10, left: 20, right: 20 },
        info: {
          Title: `Montessori Assessment - ${hydrated.studentName || 'Pupil'}`,
          Author: 'Ugbekun Schools Platform',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      drawMontessoriReportCard(doc, hydrated);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function generateBatchClassReportCardsPdf(params) {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun Schools',
        branchCode = 'GEN',
        className = 'Classroom',
        sectionName = '',
        sessionName = '',
        schoolBranding = {},
        students = [],
      } = params;

      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 14, bottom: 10, left: 20, right: 20 },
        info: {
          Title: `Batch Report Cards - ${className} ${sectionName}`,
          Author: 'Ugbekun Schools Platform',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (students.length === 0) {
        doc.fontSize(16).fillColor('#0f172a').text('No student report card records found for this class selection.', 50, 100);
        doc.end();
        return;
      }

      // Preload shared school logo & signatures once for the entire class batch
      const sharedAssets = await preloadReportCardAssetBuffers({
        ...params,
        schoolBranding,
      });

      for (let idx = 0; idx < students.length; idx++) {
        const student = students[idx];
        if (idx > 0) {
          doc.addPage();
        }

        const studentPhotoBuffer = await fetchImage(student.photo || student.studentPhoto || null);

        const studentParams = {
          schoolName,
          branchCode,
          className,
          sectionName,
          sessionName,
          schoolBranding,
          logoBuffer: sharedAssets.logoBuffer,
          teacherSignatureBuffer: sharedAssets.teacherSignatureBuffer,
          principalSignatureBuffer: sharedAssets.principalSignatureBuffer,
          ...student,
          studentPhotoBuffer,
        };

        if (student.usesScores === false || student.isCommentBased || (student.subjectComments && student.subjectComments.length > 0)) {
          drawCommentBasedReportCard(doc, studentParams);
        } else if (student.isEcd) {
          drawMontessoriReportCard(doc, studentParams);
        } else {
          drawStandardReportCard(doc, studentParams);
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function fetchImage(photoPath) {
  return new Promise((resolve) => {
    if (!photoPath || typeof photoPath !== 'string') return resolve(null);
    const trimmed = photoPath.trim();
    if (!trimmed) return resolve(null);

    // Support Base64 Data URIs (e.g., data:image/png;base64,...)
    if (trimmed.startsWith('data:image/')) {
      const commaIdx = trimmed.indexOf(',');
      if (commaIdx !== -1) {
        try {
          const base64Data = trimmed.slice(commaIdx + 1);
          return resolve(Buffer.from(base64Data, 'base64'));
        } catch {
          return resolve(null);
        }
      }
      return resolve(null);
    }

    if (trimmed.startsWith('/uploads/') || trimmed.startsWith('uploads/')) {
      const cleanPath = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
      const fullPath = path.join(__dirname, '..', cleanPath);
      fs.readFile(fullPath, (err, data) => {
        if (err) resolve(null);
        else resolve(data);
      });
      return;
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const client = trimmed.startsWith('https://') ? https : require('http');
      const req = client.get(trimmed, { timeout: 6000 }, (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      return;
    }
    const localFallback = path.join(__dirname, '..', trimmed);
    fs.readFile(localFallback, (err, data) => {
      if (!err) resolve(data);
      else resolve(null);
    });
  });
}

function generateStudentIdCardPdf(params) {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun School',
        branchName = 'Main Campus',
        primaryColor = '#1b5e20',
        secondaryColor = '#2e7d32',
        studentName,
        registerNo,
        className,
        sectionName,
        sessionName,
        photoUrl,
        verifyToken,
        cardNumber
      } = params;

      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: `Student ID - ${studentName}`,
          Author: 'Ugbekun Schools Platform'
        }
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Card Dimensions in points (ID-1 scale: 242.6 x 153)
      const w = 242.6;
      const h = 153;
      const x = (595.28 - w) / 2;
      const yFront = 150;
      const yBack = 320;

      // Fetch photo and QR code buffer
      const photoBuffer = await fetchImage(photoUrl);
      const verifyUrl = buildVerificationUrl(verifyToken);
      const qrBuffer = await generateQrBuffer(verifyUrl, { width: 100, margin: 1 });

      // ─── FRONT OF CARD ──────────────────────────────────────────────────
      // Card Container & Shadow effect
      doc.rect(x + 2, yFront + 2, w, h).fill('#e2e8f0');
      doc.roundedRect(x, yFront, w, h, 6).fill('#ffffff').stroke('#cbd5e1');

      // Top Header Band
      doc.roundedRect(x, yFront, w, 32, 6).fill(primaryColor);
      doc.rect(x, yFront + 20, w, 12).fill(primaryColor); // Flat bottom corner workaround

      // School branding
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5)
         .text(schoolName.toUpperCase(), x + 8, yFront + 6, { width: w - 16, align: 'center', ellipsis: true });
      doc.font('Helvetica').fontSize(6).fillColor('#f1f5f9')
         .text(branchName.toUpperCase(), x + 8, yFront + 17, { width: w - 16, align: 'center', ellipsis: true });

      // Student details area
      doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(8.5)
         .text(studentName, x + 72, yFront + 45, { width: w - 80, height: 22, ellipsis: true });

      doc.font('Helvetica').fontSize(6.5).fillColor('#64748b');
      doc.text('Reg No:', x + 72, yFront + 68);
      doc.text('Class:', x + 72, yFront + 83);
      doc.text('Session:', x + 72, yFront + 98);
      doc.text('Card No:', x + 72, yFront + 113);

      doc.fillColor('#0f172a').font('Helvetica-Bold');
      doc.text(registerNo || 'N/A', x + 106, yFront + 68);
      doc.text(`${className || 'N/A'} - ${sectionName || 'N/A'}`, x + 106, yFront + 83);
      doc.text(sessionName || 'N/A', x + 106, yFront + 98);
      doc.text(cardNumber || 'N/A', x + 106, yFront + 113);

      // Student Photo
      const photoX = x + 10;
      const photoY = yFront + 45;
      const photoW = 52;
      const photoH = 62;
      doc.rect(photoX, photoY, photoW, photoH).stroke('#cbd5e1');
      if (photoBuffer) {
        try {
          doc.image(photoBuffer as any, photoX + 1, photoY + 1, { width: photoW - 2, height: photoH - 2 });
        } catch (e) {
          drawPhotoPlaceholder(doc, photoX, photoY, photoW, photoH);
        }
      } else {
        drawPhotoPlaceholder(doc, photoX, photoY, photoW, photoH);
      }

      // Title/Role Ribbon
      doc.rect(x, yFront + h - 16, w, 16).fill(secondaryColor);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5)
         .text('STUDENT ID CARD', x, yFront + h - 11, { width: w, align: 'center' });

      // ─── BACK OF CARD ───────────────────────────────────────────────────
      doc.rect(x + 2, yBack + 2, w, h).fill('#e2e8f0');
      doc.roundedRect(x, yBack, w, h, 6).fill('#ffffff').stroke('#cbd5e1');

      // Top bar
      doc.rect(x, yBack, w, 8).fill(primaryColor);

      // QR Code (centered, large)
      if (qrBuffer) {
        doc.image(qrBuffer, x + (w - 60) / 2, yBack + 20, { width: 60, height: 60 });
      }

      // Details
      doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(6)
         .text('SCAN QR CODE TO VERIFY IDENTITY', x + 10, yBack + 86, { width: w - 20, align: 'center' });

      doc.font('Helvetica').fontSize(5.5).fillColor('#475569');
      doc.text('If found, please return to the school address:', x + 15, yBack + 102, { width: w - 30, align: 'center' });
      doc.font('Helvetica-Bold').text(branchName || 'Ugbekun School', x + 15, yBack + 110, { width: w - 30, align: 'center' });

      // Footer contact strip
      doc.rect(x, yBack + h - 16, w, 16).fill('#f8fafc');
      doc.moveTo(x, yBack + h - 16).lineTo(x + w, yBack + h - 16).stroke('#cbd5e1');
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(6)
         .text('PUBLIC VERIFICATION PORTAL SECURITY ACTIVE', x, yBack + h - 11, { width: w, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function generateStaffIdCardPdf(params) {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun School',
        branchName = 'Main Campus',
        primaryColor = '#1b5e20',
        secondaryColor = '#2e7d32',
        staffName,
        roleName = 'Staff',
        username,
        photoUrl,
        verifyToken,
        cardNumber
      } = params;

      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: `Staff ID - ${staffName}`,
          Author: 'Ugbekun Schools Platform'
        }
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Card Dimensions in points (ID-1 scale: 242.6 x 153)
      const w = 242.6;
      const h = 153;
      const x = (595.28 - w) / 2;
      const yFront = 150;
      const yBack = 320;

      // Fetch photo and QR code buffer
      const photoBuffer = await fetchImage(photoUrl);
      const verifyUrl = buildVerificationUrl(verifyToken);
      const qrBuffer = await generateQrBuffer(verifyUrl, { width: 100, margin: 1 });

      // ─── FRONT OF CARD ──────────────────────────────────────────────────
      doc.rect(x + 2, yFront + 2, w, h).fill('#e2e8f0');
      doc.roundedRect(x, yFront, w, h, 6).fill('#ffffff').stroke('#cbd5e1');

      // Top Header Band
      doc.roundedRect(x, yFront, w, 32, 6).fill(primaryColor);
      doc.rect(x, yFront + 20, w, 12).fill(primaryColor);

      // School branding
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5)
         .text(schoolName.toUpperCase(), x + 8, yFront + 6, { width: w - 16, align: 'center', ellipsis: true });
      doc.font('Helvetica').fontSize(6).fillColor('#f1f5f9')
         .text(branchName.toUpperCase(), x + 8, yFront + 17, { width: w - 16, align: 'center', ellipsis: true });

      // Details area
      doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(8.5)
         .text(staffName, x + 72, yFront + 45, { width: w - 80, height: 22, ellipsis: true });

      doc.font('Helvetica').fontSize(6.5).fillColor('#64748b');
      doc.text('Designation:', x + 72, yFront + 68);
      doc.text('ID/Username:', x + 72, yFront + 83);
      doc.text('Card No:', x + 72, yFront + 98);
      doc.text('Issued Date:', x + 72, yFront + 113);

      doc.fillColor('#0f172a').font('Helvetica-Bold');
      doc.text(roleName, x + 118, yFront + 68);
      doc.text(username || 'N/A', x + 118, yFront + 83);
      doc.text(cardNumber || 'N/A', x + 118, yFront + 98);
      doc.text(new Date().toLocaleDateString(), x + 118, yFront + 113);

      // Photo
      const photoX = x + 10;
      const photoY = yFront + 45;
      const photoW = 52;
      const photoH = 62;
      doc.rect(photoX, photoY, photoW, photoH).stroke('#cbd5e1');
      if (photoBuffer) {
        try {
          doc.image(photoBuffer as any, photoX + 1, photoY + 1, { width: photoW - 2, height: photoH - 2 });
        } catch (e) {
          drawPhotoPlaceholder(doc, photoX, photoY, photoW, photoH);
        }
      } else {
        drawPhotoPlaceholder(doc, photoX, photoY, photoW, photoH);
      }

      // Title/Role Ribbon
      doc.rect(x, yFront + h - 16, w, 16).fill(secondaryColor);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5)
         .text('STAFF ID CARD', x, yFront + h - 11, { width: w, align: 'center' });

      // ─── BACK OF CARD ───────────────────────────────────────────────────
      doc.rect(x + 2, yBack + 2, w, h).fill('#e2e8f0');
      doc.roundedRect(x, yBack, w, h, 6).fill('#ffffff').stroke('#cbd5e1');

      // Top bar
      doc.rect(x, yBack, w, 8).fill(primaryColor);

      // QR Code
      if (qrBuffer) {
        doc.image(qrBuffer, x + (w - 60) / 2, yBack + 20, { width: 60, height: 60 });
      }

      doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(6)
         .text('SCAN QR CODE TO VERIFY STAFF IDENTITY', x + 10, yBack + 86, { width: w - 20, align: 'center' });

      doc.font('Helvetica').fontSize(5.5).fillColor('#475569');
      doc.text('If found, please return to the school address:', x + 15, yBack + 102, { width: w - 30, align: 'center' });
      doc.font('Helvetica-Bold').text(branchName || 'Ugbekun School', x + 15, yBack + 110, { width: w - 30, align: 'center' });

      // Footer
      doc.rect(x, yBack + h - 16, w, 16).fill('#f8fafc');
      doc.moveTo(x, yBack + h - 16).lineTo(x + w, yBack + h - 16).stroke('#cbd5e1');
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(6)
         .text('PUBLIC VERIFICATION PORTAL SECURITY ACTIVE', x, yBack + h - 11, { width: w, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function generateCertificatePdf(params) {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun School',
        branchName = 'Main Campus',
        primaryColor = '#1b5e20',
        secondaryColor = '#2e7d32',
        studentName,
        certificateType, // "completion" | "excellence" | "leaving"
        certificateNo,
        title,
        description,
        sessionName,
        verifyToken
      } = params;

      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 40,
        info: {
          Title: `Certificate - ${studentName}`,
          Author: 'Ugbekun Schools Platform'
        }
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const w = 841.89;
      const h = 595.28;

      // Draw background decorative border
      doc.rect(20, 20, w - 40, h - 40).lineWidth(3).stroke(primaryColor);
      doc.rect(26, 26, w - 52, h - 52).lineWidth(1).stroke(secondaryColor);

      // Header Branding
      doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(26)
         .text(schoolName.toUpperCase(), 40, 55, { align: 'center', width: w - 80 });
      doc.fillColor('#475569').font('Helvetica').fontSize(12)
         .text(branchName.toUpperCase(), 40, 90, { align: 'center', width: w - 80 });

      // Divider line
      doc.moveTo(w / 2 - 100, 115).lineTo(w / 2 + 100, 115).lineWidth(1.5).stroke(secondaryColor);

      // Certificate Title
      let mainTitle = 'CERTIFICATE OF ACHIEVEMENT';
      if (certificateType === 'excellence') {
        mainTitle = 'CERTIFICATE OF ACADEMIC EXCELLENCE';
      } else if (certificateType === 'leaving') {
        mainTitle = 'GRADUATION / SCHOOL LEAVING CERTIFICATE';
      } else if (certificateType === 'completion') {
        mainTitle = 'CERTIFICATE OF TERM COMPLETION';
      }

      doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(20)
         .text(mainTitle, 40, 140, { align: 'center', width: w - 80 });

      doc.fillColor('#64748b').font('Helvetica').fontSize(13)
         .text('This is proudly presented to', 40, 190, { align: 'center', width: w - 80 });

      // Student name (very large and elegant)
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(28)
         .text(studentName, 40, 220, { align: 'center', width: w - 80 });

      // Certificate details
      doc.fillColor('#334155').font('Helvetica').fontSize(11)
         .text(description || `For successfully meeting all academic requirements for the ${sessionName || 'current'} session.`, 100, 280, { align: 'center', width: w - 200, lineGap: 4 });

      // Date & Award fields
      doc.fillColor('#64748b').font('Helvetica').fontSize(9)
         .text(`Certificate No: ${certificateNo}`, 40, 360, { align: 'center', width: w - 80 });
      doc.text(`Date of Issue: ${new Date().toLocaleDateString()}`, 40, 375, { align: 'center', width: w - 80 });

      // Signatures
      const sigY = 470;
      doc.moveTo(100, sigY).lineTo(280, sigY).lineWidth(1).stroke('#cbd5e1');
      doc.moveTo(w - 280, sigY).lineTo(w - 100, sigY).lineWidth(1).stroke('#cbd5e1');

      doc.fillColor('#475569').font('Helvetica').fontSize(9)
         .text('SCHOOL PRINCIPAL', 100, sigY + 5, { width: 180, align: 'center' })
         .text('SCHOOL PROPRIETOR', w - 280, sigY + 5, { width: 180, align: 'center' });

      // QR Code in bottom center/right for verification
      const verifyUrl = buildVerificationUrl(verifyToken);
      const qrBuffer = await generateQrBuffer(verifyUrl, { width: 80, margin: 1 });
      if (qrBuffer) {
        doc.image(qrBuffer, w / 2 - 25, 430, { width: 50, height: 50 });
        doc.fillColor('#94a3b8').fontSize(6).font('Helvetica-Bold')
           .text('SCAN TO VERIFY', w / 2 - 50, 485, { width: 100, align: 'center' });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function generatePayslipPdf(params) {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun School',
        branchName = 'Main Campus',
        monthYear = 'Current Month',
        staffName,
        staffRole = 'Staff',
        baseSalary = 0,
        housingAllowance = 0,
        transportAllowance = 0,
        medicalAllowance = 0,
        taxDeduction = 0,
        pensionDeduction = 0,
        otherDeductions = 0,
        netSalary = 0,
        paymentMethod = 'Bank Transfer'
      } = params;

      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const w = 515;

      // Header Band
      doc.rect(40, 40, w, 60).fill('#0f172a');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16)
         .text(schoolName.toUpperCase(), 55, 52, { width: w - 30 });
      doc.font('Helvetica').fontSize(9).fillColor('#94a3b8')
         .text(`OFFICIAL PAYSLIP — ${monthYear.toUpperCase()} (${branchName})`, 55, 75, { width: w - 30 });

      // Staff Summary Block
      doc.rect(40, 115, w, 65).fill('#f8fafc').stroke('#e2e8f0');
      doc.fillColor('#475569').font('Helvetica').fontSize(8);
      doc.text('Employee Name:', 55, 125);
      doc.text('Role / Designation:', 55, 142);
      doc.text('Payment Method:', 300, 125);
      doc.text('Pay Period:', 300, 142);

      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9);
      doc.text(staffName, 135, 125);
      doc.text(staffRole, 135, 142);
      doc.text(paymentMethod, 390, 125);
      doc.text(monthYear, 390, 142);

      // Itemized Earnings & Deductions Table
      let y = 195;
      doc.rect(40, y, w, 24).fill('#1e293b');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
      doc.text('EARNINGS / ALLOWANCES', 55, y + 7, { width: 200 });
      doc.text('AMOUNT (NGN)', 240, y + 7, { width: 100, align: 'right' });
      doc.text('DEDUCTIONS', 350, y + 7, { width: 100 });
      doc.text('AMOUNT (NGN)', 445, y + 7, { width: 90, align: 'right' });

      y += 24;

      const earnings = [
        { label: 'Basic Salary', val: Number(baseSalary) },
        { label: 'Housing Allowance', val: Number(housingAllowance) },
        { label: 'Transport Allowance', val: Number(transportAllowance) },
        { label: 'Medical Allowance', val: Number(medicalAllowance) }
      ];

      const deductions = [
        { label: 'PAYE Tax', val: Number(taxDeduction) },
        { label: 'Pension Contribution', val: Number(pensionDeduction) },
        { label: 'Salary Advance / Other', val: Number(otherDeductions) }
      ];

      const maxRows = Math.max(earnings.length, deductions.length);
      for (let i = 0; i < maxRows; i++) {
        const rowY = y + (i * 22);
        doc.rect(40, rowY, w, 22).fill(i % 2 === 0 ? '#ffffff' : '#f8fafc').stroke('#f1f5f9');
        
        doc.fillColor('#334155').font('Helvetica').fontSize(8);
        if (earnings[i]) {
          doc.text(earnings[i].label, 55, rowY + 6);
          doc.font('Helvetica-Bold').text(`₦${earnings[i].val.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 240, rowY + 6, { width: 100, align: 'right' });
        }

        doc.font('Helvetica');
        if (deductions[i]) {
          doc.text(deductions[i].label, 350, rowY + 6);
          doc.font('Helvetica-Bold').text(`₦${deductions[i].val.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 445, rowY + 6, { width: 90, align: 'right' });
        }
      }

      y += (maxRows * 22) + 15;

      // Net Pay Summary Box
      doc.rect(40, y, w, 45).fill('#ecfdf5').stroke('#10b981');
      doc.fillColor('#047857').font('Helvetica-Bold').fontSize(10);
      doc.text('NET SALARY PAYABLE:', 55, y + 15);
      doc.fontSize(16).text(`₦${Number(netSalary).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 250, y + 12, { width: w - 270, align: 'right' });

      // Signatures
      y += 75;
      doc.moveTo(55, y + 30).lineTo(200, y + 30).stroke('#cbd5e1');
      doc.moveTo(350, y + 30).lineTo(495, y + 30).stroke('#cbd5e1');

      doc.fillColor('#64748b').font('Helvetica').fontSize(8);
      doc.text('Staff Signature', 55, y + 35, { width: 145, align: 'center' });
      doc.text('Bursar / Authorized Signatory', 350, y + 35, { width: 145, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function generateEmploymentLetterPdf(params) {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun School',
        branchName = 'Main Campus',
        staffName,
        jobTitle,
        joiningDate,
        salaryAmount = 0,
        letterContent,
        issuedDate = new Date()
      } = params;

      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const w = 495;

      // Header Letterhead
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(18)
         .text(schoolName.toUpperCase(), 50, 50, { width: w, align: 'center' });
      doc.font('Helvetica').fontSize(9).fillColor('#64748b')
         .text(`${branchName} — Office of Human Resources`, 50, 72, { width: w, align: 'center' });
      
      doc.moveTo(50, 88).lineTo(545, 88).stroke('#cbd5e1');

      // Date & Ref
      doc.fillColor('#334155').font('Helvetica').fontSize(9);
      doc.text(`Date: ${new Date(issuedDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}`, 50, 105);
      doc.text(`Ref: UGB/HR/EMP/${Math.floor(1000 + Math.random() * 9000)}`, 50, 120);

      // Addressee
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a');
      doc.text(`To: ${staffName}`, 50, 145);
      doc.font('Helvetica').fontSize(9).fillColor('#475569');
      doc.text(`Designation: ${jobTitle}`, 50, 160);

      // Title
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a')
         .text(`LETTER OF APPOINTMENT / EMPLOYMENT`, 50, 185, { width: w, align: 'center', underline: true });

      // Content Body
      doc.font('Helvetica').fontSize(9.5).fillColor('#1e293b');
      const cleanContent = (letterContent || `Dear ${staffName},\n\nWe are pleased to offer you employment at ${schoolName} for the position of ${jobTitle}, commencing on ${new Date(joiningDate).toLocaleDateString()}. Your monthly remuneration package will be ₦${Number(salaryAmount).toLocaleString()}.\n\nWelcome to the team!`).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');

      doc.text(cleanContent, 50, 215, { width: w, align: 'justify', lineGap: 4 });

      // Closing & Signature
      const signY = doc.y + 35;
      doc.text('Yours faithfully,', 50, signY);
      doc.font('Helvetica-Bold').text(schoolName, 50, signY + 15);
      
      doc.moveTo(50, signY + 60).lineTo(200, signY + 60).stroke('#cbd5e1');
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#475569')
         .text('HEAD OF HUMAN RESOURCES / PROPRIETOR', 50, signY + 65, { width: 220 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawSingleInvoicePage(doc, params) {
  const {
    schoolName = 'Ugbekun Schools',
    branchCode = 'GEN',
    invoiceNo = 'INV/2026/0001',
    termLabel = 'First Term',
    sessionName = 'Active Session',
    studentName = 'Student',
    registerNo = '',
    className = 'Classroom',
    sectionName = '',
    issuedAt = new Date(),
    dueDate = null,
    status = 'unpaid',
    items = [],
    totalAmount = 0,
    paidAmount = 0,
    balanceAmount = 0,
    schoolBank = null
  } = params

  const primaryColor = '#065f46'   // Dark Emerald Green
  const accentColor = '#10b981'    // Emerald Green
  const darkColor = '#0f172a'      // Slate-900
  const textMuted = '#475569'      // Slate-600
  const lightBorder = '#cbd5e1'    // Slate-300
  const lightBg = '#f8fafc'        // Slate-50

  const totalNum = Number(totalAmount) || 0
  const paidNum = Number(paidAmount) || 0
  const balanceNum = Number(balanceAmount) || (totalNum - paidNum)
  const isPaid = status === 'paid' || balanceNum <= 0
  const isPartial = status === 'partial' || (paidNum > 0 && balanceNum > 0)

  // ─── Top Header Section (Y: 30 to 95) ──────────────────────────────────
  doc.rect(30, 30, 535, 65).fill(primaryColor)

  // Left Header Text
  doc.fillColor('#ffffff')
     .font('Helvetica-Bold')
     .fontSize(16)
     .text(schoolName.toUpperCase(), 45, 42, { width: 340, align: 'left' })

  doc.font('Helvetica')
     .fontSize(9)
     .fillColor('#a7f3d0') // Light emerald green
     .text(`OFFICIAL FEE INVOICE & DEMAND NOTICE • BRANCH: ${branchCode}`, 45, 64)

  // Right Header Text (Invoice No & Date)
  doc.fillColor('#ffffff')
     .font('Helvetica-Bold')
     .fontSize(12)
     .text(invoiceNo, 360, 42, { width: 190, align: 'right' })

  const issueDateStr = issuedAt ? new Date(issuedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : new Date().toLocaleDateString()
  doc.font('Helvetica')
     .fontSize(9)
     .fillColor('#e2e8f0')
     .text(`Issued: ${issueDateStr}`, 360, 60, { width: 190, align: 'right' })
     .text(`Session: ${sessionName || 'Active'}`, 360, 72, { width: 190, align: 'right' })

  let y = 105

  // ─── Status & Due Date Strip (Y: 105 to 135) ───────────────────────────
  doc.rect(30, y, 535, 30).fill(lightBg).stroke(lightBorder)

  // Status Badge
  let statusBg = '#fee2e2'
  let statusTextColor = '#991b1b'
  let statusText = 'UNPAID / OUTSTANDING'

  if (isPaid) {
    statusBg = '#dcfce7'
    statusTextColor = '#166534'
    statusText = 'PAID IN FULL'
  } else if (isPartial) {
    statusBg = '#fef3c7'
    statusTextColor = '#92400e'
    statusText = 'PARTIALLY PAID'
  }

  doc.roundedRect(42, y + 6, 130, 18, 4).fill(statusBg)
  doc.fillColor(statusTextColor).font('Helvetica-Bold').fontSize(8.5)
     .text(statusText, 42, y + 10, { width: 130, align: 'center' })

  // Due Date Notice
  const dueStr = dueDate ? new Date(dueDate).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'Due Upon Receipt'
  doc.fillColor(darkColor).font('Helvetica').fontSize(9)
     .text('Payment Due Date: ', 320, y + 10, { continued: true })
     .font('Helvetica-Bold').fillColor(isPaid ? '#166534' : '#b91c1c')
     .text(dueStr)

  y += 40

  // ─── Student Profile & Billing Metadata (Y: 145 to 215) ────────────────
  doc.rect(30, y, 535, 68).stroke(lightBorder)

  // Left Column: Student Details
  doc.fillColor(textMuted).font('Helvetica').fontSize(8.5)
     .text('Billed Student:', 45, y + 10)
     .text('Registration No:', 45, y + 28)
     .text('Classroom & Stream:', 45, y + 46)

  doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(9.5)
     .text(studentName, 140, y + 10)
     .text(registerNo || 'Pending / N/A', 140, y + 28)
     .text(`${className} ${sectionName ? `(${sectionName})` : ''}`, 140, y + 46)

  // Right Column: Invoice Info
  doc.fillColor(textMuted).font('Helvetica').fontSize(8.5)
     .text('Academic Term:', 340, y + 10)
     .text('Billing Currency:', 340, y + 28)
     .text('Payment Status:', 340, y + 46)

  doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(9.5)
     .text(termLabel || 'Current Term', 430, y + 10)
     .text('Nigerian Naira (NGN / ₦)', 430, y + 28)
     .text(statusText, 430, y + 46)

  y += 80

  // ─── Itemized Fee Schedule Table (Y: 225 onwards) ──────────────────────
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(11).text('ITEMIZED FEE SCHEDULE', 30, y)
  y += 15

  // Table Header Row
  doc.rect(30, y, 535, 20).fill(primaryColor)
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5)
     .text('#', 40, y + 6, { width: 25 })
     .text('FEE ITEM DESCRIPTION', 70, y + 6, { width: 260 })
     .text('FEE CODE', 340, y + 6, { width: 80 })
     .text('AMOUNT (₦)', 430, y + 6, { width: 125, align: 'right' })

  y += 20

  // Table Data Rows
  const rowHeight = 20
  const maxRows = 10
  const renderedItems = items.slice(0, maxRows)

  renderedItems.forEach((item, idx) => {
    if (idx % 2 === 0) {
      doc.rect(30, y, 535, rowHeight).fill(lightBg)
    } else {
      doc.rect(30, y, 535, rowHeight).fill('#ffffff')
    }
    doc.rect(30, y, 535, rowHeight).stroke(lightBorder)

    const itemAmt = Number(item.amount) || 0
    doc.fillColor(darkColor).font('Helvetica').fontSize(8.5)
       .text(String(idx + 1), 40, y + 6, { width: 25 })
       .text(item.description || 'School Fee Component', 70, y + 6, { width: 260 })
       .text(item.feeTypeCode || item.code || 'SCH-FEE', 340, y + 6, { width: 80 })
       .font('Helvetica-Bold')
       .text(`₦${itemAmt.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 430, y + 6, { width: 125, align: 'right' })

    y += rowHeight
  })

  // Fillers if few items
  if (renderedItems.length < 4) {
    const fillers = 4 - renderedItems.length
    for (let i = 0; i < fillers; i++) {
      doc.rect(30, y, 535, rowHeight).stroke(lightBorder)
      y += rowHeight
    }
  }

  y += 10

  // ─── Financial Summary Sub-table ─────────────────────────────────────
  const summaryBoxWidth = 230
  const summaryBoxX = 335
  const summaryHeight = 70

  doc.rect(summaryBoxX, y, summaryBoxWidth, summaryHeight).fill(lightBg).stroke(lightBorder)

  doc.fillColor(darkColor).font('Helvetica').fontSize(8.5)
     .text('Total Invoiced Amount:', summaryBoxX + 15, y + 10)
     .text('Total Amount Paid:', summaryBoxX + 15, y + 28)
     .font('Helvetica-Bold').fontSize(9.5)
     .text('OUTSTANDING BALANCE:', summaryBoxX + 15, y + 48)

  doc.font('Helvetica-Bold').fontSize(9)
     .text(`₦${totalNum.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, summaryBoxX + 130, y + 10, { width: 85, align: 'right' })
     .fillColor('#166534')
     .text(`₦${paidNum.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, summaryBoxX + 130, y + 28, { width: 85, align: 'right' })
     .fillColor(balanceNum > 0 ? '#b91c1c' : '#166534')
     .fontSize(10)
     .text(`₦${balanceNum.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, summaryBoxX + 130, y + 48, { width: 85, align: 'right' })

  // ─── School Bank Payment Details Box (Left Side) ────────────────────
  const bankBoxWidth = 295
  const bankBoxX = 30
  doc.rect(bankBoxX, y, bankBoxWidth, summaryHeight).fill('#f0fdf4').stroke('#86efac')
  doc.rect(bankBoxX, y, 4, summaryHeight).fill(primaryColor)

  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(9)
     .text('OFFICIAL SCHOOL BANK PAYMENT DETAILS', bankBoxX + 14, y + 8)

  const bankName = schoolBank?.bankName || 'Access Bank / Zenith Bank'
  const acctName = schoolBank?.accountName || schoolName
  const acctNo = schoolBank?.accountNumber || '0123456789'

  doc.fillColor(darkColor).font('Helvetica').fontSize(8)
     .text(`Bank: ${bankName}`, bankBoxX + 14, y + 24)
     .text(`Account Name: ${acctName}`, bankBoxX + 14, y + 37)
     .font('Helvetica-Bold').fontSize(9.5)
     .text(`Account No: ${acctNo}`, bankBoxX + 14, y + 50)

  y += summaryHeight + 15

  // ─── Payment Instructions Notice ─────────────────────────────────────
  doc.rect(30, y, 535, 45).fill('#fffbeeb0').stroke('#fde68a')
  doc.rect(30, y, 4, 45).fill('#d97706')

  doc.fillColor('#92400e').font('Helvetica-Bold').fontSize(8.5)
     .text('PAYMENT INSTRUCTIONS & POLICIES:', 42, y + 8)
  doc.font('Helvetica').fontSize(8).fillColor('#78350f')
     .text(`1. Please quote Invoice No (${invoiceNo}) or Student Reg No (${registerNo || studentName}) as the bank transfer description. 2. Submit payment evidence/receipt to the Bursar\'s Office or upload via Parent Portal for instant reconciliation.`, 42, y + 22, { width: 515 })

  y += 65

  // ─── Signatures Block ────────────────────────────────────────────────
  const sigY = 705
  doc.moveTo(40, sigY).lineTo(220, sigY).stroke(lightBorder)
  doc.moveTo(375, sigY).lineTo(555, sigY).stroke(lightBorder)

  doc.fillColor(textMuted).font('Helvetica').fontSize(8)
     .text('BURSAR / ACCOUNTS OFFICER', 40, sigY + 5, { width: 180, align: 'center' })
     .text('AUTHORIZED SCHOOL STAMP', 375, sigY + 5, { width: 180, align: 'center' })

  // ─── Footer ──────────────────────────────────────────────────────────
  doc.moveTo(30, 755).lineTo(565, 755).stroke('#e2e8f0')

  doc.fillColor(textMuted).font('Helvetica').fontSize(7.5)
     .text('This is an official computer-generated student financial invoice issued by the Ugbekun 2.0 Management System.', 30, 765, { align: 'center', width: 535 })
     .text(`© ${new Date().getFullYear()} ${schoolName}. All rights reserved.`, 30, 775, { align: 'center', width: 535 })
}

function generateSingleInvoicePdf(params) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 30,
        info: {
          Title: `Invoice - ${params.invoiceNo || 'Fee Invoice'}`,
          Author: 'Ugbekun Schools Platform',
        },
      })

      const chunks = []
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      drawSingleInvoicePage(doc, params)
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

function generateBatchClassInvoicesPdf(params) {
  return new Promise((resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun Schools',
        branchCode = 'GEN',
        className = 'Classroom',
        sectionName = '',
        sessionName = '',
        schoolBank = null,
        invoices = []
      } = params

      const doc = new PDFDocument({
        size: 'A4',
        margin: 30,
        info: {
          Title: `Batch Fee Invoices - ${className} ${sectionName}`,
          Author: 'Ugbekun Schools Platform',
        },
      })

      const chunks = []
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      if (invoices.length === 0) {
        doc.fontSize(16).fillColor('#0f172a').text('No student invoice records found for this class selection.', 50, 100)
        doc.end()
        return
      }

      invoices.forEach((inv, idx) => {
        if (idx > 0) {
          doc.addPage()
        }

        const invoiceParams = {
          schoolName,
          branchCode,
          className,
          sectionName,
          sessionName,
          schoolBank,
          ...inv
        }

        drawSingleInvoicePage(doc, invoiceParams)
      })

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
/**
 * Generates an official printable Lesson Plan PDF document.
 *
 * @param {object} params
 * @returns {Promise<Buffer>}
 */
function generateLessonPlanPdf(params) {
  return new Promise((resolve, reject) => {
    try {
      const {
        schoolName = 'UGBEKUN GROUP OF SCHOOLS',
        branchCode = 'MAIN BRANCH',
        teacherName = 'Subject Teacher',
        subjectName = 'Basic Science',
        className = 'JSS 1',
        sectionName = 'Gold',
        coreTopic = 'Living and Non-Living Things',
        educationalObjectives = '',
        materialLists = '',
        teachingGuide = '',
        assessmentCriteria = '',
        classAssignments = '',
        status = 'PUBLISHED',
        createdAt = new Date(),
        weekNo = 'Week 3'
      } = params

      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        info: {
          Title: `Lesson Plan - ${coreTopic}`,
          Author: teacherName,
        }
      })

      const chunks = []
      doc.on('data', chunk => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))

      // Draw Header Banner
      doc.rect(36, 36, 523, 64).fill('#1e1b4b') // Deep Indigo
      doc.fillColor('#fbbf24').font('Helvetica-Bold').fontSize(12)
         .text(schoolName.toUpperCase(), 46, 46, { width: 503, align: 'center' })
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10)
         .text('OFFICIAL PEDAGOGICAL LESSON PLAN', 46, 62, { width: 503, align: 'center' })
      doc.fillColor('#cbd5e1').font('Helvetica').fontSize(8)
         .text(`Branch Code: ${branchCode} • Term Schedule: ${weekNo} • Status: ${status}`, 46, 76, { width: 503, align: 'center' })

      let curY = 110

      // Metadata Table Box
      doc.rect(36, curY, 523, 48).fill('#f8fafc').stroke('#cbd5e1')
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8.5)
      
      doc.text('Subject:', 46, curY + 8)
      doc.font('Helvetica').text(subjectName, 90, curY + 8)

      doc.font('Helvetica-Bold').text('Classroom:', 220, curY + 8)
      doc.font('Helvetica').text(`${className} ${sectionName ? `(${sectionName})` : ''}`, 280, curY + 8)

      doc.font('Helvetica-Bold').text('Teacher:', 400, curY + 8)
      doc.font('Helvetica').text(teacherName, 445, curY + 8)

      doc.font('Helvetica-Bold').text('Core Topic:', 46, curY + 26)
      doc.font('Helvetica').text(coreTopic, 105, curY + 26, { width: 440 })

      curY += 58

      // Helper function to draw pedagogical section box
      function drawSectionBox(title, content, bgColor = '#ffffff', borderColor = '#e2e8f0') {
        if (!content) return

        // Check if page overflow
        if (curY > 680) {
          doc.addPage()
          curY = 36
        }

        doc.fillColor('#1e1b4b').font('Helvetica-Bold').fontSize(9)
           .text(title.toUpperCase(), 36, curY)
        curY += 14

        doc.font('Helvetica').fontSize(8);
        const textHeight = doc.heightOfString(content, { width: 505 });
        const boxHeight = Math.max(textHeight + 14, 28)

        doc.rect(36, curY, 523, boxHeight).fill(bgColor).stroke(borderColor)
        doc.fillColor('#1e293b').font('Helvetica').fontSize(8)
           .text(content, 46, curY + 7, { width: 503, lineGap: 2.5 })

        curY += boxHeight + 12
      }

      // Section 1: Objectives
      drawSectionBox('1. Behavioral Learning Objectives (Bloom\'s Taxonomy)', educationalObjectives, '#f0fdf4', '#bbf7d0')

      // Section 2: Instructional Materials
      drawSectionBox('2. Instructional Materials & Teaching Aids', materialLists, '#f8fafc', '#e2e8f0')

      // Section 3: Step-by-Step Procedure
      drawSectionBox('3. Step-by-Step Instructional Sequence & Methodology', teachingGuide, '#ffffff', '#cbd5e1')

      // Section 4: Assessment Criteria
      drawSectionBox('4. Formative Evaluation & Assessment Rubric', assessmentCriteria, '#fefce8', '#fef08a')

      // Section 5: Homework
      drawSectionBox('5. Home Assignment & Extension Activity', classAssignments, '#faf5ff', '#e9d5ff')

      // Section 6: Endorsements / Sign-off
      if (curY > 670) {
        doc.addPage()
        curY = 40
      }

      doc.rect(36, curY, 523, 55).fill('#f8fafc').stroke('#cbd5e1')
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8)

      doc.text('Subject Teacher Signature: ______________________', 46, curY + 14)
      doc.text(`Date: ${new Date(createdAt).toLocaleDateString()}`, 46, curY + 34)

      doc.text('HOD / Academic Director Endorsement: ______________________', 290, curY + 14)
      doc.text('Official School Stamp: [ VERIFIED ]', 290, curY + 34)

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

function drawPhotoPlaceholder(doc, x, y, w, h) {
  doc.rect(x + 1, y + 1, w - 2, h - 2).fill('#f1f5f9');
  doc.fillColor('#94a3b8').font('Helvetica-Bold').fontSize(6)
     .text('PHOTO', x, y + h / 2 - 8, { width: w, align: 'center' })
     .text('PLACEHOLDER', x, y + h / 2, { width: w, align: 'center' });
}

export {
  generateCredentialSlipPdf,
  generateBatchClassCredentialSlipsPdf,
  generateReportCardPdf,
  generateMontessoriReportCardPdf,
  generateCommentBasedReportCardPdf,
  generateBatchClassReportCardsPdf,
  generateSingleInvoicePdf,
  generateBatchClassInvoicesPdf,
  generateStudentIdCardPdf,
  generateStaffIdCardPdf,
  generateCertificatePdf,
  generatePayslipPdf,
  generateEmploymentLetterPdf,
  generateLessonPlanPdf,
};

export default {
  generateCredentialSlipPdf,
  generateBatchClassCredentialSlipsPdf,
  generateReportCardPdf,
  generateMontessoriReportCardPdf,
  generateCommentBasedReportCardPdf,
  generateBatchClassReportCardsPdf,
  generateSingleInvoicePdf,
  generateBatchClassInvoicesPdf,
  generateStudentIdCardPdf,
  generateStaffIdCardPdf,
  generateCertificatePdf,
  generatePayslipPdf,
  generateEmploymentLetterPdf,
  generateLessonPlanPdf,
};


