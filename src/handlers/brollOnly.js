const { query } = require("../db/pool");
const { transcribeVideo, extractWordTimingsForClip } = require("../services/transcriber");
const { formatTime } = require("../services/clipCutter");
const { buildBrollSegments } = require("../services/brollEngine");
const { extractClipThumbnail } = require("../services/thumbnailExtractor");
const pathModule = require("path");
const fs = require("fs");
const { promisify } = require("util");
const { exec } = require("child_process");
const execAsync = promisify(exec);

/**
 * handleBrollOnly
 *
 * Takes the source video AS-IS (no reframe, no caption burn, no cut).
 * Overlays b-roll footage onto it using ffmpeg filter_complex,
 * then saves the result.
 */
async function handleBrollOnly(dbJob, videoPath, jobId, userId, helpers) {
  const brollStyle = dbJob.broll_style || "fullscreen";

  console.log(`\nTranscribing for B-roll placement...`);
  const segments = await transcribeVideo(videoPath);
  const transcript = segments.map((s) => s.text).join(" ");
  const lastEnd = segments[segments.length - 1]?.endSec || 60;

  // Probe actual video duration
  let videoDuration = lastEnd;
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
    console.warn(`   ⚠️  Could not probe duration: ${e.message.split("\n")[0]}`);
  }

  const clip = {
    title: dbJob.video_title || "B-roll Video",
    startSec: 0,
    endSec: videoDuration,
    transcript,
  };

  const wordTimings = extractWordTimingsForClip(segments, 0, videoDuration);

  // Determine output dir — same folder as source or jobs output dir
  const outputDir = pathModule.join(
    process.env.OUTPUTS_DIR || pathModule.dirname(videoPath),
    jobId,
  );
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  console.log(`\nBuilding B-roll segments...`);
  const brollSegments = await buildBrollSegments(
    clip,
    wordTimings,
    "general",
    "general",
    true,
    brollStyle,
    outputDir,
  );

  // FIX: compose b-roll onto the ORIGINAL video with ffmpeg directly.
  // No cutClip (no reframe), no burnCaptions (no captions).
  let finalPath = videoPath; // default: return original if no b-roll
  let fileUrl = `/outputs/${jobId}/${pathModule.basename(videoPath)}`;

  if (brollSegments && brollSegments.length > 0) {
    finalPath = pathModule.join(outputDir, `broll_${Date.now()}.mp4`);
    fileUrl = `/outputs/${jobId}/${pathModule.basename(finalPath)}`;

    try {
      await applyBrollOverlay(videoPath, brollSegments, finalPath, videoDuration);
      console.log(`   ✅ B-roll overlay applied`);
    } catch (overlayErr) {
      console.error(`   ❌ B-roll overlay failed: ${overlayErr.message}`);
      // Fall back to copying the original untouched
      finalPath = pathModule.join(outputDir, `broll_${Date.now()}_original.mp4`);
      fileUrl = `/outputs/${jobId}/${pathModule.basename(finalPath)}`;
      fs.copyFileSync(videoPath, finalPath);
    }
  } else {
    console.log(`   ℹ️  No b-roll segments — copying original video`);
    const copyPath = pathModule.join(outputDir, `broll_${Date.now()}_original.mp4`);
    fs.copyFileSync(videoPath, copyPath);
    finalPath = copyPath;
    fileUrl = `/outputs/${jobId}/${pathModule.basename(finalPath)}`;
  }

  const { rows: clipRows } = await query(
    `INSERT INTO clips (job_id, user_id, title, file_path, file_url, duration, start_time, end_time, hook_score, platforms, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      jobId,
      userId,
      clip.title,
      finalPath,
      fileUrl,
      formatTime(videoDuration),
      "0:00",
      formatTime(videoDuration),
      100,
      ["b-roll"],
      transcript,
    ],
  );

  const clipId = clipRows[0].id;
  if (finalPath && fs.existsSync(finalPath)) {
    await extractClipThumbnail(finalPath, jobId, clipId);
  }
}

/**
 * applyBrollOverlay
 *
 * Overlays b-roll clips onto the base video at their designated time windows
 * using ffmpeg filter_complex. Supports "fullscreen" style (replaces video track)
 * and "pip" / side-by-side styles as your brollEngine defines them.
 *
 * brollSegments shape expected:
 *   { startSec, endSec, videoUrl (local path), style? }
 */
async function applyBrollOverlay(baseVideoPath, brollSegments, outputPath, totalDuration) {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

  // Build ffmpeg inputs: [0] = base, [1..N] = b-roll clips
  const inputs = [`-i "${baseVideoPath}"`];
  const validSegments = [];

  for (const seg of brollSegments) {
    const brollPath = seg.videoUrl || seg.filePath || seg.path;
    if (!brollPath || !fs.existsSync(brollPath)) {
      console.warn(`   ⚠️  B-roll file missing, skipping: ${brollPath}`);
      continue;
    }
    const segDur = seg.endSec - seg.startSec;
    if (segDur <= 0) continue;
    // Trim b-roll to exact needed duration before overlaying
    inputs.push(`-ss 0 -t ${segDur.toFixed(3)} -i "${brollPath}"`);
    validSegments.push(seg);
  }

  if (validSegments.length === 0) {
    // Nothing valid — just copy
    fs.copyFileSync(baseVideoPath, outputPath);
    return;
  }

  // Build filter_complex: overlay each b-roll at its timestamp
  // For fullscreen: use `overlay=0:0:enable='between(t,start,end)'`
  // Scale each b-roll to match source dimensions first
  let filterParts = [];
  let currentVideo = "[0:v]";

  // Probe base video dimensions
  let srcW = 1920, srcH = 1080;
  try {
    const { stdout } = await execAsync(
      `"${process.env.FFPROBE_PATH || "ffprobe"}" -v quiet -select_streams v:0 -show_entries stream=width,height -of json "${baseVideoPath}"`,
      { timeout: 10000 },
    );
    const info = JSON.parse(stdout);
    if (info?.streams?.[0]) {
      srcW = info.streams[0].width || srcW;
      srcH = info.streams[0].height || srcH;
    }
  } catch {}

  for (let idx = 0; idx < validSegments.length; idx++) {
    const seg = validSegments[idx];
    const inputIdx = idx + 1; // 0 is base
    const scaledLabel = `[bscaled${idx}]`;
    const outLabel = idx < validSegments.length - 1 ? `[vout${idx}]` : "[vfinal]";

    filterParts.push(
      `[${inputIdx}:v]scale=${srcW}:${srcH}:force_original_aspect_ratio=decrease,pad=${srcW}:${srcH}:(ow-iw)/2:(oh-ih)/2${scaledLabel}`,
    );
    filterParts.push(
      `${currentVideo}${scaledLabel}overlay=0:0:enable='between(t,${seg.startSec.toFixed(3)},${seg.endSec.toFixed(3)})'${outLabel}`,
    );
    currentVideo = outLabel;
  }

  const filterComplex = filterParts.join("; ");

  const cmd = [
    `"${ffmpeg}"`,
    inputs.join(" "),
    `-filter_complex "${filterComplex}"`,
    `-map "[vfinal]"`,
    `-map 0:a:0`,          // always keep original audio
    `-c:v libx264`,
    `-preset fast`,
    `-crf 18`,
    `-pix_fmt yuv420p`,
    `-c:a aac`,
    `-b:a 192k`,
    `-movflags +faststart`,
    `-t ${totalDuration.toFixed(3)}`,
    `-y`,
    `"${outputPath}"`,
  ].join(" ");

  await execAsync(cmd, { timeout: 20 * 60 * 1000 });

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 50000) {
    throw new Error("ffmpeg b-roll overlay produced no/empty output");
  }
}

module.exports = handleBrollOnly;