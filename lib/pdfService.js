const PDFDocument = require('pdfkit')
const fs = require('fs')
const path = require('path')
const https = require('https')
const { generateQrBuffer, buildVerificationUrl } = require('./qrService')

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

function getOrdinalSuffix(i) {
  const j = i % 10, k = i % 100;
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}

function generateReportCardPdf(params) {
  return new Promise((resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun Schools',
        branchCode = 'GEN',
        studentName,
        registerNo = '',
        className = '',
        sectionName = '',
        sessionName = '',
        reportCard = [],
        overallAverage = 0,
        commentary = '',
        rank = null,
        totalClassStudents = null,
        rankingType = 'full',
        rankingLimit = 3,
        resumptionDate = null,
        formTeacherName = 'Form Teacher'
      } = params

      // Create an A4-sized PDF with margins
      const doc = new PDFDocument({
        size: 'A4',
        margin: 30,
        info: {
          Title: `Report Card - ${studentName}`,
          Author: 'Ugbekun Schools Platform',
        },
      })

      const chunks = []
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // Theme Colors
      const primaryColor = '#1e3a8a'   // Royal Navy Blue
      const secondaryColor = '#3b82f6' // Vibrant Blue
      const darkColor = '#0f172a'      // Slate-900
      const textMuted = '#475569'      // Slate-600
      const lightBorder = '#e2e8f0'    // Slate-200
      const lightBg = '#f8fafc'        // Slate-50

      // Compute Ranking String
      let rankString = '-'
      if (rankingType === 'full' && rank && totalClassStudents) {
        rankString = `${rank}${getOrdinalSuffix(rank)} of ${totalClassStudents}`
      } else if (rankingType === 'topn' && rank && rankingLimit) {
        if (rank <= rankingLimit) {
          rankString = `${rank}${getOrdinalSuffix(rank)} (Top ${rankingLimit})`
        } else {
          rankString = 'Graded'
        }
      } else if (rankingType === 'hidden') {
        rankString = 'Hidden'
      }

      // Compute GPA letter grade equivalent
      let gpaRating = 'F'
      if (overallAverage >= 70) gpaRating = 'A'
      else if (overallAverage >= 60) gpaRating = 'B'
      else if (overallAverage >= 50) gpaRating = 'C'
      else if (overallAverage >= 45) gpaRating = 'D'
      else if (overallAverage >= 40) gpaRating = 'E'

      // ─── Header Section (Y: 30 to 90) ────────────────────────────────────
      doc.rect(30, 30, 535, 60).fill(primaryColor)

      // Left Header Text
      doc.fillColor('#ffffff')
         .font('Helvetica-Bold')
         .fontSize(16)
         .text(schoolName.toUpperCase(), 45, 42, { width: 350, align: 'left' })

      doc.font('Helvetica')
         .fontSize(9)
         .fillColor('#93c5fd') // Light blue
         .text(`OFFICIAL TERM REPORT CARD • BRANCH: ${branchCode}`, 45, 64)

      // Right Header Text (Exam & Session)
      const examName = reportCard[0]?.examName || 'Term Evaluation'
      doc.fillColor('#ffffff')
         .font('Helvetica-Bold')
         .fontSize(12)
         .text(examName.toUpperCase(), 350, 42, { width: 200, align: 'right' })

      doc.font('Helvetica')
         .fontSize(9)
         .fillColor('#e2e8f0')
         .text(`Session: ${sessionName || 'Active'}`, 350, 60, { width: 200, align: 'right' })
         .text(`Date printed: ${new Date().toLocaleDateString()}`, 350, 72, { width: 200, align: 'right' })

      let y = 105

      // ─── Student Profile Info Block (Y: 105 to 175) ─────────────────────
      doc.rect(30, y, 535, 70).stroke(lightBorder)

      // Left Column
      doc.fillColor(textMuted).font('Helvetica').fontSize(9)
         .text('Student Name:', 45, y + 12)
         .text('Registration No:', 45, y + 30)
         .text('Classroom Room:', 45, y + 48)

      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(9.5)
         .text(studentName, 130, y + 12)
         .text(registerNo || 'Pending', 130, y + 30)
         .text(`${className} (${sectionName || 'Main'})`, 130, y + 48)

      // Right Column
      doc.fillColor(textMuted).font('Helvetica').fontSize(9)
         .text('Overall Average:', 330, y + 12)
         .text('GPA Grade:', 330, y + 30)
         .text('Class Ranking:', 330, y + 48)

      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(9.5)
         .text(`${overallAverage}%`, 420, y + 12)
         .text(gpaRating, 420, y + 30)
         .text(rankString, 420, y + 48)

      y += 85

      // ─── Academic Scoreboard Table (Y: 190 onwards) ─────────────────────
      doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(11).text('ACADEMIC SCORE BOARD', 30, y)
      y += 15

      // Table Header Row
      doc.rect(30, y, 535, 20).fill(primaryColor)
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5)
         .text('SUBJECT CODE', 40, y + 6, { width: 75 })
         .text('SUBJECT NAME', 115, y + 6, { width: 160 })
         .text('TEST (40)', 280, y + 6, { width: 45, align: 'right' })
         .text('EXAM (60)', 330, y + 6, { width: 45, align: 'right' })
         .text('TOTAL (100)', 380, y + 6, { width: 50, align: 'right' })
         .text('CLASS AVG', 435, y + 6, { width: 60, align: 'right' })
         .text('GRADE', 500, y + 6, { width: 55, align: 'center' })
      
      y += 20

      // Table Data Rows
      const rowHeight = 20
      const maxRows = 12
      const itemsToRender = reportCard.slice(0, maxRows)

      itemsToRender.forEach((row, idx) => {
        // Alternate row backgrounds
        if (idx % 2 === 0) {
          doc.rect(30, y, 535, rowHeight).fill(lightBg)
        } else {
          doc.rect(30, y, 535, rowHeight).fill('#ffffff')
        }

        // Draw row borders
        doc.rect(30, y, 535, rowHeight).stroke(lightBorder)

        const testScore = row.cbtMark !== undefined && row.cbtMark !== null ? String(row.cbtMark) : '-'
        const examScore = row.theoryMark !== undefined && row.theoryMark !== null ? String(row.theoryMark) : '-'
        const totalScore = row.mark !== null ? String(row.mark) : '-'

        // Grade calculation based on total score
        let gradeLetter = '-'
        if (row.mark !== null && !isNaN(parseFloat(row.mark))) {
          const tot = parseFloat(row.mark)
          if (tot >= 70) gradeLetter = 'A'
          else if (tot >= 60) gradeLetter = 'B'
          else if (tot >= 50) gradeLetter = 'C'
          else if (tot >= 45) gradeLetter = 'D'
          else if (tot >= 40) gradeLetter = 'E'
          else gradeLetter = 'F'
        }

        doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(8)
           .text(row.subjectCode || '-', 40, y + 6, { width: 75 })

        doc.font('Helvetica').fontSize(8.5)
           .text(row.subjectName || '-', 115, y + 6, { width: 160 })

        doc.font('Helvetica').fontSize(8)
           .text(row.absent ? '-' : testScore, 280, y + 6, { width: 45, align: 'right' })
           .text(row.absent ? '-' : examScore, 330, y + 6, { width: 45, align: 'right' })
           .text(row.absent ? '-' : totalScore, 380, y + 6, { width: 50, align: 'right' })
           .text(row.absent ? '-' : `${row.classAverage}`, 435, y + 6, { width: 60, align: 'right' })

        doc.font('Helvetica-Bold').fontSize(8)
           .text(row.absent ? 'ABS' : gradeLetter, 500, y + 6, { width: 55, align: 'center' })

        y += rowHeight
      })

      // Add empty rows if subjects are few, to keep layout structure uniform
      if (itemsToRender.length < 5) {
        const fillers = 5 - itemsToRender.length
        for (let i = 0; i < fillers; i++) {
          doc.rect(30, y, 535, rowHeight).stroke(lightBorder)
          y += rowHeight
        }
      }

      y += 15

      // ─── Summary & Commentary Box ───────────────────────────────────────
      const remarksHeight = 90
      doc.rect(30, y, 320, remarksHeight).stroke(lightBorder)
      doc.rect(360, y, 205, remarksHeight).stroke(lightBorder)

      // Left: Commentary Title & Text
      doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(9)
         .text('FORM TEACHER HOLISTIC COMMENTARY', 40, y + 10)
      
      const remarkText = commentary || 'No performance remarks or behavioral feedback has been recorded for this term yet.'
      doc.fillColor(darkColor).font('Helvetica-Oblique').fontSize(8.5)
         .text(`"${remarkText}"`, 40, y + 26, { width: 300, height: 55, ellipsis: true })

      // Right: Term Overview & Info
      doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(9)
         .text('TERM OVERVIEW', 370, y + 10)

      doc.fillColor(textMuted).font('Helvetica').fontSize(8.5)
         .text('Next Term Resumption:', 370, y + 28)
      
      const resumptionStr = resumptionDate ? new Date(resumptionDate).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'To Be Announced'
      doc.fillColor(darkColor).font('Helvetica-Bold')
         .text(resumptionStr, 370, y + 40)

      doc.fillColor(textMuted).font('Helvetica')
         .text('Form Teacher:', 370, y + 58)
      doc.fillColor(darkColor).font('Helvetica-Bold')
         .text(formTeacherName, 370, y + 70)

      y += remarksHeight + 20

      // ─── Signature Block ────────────────────────────────────────────────
      const sigY = 700
      doc.moveTo(40, sigY).lineTo(220, sigY).stroke(lightBorder)
      doc.moveTo(375, sigY).lineTo(555, sigY).stroke(lightBorder)

      doc.fillColor(textMuted).font('Helvetica').fontSize(8)
         .text('FORM TEACHER SIGNATURE', 40, sigY + 5, { width: 180, align: 'center' })
         .text('SCHOOL PRINCIPAL SIGNATURE', 375, sigY + 5, { width: 180, align: 'center' })

      // ─── Footer ─────────────────────────────────────────────────────────
      doc.moveTo(30, 755).lineTo(565, 755).stroke('#e2e8f0')

      doc.fillColor(textMuted).font('Helvetica').fontSize(7.5)
         .text('This is an official computer-generated student evaluation record compiled on the Ugbekun 2.0 Portal.', 30, 765, { align: 'center', width: 535 })
         .text(`© ${new Date().getFullYear()} ${schoolName}. All rights reserved.`, 30, 775, { align: 'center', width: 535 })

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

function generateMontessoriReportCardPdf(params) {
  return new Promise((resolve, reject) => {
    try {
      const {
        schoolName = 'Ugbekun Schools',
        branchCode = 'GEN',
        studentName,
        registerNo = '',
        className = '',
        sectionName = '',
        sessionName = '',
        examName = 'Term Evaluation',
        assessment = {},
        resumptionDate = null,
        formTeacherName = 'Form Teacher'
      } = params

      // Create an A4-sized PDF with margins
      const doc = new PDFDocument({
        size: 'A4',
        margin: 30,
        info: {
          Title: `Montessori Assessment - ${studentName}`,
          Author: 'Ugbekun Schools Platform',
        },
      })

      const chunks = []
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // Theme Colors (Montessori / Early Childhood Theme: Emerald and Indigo)
      const primaryColor = '#059669'   // Emerald Green
      const secondaryColor = '#4f46e5' // Indigo
      const darkColor = '#0f172a'      // Slate-900
      const textMuted = '#475569'      // Slate-600
      const lightBorder = '#e2e8f0'    // Slate-200
      const lightBg = '#f8fafc'        // Slate-50

      // Helper function to draw rubric progress pill indicators
      const drawRatingPills = (doc, x, y, width, activeRating) => {
        const rubrics = ['EM', 'DV', 'AC', 'MS']
        const pillWidth = (width - 15) / 4
        const pillHeight = 15

        rubrics.forEach((code, idx) => {
          const rx = x + idx * (pillWidth + 5)
          const isActive = activeRating === code

          doc.save()
          if (isActive) {
            // Filled active badge
            doc.roundedRect(rx, y, pillWidth, pillHeight, 3).fill(primaryColor)
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5)
               .text(code, rx, y + 4, { width: pillWidth, align: 'center' })
          } else {
            // Muted hollow badge
            doc.roundedRect(rx, y, pillWidth, pillHeight, 3).stroke(lightBorder)
            doc.fillColor('#94a3b8').font('Helvetica').fontSize(7.5)
               .text(code, rx, y + 4, { width: pillWidth, align: 'center' })
          }
          doc.restore()
        })
      }

      // ─── Header Section (Y: 30 to 90) ────────────────────────────────────
      doc.rect(30, 30, 535, 60).fill(primaryColor)

      // Left Header Text
      doc.fillColor('#ffffff')
         .font('Helvetica-Bold')
         .fontSize(16)
         .text(schoolName.toUpperCase(), 45, 42, { width: 350, align: 'left' })

      doc.font('Helvetica')
         .fontSize(9)
         .fillColor('#d1fae5') // Light emerald green
         .text(`MONTESSORI & NARRATIVE ASSESSMENT SHEET`, 45, 64)

      // Right Header Text (Exam & Session)
      doc.fillColor('#ffffff')
         .font('Helvetica-Bold')
         .fontSize(12)
         .text(examName.toUpperCase(), 350, 42, { width: 200, align: 'right' })

      doc.font('Helvetica')
         .fontSize(9)
         .fillColor('#f0fdf4')
         .text(`Session: ${sessionName || 'Active'}`, 350, 60, { width: 200, align: 'right' })
         .text(`Date printed: ${new Date().toLocaleDateString()}`, 350, 72, { width: 200, align: 'right' })

      let y = 105

      // ─── Student Profile Info Block (Y: 105 to 165) ─────────────────────
      doc.rect(30, y, 535, 60).stroke(lightBorder)

      // Left Column
      doc.fillColor(textMuted).font('Helvetica').fontSize(9)
         .text('Student Name:', 45, y + 12)
         .text('Registration No:', 45, y + 28)
         .text('Classroom Room:', 45, y + 44)

      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(9.5)
         .text(studentName, 130, y + 12)
         .text(registerNo || 'Pending', 130, y + 28)
         .text(`${className} (${sectionName || 'Main'})`, 130, y + 44)

      // Right Column - Montessori Rubric Legend
      doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(8.5)
         .text('RUBRIC EVALUATION LEGEND:', 330, y + 12)
      
      doc.fillColor(textMuted).font('Helvetica').fontSize(8)
         .text('EM : Emerging (Starting to demonstrate skill)', 330, y + 26)
         .text('DV : Developing (Demonstrates occasionally)', 330, y + 36)
         .text('AC : Achieved (Performs consistently)', 330, y + 46)
         .text('MS : Mastered (Internalized skill / models for peers)', 330, y + 56)

      y += 75

      // ─── Assessment Matrix Tables (Y: 180 to 440) ─────────────────────
      doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(11).text('DEVELOPMENTAL PROGRESS MATRIX', 30, y)
      y += 15

      const cardWidth = 260
      const cardHeight = 240

      // Psychomotor Card Outer Border
      doc.roundedRect(30, y, cardWidth, cardHeight, 6).stroke(lightBorder)
      // Behavioral Card Outer Border
      doc.roundedRect(305, y, cardWidth, cardHeight, 6).stroke(lightBorder)

      // Card Headers
      doc.roundedRect(30, y, cardWidth, 24, 6).fill(primaryColor)
      doc.roundedRect(305, y, cardWidth, 24, 6).fill(secondaryColor)

      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
         .text('1. PSYCHOMOTOR DOMAIN', 40, y + 8, { width: cardWidth - 20 })
         .text('2. BEHAVIORAL DOMAIN', 315, y + 8, { width: cardWidth - 20 })

      let psychomotorY = y + 35
      let behavioralY = y + 35

      // Sub-domains list
      const psychomotorFields = [
        { key: 'writingMastery', label: 'Writing Mastery' },
        { key: 'drawingCapability', label: 'Drawing Capability' },
        { key: 'physicalCoordination', label: 'Physical Coordination' },
        { key: 'motorSkillProgression', label: 'Motor Skill Progression' }
      ]

      const behavioralFields = [
        { key: 'generalPunctuality', label: 'General Punctuality' },
        { key: 'peerRespect', label: 'Peer Respect' },
        { key: 'aestheticNeatness', label: 'Aesthetic Neatness' },
        { key: 'activeGroupParticipation', label: 'Active Group Participation' }
      ]

      // Draw Psychomotor Sub-domains
      psychomotorFields.forEach((field) => {
        doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(8.5)
           .text(field.label, 40, psychomotorY)
        
        const rating = assessment[field.key] || ''
        drawRatingPills(doc, 40, psychomotorY + 12, cardWidth - 20, rating)
        psychomotorY += 50
      })

      // Draw Behavioral Sub-domains
      behavioralFields.forEach((field) => {
        doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(8.5)
           .text(field.label, 315, behavioralY)
        
        const rating = assessment[field.key] || ''
        drawRatingPills(doc, 315, behavioralY + 12, cardWidth - 20, rating)
        behavioralY += 50
      })

      y += cardHeight + 20

      // ─── Narrative Commentary Box (Y: 440 to 580) ────────────────────────
      doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(11).text('HOLISTIC DEVELOPMENTAL COMMENTARY', 30, y)
      y += 15

      const commentHeight = 110
      doc.roundedRect(30, y, 535, commentHeight, 6).stroke(lightBorder)
      
      const commentText = assessment.narrativeComment || 'No qualitative narrative commentary or developmental remarks have been logged for this term evaluation.'
      doc.fillColor(darkColor).font('Helvetica-Oblique').fontSize(9)
         .text(`"${commentText}"`, 42, y + 12, { width: 511, height: commentHeight - 24, align: 'justify', lineGap: 3 })

      y += commentHeight + 15

      // ─── Resumption & Form Teacher Details ────────────────────────────────
      doc.rect(30, y, 535, 40).stroke(lightBorder)
      
      doc.fillColor(textMuted).font('Helvetica').fontSize(8.5)
         .text('Next Term Resumption:', 45, y + 10)
         .text('Form Teacher Name:', 300, y + 10)

      const resumptionStr = resumptionDate ? new Date(resumptionDate).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'To Be Announced'
      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(9)
         .text(resumptionStr, 45, y + 22)
         .text(formTeacherName, 300, y + 22)

      y += 65

      // ─── Signature Block ────────────────────────────────────────────────
      const sigY = 710
      doc.moveTo(40, sigY).lineTo(220, sigY).stroke(lightBorder)
      doc.moveTo(375, sigY).lineTo(555, sigY).stroke(lightBorder)

      doc.fillColor(textMuted).font('Helvetica').fontSize(8)
         .text('FORM TEACHER SIGNATURE', 40, sigY + 5, { width: 180, align: 'center' })
         .text('SCHOOL PRINCIPAL SIGNATURE', 375, sigY + 5, { width: 180, align: 'center' })

      // ─── Footer ─────────────────────────────────────────────────────────
      doc.moveTo(30, 755).lineTo(565, 755).stroke('#e2e8f0')

      doc.fillColor(textMuted).font('Helvetica').fontSize(7.5)
         .text('This is an official computer-generated student narrative evaluation compiled on the Ugbekun 2.0 Portal.', 30, 765, { align: 'center', width: 535 })
         .text(`© ${new Date().getFullYear()} ${schoolName}. All rights reserved.`, 30, 775, { align: 'center', width: 535 })

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

function fetchImage(photoPath) {
  return new Promise((resolve) => {
    if (!photoPath) return resolve(null);
    if (photoPath.startsWith('/uploads/') || photoPath.startsWith('uploads/')) {
      const cleanPath = photoPath.startsWith('/') ? photoPath.slice(1) : photoPath;
      const fullPath = path.join(__dirname, '..', cleanPath);
      fs.readFile(fullPath, (err, data) => {
        if (err) resolve(null);
        else resolve(data);
      });
      return;
    }
    if (photoPath.startsWith('http://') || photoPath.startsWith('https://')) {
      https.get(photoPath, (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
      return;
    }
    const localFallback = path.join(__dirname, '..', photoPath);
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
          doc.image(photoBuffer, photoX + 1, photoY + 1, { width: photoW - 2, height: photoH - 2 });
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
          doc.image(photoBuffer, photoX + 1, photoY + 1, { width: photoW - 2, height: photoH - 2 });
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

function drawPhotoPlaceholder(doc, x, y, w, h) {
  doc.rect(x + 1, y + 1, w - 2, h - 2).fill('#f1f5f9');
  doc.fillColor('#94a3b8').font('Helvetica-Bold').fontSize(6)
     .text('PHOTO', x, y + h / 2 - 8, { width: w, align: 'center' })
     .text('PLACEHOLDER', x, y + h / 2, { width: w, align: 'center' });
}

module.exports = {
  generateCredentialSlipPdf,
  generateReportCardPdf,
  generateMontessoriReportCardPdf,
  generateStudentIdCardPdf,
  generateStaffIdCardPdf,
  generateCertificatePdf
}
