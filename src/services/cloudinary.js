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

  try {
    console.log(`☁️  Uploading ${filePath} to Cloudinary...`);
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: "video",
      folder: "clipzen",
      ...options,
    });
    console.log(`✅ Cloudinary upload success: ${result.secure_url}`);
    return result.secure_url;
  } catch (error) {
    console.error("❌ Cloudinary upload failed:", error);
    return null;
  }
}

module.exports = {
  uploadToCloudinary,
  isCloudinaryConfigured: isConfigured,
};
