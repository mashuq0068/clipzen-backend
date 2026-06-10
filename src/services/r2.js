/**
 * r2.js — Cloudflare R2 object storage (S3-compatible).
 *
 * R2 is the primary host for generated clips + thumbnails. Unlike Cloudinary's
 * free plan (hard 100 MB per-video cap, credit-metered bandwidth), R2 has no
 * practical file-size limit and ZERO egress fees, so serving video to viewers
 * is effectively free. Large files are uploaded via automatic multipart.
 *
 * Required env (see .env.example):
 *   R2_ACCOUNT_ID         Cloudflare account ID (from the R2 dashboard)
 *   R2_ACCESS_KEY_ID      R2 API token access key
 *   R2_SECRET_ACCESS_KEY  R2 API token secret
 *   R2_BUCKET             bucket name, e.g. clipzen-clips
 *   R2_PUBLIC_BASE        public URL base, e.g. https://pub-xxxx.r2.dev
 *                         or a custom domain like https://cdn.clipzen.pro
 * Optional:
 *   R2_ENDPOINT           override the S3 endpoint (defaults to the account URL)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE,
  R2_ENDPOINT,
} = process.env;

const isR2Configured = !!(
  R2_ACCOUNT_ID &&
  R2_ACCESS_KEY_ID &&
  R2_SECRET_ACCESS_KEY &&
  R2_BUCKET &&
  R2_PUBLIC_BASE
);

const endpoint =
  R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);

const s3 = isR2Configured
  ? new S3Client({
      region: "auto",
      endpoint,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

if (!isR2Configured) {
  console.warn("⚠️  Cloudflare R2 is not fully configured — R2 uploads will be skipped.");
}

// Content-Type matters: without it R2 serves application/octet-stream, which
// makes browsers download the file instead of streaming it inline in <video>.
const MIME_BY_EXT = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function guessContentType(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * Upload a local file to R2 and return its public URL.
 * @param {string} filePath - Absolute local file path
 * @param {object} [opts]
 * @param {string} [opts.folder="clipzen"] - key prefix (e.g. "clipzen/thumbnails")
 * @param {string} [opts.contentType] - override the guessed Content-Type
 * @param {string} [opts.key] - explicit object key (overrides folder + name)
 * @returns {Promise<string|null>} Public URL, or null on failure / not configured
 */
async function uploadToR2(filePath, opts = {}) {
  if (!isR2Configured) return null;
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`R2 upload failed: file does not exist at "${filePath}"`);
    return null;
  }

  const folder = (opts.folder || "clipzen").replace(/^\/+|\/+$/g, "");
  const base = path.basename(filePath);
  // Random prefix keeps keys unique across jobs (clip_0.mp4 repeats per job).
  const key = opts.key || `${folder}/${crypto.randomUUID()}-${base}`;
  const contentType = opts.contentType || guessContentType(filePath);

  try {
    const sizeBytes = (() => {
      try { return fs.statSync(filePath).size; } catch { return 0; }
    })();
    console.log(
      `☁️  Uploading ${base} (${(sizeBytes / 1048576).toFixed(0)}MB) to R2 → ${key}`,
    );

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: R2_BUCKET,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentType: contentType,
      },
      // 50 MB parts; SDK switches to multipart automatically for big files.
      partSize: 50 * 1024 * 1024,
      queueSize: 4,
    });

    await upload.done();

    const url = `${R2_PUBLIC_BASE.replace(/\/+$/, "")}/${key}`;
    console.log(`✅ R2 upload success: ${url}`);
    return url;
  } catch (error) {
    console.error("❌ R2 upload failed:", error?.message || error);
    return null;
  }
}

module.exports = { uploadToR2, isR2Configured };
