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

  // Output dir must always be inside outputs/<jobId>/ so fileUrl resolves correctly.
  // Never derive from videoPath (which is in uploads/) — that breaks the URL mapping.
  const OUTPUTS_DIR = process.env.OUTPUTS_DIR || pathModule.resolve(__dirname, '../../outputs');
  const outputDir = pathModule.join(OUTPUTS_DIR, jobId);
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
 * Overlays b-roll clips onto the base video using ffmpeg filter_complex.
 *
 * Two bugs fixed vs the old version:
 *  1. STUCK FRAME — the old code used `-ss 0 -t dur` as an INPUT flag, so the
 *     b-roll clip was decoded from t=0 in its own timeline but the overlay
 *     `enable='between(t,startSec,endSec)'` gate uses the BASE video's clock.
 *     The b-roll plays silently from second 0, and when the gate opens it's
 *     already partway through — or ffmpeg holds the last decoded frame making it
 *     look frozen. Fix: use setpts to retime the b-roll so its t=0 lines up with
 *     the overlay window start in the base video timeline.
 *  2. FULL-WIDTH / NO BLACK BARS — old code used
 *     `force_original_aspect_ratio=decrease` + pad, which letterboxes portrait
 *     b-roll inside a landscape frame (or vice-versa). Fix: use
 *     `force_original_aspect_ratio=increase` + crop to fill the frame edge-to-edge
 *     regardless of whether the source video or b-roll is portrait or landscape.
 */
async function applyBrollOverlay(baseVideoPath, brollSegments, outputPath, totalDuration) {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";

  // Probe base video dimensions
  let srcW = 1920, srcH = 1080;
  try {
    const { stdout } = await execAsync(
      `"${ffprobe}" -v quiet -select_streams v:0 -show_entries stream=width,height -of json "${baseVideoPath}"`,
      { timeout: 10000 },
    );
    const info = JSON.parse(stdout);
    if (info?.streams?.[0]) {
      srcW = info.streams[0].width || srcW;
      srcH = info.streams[0].height || srcH;
    }
  } catch {}

  // Build input list and valid segments
  const inputs = [`-i "${baseVideoPath}"`];
  const validSegments = [];

  for (const seg of brollSegments) {
    const brollPath = seg.videoUrl || seg.filePath || seg.path;
    if (!brollPath || !fs.existsSync(brollPath)) {
      console.warn(`   ⚠️  B-roll file missing, skipping: ${brollPath}`);
      continue;
    }
    // brollEngine returns durationSec, not endSec — support both shapes
    const segDur = seg.endSec != null
      ? seg.endSec - seg.startSec
      : (seg.durationSec || 0);
    if (segDur <= 0) continue;

    // Load the full b-roll clip — trimming is done in the filter graph via trim/setpts
    // so the decoder has frames ready exactly when the overlay gate opens.
    inputs.push(`-i "${brollPath}"`);
    validSegments.push({ ...seg, _startSec: seg.startSec, _endSec: seg.startSec + segDur, _dur: segDur });
  }

  if (validSegments.length === 0) {
    fs.copyFileSync(baseVideoPath, outputPath);
    return;
  }

  let filterParts = [];
  let currentVideo = "[0:v]";

  for (let idx = 0; idx < validSegments.length; idx++) {
    const seg = validSegments[idx];
    const inputIdx = idx + 1;
    const trimLabel  = `[btrim${idx}]`;
    const scaledLabel = `[bscaled${idx}]`;
    const outLabel   = idx < validSegments.length - 1 ? `[vout${idx}]` : "[vfinal]";

    // FIX 1 (stuck): trim the b-roll to [0, segDur] in its own timeline,
    // then shift its PTS so t=0 of the b-roll aligns with startSec of the base video.
    // The overlay filter's enable gate then opens exactly when the clip is ready.
    filterParts.push(
      `[${inputIdx}:v]trim=0:${seg._dur.toFixed(3)},setpts=PTS-STARTPTS+${seg._startSec.toFixed(3)}/TB${trimLabel}`
    );

    // FIX 2 (full-width): scale to fill (increase + crop) instead of letterbox (decrease + pad).
    // Works for any input aspect ratio — portrait b-roll on landscape video, or vice-versa.
    filterParts.push(
      `${trimLabel}scale=${srcW}:${srcH}:force_original_aspect_ratio=increase,crop=${srcW}:${srcH}${scaledLabel}`
    );

    // Overlay: enable window matches the retimed PTS exactly
    filterParts.push(
      `${currentVideo}${scaledLabel}overlay=0:0:enable='between(t,${seg._startSec.toFixed(3)},${seg._endSec.toFixed(3)})'${outLabel}`
    );

    currentVideo = outLabel;
  }

  const filterComplex = filterParts.join("; ");

  const cmd = [
    `"${ffmpeg}"`,
    inputs.join(" "),
    `-filter_complex "${filterComplex}"`,
    `-map "[vfinal]"`,
    `-map 0:a:0`,
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