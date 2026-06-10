/**
 * storage.js — unified asset uploader for generated clips + thumbnails.
 *
 * Routing order:
 *   1. Cloudflare R2   (preferred: no size cap, free egress, cheap storage)
 *   2. Cloudinary      (legacy fallback if R2 isn't configured)
 *   3. null            (nothing configured → callers keep serving from /outputs)
 *
 * Signature-compatible with the old uploadToCloudinary(filePath, options):
 * it accepts the same `{ resource_type, folder, contentType }` options so the
 * handlers and jobFinalizer didn't need to change how they call it.
 */

const { uploadToR2, isR2Configured } = require("./r2");
const { uploadToCloudinary, isCloudinaryConfigured } = require("./cloudinary");

const isStorageConfigured = isR2Configured || isCloudinaryConfigured;

/**
 * @param {string} filePath - absolute local path
 * @param {object} [options] - { resource_type: "video"|"image", folder, contentType }
 * @returns {Promise<string|null>} public URL or null
 */
async function uploadToStorage(filePath, options = {}) {
  if (isR2Configured) {
    const isImage = options.resource_type === "image";
    const folder = options.folder || (isImage ? "clipzen/thumbnails" : "clipzen");
    return uploadToR2(filePath, { folder, contentType: options.contentType });
  }
  if (isCloudinaryConfigured) {
    return uploadToCloudinary(filePath, options);
  }
  return null;
}

module.exports = { uploadToStorage, isStorageConfigured };
