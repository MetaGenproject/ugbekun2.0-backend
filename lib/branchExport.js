const PDFDocument = require('pdfkit')

const BRANCH_SELECT = {
  id: true,
  name: true,
  code: true,
  address: true,
  city: true,
  state: true,
  phone: true,
  email: true,
  adminName: true,
  active: true,
  createdAt: true,
  updatedAt: true,
}

const CSV_HEADERS = [
  'ID',
  'School Name',
  'Code',
  'Branch Admin',
  'Email',
  'Phone',
  'City',
  'State',
  'Address',
  'Status',
  'Students',
  'Parents',
  'Teachers',
  'Staff',
  'Created At',
]

function escapeCsv(value) {
  const str = value == null ? '' : String(value)
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function formatBranchRow(branch) {
  return {
    id: branch.id,
    name: branch.name,
    code: branch.code || '',
    adminName: branch.adminName || '',
    email: branch.email || '',
    phone: branch.phone || '',
    city: branch.city || '',
    state: branch.state || '',
    address: branch.address || '',
    status: branch.active ? 'Active' : 'Inactive',
    students: branch.students ?? 0,
    parents: branch.parents ?? 0,
    teachers: branch.teachers ?? 0,
    staff: branch.staff ?? 0,
    createdAt: branch.createdAt ? new Date(branch.createdAt).toISOString() : '',
  }
}

function branchesToCsv(branches) {
  const lines = [CSV_HEADERS.join(',')]
  for (const branch of branches) {
    const row = formatBranchRow(branch)
    lines.push([
      row.id,
      escapeCsv(row.name),
      escapeCsv(row.code),
      escapeCsv(row.adminName),
      escapeCsv(row.email),
      escapeCsv(row.phone),
      escapeCsv(row.city),
      escapeCsv(row.state),
      escapeCsv(row.address),
      row.status,
      row.students,
      row.parents,
      row.teachers,
      row.staff,
      escapeCsv(row.createdAt),
    ].join(','))
  }
  return lines.join('\n')
}

function buildBranchesPdf(branches, title = 'Ugbekun Branch Directory') {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' })
    const chunks = []

    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.fontSize(18).text(title, { align: 'center' })
    doc.moveDown(0.5)
    doc.fontSize(10).fillColor('#555555').text(
      `Generated ${new Date().toLocaleString()} · ${branches.length} branch${branches.length === 1 ? '' : 'es'}`,
      { align: 'center' }
    )
    doc.moveDown(1.2)
    doc.fillColor('#000000')

    branches.forEach((branch, index) => {
      const row = formatBranchRow(branch)
      if (index > 0) doc.moveDown(0.6)

      if (doc.y > 700) doc.addPage()

      doc.fontSize(12).font('Helvetica-Bold').text(`${row.id}. ${row.name}`)
      doc.font('Helvetica').fontSize(10)
      doc.text(`Code: ${row.code || '—'}  ·  Admin: ${row.adminName || '—'}  ·  ${row.status}`)
      doc.text(`Email: ${row.email || '—'}  ·  Phone: ${row.phone || '—'}`)
      doc.text(`Location: ${[row.city, row.state].filter(Boolean).join(', ') || '—'}`)
      doc.text(`Students: ${row.students}  ·  Parents: ${row.parents}  ·  Teachers: ${row.teachers}  ·  Staff: ${row.staff}`)
      if (row.address) {
        doc.text(`Address: ${row.address}`)
      }
    })

    doc.end()
  })
}

module.exports = {
  BRANCH_SELECT,
  branchesToCsv,
  buildBranchesPdf,
  formatBranchRow,
}
