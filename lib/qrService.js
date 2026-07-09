const QRCode = require('qrcode');

/**
 * Generates a QR code image as a PNG Buffer.
 * Suitable for embedding directly in PDFKit documents using doc.image(buffer).
 * 
 * @param {string} text - The URL or text to encode in the QR code
 * @param {object} [options] - QR code customization options
 * @returns {Promise<Buffer>} PNG Buffer
 */
async function generateQrBuffer(text, options = {}) {
  const defaultOptions = {
    errorCorrectionLevel: 'M',
    type: 'png',
    margin: 1,
    width: 250,
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  };
  
  return QRCode.toBuffer(text, { ...defaultOptions, ...options });
}

/**
 * Generates a QR code image as a Base64 Data URI string.
 * 
 * @param {string} text - The URL or text to encode
 * @param {object} [options] - QR code customization options
 * @returns {Promise<string>} Data URL string (e.g. data:image/png;base64,...)
 */
async function generateQrDataUri(text, options = {}) {
  const defaultOptions = {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 250,
  };
  
  return QRCode.toDataURL(text, { ...defaultOptions, ...options });
}

/**
 * Constructs the public verification URL for a given token.
 * Uses FRONTEND_URL from environment variables.
 * 
 * @param {string} token - The unique verifyToken
 * @returns {string} Verification URL
 */
function buildVerificationUrl(token) {
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  // Strip trailing slash if present
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${cleanBaseUrl}/verify/${token}`;
}

module.exports = {
  generateQrBuffer,
  generateQrDataUri,
  buildVerificationUrl
};
