const { query } = require("../db/pool");
const {
  transcribeVideo,
  extractWordTimingsForClip,
} = require("../services/transcriber");
const { cutClip, formatTime } = require("../services/clipCutter");
const { burnCaptions } = require("../services/captionBurner");
const { buildBrollSegments } = require("../services/brollEngine");
const { extractClipThumbnail } = require("../services/thumbnailExtractor");
const { uploadToCloudinary } = require("../services/cloudinary");
const { promisify } = require("util");
const { exec } = require("child_process");
const pathModule = require("path");
const fs = require("fs");

const execAsync = promisify(exec);

/**
 * Returns { brollFolder } so the worker can clean it up in `finally`.
 */
async function handleEditVideo(dbJob, videoPath, jobId, userId, helpers) {
  const {
    analyzeClipTimelineForClip,
    trimToStableLayoutWindow,
    trimToTimelineWindow,
  } = helpers;

  const brollEnabled = dbJob.broll_enabled || false;
  const brollStyle = dbJob.broll_style || "fullscreen";
  const platforms = Array.isArray(dbJob.platforms) && dbJob.platforms.length > 0
    ? dbJob.platforms
    : ["tiktok"];

  // Probe actual video duration via ffprobe (don't rely on segments alone)
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
    console.warn(`  ⚠️  Could not probe duration: ${e.message.split("\n")[0]}`);
  }

  const analysisClip = {
    title: dbJob.video_title || "Edited Video",
    startSec: 0,
    endSec: videoDuration,
  };

  console.log(`\nTranscribing...`);
  console.log(`\nAnalyzing layout...`);
  const [segments, clipTimeline] = await Promise.all([
    transcribeVideo(videoPath, dbJob.language),
    analyzeClipTimelineForClip(videoPath, analysisClip),
  ]);
  const transcriptJson = JSON.stringify(segments);

  const clip = {
    ...analysisClip,
    transcript: transcriptJson,
  };

  let finalClipTimeline = clipTimeline || {
    timeline: [],
    srcW: 1920,
    srcH: 1080,
    isAlreadyVertical: false,
  };

  const modeSummary = finalClipTimeline.timeline.reduce((acc, e) => {
    acc[e.decision.mode] = (acc[e.decision.mode] || 0) + 1;
    return acc;
  }, {});
  console.log(`  Face timeline: ${JSON.stringify(modeSummary)}`);

  // ── Face analysis ──────────────────────────────────────────────────────────
  try {

    // ── Layout stabilization ───────────────────────────────────────────────
    if (!finalClipTimeline.isAlreadyVertical && finalClipTimeline.timeline.length >= 4) {
      const originalClipStart = clip.startSec;
      const trimmed = trimToStableLayoutWindow(clip, finalClipTimeline.timeline);
      if (trimmed.wasTrimmed) {
        console.log(
          `  ✂️  Layout-stabilized: [${formatTime(clip.startSec)}-${formatTime(clip.endSec)}] → ` +
            `[${formatTime(trimmed.startSec)}-${formatTime(trimmed.endSec)}] ` +
            `dominant="${trimmed.dominantMode}" (${(trimmed.dominantFrac * 100).toFixed(0)}%)`,
        );
        const trimmedTimeline = trimToTimelineWindow(
          finalClipTimeline.timeline,
          trimmed.startSec,
          trimmed.endSec,
          originalClipStart,
        );
        clip.startSec = trimmed.startSec;
        clip.endSec = trimmed.endSec;
        finalClipTimeline = { ...finalClipTimeline, timeline: trimmedTimeline };
      }
    }
  } catch (e) {
    console.warn(`  Face analysis failed, using passthrough: ${e.message}`);
  }

  // ── Cut ────────────────────────────────────────────────────────────────────
  console.log(`\nCutting & reframing...`);
  const cut = await cutClip(
    videoPath,
    clip.startSec,
    clip.endSec,
    jobId,
    "general",
    clip,
    finalClipTimeline,
  );
  let filePath = cut.filePath;
  let fileUrl = cut.fileUrl;

  // ── Captions + B-roll ──────────────────────────────────────────────────────
  let brollFolder = null;

  if (filePath) {
    const wordTimings = extractWordTimingsForClip(segments, clip.startSec, clip.endSec);
    const jobOutputDir = pathModule.dirname(filePath);
    brollFolder = pathModule.join(jobOutputDir, "broll");

    console.log(`\nBuilding B-roll...`);
    const brollSegments = await buildBrollSegments(
      clip,
      wordTimings,
      "general",
      "general",
      brollEnabled,
      brollStyle,
      jobOutputDir,
    );

    const isSplitClip =
      finalClipTimeline.timeline.length > 0 &&
      finalClipTimeline.timeline.filter((e) => e.decision.mode === "split").length >
        finalClipTimeline.timeline.length * 0.4;

    const splitTimeline = [];
    if (finalClipTimeline.timeline.length > 0) {
      const tl = finalClipTimeline.timeline;
      for (let ti = 0; ti < tl.length; ti++) {
        if (tl[ti].decision.mode !== "split") continue;
        const segStart = tl[ti].clipTimeSec;
        const segEnd =
          ti + 1 < tl.length
            ? tl[ti + 1].clipTimeSec
            : clip.endSec - clip.startSec;
        const last = splitTimeline[splitTimeline.length - 1];
        if (last && Math.abs(last.endSec - segStart) < 0.05) {
          last.endSec = segEnd;
        } else {
          splitTimeline.push({ startSec: segStart, endSec: segEnd });
        }
      }
    }

    console.log(`\nBurning captions...`);
    let captionedPath = null;
    try {
      captionedPath = await burnCaptions(
        {
          ...clip,
          filePath,
          fileUrl,
          wordTimings,
          jobId,
          startSec: 0,
          endSec: clip.endSec - clip.startSec,
          captionPosition: isSplitClip ? "center" : "bottom",
          brollSegments,
          splitTimeline,
        },
        "general",
        platforms,
      );
    } catch (burnErr) {
      console.error(`  ❌ Caption burn failed: ${burnErr.message}`);
    }

    if (
      captionedPath &&
      captionedPath !== filePath &&
      fs.existsSync(captionedPath) &&
      fs.statSync(captionedPath).size > 100_000
    ) {
      fileUrl = `/outputs/${jobId}/${pathModule.basename(captionedPath)}`;
      filePath = captionedPath;
      console.log(`  Captions burned`);
    } else if (captionedPath && captionedPath !== filePath) {
      console.warn(`  ⚠️  Burn output invalid — keeping original cut`);
    }
  }

  // ── Save to DB ─────────────────────────────────────────────────────────────
  const { rows: clipRows } = await query(
    `INSERT INTO clips (job_id, user_id, title, file_path, file_url, duration, start_time, end_time, hook_score, platforms, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      jobId,
      userId,
      clip.title,
      filePath,
      fileUrl,
      formatTime(clip.endSec - clip.startSec),
      "0:00",
      formatTime(clip.endSec - clip.startSec),
      100,
      platforms,
      transcriptJson,
    ],
  );

  const clipId = clipRows[0].id;
  if (filePath && fs.existsSync(filePath)) {
    await extractClipThumbnail(filePath, jobId, clipId);
  }

  return { brollFolder };
}

module.exports = handleEditVideo;