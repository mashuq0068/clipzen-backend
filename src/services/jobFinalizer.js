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
const { uploadToStorage, isStorageConfigured } = require("./storage");

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
  return uploadToStorage(localPath, {
    resource_type: "image",
    folder: "clipzen/thumbnails",
  });
}

/**
 * Upload all of a job's assets to Cloudinary, persist the URLs, then remove the
 * local job folder. No-op (keeps local files) when Cloudinary isn't configured.
 */
async function finalizeJobAssets(jobId) {
  if (!isStorageConfigured) {
    console.log(
      "   ☁️  No cloud storage configured (R2/Cloudinary) — keeping local files (no cleanup)",
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
  // Track whether EVERY clip ended up with a cloud URL. If any video upload
  // failed (e.g. file too large), we must KEEP the local folder so the clip is
  // still served from /outputs (the frontend falls back to file_url). Deleting
  // it would leave that clip with no cloud_url AND no local file = unplayable.
  let allClipsOnCloud = true;
  try {
    const { rows: clips } = await query(
      "SELECT id, file_path, file_url, cloud_url, thumbnail_url FROM clips WHERE job_id = $1",
      [jobId],
    );

    for (const c of clips) {
      // 2a. Video → Cloudinary (only if not already a cloud URL)
      let cloudUrl = c.cloud_url;
      if (!isCloudUrl(cloudUrl)) {
        const vpath =
          c.file_path && fs.existsSync(c.file_path)
            ? c.file_path
            : localFromUrl(c.file_url);
        if (vpath && fs.existsSync(vpath)) {
          const url = await uploadToStorage(vpath, { resource_type: "video" });
          if (url) {
            cloudUrl = url;
            await query("UPDATE clips SET cloud_url = $1 WHERE id = $2", [url, c.id]);
          }
        }
      }
      if (!isCloudUrl(cloudUrl)) {
        allClipsOnCloud = false;
        console.warn(`   ⚠️  Clip ${c.id} has no cloud URL — keeping its local file`);
      }

      // 2b. Thumbnail → Cloudinary (only if still a local URL).
      // Only switch thumbnail_url to cloud if the folder will actually be
      // deleted; otherwise leave the working local thumbnail in place.
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
    allClipsOnCloud = false;
  }

  // ── 3. Delete the job output folder — ONLY if every clip is on Cloudinary ──
  const jobDir = path.join(OUTPUT_BASE, jobId);
  if (!allClipsOnCloud) {
    console.warn(
      `   ⚠️  Keeping local folder outputs/${jobId} — one or more clips aren't on Cloudinary (served locally).`,
    );
    return;
  }
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
