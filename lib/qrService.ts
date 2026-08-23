import QRCode from 'qrcode';

/**
 * Generates a QR code image as a PNG Buffer.
 * Suitable for embedding directly in PDFKit documents using doc.image(buffer).
 * 
 * @param text - The URL or text to encode in the QR code
 * @param options - QR code customization options
 * @returns PNG Buffer
 */
export async function generateQrBuffer(text: string, options: any = {}): Promise<Buffer> {
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
  
  return (QRCode as any).toBuffer(text, { ...defaultOptions, ...options });
}

/**
 * Generates a QR code image as a Base64 Data URI string.
 * 
 * @param text - The URL or text to encode
 * @param options - QR code customization options
 * @returns Data URL string (e.g. data:image/png;base64,...)
 */
export async function generateQrDataUri(text: string, options: any = {}): Promise<string> {
  const defaultOptions = {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 250,
  };
  
  return (QRCode as any).toDataURL(text, { ...defaultOptions, ...options });
}

/**
 * Constructs the public verification URL for a given token.
 * Uses FRONTEND_URL from environment variables.
 * 
 * @param token - The unique verifyToken
 * @returns Verification URL
 */
export function buildVerificationUrl(token: string): string {
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  // Strip trailing slash if present
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${cleanBaseUrl}/verify/${token}`;
}

export default {
  generateQrBuffer,
  generateQrDataUri,
  buildVerificationUrl
};
