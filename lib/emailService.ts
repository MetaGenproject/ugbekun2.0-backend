import nodemailer from 'nodemailer';
import dns from 'dns';
import {
  buildOnboardingEmail,
  buildTeacherOnboardingEmail,
  buildGracePeriodExtensionEmail,
  OnboardingEmailData,
  TeacherOnboardingEmailData,
  GracePeriodEmailData,
} from './emailTemplates';

// Force IPv4-first DNS resolution — prevents ENETUNREACH on networks
// without IPv6 support (mail.ugbekun.com is behind Cloudflare which
// returns both AAAA and A records)
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

// ─── Configuration Validation ──────────────────────────────────────────────────

export const SMTP_CONFIG = {
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465', 10) || 465,
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || process.env.SMTP_USER,
};

function liveSmtp() {
  return {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465', 10) || 465,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
  };
}

export function isSmtpConfigured() {
  const cfg = liveSmtp();
  return Boolean(cfg.host && cfg.user && cfg.pass);
}

const REQUIRED_VARS: Array<keyof typeof SMTP_CONFIG> = ['host', 'user', 'pass'];
const missingVars = REQUIRED_VARS.filter((key) => !SMTP_CONFIG[key]);

export const isConfigured = isSmtpConfigured();

if (!isConfigured) {
  console.warn(
    `[EMAIL SERVICE] ⚠️  SMTP not fully configured — missing: ${missingVars.join(', ')}. ` +
      `Email delivery is disabled. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env to enable.`
  );
} else {
  console.log(`[EMAIL SERVICE] ✓ SMTP configured → ${SMTP_CONFIG.host}:${SMTP_CONFIG.port} as ${SMTP_CONFIG.user}`);
}

// ─── Transporter (Lazy Singleton) ──────────────────────────────────────────────

let _transporter: nodemailer.Transporter | null = null;

export function resetEmailRuntime() {
  _transporter = null;
}

export function getTransporter(): nodemailer.Transporter {
  if (_transporter) return _transporter;

  const cfg = liveSmtp();
  const isSecure = cfg.port === 465;

  _transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: isSecure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    dnsTimeout: 10_000,
    tls: {
      rejectUnauthorized: false,
      servername: cfg.host || 'mail.ugbekun.com',
    },
  } as any);

  return _transporter;
}

// ─── Core Send Function ────────────────────────────────────────────────────────

export interface SendMailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send an email. Never throws — returns a structured result object.
 */
export async function sendMail(
  to: string,
  subject: string,
  html: string,
  options: any = {}
): Promise<SendMailResult> {
  if (process.env.EMAIL_ENABLED === 'false') {
    console.warn(`[EMAIL SERVICE] Skipping email to ${to} — email delivery is disabled globally.`);
    return { success: false, error: 'Email delivery is disabled' };
  }

  if (!isSmtpConfigured()) {
    console.warn(`[EMAIL SERVICE] Skipping email to ${to} — SMTP not configured.`);
    return { success: false, error: 'SMTP not configured' };
  }

  if (!to || !subject) {
    return { success: false, error: 'Recipient and subject are required' };
  }

  try {
    const cfg = liveSmtp();
    const transporter = getTransporter();
    const mailOptions = {
      from: cfg.from,
      to,
      subject,
      html,
      ...options,
    };

    const info = await transporter.sendMail(mailOptions);

    console.log(
      `[EMAIL SERVICE] ✓ Email sent to ${to} | Subject: "${subject}" | MessageId: ${info.messageId}`
    );

    return { success: true, messageId: info.messageId };
  } catch (err: any) {
    console.error(`[EMAIL SERVICE] ✗ Failed to send email to ${to}`, {
      subject,
      errorCode: err.code,
      errorMessage: err.message,
      responseCode: err.responseCode,
      command: err.command,
    });

    return {
      success: false,
      error: err.message || 'Unknown email delivery error',
    };
  }
}

/**
 * Sends student + parent login credentials to the parent's email.
 */
export async function sendOnboardingCredentials(
  payload: OnboardingEmailData & { parentEmail?: string }
): Promise<SendMailResult> {
  const { parentEmail } = payload;

  if (!parentEmail) {
    console.warn('[EMAIL SERVICE] No parent email provided — skipping onboarding email.');
    return { success: false, error: 'No parent email provided' };
  }

  const { subject, html } = buildOnboardingEmail(payload);
  return sendMail(parentEmail, subject, html);
}

/**
 * Sends teacher login credentials to the teacher's email.
 */
export async function sendTeacherOnboardingCredentials(
  payload: TeacherOnboardingEmailData & { teacherEmail?: string }
): Promise<SendMailResult> {
  const { teacherEmail } = payload;

  if (!teacherEmail) {
    console.warn('[EMAIL SERVICE] No teacher email provided — skipping onboarding email.');
    return { success: false, error: 'No teacher email provided' };
  }

  const { subject, html } = buildTeacherOnboardingEmail(payload);
  return sendMail(teacherEmail, subject, html);
}

/**
 * Sends a subscription grace period extension email to the school branch admin.
 */
export async function sendGracePeriodExtensionEmail(
  payload: GracePeriodEmailData & { adminEmail?: string }
): Promise<SendMailResult> {
  const { adminEmail } = payload;

  if (!adminEmail) {
    console.warn('[EMAIL SERVICE] No admin email provided — skipping grace period extension email.');
    return { success: false, error: 'No admin email provided' };
  }

  const { subject, html } = buildGracePeriodExtensionEmail(payload);
  return sendMail(adminEmail, subject, html);
}

export default {
  sendMail,
  sendOnboardingCredentials,
  sendTeacherOnboardingCredentials,
  sendGracePeriodExtensionEmail,
  isConfigured,
};
