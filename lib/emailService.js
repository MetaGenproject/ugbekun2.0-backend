/**
 * Email Service
 *
 * Production-grade SMTP delivery with:
 * - Config validation on load (graceful degradation if SMTP unconfigured)
 * - Singleton transporter with connection pooling
 * - Structured error handling (never throws — always returns result object)
 * - Timeout protection against hanging connections
 */

const nodemailer = require('nodemailer')
const dns = require('dns')
const { buildOnboardingEmail, buildTeacherOnboardingEmail } = require('./emailTemplates')

// Force IPv4-first DNS resolution — prevents ENETUNREACH on networks
// without IPv6 support (mail.ugbekun.com is behind Cloudflare which
// returns both AAAA and A records)
dns.setDefaultResultOrder('ipv4first')

// ─── Configuration Validation ──────────────────────────────────────────────────

const SMTP_CONFIG = {
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT, 10) || 465,
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || process.env.SMTP_USER,
}

const REQUIRED_VARS = ['host', 'user', 'pass']
const missingVars = REQUIRED_VARS.filter((key) => !SMTP_CONFIG[key])

const isConfigured = missingVars.length === 0

if (!isConfigured) {
  console.warn(
    `[EMAIL SERVICE] ⚠️  SMTP not fully configured — missing: ${missingVars.join(', ')}. ` +
    `Email delivery is disabled. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env to enable.`
  )
} else {
  console.log(`[EMAIL SERVICE] ✓ SMTP configured → ${SMTP_CONFIG.host}:${SMTP_CONFIG.port} as ${SMTP_CONFIG.user}`)
}

// ─── Transporter (Lazy Singleton) ──────────────────────────────────────────────

let _transporter = null

function getTransporter() {
  if (_transporter) return _transporter

  const isSecure = SMTP_CONFIG.port === 465

  _transporter = nodemailer.createTransport({
    host: SMTP_CONFIG.host,
    port: SMTP_CONFIG.port,
    secure: isSecure, // true for 465 (SMTPS), false for 587 (STARTTLS — upgrades after EHLO)
    auth: {
      user: SMTP_CONFIG.user,
      pass: SMTP_CONFIG.pass,
    },
    // Connection pooling — reuses connections across sends
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    // Timeout protection
    connectionTimeout: 15_000, // 15s to establish connection
    greetingTimeout: 15_000,   // 15s for server greeting
    socketTimeout: 20_000,     // 20s for socket inactivity
    dnsTimeout: 10_000,
    // Force IPv4 — prevents ENETUNREACH on networks without IPv6 support
    // (mail.ugbekun.com is behind Cloudflare, resolves to both AAAA + A records)
    // nodemailer uses dns.lookup internally; setting family:4 forces A-record only
    socketOptions: {
      family: 4,
    },
    // TLS options for shared hosting / Cloudflare-proxied mail servers
    tls: {
      rejectUnauthorized: false,
      servername: 'mail.ugbekun.com',
    },
  })

  return _transporter
}

// ─── Core Send Function ────────────────────────────────────────────────────────

/**
 * Send an email. Never throws — returns a structured result object.
 *
 * @param {string} to       - Recipient email address
 * @param {string} subject  - Email subject line
 * @param {string} html     - HTML body content
 * @param {object} [options] - Additional nodemailer options (cc, bcc, attachments, etc.)
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendMail(to, subject, html, options = {}) {
  if (!isConfigured) {
    console.warn(`[EMAIL SERVICE] Skipping email to ${to} — SMTP not configured.`)
    return { success: false, error: 'SMTP not configured' }
  }

  if (!to || !subject) {
    return { success: false, error: 'Recipient and subject are required' }
  }

  try {
    const transporter = getTransporter()
    const mailOptions = {
      from: SMTP_CONFIG.from,
      to,
      subject,
      html,
      ...options,
    }

    const info = await transporter.sendMail(mailOptions)

    console.log(
      `[EMAIL SERVICE] ✓ Email sent to ${to} | Subject: "${subject}" | MessageId: ${info.messageId}`
    )

    return { success: true, messageId: info.messageId }
  } catch (err) {
    // Structured error logging with context for debugging
    console.error(`[EMAIL SERVICE] ✗ Failed to send email to ${to}`, {
      subject,
      errorCode: err.code,
      errorMessage: err.message,
      responseCode: err.responseCode,
      command: err.command,
    })

    return {
      success: false,
      error: err.message || 'Unknown email delivery error',
    }
  }
}

// ─── Onboarding Credentials Email ──────────────────────────────────────────────

/**
 * Sends student + parent login credentials to the parent's email
 * after a successful onboarding transaction.
 *
 * @param {object} payload
 * @param {string} payload.parentEmail       - Recipient email
 * @param {string} payload.parentName        - Parent display name
 * @param {string} payload.studentName       - Student full name
 * @param {string} payload.registerNo        - Student registration number
 * @param {string} payload.studentUsername    - Student login username
 * @param {string} payload.studentPassword   - Student plaintext password
 * @param {string} [payload.parentUsername]   - Parent login username (null if existing)
 * @param {string} [payload.parentPassword]  - Parent plaintext password (null if existing)
 * @param {boolean} [payload.isExistingParent] - True if parent already had an account
 * @param {string} payload.schoolName        - School / branch name
 * @param {string} [payload.branchCode]      - Branch code
 * @param {string} payload.loginUrl          - Frontend login URL
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendOnboardingCredentials(payload) {
  const { parentEmail } = payload

  if (!parentEmail) {
    console.warn('[EMAIL SERVICE] No parent email provided — skipping onboarding email.')
    return { success: false, error: 'No parent email provided' }
  }

  const { subject, html } = buildOnboardingEmail(payload)
  return sendMail(parentEmail, subject, html)
}

// ─── Teacher Onboarding Credentials Email ────────────────────────────────────────

/**
 * Sends teacher login credentials to the teacher's email.
 *
 * @param {object} payload
 * @param {string} payload.teacherEmail      - Recipient email
 * @param {string} payload.teacherName       - Teacher display name
 * @param {string} payload.username          - Teacher login username
 * @param {string} payload.password          - Teacher plaintext password
 * @param {string} payload.schoolName        - School / branch name
 * @param {string} [payload.branchCode]      - Branch code
 * @param {string} payload.loginUrl          - Frontend login URL
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendTeacherOnboardingCredentials(payload) {
  const { teacherEmail } = payload

  if (!teacherEmail) {
    console.warn('[EMAIL SERVICE] No teacher email provided — skipping onboarding email.')
    return { success: false, error: 'No teacher email provided' }
  }

  const { subject, html } = buildTeacherOnboardingEmail(payload)
  return sendMail(teacherEmail, subject, html)
}

module.exports = {
  sendMail,
  sendOnboardingCredentials,
  sendTeacherOnboardingCredentials,
  isConfigured,
}
