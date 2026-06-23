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
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Builds a branded HTML email for student onboarding credentials.
 *
 * @param {object} data
 * @param {string} data.parentName       - Parent's display name
 * @param {string} data.studentName      - Student's full name (first + last)
 * @param {string} data.registerNo       - Student registration number
 * @param {string} data.studentUsername   - Student login username
 * @param {string} data.studentPassword  - Student plaintext password
 * @param {string} [data.parentUsername]  - Parent login username (null if existing parent)
 * @param {string} [data.parentPassword] - Parent plaintext password (null if existing parent)
 * @param {string} data.schoolName       - Branch / school display name
 * @param {string} [data.branchCode]     - Branch code (e.g. "MTGA")
 * @param {string} data.loginUrl         - Frontend login page URL
 * @param {boolean} [data.isExistingParent] - True when parent already had an account
 * @returns {{ subject: string, html: string }}
 */
function buildOnboardingEmail(data) {
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
  } = data

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
  }

  const subject = `Welcome to ${safe.schoolName} — Login Credentials for ${safe.studentName}`

  // ── Parent credentials block ──────────────────────────────────────
  let parentCredentialsBlock = ''
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
      </tr>`
  } else if (isExistingParent) {
    parentCredentialsBlock = `
      <tr>
        <td style="padding: 0 30px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; border-radius: 8px; border-left: 4px solid #888;">
            <tr>
              <td style="padding: 16px 20px;">
                <p style="margin: 0; font-size: 14px; color: #555;">
                  👤 <strong>Parent Account</strong> — Your existing login credentials remain unchanged.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
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

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #1b5e20, #2e7d32); padding: 30px; text-align: center;">
              <h1 style="margin: 0 0 6px; font-size: 22px; font-weight: 700; color: #ffffff;">
                🎓 Welcome to ${safe.schoolName}
              </h1>
              ${safe.branchCode ? `<p style="margin: 0; font-size: 13px; color: rgba(255,255,255,0.8);">Branch Code: ${safe.branchCode}</p>` : ''}
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding: 30px 30px 10px;">
              <p style="margin: 0 0 14px; font-size: 16px; color: #333;">
                Dear <strong>${safe.parentName}</strong>,
              </p>
              <p style="margin: 0 0 14px; font-size: 15px; color: #555; line-height: 1.6;">
                Your child <strong>${safe.studentName}</strong> has been successfully enrolled at
                <strong>${safe.schoolName}</strong>.
                ${safe.registerNo ? `Their registration number is <strong>${safe.registerNo}</strong>.` : ''}
              </p>
              <p style="margin: 0 0 6px; font-size: 15px; color: #555; line-height: 1.6;">
                Below are the portal login credentials. Please keep these safe and confidential.
              </p>
            </td>
          </tr>

          <!-- Student Credentials -->
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

          <!-- Parent Credentials -->
          ${parentCredentialsBlock}

          <!-- Security Warning -->
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

          <!-- CTA Button -->
          <tr>
            <td style="padding: 10px 30px 30px; text-align: center;">
              <a href="${safe.loginUrl}"
                 style="display: inline-block; padding: 14px 36px; background: linear-gradient(135deg, #1b5e20, #2e7d32); color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 600; letter-spacing: 0.3px;">
                Login to School Portal →
              </a>
            </td>
          </tr>

          <!-- Footer -->
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
</html>`

  return { subject, html }
}

/**
 * Builds a branded HTML email for teacher onboarding credentials.
 *
 * @param {object} data
 * @param {string} data.teacherName      - Teacher full name
 * @param {string} data.username         - Teacher login username
 * @param {string} data.password         - Teacher plaintext password
 * @param {string} data.schoolName       - Branch / school name
 * @param {string} [data.branchCode]     - Branch code
 * @param {string} data.loginUrl         - Frontend login URL
 * @returns {{ subject: string, html: string }}
 */
function buildTeacherOnboardingEmail(data) {
  const {
    teacherName,
    username,
    password,
    schoolName,
    branchCode,
    loginUrl,
  } = data

  const safe = {
    teacherName: escapeHtml(teacherName || 'Teacher'),
    username: escapeHtml(username),
    password: escapeHtml(password),
    schoolName: escapeHtml(schoolName || 'Your School'),
    branchCode: escapeHtml(branchCode || ''),
    loginUrl: escapeHtml(loginUrl || ''),
  }

  const subject = `Welcome to ${safe.schoolName} — Teacher Access Credentials`

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

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #001a4e, #003da5); padding: 30px; text-align: center;">
              <h1 style="margin: 0 0 6px; font-size: 22px; font-weight: 700; color: #ffffff;">
                🎓 Welcome to ${safe.schoolName}
              </h1>
              \${safe.branchCode ? \`<p style="margin: 0; font-size: 13px; color: rgba(255,255,255,0.8);">Branch Code: \${safe.branchCode}</p>\` : ''}
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding: 30px 30px 10px;">
              <p style="margin: 0 0 14px; font-size: 16px; color: #333;">
                Dear <strong>\${safe.teacherName}</strong>,
              </p>
              <p style="margin: 0 0 14px; font-size: 15px; color: #555; line-height: 1.6;">
                You have been registered as an academic staff member at <strong>\${safe.schoolName}</strong>. 
                Below are your portal login credentials. Please keep these safe and confidential.
              </p>
            </td>
          </tr>

          <!-- Credentials -->
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
                        <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #1a1a1a; font-family: 'Courier New', monospace;">\${safe.username}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; font-size: 14px; color: #555; width: 100px;">Password:</td>
                        <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #1a1a1a; font-family: 'Courier New', monospace;">\${safe.password}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Security Warning -->
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

          <!-- CTA Button -->
          <tr>
            <td style="padding: 10px 30px 30px; text-align: center;">
              <a href="\${safe.loginUrl}"
                 style="display: inline-block; padding: 14px 36px; background: linear-gradient(135deg, #001a4e, #003da5); color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 600; letter-spacing: 0.3px;">
                Login to Teacher Portal →
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 30px; border-top: 1px solid #eee; text-align: center;">
              <p style="margin: 0 0 4px; font-size: 12px; color: #999;">
                This is an automated message from the Ugbekun Schools Platform.
              </p>
              <p style="margin: 0; font-size: 12px; color: #bbb;">
                © \${new Date().getFullYear()} Ugbekun. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { subject, html }
}

module.exports = {
  buildOnboardingEmail,
  buildTeacherOnboardingEmail,
  escapeHtml,
}
