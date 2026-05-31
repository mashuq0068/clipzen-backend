/**
 * jobFinalizer.js
 *
 * Runs after a job's handler finishes successfully.
 *
 * During processing, clip videos + thumbnails are written locally into
 * outputs/<jobId>/ (temp). This step pushes everything to Cloudinary, saves the
 * cloud URLs to the DB, then DELETES the whole outputs/<jobId> folder (clips,
 * thumbnails, b-roll — everything) so nothing is served from local disk.
 *
 * Safety: if Cloudinary is NOT configured, we keep the local files and skip
 * deletion, so the app still works by serving from /outputs.
 */

const fs = require("fs");
const path = require("path");
const { query } = require("../db/pool");
const { uploadToCloudinary, isCloudinaryConfigured } = require("./cloudinary");

const OUTPUT_BASE =
  process.env.OUTPUT_DIR || path.resolve(__dirname, "../../outputs");

const isCloudUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u);
const isLocalUrl = (u) => typeof u === "string" && u.startsWith("/outputs/");

/** Map a "/outputs/<jobId>/..." URL back to its absolute local path. */
function localFromUrl(url) {
  if (!isLocalUrl(url)) return null;
  return path.join(OUTPUT_BASE, url.replace(/^\/outputs\//, ""));
}

async function uploadImage(localPath) {
  return uploadToCloudinary(localPath, {
    resource_type: "image",
    folder: "clipzen/thumbnails",
  });
}

/**
 * Upload all of a job's assets to Cloudinary, persist the URLs, then remove the
 * local job folder. No-op (keeps local files) when Cloudinary isn't configured.
 */
async function finalizeJobAssets(jobId) {
  if (!isCloudinaryConfigured) {
    console.log(
      "   ☁️  Cloudinary not configured — keeping local files (no cleanup)",
    );
    return;
  }

  // ── 1. Job thumbnail ──────────────────────────────────────
  try {
    const { rows } = await query(
      "SELECT thumbnail_url FROM jobs WHERE id = $1",
      [jobId],
    );
    const tu = rows[0]?.thumbnail_url;
    if (isLocalUrl(tu)) {
      const local = localFromUrl(tu);
      if (local && fs.existsSync(local)) {
        const url = await uploadImage(local);
        if (url) {
          await query("UPDATE jobs SET thumbnail_url = $1 WHERE id = $2", [
            url,
            jobId,
          ]);
        }
      }
    }
  } catch (e) {
    console.warn(`   ⚠️  Job thumbnail upload failed: ${e.message}`);
  }

  // ── 2. Clip videos + thumbnails ───────────────────────────
  try {
    const { rows: clips } = await query(
      "SELECT id, file_path, file_url, cloud_url, thumbnail_url FROM clips WHERE job_id = $1",
      [jobId],
    );

    for (const c of clips) {
      // 2a. Video → Cloudinary (only if not already a cloud URL)
      if (!isCloudUrl(c.cloud_url)) {
        const vpath =
          c.file_path && fs.existsSync(c.file_path)
            ? c.file_path
            : localFromUrl(c.file_url);
        if (vpath && fs.existsSync(vpath)) {
          const url = await uploadToCloudinary(vpath, { resource_type: "video" });
          if (url) {
            await query("UPDATE clips SET cloud_url = $1 WHERE id = $2", [
              url,
              c.id,
            ]);
          }
        }
      }

      // 2b. Thumbnail → Cloudinary (only if still a local URL)
      if (isLocalUrl(c.thumbnail_url)) {
        const tp = localFromUrl(c.thumbnail_url);
        if (tp && fs.existsSync(tp)) {
          const turl = await uploadImage(tp);
          if (turl) {
            await query("UPDATE clips SET thumbnail_url = $1 WHERE id = $2", [
              turl,
              c.id,
            ]);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`   ⚠️  Clip asset upload failed: ${e.message}`);
  }

  // ── 3. Delete the whole job output folder ─────────────────
  const jobDir = path.join(OUTPUT_BASE, jobId);
  try {
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
      console.log(`   🧹 Removed local job folder: outputs/${jobId}`);
    }
  } catch (e) {
    console.warn(`   ⚠️  Could not remove job folder: ${e.message}`);
  }
}

module.exports = { finalizeJobAssets };
