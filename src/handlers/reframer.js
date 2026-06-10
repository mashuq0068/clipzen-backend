const { query } = require("../db/pool");
const { cutClip, formatTime } = require("../services/clipCutter");
const { extractClipThumbnail } = require("../services/thumbnailExtractor");
const { uploadToStorage } = require("../services/storage");

const { promisify } = require("util");
const { exec } = require("child_process");
const fs = require("fs");

const execAsync = promisify(exec);

async function handleReframer(
  dbJob,
  videoPath,
  jobId,
  userId,
  helpers,
) {
  const { analyzeClipTimelineForClip } = helpers;

  const platforms = dbJob.platforms || ["tiktok"];

  // ─────────────────────────────
  // duration
  // ─────────────────────────────
  let videoDuration = 60;

  try {
    const ffprobe = process.env.FFPROBE_PATH || "ffprobe";

    const { stdout } = await execAsync(
      `"${ffprobe}" -v quiet -print_format json -show_format "${videoPath}"`,
      { timeout: 15000 },
    );

    const info = JSON.parse(stdout);
    const dur = parseFloat(info?.format?.duration || "0");

    if (dur > 0) videoDuration = dur;
  } catch (e) {
    console.warn(`⚠️ ffprobe failed: ${e.message}`);
  }

  const clip = {
    title: dbJob.video_title || "Reframed Video",
    startSec: 0,
    endSec: videoDuration,
    transcript: "",
  };

  // ─────────────────────────────
  // timeline
  // ─────────────────────────────
  let clipTimeline = null;

  try {
    clipTimeline = await analyzeClipTimelineForClip(
      videoPath,
      clip,
    );
  } catch (e) {
    console.warn(`⚠️ timeline failed: ${e.message}`);
  }

  // ─────────────────────────────
  // cut
  // ─────────────────────────────
  const cut = await cutClip(
    videoPath,
    clip.startSec,
    clip.endSec,
    jobId,
    "general",
    clip,
    clipTimeline,
  );

  if (!cut?.filePath) {
    throw new Error("Cut failed");
  }

  // ─────────────────────────────
  // DB insert
  // ─────────────────────────────
  let cloudUrl = null;
  try {
    cloudUrl = await uploadToStorage(cut.filePath, { resource_type: "video" });
  } catch (err) {
    console.error("  ⚠️ Cloudinary upload failed:", err);
  }

  const { rows: clipRows } = await query(
    `
      INSERT INTO clips (
        job_id,
        user_id,
        title,
        file_path,
        file_url,
        cloud_url,
        thumbnail_url,
        duration,
        start_time,
        end_time,
        hook_score,
        platforms,
        transcript
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
      )
      RETURNING id
    `,
    [
      jobId,
      userId,
      clip.title,
      cut.filePath,
      cut.fileUrl,
      cloudUrl,
      null,
      formatTime(videoDuration),
      "0:00",
      formatTime(videoDuration),
      100,
      platforms,
      null,
    ],
  );

  const clipId = clipRows[0].id;

  // ─────────────────────────────
  // thumbnail (MATCH MAGIC CLIPS STYLE)
  // ─────────────────────────────
  if (cut.filePath && fs.existsSync(cut.filePath)) {
    const thumbUrl = await extractClipThumbnail(
      cut.filePath,
      jobId,
      clipId,
    );

    if (thumbUrl) {
      await query(
        `UPDATE clips SET thumbnail_url = $1 WHERE id = $2`,
        [thumbUrl, clipId],
      );
    }
  }

  console.log(
    `✅ Reframed video completed (clipId=${clipId})`,
  );
}

module.exports = handleReframer;