/* eslint-disable preserve-caught-error */
/* eslint-disable no-undef */
console.log("✅ [clipCutter] DYNAMIC CROP v3 LOADED");
const { execFile, exec } = require("child_process");
const path = require("path");
const fs   = require("fs");
const util = require("util");
const { v4: uuidv4 } = require("uuid");

const execFileAsync = util.promisify(execFile);
const execAsync     = util.promisify(exec);

function getFFmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

const COLOR_GRADES = {
  time:        "eq=contrast=1.08:saturation=1.10:brightness=0.01",
  money:       "eq=contrast=1.10:saturation=1.20:brightness=0.02",
  health:      "eq=contrast=1.08:saturation=1.15:brightness=0.01",
  success:     "eq=contrast=1.12:saturation=1.25:brightness=0.02",
  technology:  "eq=contrast=1.08:saturation=1.10",
  science:     "eq=contrast=1.05:saturation=0.90:brightness=-0.01",
  society:     "eq=contrast=1.06:saturation=1.05",
  philosophy:  "eq=contrast=1.05:saturation=0.92:brightness=-0.01",
  sports:      "eq=contrast=1.12:saturation=1.35:brightness=0.02",
  fitness:     "eq=contrast=1.10:saturation=1.30:brightness=0.02",
  motivation:  "eq=contrast=1.15:saturation=1.25:brightness=0.03",
  business:    "eq=contrast=1.08:saturation=1.10:brightness=0.01",
  documentary: "eq=contrast=1.05:saturation=0.88:brightness=-0.01",
  mystery:     "eq=contrast=1.10:saturation=0.80:brightness=-0.02",
  podcast:     "eq=contrast=1.04:saturation=0.95",
  educational: "eq=contrast=1.06:saturation=1.05",
  comedy:      "eq=contrast=1.10:saturation=1.20:brightness=0.02",
  cooking:     "eq=contrast=1.08:saturation=1.40:brightness=0.01",
  gaming:      "eq=contrast=1.10:saturation=1.15:brightness=-0.01",
  news:        "eq=contrast=1.06:saturation=0.95:brightness=0.01",
  general:     "eq=contrast=1.08:saturation=1.15",
};

const OUT_W  = 1080;
const OUT_H  = 1920;
const HALF_H = 960;

// Split zoom levels.
// SPLIT_ZOOM      — standard podcast (2 people roughly centred): slight zoom.
// SPLIT_ZOOM_WIDE — complex panel (faces >50% apart, e.g. 2-left / 2-right):
//                   barely any zoom so edge speakers are never cropped out.
const SPLIT_ZOOM      = 1.30;  // was 1.35 — less aggressive
const SPLIT_ZOOM_WIDE = 1.22;  // for isWideLayout panels

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ─── faceCropCoords ───────────────────────────────────────────────────────────
// Computes a 9:16 crop region from the source frame centred on (cxNorm, cyNorm).
// cropY is biased 38% above centre so the face sits slightly above the midpoint
// of the vertical frame — natural for portrait talking-head video.
function faceCropCoords(srcW, srcH, cxNorm, cyNorm, outW, outH) {
  const cropW = Math.min(Math.round(srcH * (outW / outH)), srcW);
  const cropH = Math.min(Math.round(cropW * (outH / outW)), srcH);
  const cropX = clamp(Math.round(cxNorm * srcW - cropW / 2), 0, srcW - cropW);
  const cropY = clamp(
    Math.round(cyNorm * srcH - cropH * 0.38),
    0,
    Math.max(0, srcH - cropH)
  );
  return { cropW, cropH, cropX, cropY };
}

// ─── faceCropCoordsZoomed ─────────────────────────────────────────────────────
// Used for split panels so each half fills its 540p slot with some presence.
// isRight: true for the right-side person — clamps cropX to right half of source
// so the two panels never overlap or show the same region.
function faceCropCoordsZoomed(srcW, srcH, cxNorm, cyNorm, outW, outH, zoom = 1.0, isRight = false) {
  const cropH = Math.round(srcH / zoom);
  const cropW = Math.min(Math.round(cropH * (outW / outH)), srcW);
  const idealX = Math.round(cxNorm * srcW - cropW / 2);
  // Left person: crop must start in left half (cropX + cropW <= srcW/2 + some slack)
  // Right person: crop must start far enough right that it centers on the right face
  // Core fix: clamp each side to its own half of the frame
  const halfW = Math.round(srcW / 2);
  const cropX = isRight
    ? clamp(idealX, Math.max(0, halfW - Math.round(cropW * 0.3)), srcW - cropW)
    : clamp(idealX, 0, Math.min(srcW - cropW, halfW + Math.round(cropW * 0.3)));
  const cropY = clamp(
    Math.round(cyNorm * srcH - cropH * 0.38),
    0,
    Math.max(0, srcH - cropH)
  );
  return { cropW, cropH, cropX, cropY };
}

// ─── _isFaceMode helper ───────────────────────────────────────────────────────
function _isFaceMode(mode) {
  return mode === "face" || mode === "face_left" || mode === "face_right";
}

// ─── buildStaticFilterSpec ────────────────────────────────────────────────────
// Produces a single-mode ffmpeg filter spec for clips that have a uniform layout
// (or for each segment inside buildDynamicFilterSpec).
//
// Modes handled:
//   face / face_left / face_right  — crop to focused speaker position
//   split                          — top/bottom vstack of left/right faces
//   blur_overlay                   — fit-in-frame with blurred background
//   passthrough                    — centre-crop letterboxed source
function buildStaticFilterSpec(decision, cropHint, srcW, srcH, grade, fade) {
  const mode = decision?.mode || "passthrough";

  // face / face_left / face_right all crop to the same faceCxNorm / faceCyNorm.
  // The directional distinction matters for ADJACENT segment merging in
  // buildDynamicFilterSpec (face_left→face_right is a real cut, not noise).
  if (_isFaceMode(mode)) {
    const { cropW, cropH, cropX, cropY } = faceCropCoords(
      srcW, srcH,
      decision.faceCxNorm ?? 0.5,
      decision.faceCyNorm ?? 0.5,
      OUT_W, OUT_H
    );
    return {
      mode:    "vf",
      vf:      `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${OUT_W}:${OUT_H},${grade},${fade}`,
      isSplit: false,
    };
  }

  if (mode === "blur_overlay") {
    const fc = [
      `[0:v]split[bg_raw][fg_raw]`,
      `[bg_raw]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},boxblur=55:5,eq=brightness=-0.25:saturation=0.5[blurbg]`,
      `[fg_raw]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease[fgfit]`,
      `[blurbg][fgfit]overlay=(W-w)/2:(H-h)/2,${grade},${fade}[outv]`,
      `[0:a]acopy[outa]`,
    ].join(";");
    return { mode: "fc", fc, videoLabel: "[outv]", audioLabel: "[outa]", isSplit: false };
  }

  if (mode === "split") {
    // Wide-layout panels use SPLIT_ZOOM_WIDE (1.05) to avoid cropping edge speakers.
    const zoom = decision.isWideLayout ? SPLIT_ZOOM_WIDE : SPLIT_ZOOM;

    const L = faceCropCoordsZoomed(
      srcW, srcH,
      decision.leftCxNorm  ?? 0.25,
      decision.leftCyNorm  ?? 0.4,
      OUT_W, HALF_H, zoom, false
    );
    const R = faceCropCoordsZoomed(
      srcW, srcH,
      decision.rightCxNorm ?? 0.75,
      decision.rightCyNorm ?? 0.4,
      OUT_W, HALF_H, zoom, true
    );
    const fc = [
      `[0:v]split[top_src][bot_src]`,
      `[top_src]crop=${L.cropW}:${L.cropH}:${L.cropX}:${L.cropY},scale=${OUT_W}:${HALF_H}[top]`,
      `[bot_src]crop=${R.cropW}:${R.cropH}:${R.cropX}:${R.cropY},scale=${OUT_W}:${HALF_H}[bot]`,
      `[top][bot]vstack=inputs=2,${grade},${fade}[outv]`,
      `[0:a]acopy[outa]`,
    ].join(";");
    return { mode: "fc", fc, videoLabel: "[outv]", audioLabel: "[outa]", isSplit: true };
  }

  // passthrough
  const y = cropHint?.y || "center";
  const scaleFilter = y === "upper" || y === "lower" ? "scale=-2:2100" : `scale=-2:${OUT_H}`;
  const yOff = y === "upper" ? ":60" : y === "lower" ? ":120" : ":(ih-1920)/2";
  return {
    mode:    "vf",
    vf:      `${scaleFilter},crop=${OUT_W}:${OUT_H}:(iw-${OUT_W})/2${yOff},${grade},${fade}`,
    isSplit: false,
  };
}

// ─── buildStableSplitFilterSpec ───────────────────────────────────────────────
// When a clip is ≥70% split frames, render with averaged left/right positions
// for the whole duration instead of per-second crops. Eliminates micro-jitter
// in split panel crop positions.
// Carries through isWideLayout via majority vote across all split frames.
function buildStableSplitFilterSpec(timeline, srcW, srcH, grade, fade) {
  const leftCxs  = [], leftCys  = [];
  const rightCxs = [], rightCys = [];
  let wideCount = 0, splitCount = 0;

  for (const e of timeline) {
    if (e.decision.mode !== "split") continue;
    leftCxs.push(e.decision.leftCxNorm   ?? 0.25);
    leftCys.push(e.decision.leftCyNorm   ?? 0.4);
    rightCxs.push(e.decision.rightCxNorm ?? 0.75);
    rightCys.push(e.decision.rightCyNorm ?? 0.4);
    if (e.decision.isWideLayout) wideCount++;
    splitCount++;
  }

  const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const lcx = avg(leftCxs)  ?? 0.25;
  const lcy = avg(leftCys)  ?? 0.40;
  const rcx = avg(rightCxs) ?? 0.75;
  const rcy = avg(rightCys) ?? 0.40;
  const isWideLayout = splitCount > 0 && (wideCount / splitCount) >= 0.5;

  const decision = {
    mode: "split",
    leftCxNorm:  lcx, leftCyNorm:  lcy,
    rightCxNorm: rcx, rightCyNorm: rcy,
    isWideLayout,
  };
  console.log(
    `[clipCutter] stable-split: L=(${lcx.toFixed(3)},${lcy.toFixed(3)}) R=(${rcx.toFixed(3)},${rcy.toFixed(3)}) wide=${isWideLayout}`
  );
  return { ...buildStaticFilterSpec(decision, null, srcW, srcH, grade, fade), isSplit: true };
}

// ─── buildDynamicFilterSpec ───────────────────────────────────────────────────
// Builds a per-segment filter complex for clips whose layout changes mid-way.
// Collapses adjacent segments with matching decisions to reduce filter complexity.
//
// face_left → face_right adjacency is NOT collapsed (different modes = real cut).
// face_left → face_left with nearly identical cx/cy IS collapsed (same shot drifting).
function buildDynamicFilterSpec(timeline, srcW, srcH, grade, fade, clipDuration) {
  const rawSegments = timeline.map((entry, i) => ({
    startT:   entry.clipTimeSec,
    endT:     i + 1 < timeline.length ? timeline[i + 1].clipTimeSec : clipDuration,
    decision: entry.decision,
  }));

  function decisionsMatch(a, b) {
    if (a.mode !== b.mode) return false;

    if (_isFaceMode(a.mode)) {
      return (
        Math.abs((a.faceCxNorm ?? 0.5) - (b.faceCxNorm ?? 0.5)) < 0.08 &&
        Math.abs((a.faceCyNorm ?? 0.5) - (b.faceCyNorm ?? 0.5)) < 0.08
      );
    }
    if (a.mode === "split") {
      return (
        Math.abs((a.leftCxNorm  ?? 0.25) - (b.leftCxNorm  ?? 0.25)) < 0.08 &&
        Math.abs((a.rightCxNorm ?? 0.75) - (b.rightCxNorm ?? 0.75)) < 0.08
      );
    }
    return true;
  }

  const segments = [];
  for (const raw of rawSegments) {
    const last = segments[segments.length - 1];
    if (last && decisionsMatch(last.decision, raw.decision)) {
      last.endT = raw.endT;
    } else {
      segments.push({ ...raw });
    }
  }

  console.log(
    `[clipCutter] collapsed ${rawSegments.length} raw entries → ${segments.length} segments`
  );
  console.log(
    `[clipCutter] dynamic segments: ${segments.map(s =>
      `${s.startT.toFixed(1)}s-${s.endT.toFixed(1)}s(${s.decision.mode})`
    ).join(", ")}`
  );

  const splitDuration  = segments
    .filter(s => s.decision.mode === "split")
    .reduce((acc, s) => acc + (s.endT - s.startT), 0);
  const isSplit = splitDuration / clipDuration > 0.4;

  // FIXED: Only use stable split rendering when there are NO face (1-person angle)
  // segments mixed in. If there are face segments, use dynamic per-segment rendering
  // so each camera angle (1-person vs 2-person) gets the correct layout.
  //
  // Old bug: rawSplitFrac >= 0.50 would collapse a clip with 60% split + 40% face
  // into a single stable split, rendering the 1-person angles as split too.
  const hasFaceSegments = segments.some(s => _isFaceMode(s.decision.mode));
  const rawSplitFrac    = rawSegments.filter(s => s.decision.mode === "split").length / (rawSegments.length || 1);

  if (rawSplitFrac >= 0.50 && !hasFaceSegments) {
    console.log(`[clipCutter] split-dominant (${(rawSplitFrac * 100).toFixed(0)}%), no face angles → stable split filter`);
    return buildStableSplitFilterSpec(timeline, srcW, srcH, grade, fade);
  }

  if (rawSplitFrac >= 0.50 && hasFaceSegments) {
    console.log(
      `[clipCutter] split-dominant (${(rawSplitFrac * 100).toFixed(0)}%) but has ` +
      `${segments.filter(s => _isFaceMode(s.decision.mode)).length} face angle(s) → dynamic per-segment render`
    );
  }

  if (segments.length === 1) {
    const seg    = segments[0];
    const dur    = Math.max(0.5, seg.endT - seg.startT);
    const segFade = `fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, dur - 0.5).toFixed(2)}:d=0.4`;
    const spec   = buildStaticFilterSpec(seg.decision, null, srcW, srcH, grade, segFade);
    return { ...spec, isSplit };
  }

  // Multi-segment dynamic filter
  const filterParts  = [];
  const videoStreams  = [];
  const audioStreams  = [];

  for (let i = 0; i < segments.length; i++) {
    const seg  = segments[i];
    const dur  = Math.max(0.5, seg.endT - seg.startT);
    const mode = seg.decision.mode;

    filterParts.push(
      `[0:v]trim=start=${seg.startT.toFixed(3)}:duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[seg${i}v_raw]`
    );
    filterParts.push(
      `[0:a]atrim=start=${seg.startT.toFixed(3)}:duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS[seg${i}a_raw]`
    );

    if (_isFaceMode(mode)) {
      const { cropW, cropH, cropX, cropY } = faceCropCoords(
        srcW, srcH,
        seg.decision.faceCxNorm ?? 0.5,
        seg.decision.faceCyNorm ?? 0.5,
        OUT_W, OUT_H
      );
      filterParts.push(
        `[seg${i}v_raw]crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${OUT_W}:${OUT_H},setsar=1[seg${i}v]`
      );
    } else if (mode === "split") {
      const zoom = seg.decision.isWideLayout ? SPLIT_ZOOM_WIDE : SPLIT_ZOOM;
      const L = faceCropCoordsZoomed(
        srcW, srcH,
        seg.decision.leftCxNorm  ?? 0.25,
        seg.decision.leftCyNorm  ?? 0.4,
        OUT_W, HALF_H, zoom, false
      );
      const R = faceCropCoordsZoomed(
        srcW, srcH,
        seg.decision.rightCxNorm ?? 0.75,
        seg.decision.rightCyNorm ?? 0.4,
        OUT_W, HALF_H, zoom, true
      );
      filterParts.push(`[seg${i}v_raw]split[seg${i}top_src][seg${i}bot_src]`);
      filterParts.push(
        `[seg${i}top_src]crop=${L.cropW}:${L.cropH}:${L.cropX}:${L.cropY},scale=${OUT_W}:${HALF_H}[seg${i}top]`
      );
      filterParts.push(
        `[seg${i}bot_src]crop=${R.cropW}:${R.cropH}:${R.cropX}:${R.cropY},scale=${OUT_W}:${HALF_H}[seg${i}bot]`
      );
      filterParts.push(
        `[seg${i}top][seg${i}bot]vstack=inputs=2,setsar=1[seg${i}v]`
      );
    } else if (mode === "blur_overlay") {
      filterParts.push(`[seg${i}v_raw]split[seg${i}bg_raw][seg${i}fg_raw]`);
      filterParts.push(
        `[seg${i}bg_raw]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},boxblur=55:5,eq=brightness=-0.25:saturation=0.5[seg${i}blurbg]`
      );
      filterParts.push(
        `[seg${i}fg_raw]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease[seg${i}fgfit]`
      );
      filterParts.push(
        `[seg${i}blurbg][seg${i}fgfit]overlay=(W-w)/2:(H-h)/2,setsar=1[seg${i}v]`
      );
    } else {
      // passthrough
      filterParts.push(
        `[seg${i}v_raw]scale=-2:${OUT_H},crop=${OUT_W}:${OUT_H}:(iw-${OUT_W})/2:(ih-${OUT_H})/2,setsar=1[seg${i}v]`
      );
    }

    videoStreams.push(`[seg${i}v]`);
    audioStreams.push(`[seg${i}a_raw]`);
  }

  const n = segments.length;
  const interleavedStreams = videoStreams.map((v, idx) => `${v}${audioStreams[idx]}`).join("");
  filterParts.push(`${interleavedStreams}concat=n=${n}:v=1:a=1[concat_v][concat_a]`);
  filterParts.push(`[concat_v]${grade},${fade}[outv]`);
  filterParts.push(`[concat_a]acopy[outa]`);

  return {
    mode:       "fc",
    fc:         filterParts.join(";"),
    videoLabel: "[outv]",
    audioLabel: "[outa]",
    isSplit,
  };
}

// ─── filterArgs ───────────────────────────────────────────────────────────────
function filterArgs(spec) {
  if (spec.mode === "fc") {
    return ["-filter_complex", spec.fc, "-map", spec.videoLabel, "-map", spec.audioLabel];
  }
  return ["-vf", spec.vf];
}

// ─── formatTime ───────────────────────────────────────────────────────────────
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── cutSingleSegment ─────────────────────────────────────────────────────────
async function cutSingleSegment(ffmpeg, videoPath, startSec, endSec, outputPath, filterSpec, videoArgs) {
  await execFileAsync(
    ffmpeg,
    [
      "-ss", startSec.toString(),
      "-i", videoPath,
      "-t", Math.max(1, endSec - startSec).toString(),
      ...filterArgs(filterSpec),
      ...videoArgs,
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-movflags", "+faststart",
      "-brand", "mp42",
      "-y", outputPath,
    ],
    { timeout: 10 * 60 * 1000 }
  );
}

// ─── stitchSegments ───────────────────────────────────────────────────────────
async function stitchSegments(ffmpeg, videoPath, segments, outputPath, filterSpec, videoArgs, tmpDir) {
  const tmpFiles = [];
  try {
    for (let i = 0; i < segments.length; i++) {
      const seg      = segments[i];
      const duration = Math.max(1, seg.endSec - seg.startSec);
      const tmpPath  = path.join(tmpDir, `_seg_${Date.now()}_${i}.mp4`);
      tmpFiles.push(tmpPath);

      console.log(`      Segment ${i + 1}: ${formatTime(seg.startSec)}→${formatTime(seg.endSec)} (${duration.toFixed(1)}s)`);

      await execFileAsync(
        ffmpeg,
        [
          "-ss", seg.startSec.toString(),
          "-i", videoPath,
          "-t", duration.toString(),
          ...filterArgs(filterSpec),
          ...videoArgs,
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", "192k",
          "-ar", "44100",
          "-y", tmpPath,
        ],
        { timeout: 5 * 60 * 1000 }
      );
    }

    const n         = tmpFiles.length;
    const inputArgs = tmpFiles.flatMap(f => ["-i", f]);
    const streams   = Array.from({ length: n }, (_, i) => `[${i}:v][${i}:a]`).join("");

    await execFileAsync(
      ffmpeg,
      [
        ...inputArgs,
        "-filter_complex", `${streams}concat=n=${n}:v=1:a=1[outv][outa]`,
        "-map", "[outv]",
        "-map", "[outa]",
        ...videoArgs,
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-brand", "mp42",
        "-y", outputPath,
      ],
      { timeout: 15 * 60 * 1000 }
    );
  } finally {
    for (const f of tmpFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
}

// ─── MAIN EXPORT: cutClip ─────────────────────────────────────────────────────
async function cutClip(
  videoPath,
  startSec,
  endSec,
  jobId,
  contentType  = "general",
  clipPlan     = null,
  clipTimeline = null
) {
  const ffmpeg    = getFFmpegPath();
  const outputDir = path.resolve(process.env.OUTPUT_DIR || "./outputs");
  const clipDir   = path.join(outputDir, jobId);
  if (!fs.existsSync(clipDir)) fs.mkdirSync(clipDir, { recursive: true });

  const filename   = `clip_${uuidv4()}.mp4`;
  const outputPath = path.join(clipDir, filename);
  const fileUrl    = `/outputs/${jobId}/${filename}`;

  const isMultiSeg    = clipPlan?.segments && clipPlan.segments.length > 1;
  const totalDuration = isMultiSeg
    ? clipPlan.segments.reduce((s, seg) => s + (seg.endSec - seg.startSec), 0)
    : Math.max(1, endSec - startSec);

  if (isMultiSeg) {
    console.log(
      `✂️  Stitching: ${clipPlan.segments.map(s => `${formatTime(s.startSec)}-${formatTime(s.endSec)}`).join(" + ")} (${totalDuration.toFixed(1)}s) [${contentType}]`
    );
  } else {
    console.log(
      `✂️  Cutting: ${formatTime(startSec)}→${formatTime(endSec)} (${totalDuration.toFixed(1)}s) [${contentType}]`
    );
  }

  try {
    const grade    = COLOR_GRADES[contentType] || COLOR_GRADES.general;
    const cropHint = clipPlan?.directives?.cropHint || { y: "center" };
    const fade     = `fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, totalDuration - 0.5).toFixed(2)}:d=0.4`;

    const useGpu    = process.env.USE_GPU_ENCODING === "true";
    const videoArgs = useGpu
      ? ["-c:v", "h264_nvenc", "-preset", "fast", "-cq", "20", "-profile:v", "main", "-level", "4.0"]
      : ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-profile:v", "main", "-level", "4.0"];

    let filterSpec;

    const {
      timeline        = [],
      srcW            = 1920,
      srcH            = 1080,
      isAlreadyVertical = false,
    } = clipTimeline || {};

    if (isAlreadyVertical || timeline.length === 0) {
      console.log(`[clipCutter] no timeline → passthrough`);
      filterSpec = buildStaticFilterSpec(
        { mode: "passthrough" },
        cropHint, srcW, srcH, grade, fade
      );
    } else {
      console.log(`[clipCutter] applying dynamic crop (${timeline.length} timeline entries)`);
      filterSpec = buildDynamicFilterSpec(timeline, srcW, srcH, grade, fade, totalDuration);
    }

    console.log(`[clipCutter] filterSpec.mode=${filterSpec.mode} isSplit=${filterSpec.isSplit}`);

    if (isMultiSeg) {
      await stitchSegments(
        ffmpeg, videoPath, clipPlan.segments,
        outputPath, filterSpec, videoArgs, clipDir
      );
    } else {
      await cutSingleSegment(
        ffmpeg, videoPath, startSec, endSec,
        outputPath, filterSpec, videoArgs
      );
    }

    console.log(`✅ Clip saved: ${outputPath}`);
    return { filePath: outputPath, fileUrl };
  } catch (err) {
    console.error("FFmpeg error:", err.stderr || err.message);
    throw new Error(`Clip cutting failed: ${err.message}`);
  }
}

module.exports = { cutClip, formatTime };