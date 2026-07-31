const cloudinary = require('cloudinary').v2;

// Automatically uses CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET from process.env
cloudinary.config();

/**
 * Uploads a file buffer directly to Cloudinary.
 * @param {Buffer} buffer - File buffer from multer
 * @param {Object} options - Cloudinary upload options (folder, public_id, resource_type)
 * @returns {Promise<string>} - Cloudinary secure URL
 */
async function uploadToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: options.folder || 'ugbekun_school_uploads',
      resource_type: options.resource_type || 'auto',
      ...options,
    };

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) {
        console.error('[CLOUDINARY] Upload stream error:', error);
        return reject(error);
      }
      resolve(result.secure_url);
    });

    stream.end(buffer);
  });
}

module.exports = {
  cloudinary,
  uploadToCloudinary,
};
