import { v2 as cloudinary } from 'cloudinary';

// Automatically uses CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET from process.env
cloudinary.config();

/**
 * Uploads a file buffer directly to Cloudinary.
 * @param buffer - File buffer from multer
 * @param options - Cloudinary upload options (folder, public_id, resource_type)
 * @returns Cloudinary secure URL
 */
export async function uploadToCloudinary(buffer: Buffer, options: any = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: options.folder || 'ugbekun_school_uploads',
      resource_type: options.resource_type || 'auto',
      ...options,
    };

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error || !result) {
        console.error('[CLOUDINARY] Upload stream error:', error);
        return reject(error);
      }
      resolve(result.secure_url);
    });

    stream.end(buffer);
  });
}

export { cloudinary };
export default {
  cloudinary,
  uploadToCloudinary,
};
