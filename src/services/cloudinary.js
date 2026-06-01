const cloudinary = require("cloudinary").v2;
const fs = require("fs");

const isConfigured = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (isConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
} else {
  console.warn("⚠️  Cloudinary keys are not fully configured. Video uploads will be skipped.");
}

/**
 * Uploads a local file to Cloudinary as a video resource.
 * @param {string} filePath - Absolute local file path
 * @param {object} [options] - Additional Cloudinary upload options
 * @returns {Promise<string|null>} Secure URL if uploaded successfully, null otherwise
 */
async function uploadToCloudinary(filePath, options = {}) {
  if (!isConfigured) {
    return null;
  }
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`Cloudinary upload failed: File does not exist at "${filePath}"`);
    return null;
  }

  const uploadOptions = {
    resource_type: "video",
    folder: "clipzen",
    ...options,
  };

  try {
    console.log(`☁️  Uploading ${filePath} to Cloudinary...`);

    // Large files must use the chunked upload_large endpoint — a single
    // upload() request on a big file returns HTTP 413 (Payload Too Large).
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(filePath).size; } catch {}
    const LARGE_THRESHOLD = 90 * 1024 * 1024; // 90 MB
    const useLarge =
      uploadOptions.resource_type !== "image" && sizeBytes > LARGE_THRESHOLD;

    let result;
    if (useLarge) {
      console.log(`   ⬆️  Large file (${(sizeBytes / 1048576).toFixed(0)}MB) → chunked upload_large`);
      result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_large(
          filePath,
          { ...uploadOptions, chunk_size: 20 * 1024 * 1024 },
          (err, res) => (err ? reject(err) : resolve(res)),
        );
      });
    } else {
      result = await cloudinary.uploader.upload(filePath, uploadOptions);
    }

    if (!result?.secure_url) {
      console.error("❌ Cloudinary upload returned no URL");
      return null;
    }
    console.log(`✅ Cloudinary upload success: ${result.secure_url}`);
    return result.secure_url;
  } catch (error) {
    console.error("❌ Cloudinary upload failed:", error?.message || error);
    return null;
  }
}

module.exports = {
  uploadToCloudinary,
  isCloudinaryConfigured: isConfigured,
};
