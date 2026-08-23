/**
 * Email Template Builder
 *
 * Separated from email service to keep rendering logic testable,
 * reusable (password reset, report cards, announcements), and
 * easy to reskin without touching delivery infrastructure.
 *
 * All templates use inline CSS only — email clients strip <link> tags
 * and most <style> blocks. Dynamic values are HTML-escaped.
 */

/**
 * Escape HTML entities to prevent XSS in email clients.
 */
export function escapeHtml(str?: string | number | null): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface OnboardingEmailData {
  parentName?: string;
  studentName: string;
  registerNo?: string;
  studentUsername: string;
  studentPassword: string;
  parentUsername?: string | null;
  parentPassword?: string | null;
  schoolName?: string;
  branchCode?: string;
  loginUrl?: string;
  isExistingParent?: boolean;
}

/**
 * Builds a branded HTML email for student onboarding credentials.
 */
export function buildOnboardingEmail(data: OnboardingEmailData): { subject: string; html: string } {
  const {
    parentName,
    studentName,
    registerNo,
    studentUsername,
    studentPassword,
    parentUsername,
    parentPassword,
    schoolName,
    branchCode,
    loginUrl,
    isExistingParent = false,
  } = data;

  const safe = {
    parentName: escapeHtml(parentName || 'Parent'),
    studentName: escapeHtml(studentName),
    registerNo: escapeHtml(registerNo || ''),
    studentUsername: escapeHtml(studentUsername),
    studentPassword: escapeHtml(studentPassword),
    parentUsername: escapeHtml(parentUsername || ''),
    parentPassword: escapeHtml(parentPassword || ''),
    schoolName: escapeHtml(schoolName || 'Your School'),
    branchCode: escapeHtml(branchCode || ''),
    loginUrl: escapeHtml(loginUrl || ''),
  };

  const subject = `Welcome to ${safe.schoolName} — Login Credentials for ${safe.studentName}`;

  let parentCredentialsBlock = '';
  if (!isExistingParent && parentUsername && parentPassword) {
    parentCredentialsBlock = `
      <tr>
        <td style="padding: 0 30px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f0f7f0; border-radius: 8px; border-left: 4px solid #2e7d32;">
            <tr>
              <td style="padding: 20px;">
                <p style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #2e7d32; text-transform: uppercase; letter-spacing: 0.5px;">
                  👤 Parent Account
                </p>
                <table cellpadding="0" cellspacing="0" style="width: 100%;">
                  <tr>
                    <td style="padding: 6px 0; font-size: 14px; color: #555; width: 100px;">Username:</td>
                    <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #1a1a1a; font-family: 'Courier New', monospace;">${safe.parentUsername}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; font-size: 14px; color: #555; width: 100px;">Password:</td>
                    <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #1a1a1a; font-family: 'Courier New', monospace;">${safe.parentPassword}</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f6f8; padding: 30px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #1b5e20, #2e7d32); padding: 30px; text-align: center;">
              <h1 style="margin: 0 0 6px; font-size: 22px; font-weight: 700; color: #ffffff;">
                🎓 Welcome to ${safe.schoolName}
              </h1>
              ${safe.branchCode ? `<p style="margin: 0; font-size: 13px; color: rgba(255,255,255,0.8);">Branch Code: ${safe.branchCode}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 30px 10px;">
              <p style="margin: 0 0 14px; font-size: 16px; color: #333;">
                Dear <strong>${safe.parentName}</strong>,
              </p>
              <p style="margin: 0 0 14px; font-size: 15px; color: #555; line-height: 1.6;">
                Congratulations! <strong>${safe.studentName}</strong> has been successfully enrolled at 
                <strong>${safe.schoolName}</strong>.
                ${safe.registerNo ? `Their registration number is <strong>${safe.registerNo}</strong>.` : ''}
              </p>
              <p style="margin: 0 0 6px; font-size: 15px; color: #555; line-height: 1.6;">
                Below are the portal login credentials. Please keep these safe and confidential.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 30px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #e8f5e9; border-radius: 8px; border-left: 4px solid #1b5e20;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #1b5e20; text-transform: uppercase; letter-spacing: 0.5px;">
                      👨‍🎓 Student Account
                    </p>
                    <table cellpadding="0" cellspacing="0" style="width: 100%;">
                      <tr>
                        <td style="padding: 6px 0; font-size: 14px; color: #555; width: 100px;">Username:</td>
                        <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #1a1a1a; font-family: 'Courier New', monospace;">${safe.studentUsername}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; font-size: 14px; color: #555; width: 100px;">Password:</td>
                        <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #1a1a1a; font-family: 'Courier New', monospace;">${safe.studentPassword}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${parentCredentialsBlock}
          <tr>
            <td style="padding: 10px 30px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fff8e1; border-radius: 8px; border-left: 4px solid #f9a825;">
                <tr>
                  <td style="padding: 14px 20px;">
                    <p style="margin: 0; font-size: 13px; color: #795600; line-height: 1.5;">
                      ⚠️ <strong>Security Notice:</strong> Please change both passwords immediately after your first login. Do not share these credentials with anyone.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 30px; border-top: 1px solid #eee; text-align: center;">
              <p style="margin: 0 0 4px; font-size: 12px; color: #999;">
                This is an automated message from the Ugbekun Schools Platform.
              </p>
              <p style="margin: 0; font-size: 12px; color: #bbb;">
                © ${new Date().getFullYear()} Ugbekun. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

export interface TeacherOnboardingEmailData {
  teacherName?: string;
  username: string;
  password: string;
  schoolName?: string;
  branchCode?: string;
  loginUrl?: string;
}

export function buildTeacherOnboardingEmail(data: TeacherOnboardingEmailData): { subject: string; html: string } {
  const {
    teacherName,
    username,
    password,
    schoolName,
    branchCode,
    loginUrl,
  } = data;

  const safe = {
    teacherName: escapeHtml(teacherName || 'Teacher'),
    username: escapeHtml(username),
    password: escapeHtml(password),
    schoolName: escapeHtml(schoolName || 'Your School'),
    branchCode: escapeHtml(branchCode || ''),
    loginUrl: escapeHtml(loginUrl || ''),
  };

  const subject = `Welcome to ${safe.schoolName} — Teacher Access Credentials`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f6f8; padding: 30px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #001a4e, #003da5); padding: 30px; text-align: center;">
              <h1 style="margin: 0 0 6px; font-size: 22px; font-weight: 700; color: #ffffff;">
                🎓 Welcome to ${safe.schoolName}
              </h1>
              ${safe.branchCode ? `<p style="margin: 0; font-size: 13px; color: rgba(255,255,255,0.8);">Branch Code: ${safe.branchCode}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 30px 10px;">
              <p style="margin: 0 0 14px; font-size: 16px; color: #333;">
                Dear <strong>${safe.teacherName}</strong>,
              </p>
              <p style="margin: 0 0 14px; font-size: 15px; color: #555; line-height: 1.6;">
                You have been registered as an academic staff member at <strong>${safe.schoolName}</strong>. 
                Below are your portal login credentials. Please keep these safe and confidential.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 30px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f0f4fa; border-radius: 8px; border-left: 4px solid #003da5;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #003da5; text-transform: uppercase; letter-spacing: 0.5px;">
                      💼 Teacher Account
                    </p>
                    <table cellpadding="0" cellspacing="0" style="width: 100%;">
                      <tr>
                        <td style="padding: 6px 0; font-size: 14px; color: #555; width: 100px;">Username:</td>
                        <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #1a1a1a; font-family: 'Courier New', monospace;">${safe.username}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; font-size: 14px; color: #555; width: 100px;">Password:</td>
                        <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #1a1a1a; font-family: 'Courier New', monospace;">${safe.password}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 30px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fff8e1; border-radius: 8px; border-left: 4px solid #f9a825;">
                <tr>
                  <td style="padding: 14px 20px;">
                    <p style="margin: 0; font-size: 13px; color: #795600; line-height: 1.5;">
                      ⚠️ <strong>Security Notice:</strong> Please change your password immediately after your first login. Do not share these credentials with anyone.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 30px; border-top: 1px solid #eee; text-align: center;">
              <p style="margin: 0 0 4px; font-size: 12px; color: #999;">
                This is an automated message from the Ugbekun Schools Platform.
              </p>
              <p style="margin: 0; font-size: 12px; color: #bbb;">
                © ${new Date().getFullYear()} Ugbekun. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

export interface GracePeriodEmailData {
  schoolName?: string;
  days: number | string;
  newExpiryDate: string;
  reason?: string;
  loginUrl?: string;
}

export function buildGracePeriodExtensionEmail(data: GracePeriodEmailData): { subject: string; html: string } {
  const {
    schoolName,
    days,
    newExpiryDate,
    reason,
    loginUrl,
  } = data;

  const safe = {
    schoolName: escapeHtml(schoolName || 'Your School'),
    days: escapeHtml(days),
    newExpiryDate: escapeHtml(newExpiryDate),
    reason: escapeHtml(reason || 'No reason provided'),
    loginUrl: escapeHtml(loginUrl || ''),
  };

  const subject = `Grace Period Granted — ${safe.days} Days Extension for ${safe.schoolName}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f6f8; padding: 30px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #d97706, #b45309); padding: 30px; text-align: center;">
              <h1 style="margin: 0 0 6px; font-size: 22px; font-weight: 700; color: #ffffff;">
                ⏳ Subscription Grace Period Extended
              </h1>
              <p style="margin: 0; font-size: 13px; color: rgba(255,255,255,0.9);">${safe.schoolName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 30px 10px;">
              <p style="margin: 0 0 14px; font-size: 16px; color: #333;">
                Hello Administrator,
              </p>
              <p style="margin: 0 0 14px; font-size: 15px; color: #555; line-height: 1.6;">
                A grace period of <strong>${safe.days} days</strong> has been granted for your school branch, <strong>${safe.schoolName}</strong>. 
                Your branch access remains fully active.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 30px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fef3c7; border-radius: 8px; border-left: 4px solid #d97706;">
                <tr>
                  <td style="padding: 20px;">
                    <table cellpadding="0" cellspacing="0" style="width: 100%;">
                      <tr>
                        <td style="padding: 6px 0; font-size: 14px; color: #555; width: 150px;">Extension Days:</td>
                        <td style="padding: 6px 0; font-size: 14px; font-weight: 700; color: #1a1a1a;">${safe.days} Day(s)</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; font-size: 14px; color: #555; width: 150px;">New Expiry Date:</td>
                        <td style="padding: 6px 0; font-size: 14px; font-weight: 700; color: #1a1a1a;">${safe.newExpiryDate}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; font-size: 14px; color: #555; width: 150px; vertical-align: top;">Reason:</td>
                        <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #555; font-style: italic;">${safe.reason}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 30px 20px;">
              <p style="margin: 0; font-size: 14px; color: #555; line-height: 1.5;">
                Please ensure you renew your subscription plan before the new expiry date to avoid service interruption.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 30px; border-top: 1px solid #eee; text-align: center;">
              <p style="margin: 0 0 4px; font-size: 12px; color: #999;">
                This is an automated system notification from the Ugbekun Schools Platform.
              </p>
              <p style="margin: 0; font-size: 12px; color: #bbb;">
                © ${new Date().getFullYear()} Ugbekun. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

export interface PasswordResetEmailData {
  username?: string;
  resetCode: string | number;
  schoolName?: string;
}

export function buildPasswordResetEmail(data: PasswordResetEmailData): { subject: string; html: string } {
  const { username, resetCode, schoolName } = data;
  const safe = {
    username: escapeHtml(username || 'User'),
    resetCode: escapeHtml(resetCode),
    schoolName: escapeHtml(schoolName || 'Ugbekun School Management System'),
  };

  const subject = `Password Reset Verification Code: ${safe.resetCode} - ${safe.schoolName}`;
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; background-color: #f4f6f9; margin: 0; padding: 30px; color: #1e293b;">
  <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
    <h2 style="color: #0b1536; font-size: 22px; font-weight: 800; margin-top: 0;">Password Reset Request</h2>
    <p style="font-size: 14px; color: #475569; line-height: 1.6;">
      Hello <strong>${safe.username}</strong>,<br/>
      We received a request to reset the password for your account on <strong>${safe.schoolName}</strong>.
    </p>
    <div style="background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0;">
      <span style="font-size: 11px; color: #1e40af; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 8px;">Your 6-Digit Reset Code</span>
      <span style="font-size: 32px; font-weight: 900; font-family: monospace; color: #1d4ed8; letter-spacing: 6px;">${safe.resetCode}</span>
    </div>
    <p style="font-size: 13px; color: #64748b; line-height: 1.5;">
      This code is valid for <strong>15 minutes</strong>. If you did not request a password reset, please ignore this message.
    </p>
    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;"/>
    <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">
      &copy; ${new Date().getFullYear()} Ugbekun School Management System. All rights reserved.
    </p>
  </div>
</body>
</html>`;

  return { subject, html };
}

export default {
  buildOnboardingEmail,
  buildTeacherOnboardingEmail,
  buildGracePeriodExtensionEmail,
  buildPasswordResetEmail,
  escapeHtml,
};
