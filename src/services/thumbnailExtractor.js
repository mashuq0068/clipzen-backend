/* eslint-disable no-undef */
/**
 * thumbnailExtractor.js
 *
 * Extracts thumbnails from video files using FFmpeg.
 *
 * - Job thumbnail  → taken at 10% into the full video (avoids black intros)
 * - Clip thumbnail → taken at 20% into the clip's duration (past any fade-in)
 *
 * Output files are saved to:
 *   /outputs/<jobId>/thumbnails/job_thumb.jpg
 *   /outputs/<jobId>/thumbnails/clip_<clipId>.jpg
 *
 * Returns a relative URL string like:
 *   /outputs/<jobId>/thumbnails/job_thumb.jpg
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const axios = require("axios");

/**
 * Downloads a remote image and saves it to the local filesystem.
 */
async function downloadImage(url, outputPath) {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// Base directory where all job outputs live — adjust if your OUTPUT_DIR differs
const OUTPUT_BASE = process.env.OUTPUT_DIR || path.resolve(__dirname, "../../outputs");

/**
 * Ensure a directory exists (creates recursively if needed).
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Get the duration of a video in seconds via ffprobe.
 * Falls back to 0 on error so callers can still attempt extraction.
 *
 * @param {string} videoPath - Absolute path to the video file
 * @returns {Promise<number>} Duration in seconds
 */
async function getVideoDurationSec(videoPath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    const parsed = parseFloat(stdout.trim());
    return isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

/**
 * Run FFmpeg to extract a single JPEG frame at a given timestamp.
 *
 * @param {string} videoPath   - Absolute path to video
 * @param {number} seekSec     - Timestamp (seconds) to seek to
 * @param {string} outputPath  - Absolute path for the output .jpg
 * @returns {Promise<void>}
 */
async function extractFrame(videoPath, seekSec, outputPath) {
  // -ss before -i = fast seek (key-frame accurate enough for thumbnails)
  // -vframes 1    = only grab one frame
  // -q:v 3        = JPEG quality (2=best, 5=good, lower is higher quality)
  // -vf scale     = resize to 640px wide, keep aspect ratio
  await execFileAsync("ffmpeg", [
    "-ss", String(seekSec),
    "-i", videoPath,
    "-vframes", "1",
    "-q:v", "3",
    "-vf", "scale=640:-2",
    "-y",            // overwrite if exists
    outputPath,
  ]);
}

/**
 * Extract a thumbnail for a whole JOB (the source video).
 * Seeks to 10% of the total duration to skip black/intro screens.
 *
 * @param {string} videoPath - Absolute path to the downloaded/uploaded video
 * @param {string} jobId     - Job UUID (used for the output folder)
 * @param {string} sourceUrl - Optional source URL to extract original thumbnail
 * @returns {Promise<string|null>} Relative URL like "/outputs/<jobId>/thumbnails/job_thumb.jpg"
 *                                 or null on failure
 */
async function extractJobThumbnail(videoPath, jobId, sourceUrl = null) {
  const thumbDir = path.join(OUTPUT_BASE, jobId, "thumbnails");
  ensureDir(thumbDir);
  const outputPath = path.join(thumbDir, "job_thumb.jpg");

  try {
    if (sourceUrl) {
      const regExp = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
      const match = sourceUrl.match(regExp);
      if (match && match[1]) {
        const ytThumb = `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`;
        console.log(`  🖼️  Downloading YouTube thumbnail → ${ytThumb}`);
        try {
          await downloadImage(ytThumb, outputPath);
          if (fs.existsSync(outputPath)) {
            const relUrl = `/outputs/${jobId}/thumbnails/job_thumb.jpg`;
            console.log(`  🖼️  YouTube thumbnail downloaded successfully → ${relUrl}`);
            return relUrl;
          }
        } catch (downloadErr) {
          console.warn(`  ⚠️  YouTube thumbnail download failed, falling back to frame extraction: ${downloadErr.message}`);
        }
      }
    }
    const durationSec = await getVideoDurationSec(videoPath);

    // Seek to 10% in; clamp so we never go past the end
    const seekSec = Math.min(durationSec * 0.1, durationSec - 1);
    const safeSeek = Math.max(seekSec, 0);

    await extractFrame(videoPath, safeSeek, outputPath);

    if (!fs.existsSync(outputPath)) {
      throw new Error("FFmpeg ran but output file not found");
    }

    const relUrl = `/outputs/${jobId}/thumbnails/job_thumb.jpg`;
    console.log(`  🖼️  Job thumbnail → ${relUrl}`);
    return relUrl;
  } catch (err) {
    console.warn(`  ⚠️  Job thumbnail failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract a thumbnail for a single CLIP.
 * Seeks to 20% into the clip's duration (avoids fade-in / caption overlap).
 *
 * @param {string} clipFilePath - Absolute path to the rendered clip .mp4
 * @param {string} jobId        - Job UUID (determines output folder)
 * @param {string} clipId       - Clip UUID (used for the filename)
 * @returns {Promise<string|null>} Relative URL like "/outputs/<jobId>/thumbnails/clip_<clipId>.jpg"
 *                                  or null on failure
 */
async function extractClipThumbnail(clipFilePath, jobId, clipId) {
  try {
    if (!clipFilePath || !fs.existsSync(clipFilePath)) {
      throw new Error(`Clip file not found: ${clipFilePath}`);
    }

    const thumbDir = path.join(OUTPUT_BASE, jobId, "thumbnails");
    ensureDir(thumbDir);

    const outputPath = path.join(thumbDir, `clip_${clipId}.jpg`);
    const durationSec = await getVideoDurationSec(clipFilePath);

    // Seek to 20% in; clamp so we never overshoot
    const seekSec = Math.min(durationSec * 0.2, durationSec - 0.5);
    const safeSeek = Math.max(seekSec, 0);

    await extractFrame(clipFilePath, safeSeek, outputPath);

    if (!fs.existsSync(outputPath)) {
      throw new Error("FFmpeg ran but output file not found");
    }

    const relUrl = `/outputs/${jobId}/thumbnails/clip_${clipId}.jpg`;
    console.log(`    🖼️  Clip thumbnail → ${relUrl}`);
    return relUrl;
  } catch (err) {
    console.warn(`    ⚠️  Clip thumbnail failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  extractJobThumbnail,
  extractClipThumbnail,
  getVideoDurationSec,
};