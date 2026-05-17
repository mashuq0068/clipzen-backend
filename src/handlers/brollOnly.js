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

  let finalPath = videoPath;
  let fileUrl = `/outputs/${jobId}/${pathModule.basename(videoPath)}`;

  if (brollSegments && brollSegments.length > 0) {
    finalPath = pathModule.join(outputDir, `broll_${Date.now()}.mp4`);
    fileUrl = `/outputs/${jobId}/${pathModule.basename(finalPath)}`;

    try {
      await applyBrollOverlay(videoPath, brollSegments, finalPath, videoDuration);
      console.log(`   ✅ B-roll overlay applied`);
    } catch (overlayErr) {
      console.error(`   ❌ B-roll overlay failed: ${overlayErr.message}`);
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
 * BUG FIXES vs original:
 *
 *  FIX 1 — SYNTAX ERROR (SyntaxError: Unexpected end of input)
 *    The original for-loop was missing its closing brace, and the ffmpeg
 *    exec/filterComplex assembly was accidentally placed inside the loop body.
 *    Node.js tried to parse the file and hit EOF before the function closed.
 *
 *  FIX 2 — [vfinal] NOT DEFINED
 *    The original only built [btrimN] and [bscaledN] labels but never chained
 *    overlay filters between them, so [vfinal] was never defined and ffmpeg
 *    exited with: "Output with label 'vfinal' does not exist in any defined
 *    filter graph". Fix: chain overlay filters so each b-roll is composited
 *    onto the running video stream, with the last output labeled [vfinal].
 *
 *  FIX 3 — STUCK FRAME
 *    The b-roll setpts retimes frames so t=0 of the b-roll file aligns with
 *    seg.startSec in the base video timeline, preventing frozen-frame artifacts.
 *
 *  FIX 4 — FILL vs LETTERBOX
 *    Same orientation → fill edge-to-edge (scale+crop).
 *    Different orientation → letterbox/pillarbox with black (scale+pad).
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
  // eslint-disable-next-line no-empty
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

    inputs.push(`-i "${brollPath}"`);
    validSegments.push({
      ...seg,
      _startSec: seg.startSec,
      _endSec: seg.startSec + segDur,
      _dur: segDur,
    });
  }

  if (validSegments.length === 0) {
    fs.copyFileSync(baseVideoPath, outputPath);
    return;
  }

  // ── Build filter_complex ──────────────────────────────────────────────────
  //
  // Graph for N b-roll segments:
  //
  //   [1:v] trim=0:dur0, setpts=…+start0/TB [btrim0]
  //   [btrim0] scale=…, crop=… [bscaled0]
  //   [0:v][bscaled0] overlay=enable='between(t,s0,e0)' [vout0]
  //
  //   [2:v] trim=0:dur1, setpts=…+start1/TB [btrim1]
  //   [btrim1] scale=…, crop=… [bscaled1]
  //   [vout0][bscaled1] overlay=enable='between(t,s1,e1)' [vout1]
  //
  //   … (last one outputs [vfinal])
  //
  // ─────────────────────────────────────────────────────────────────────────

  const filterParts = [];
  let currentVideo = "[0:v]"; // tracks the running composited stream

  for (let idx = 0; idx < validSegments.length; idx++) {
    const seg = validSegments[idx];
    const inputIdx   = idx + 1;
    const trimLabel  = `[btrim${idx}]`;
    const scaledLabel = `[bscaled${idx}]`;
    // Last segment outputs [vfinal]; all others output [voutN]
    const outLabel   = idx === validSegments.length - 1 ? "[vfinal]" : `[vout${idx}]`;

    // trim + retime: keep only the first segDur seconds of the b-roll file,
    // then shift PTS so the clip starts at seg._startSec in the base timeline.
    filterParts.push(
      `[${inputIdx}:v]trim=0:${seg._dur.toFixed(3)},setpts=PTS-STARTPTS+${seg._startSec.toFixed(3)}/TB${trimLabel}`
    );

    // Probe b-roll dimensions to pick the right scale strategy
    let bW = srcW, bH = srcH;
    try {
      const brollPath = seg.videoUrl || seg.filePath || seg.path;
      const { stdout: brollInfo } = await execAsync(
        `"${ffprobe}" -v quiet -select_streams v:0 -show_entries stream=width,height -of json "${brollPath}"`,
        { timeout: 10000 }
      );
      const brollMeta = JSON.parse(brollInfo);
      if (brollMeta?.streams?.[0]) {
        bW = brollMeta.streams[0].width || bW;
        bH = brollMeta.streams[0].height || bH;
      }
    } catch {}

    const baseIsPortrait  = srcH > srcW;
    const brollIsPortrait = bH > bW;
    const sameOrientation = baseIsPortrait === brollIsPortrait;

    const scaleFilter = sameOrientation
      ? `scale=${srcW}:${srcH}:force_original_aspect_ratio=increase,crop=${srcW}:${srcH}`
      : `scale=${srcW}:${srcH}:force_original_aspect_ratio=decrease,pad=${srcW}:${srcH}:(ow-iw)/2:(oh-ih)/2:black`;

    filterParts.push(`${trimLabel}${scaleFilter}${scaledLabel}`);

    // Overlay: gate this b-roll clip to its time window on the base video
    filterParts.push(
      `${currentVideo}${scaledLabel}overlay=enable='between(t,${seg._startSec.toFixed(3)},${seg._endSec.toFixed(3)})'${outLabel}`
    );

    // Next overlay sits on top of this output
    currentVideo = outLabel;
  }

  // All filter parts are now assembled — build the command
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