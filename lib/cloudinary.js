const cloudinary = require('cloudinary').v2

function assertConfigured() {
  // Prefer CLOUDINARY_URL (already present in your .env), but also support the
  // explicit vars for flexibility.
  const hasUrl = Boolean(process.env.CLOUDINARY_URL)
  const hasExplicit =
    Boolean(process.env.CLOUDINARY_CLOUD_NAME) &&
    Boolean(process.env.CLOUDINARY_API_KEY) &&
    Boolean(process.env.CLOUDINARY_API_SECRET)

  if (!hasUrl && !hasExplicit) {
    throw new Error(
      'Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET.'
    )
  }

  if (hasExplicit) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    })
  }
}

function normalizeFolder(folder) {
  return String(folder || '')
    .trim()
    .replace(/[^a-zA-Z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\/+|\/+$/g, '')
}

async function uploadBase64Image({
  base64,
  mime,
  maxBytes = 2 * 1024 * 1024,
  folder,
  publicId,
  tags,
}) {
  if (!base64) return null

  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  if (!allowed.includes(mime)) {
    throw new Error('Image must be a JPEG, PNG, WebP, or GIF.')
  }

  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > maxBytes) {
    throw new Error('Image must be smaller than 2MB.')
  }

  assertConfigured()

  const uploadFolder = normalizeFolder(folder)
  const file = `data:${mime};base64,${base64}`

  const result = await cloudinary.uploader.upload(file, {
    resource_type: 'image',
    folder: uploadFolder || undefined,
    public_id: publicId || undefined,
    overwrite: false,
    tags: tags && tags.length ? tags : undefined,
  })

  return result.secure_url || result.url
}

async function uploadBase64File({
  base64,
  mime,
  maxBytes = 10 * 1024 * 1024, // 10MB limit for files/audio
  folder,
  publicId,
}) {
  if (!base64) return null

  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > maxBytes) {
    throw new Error('File must be smaller than 10MB.')
  }

  assertConfigured()

  const uploadFolder = normalizeFolder(folder)
  const file = `data:${mime};base64,${base64}`

  let resourceType = 'raw'
  if (mime.startsWith('image/')) {
    resourceType = 'image'
  } else if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    resourceType = 'video'
  }

  const result = await cloudinary.uploader.upload(file, {
    resource_type: resourceType,
    folder: uploadFolder || undefined,
    public_id: publicId || undefined,
    overwrite: false,
  })

  return result.secure_url || result.url
}

module.exports = {
  uploadBase64Image,
  uploadBase64File,
}

