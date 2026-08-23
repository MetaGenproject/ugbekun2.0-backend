import { v2 as cloudinary } from 'cloudinary';

function assertConfigured() {
  const hasUrl = Boolean(process.env.CLOUDINARY_URL);
  const hasExplicit =
    Boolean(process.env.CLOUDINARY_CLOUD_NAME) &&
    Boolean(process.env.CLOUDINARY_API_KEY) &&
    Boolean(process.env.CLOUDINARY_API_SECRET);

  if (!hasUrl && !hasExplicit) {
    throw new Error(
      'Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET.'
    );
  }

  if (hasExplicit) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }
}

export function normalizeFolder(folder?: string): string {
  return String(folder || '')
    .trim()
    .replace(/[^a-zA-Z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\/+|\/+$/g, '');
}

export interface UploadBase64ImageOptions {
  base64: string;
  mime: string;
  maxBytes?: number;
  folder?: string;
  publicId?: string;
  tags?: string[];
}

export async function uploadBase64Image(
  optionsOrBase64: UploadBase64ImageOptions | string,
  folderArg?: string
): Promise<string | null> {
  if (!optionsOrBase64) return null;

  let base64: string;
  let mime: string = 'image/png';
  let maxBytes = 5 * 1024 * 1024;
  let folder: string | undefined = folderArg;
  let publicId: string | undefined;
  let tags: string[] | undefined;

  if (typeof optionsOrBase64 === 'string') {
    const str = optionsOrBase64;
    const match = str.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    if (match) {
      mime = match[1];
      base64 = match[2];
    } else {
      base64 = str;
    }
  } else {
    base64 = optionsOrBase64.base64;
    mime = optionsOrBase64.mime || 'image/png';
    maxBytes = optionsOrBase64.maxBytes || maxBytes;
    folder = optionsOrBase64.folder || folder;
    publicId = optionsOrBase64.publicId;
    tags = optionsOrBase64.tags;
  }

  if (!base64) return null;

  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
  if (!allowed.includes(mime)) {
    throw new Error('Image must be a JPEG, PNG, WebP, GIF, or SVG.');
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > maxBytes) {
    throw new Error('Image must be smaller than 5MB.');
  }

  assertConfigured();

  const uploadFolder = normalizeFolder(folder);
  const file = `data:${mime};base64,${base64}`;

  const result = await cloudinary.uploader.upload(file, {
    resource_type: 'image',
    folder: uploadFolder || undefined,
    public_id: publicId || undefined,
    overwrite: false,
    tags: tags && tags.length ? tags : undefined,
  });

  return result.secure_url || result.url;
}

export interface UploadBase64FileOptions {
  base64: string;
  mime: string;
  maxBytes?: number;
  folder?: string;
  publicId?: string;
}

export async function uploadBase64File({
  base64,
  mime,
  maxBytes = 10 * 1024 * 1024, // 10MB limit for files/audio
  folder,
  publicId,
}: UploadBase64FileOptions): Promise<string | null> {
  if (!base64) return null;

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > maxBytes) {
    throw new Error('File must be smaller than 10MB.');
  }

  assertConfigured();

  const uploadFolder = normalizeFolder(folder);
  const file = `data:${mime};base64,${base64}`;

  let resourceType: 'image' | 'video' | 'raw' | 'auto' = 'raw';
  if (mime.startsWith('image/')) {
    resourceType = 'image';
  } else if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    resourceType = 'video';
  }

  const result = await cloudinary.uploader.upload(file, {
    resource_type: resourceType,
    folder: uploadFolder || undefined,
    public_id: publicId || undefined,
    overwrite: false,
  });

  return result.secure_url || result.url;
}

export default {
  uploadBase64Image,
  uploadBase64File,
};
