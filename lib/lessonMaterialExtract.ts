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

    // PDF extraction
    if ((mime.includes('pdf') || name.toLowerCase().endsWith('.pdf')) && pdfParse) {
      try {
        const parsed = await pdfParse(buffer);
        if (parsed?.text?.trim()) {
          chunks.push(`--- ${name} ---\n${parsed.text.trim()}`);
        }
      } catch (error: any) {
        console.warn('[LESSON OCR] PDF parse failed:', error?.message || error);
      }
      continue;
    }

    // Text, Markdown, CSV, JSON extraction
    if (
      mime.startsWith('text/') ||
      mime.includes('json') ||
      mime.includes('csv') ||
      /\.(txt|md|csv|json|tsv)$/i.test(name)
    ) {
      try {
        const decoded = buffer.toString('utf8').trim();
        if (decoded) chunks.push(`--- ${name} ---\n${decoded}`);
      } catch (error: any) {
        console.warn('[LESSON OCR] Text decode failed:', error?.message || error);
      }
      continue;
    }

    // Image OCR with timeout protection
    if ((mime.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(name)) && Tesseract) {
      try {
        const ocrPromise = Tesseract.recognize(buffer, 'eng').then(
          (result: any) => String(result?.data?.text || '').trim()
        );
        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('OCR recognition timeout')), 12000)
        );
        const text = await Promise.race([ocrPromise, timeoutPromise]);
        if (text) {
          chunks.push(`--- ${name} (scanned document) ---\n${text}`);
        }
      } catch (error: any) {
        console.warn('[LESSON OCR] Image scan failed or timed out:', error?.message || error);
      }
    }
  }

  const text = chunks.join('\n\n').slice(0, 25000);
  return { text, fileName: names[0] || null };
}
