let Tesseract: any;
try {
  Tesseract = require('tesseract.js');
} catch {
  Tesseract = null;
}

let pdfParse: any;
try {
  pdfParse = require('pdf-parse');
} catch {
  pdfParse = null;
}

export interface SourceUpload {
  name?: string;
  mime?: string;
  base64?: string;
}

function bufferFromBase64(raw?: string) {
  if (!raw) return null;
  const cleaned = String(raw).includes(',') ? String(raw).split(',').pop() || '' : String(raw);
  try {
    const buf = Buffer.from(cleaned, 'base64');
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

export async function extractLessonSourceMaterial(
  uploads: SourceUpload[] = [],
  pastedText?: string
): Promise<{ text: string; fileName: string | null }> {
  const chunks: string[] = [];
  const names: string[] = [];

  if (pastedText && pastedText.trim()) {
    chunks.push(pastedText.trim());
  }

  for (const file of uploads.slice(0, 4)) {
    const name = String(file.name || 'upload');
    const mime = String(file.mime || '').toLowerCase();
    const buffer = bufferFromBase64(file.base64);
    if (!buffer) continue;
    if (buffer.length > 8 * 1024 * 1024) continue;
    names.push(name);

    if (mime.includes('pdf') && pdfParse) {
      try {
        const parsed = await pdfParse(buffer);
        if (parsed?.text?.trim()) chunks.push(`--- ${name} ---\n${parsed.text.trim()}`);
      } catch (error: any) {
        console.warn('[LESSON OCR] PDF parse failed:', error?.message || error);
      }
      continue;
    }

    if (mime.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) {
      chunks.push(`--- ${name} ---\n${buffer.toString('utf8').trim()}`);
      continue;
    }

    if ((mime.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(name)) && Tesseract) {
      try {
        const result = await Tesseract.recognize(buffer, 'eng');
        const text = String(result?.data?.text || '').trim();
        if (text) chunks.push(`--- ${name} (scanned) ---\n${text}`);
      } catch (error: any) {
        console.warn('[LESSON OCR] Image scan failed:', error?.message || error);
      }
    }
  }

  const text = chunks.join('\n\n').slice(0, 20000);
  return { text, fileName: names[0] || null };
}
