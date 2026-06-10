const { query } = require("../db/pool");
const { transcribeVideo, extractWordTimingsForClip } = require("../services/transcriber");
const { burnCaptions } = require("../services/captionBurner");
const { formatTime } = require("../services/clipCutter");
const { uploadToStorage } = require("../services/storage");
const pathModule = require("path");
const fs = require("fs");

async function handleAddCaptions(dbJob, videoPath, jobId, userId) {
  const platforms = dbJob.platforms || ["tiktok"];

  // ── Step 1: Transcribe ────────────────────────────────────────────────────
  const segments = await transcribeVideo(videoPath, dbJob.language);
  const wordTimings = extractWordTimingsForClip(segments, 0, 999999);

  const clip = {
    title: dbJob.video_title || "Captioned Video",
    startSec: 0,
    endSec: wordTimings[wordTimings.length - 1]?.endSec || 0,
    transcript: JSON.stringify(segments),
  };

  // ── Step 2: Copy source into outputs/<jobId>/ before burning ─────────────
  // burnCaptions derives its output path by replacing ".mp4" on clip.filePath.
  // The old worker used cutClip() which already wrote into outputs/<jobId>/,
  // so captions always landed there too. For add-captions we skip cutting,
  // so we must pre-stage the file in the right folder ourselves.
  const OUTPUTS_DIR = pathModule.resolve(__dirname, "../../outputs");
  const jobOutputDir = pathModule.join(OUTPUTS_DIR, jobId);
  if (!fs.existsSync(jobOutputDir)) {
    fs.mkdirSync(jobOutputDir, { recursive: true });
  }

  const stagedName = pathModule.basename(videoPath); // e.g. uuid.mp4
  const stagedPath = pathModule.join(jobOutputDir, stagedName);

  // Use copyFile so the original (in uploads/) is still there for worker cleanup
  fs.copyFileSync(videoPath, stagedPath);
  console.log(`   📂 Staged source → outputs/${jobId}/${stagedName}`);

  // ── Step 3: Burn captions (output will be stagedPath → _captioned.mp4) ───
  const captionedPath = await burnCaptions(
    {
      ...clip,
      filePath: stagedPath,   // <-- burn next to the staged copy, not uploads/
      fileUrl: "",
      wordTimings,
      jobId,
      startSec: 0,
      endSec: clip.endSec,
      captionPosition: "bottom",
      brollSegments: [],
      splitTimeline: [],
      // Add-captions = overlay only. Keep the source's ORIGINAL resolution/
      // aspect ratio — do NOT reframe/crop into the default 1080x1920 canvas.
      preserveOriginalSize: true,
    },
    "general",
    platforms
  );

  // ── Step 4: Validate output ───────────────────────────────────────────────
  if (!captionedPath || captionedPath === stagedPath) {
    throw new Error(
      "Caption burn failed — Remotion did not produce a captioned output file."
    );
  }
  if (!fs.existsSync(captionedPath) || fs.statSync(captionedPath).size < 100_000) {
    throw new Error(`Caption burn output missing or too small: ${captionedPath}`);
  }

  // Remove the staged raw copy — only keep the captioned version
  // eslint-disable-next-line no-empty
  try { fs.unlinkSync(stagedPath); } catch {}

  // ── Step 5: Save to DB ────────────────────────────────────────────────────
  const fileUrl = `/outputs/${jobId}/${pathModule.basename(captionedPath)}`;

  let cloudUrl = null;
  try {
    cloudUrl = await uploadToStorage(captionedPath, { resource_type: "video" });
  } catch (err) {
    console.error("  ⚠️ Cloudinary upload failed:", err);
  }

  await query(
    `INSERT INTO clips (job_id, user_id, title, file_path, file_url, cloud_url, duration, start_time, end_time, hook_score, platforms, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      jobId,
      userId,
      clip.title,
      captionedPath,
      fileUrl,
      cloudUrl,
      formatTime(clip.endSec),
      "0:00",
      formatTime(clip.endSec),
      100,
      platforms,
      clip.transcript,
    ]
  );

  console.log(`   ✅ Clip saved → ${fileUrl}`);
}

module.exports = handleAddCaptions;