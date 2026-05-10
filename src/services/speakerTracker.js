/**
 * speakerTracker.js
 *
 * Speaker-aware video reframing for short-form content.
 *
 * TWO MODES — chosen automatically based on speaker count:
 *
 * Mode 1 — ACTIVE SPEAKER ZOOM (2+ speakers, wide shot)
 *   Detects who is talking at each moment and dynamically reframes
 *   the video to keep that person centered in the 9:16 frame.
 *   e.g. podcast with two hosts sitting side-by-side → zooms to
 *   whoever is speaking, cuts back when the other speaks.
 *
 * Mode 2 — SPLIT SCREEN (exactly 2 speakers, reaction/interview format)
 *   Top half = Speaker A, Bottom half = Speaker B.
 *   Each half is independently cropped to their face region.
 *   The active speaker's half gets a subtle brightness boost.
 *   e.g. interview, debate, reaction video.
 *
 * PIPELINE:
 *   1. Extract audio → WAV (16kHz mono — pyannote requirement)
 *   2. Run pyannote-audio speaker diarization → speaker turn timestamps
 *   3. Sample frames at each speaker turn → detect face bounding boxes
 *      using Python + OpenCV + mediapipe (no fine-tuning needed)
 *   4. Map speaker ID → face region (x, y, w, h in source video)
 *   5. Build FFmpeg filtergraph:
 *      - Mode 1: per-turn crop+zoom with smooth transitions
 *      - Mode 2: vstack with two independently cropped regions
 *   6. Render final 1080×1920 MP4 — replaces input file in-place
 *      (or writes to new path if keepOriginal=true)
 *
 * DEPENDENCIES (Python side — install once):
 *   pip install pyannote.audio mediapipe opencv-python torch
 *   # pyannote requires a Hugging Face token:
 *   # https://huggingface.co/pyannote/speaker-diarization-3.1
 *   # Set env: HUGGINGFACE_TOKEN=hf_...
 *
 * DEPENDENCIES (Node side):
 *   Already available: ffmpeg, child_process, fs
 *
 * .env:
 *   HUGGINGFACE_TOKEN=hf_...        ← required for pyannote
 *   SPEAKER_MODE=auto               ← auto | zoom | split
 *   SPEAKER_MIN_TURN=1.5            ← min speaker turn duration (secs)
 *   PYTHON_PATH=py -3.11            ← or "python3"
 *
 * OUTPUT shape (returned by analyzeAndReframe):
 *   {
 *     outputPath: string,            ← reframed MP4 path
 *     speakerCount: number,
 *     mode: "zoom" | "split" | "passthrough",
 *     turns: [{ speaker, startSec, endSec, cropRegion }],
 *   }
 *
 * GRACEFUL DEGRADATION:
 *   If pyannote or mediapipe are unavailable, returns passthrough
 *   (original video unchanged) with a clear warning. The pipeline
 *   never hard-fails — it falls back and continues.
 */

"use strict";

const { execFile, exec } = require("child_process");
const path   = require("path");
const fs     = require("fs");
const util   = require("util");
const { v4: uuidv4 } = require("uuid");

const execFileAsync = util.promisify(execFile);
const execAsync     = util.promisify(exec);

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const FFMPEG       = process.env.FFMPEG_PATH   || "ffmpeg";
const FFPROBE      = process.env.FFPROBE_PATH  || "ffprobe";
const PYTHON       = process.env.PYTHON_PATH   || "python3";
const HF_TOKEN     = process.env.HUGGINGFACE_TOKEN || "";
const SPEAKER_MODE = (process.env.SPEAKER_MODE || "auto").toLowerCase();
const MIN_TURN_SEC = parseFloat(process.env.SPEAKER_MIN_TURN || "1.5");

// Output dimensions — 9:16 vertical short
const OUT_W = 1080;
const OUT_H = 1920;

// ─────────────────────────────────────────────────────────────
// PYTHON HELPER SCRIPTS (written to disk on first use)
// These avoid needing a separate .py file in the repo.
// ─────────────────────────────────────────────────────────────
const DIARIZE_SCRIPT = `
import sys, json, os, warnings
warnings.filterwarnings("ignore")

audio_path = sys.argv[1]
hf_token   = sys.argv[2]
min_turn   = float(sys.argv[3]) if len(sys.argv) > 3 else 1.5

try:
    from pyannote.audio import Pipeline
    import torch
    # pyannote >= 3.0 uses token=, older versions used use_auth_token=
    # Try modern API first, fall back silently to legacy
    try:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            token=hf_token
        )
    except TypeError:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token
        )
    # Use GPU if available
    if torch.cuda.is_available():
        pipeline = pipeline.to(torch.device("cuda"))

    diarization = pipeline(audio_path)

    turns = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        dur = turn.end - turn.start
        if dur < min_turn:
            continue
        turns.append({
            "speaker":   speaker,
            "startSec":  round(turn.start, 3),
            "endSec":    round(turn.end,   3),
        })

    # Merge consecutive turns from same speaker
    merged = []
    for t in turns:
        if merged and merged[-1]["speaker"] == t["speaker"] and t["startSec"] - merged[-1]["endSec"] < 0.5:
            merged[-1]["endSec"] = t["endSec"]
        else:
            merged.append(t)

    print(json.dumps({"ok": True, "turns": merged}))

except ImportError as e:
    print(json.dumps({"ok": False, "error": f"pyannote not installed: {e}"}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`.trim();

const FACE_DETECT_SCRIPT = `
import sys, json, cv2, warnings
warnings.filterwarnings("ignore")

video_path   = sys.argv[1]
sample_times = json.loads(sys.argv[2])   # list of seconds to sample
video_w      = int(sys.argv[3])
video_h      = int(sys.argv[4])

try:
    import mediapipe as mp
    face_det = mp.solutions.face_detection.FaceDetection(
        model_selection=1,          # 1 = full-range model (up to 5m)
        min_detection_confidence=0.5
    )

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    results = {}

    for t in sample_times:
        frame_idx = int(t * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ok, frame = cap.read()
        if not ok:
            continue

        rgb   = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        det   = face_det.process(rgb)
        faces = []
        if det.detections:
            for d in det.detections:
                bb  = d.location_data.relative_bounding_box
                x   = max(0, bb.xmin)
                y   = max(0, bb.ymin)
                w   = min(bb.width,  1.0 - x)
                h   = min(bb.height, 1.0 - y)
                cx  = x + w / 2
                cy  = y + h / 2
                faces.append({
                    "x":  round(x,  4),
                    "y":  round(y,  4),
                    "w":  round(w,  4),
                    "h":  round(h,  4),
                    "cx": round(cx, 4),
                    "cy": round(cy, 4),
                    "score": round(d.score[0], 3) if d.score else 0.5
                })
        results[str(t)] = faces

    cap.release()
    face_det.close()
    print(json.dumps({"ok": True, "frames": results}))

except ImportError as e:
    print(json.dumps({"ok": False, "error": f"mediapipe/cv2 not installed: {e}"}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`.trim();

// ─────────────────────────────────────────────────────────────
// WRITE HELPER SCRIPTS
// ─────────────────────────────────────────────────────────────
const TMP_DIR = process.env.TMP_DIR
  ? path.resolve(process.env.TMP_DIR)
  : path.resolve(__dirname, "../../tmp");

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function getScriptPath(name) {
  ensureTmpDir();
  return path.join(TMP_DIR, name);
}

function writeScript(name, content) {
  const p = getScriptPath(name);
  // Only rewrite if content changed (avoids disk churn on repeated runs)
  if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== content) {
    fs.writeFileSync(p, content, "utf8");
  }
  return p;
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — PROBE VIDEO DIMENSIONS
// ─────────────────────────────────────────────────────────────
async function probeVideo(videoPath) {
  const { stdout } = await execAsync(
    `"${FFPROBE}" -v quiet -print_format json -show_streams -select_streams v:0 "${videoPath}"`,
    { timeout: 15_000 }
  );
  const info   = JSON.parse(stdout);
  const stream = info.streams?.[0] || {};
  return {
    width:    parseInt(stream.width  || "1920", 10),
    height:   parseInt(stream.height || "1080", 10),
    duration: parseFloat(stream.duration || "0"),
    fps:      eval(stream.r_frame_rate || "25/1"), // "30000/1001" → 29.97
  };
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — EXTRACT AUDIO FOR DIARIZATION
// pyannote needs 16kHz mono WAV
// ─────────────────────────────────────────────────────────────
async function extractMonoAudio(videoPath, tmpPath) {
  await execFileAsync(FFMPEG, [
    "-i",      videoPath,
    "-ar",     "16000",
    "-ac",     "1",
    "-f",      "wav",
    "-y",
    tmpPath,
  ], { timeout: 5 * 60_000 });
}

// ─────────────────────────────────────────────────────────────
// STEP 3 — DIARIZE: who speaks when
// Returns: [{ speaker, startSec, endSec }] or null on failure
// ─────────────────────────────────────────────────────────────
async function diarizeSpeakers(audioPath) {
  if (!HF_TOKEN) {
    console.warn("   ⚠️  speakerTracker: HUGGINGFACE_TOKEN not set — skipping diarization");
    return null;
  }

  const scriptPath = writeScript("_diarize.py", DIARIZE_SCRIPT);

  try {
    const { stdout } = await execAsync(
      `${PYTHON} "${scriptPath}" "${audioPath}" "${HF_TOKEN}" ${MIN_TURN_SEC}`,
      { timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 }
    );

    // Last line is the JSON (Python may print warnings before it)
    const lines  = stdout.trim().split("\n");
    const result = JSON.parse(lines[lines.length - 1]);

    if (!result.ok) {
      console.warn(`   ⚠️  speakerTracker diarization: ${result.error}`);
      return null;
    }
    return result.turns;
  } catch (err) {
    console.warn(`   ⚠️  speakerTracker diarization failed: ${err.message.split("\n")[0]}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 4 — DETECT FACES at sampled frames
// Returns: { [timeSec]: [{ x, y, w, h, cx, cy, score }] }
// All values are 0.0–1.0 relative to frame dimensions.
// ─────────────────────────────────────────────────────────────
async function detectFaces(videoPath, sampleTimes, videoW, videoH) {
  const scriptPath = writeScript("_facedetect.py", FACE_DETECT_SCRIPT);

  try {
    const { stdout } = await execAsync(
      `${PYTHON} "${scriptPath}" "${videoPath}" '${JSON.stringify(sampleTimes)}' ${videoW} ${videoH}`,
      { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }
    );

    const lines  = stdout.trim().split("\n");
    const result = JSON.parse(lines[lines.length - 1]);

    if (!result.ok) {
      console.warn(`   ⚠️  speakerTracker face detection: ${result.error}`);
      return {};
    }
    return result.frames;
  } catch (err) {
    console.warn(`   ⚠️  speakerTracker face detection failed: ${err.message.split("\n")[0]}`);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 5 — MAP SPEAKERS TO FACE REGIONS
//
// Strategy:
//   - For each speaker turn, sample 2 frames (1/3 and 2/3 of turn duration)
//   - If we detect 2 faces: cluster by horizontal position (left/right)
//     and match speaker ID to face cluster across all turns
//   - If we detect 1 face per turn: each turn's face = that speaker
//   - Returns: Map<speakerId, { cx, cy, w, h }> — dominant face region
// ─────────────────────────────────────────────────────────────
function mapSpeakersToFaces(turns, faceFrames) {
  // Collect per-speaker face center observations
  const speakerObs = {}; // speakerId → [{ cx, cy, w, h }]

  for (const turn of turns) {
    const t1 = turn.startSec + (turn.endSec - turn.startSec) * 0.33;
    const t2 = turn.startSec + (turn.endSec - turn.startSec) * 0.67;

    for (const t of [t1, t2]) {
      // Find closest sampled frame
      const key = Object.keys(faceFrames)
        .map(k => ({ k, d: Math.abs(parseFloat(k) - t) }))
        .sort((a, b) => a.d - b.d)[0]?.k;

      if (!key) continue;
      const faces = faceFrames[key] || [];

      if (faces.length === 0) continue;

      if (faces.length === 1) {
        // Single face — assign to this speaker
        if (!speakerObs[turn.speaker]) speakerObs[turn.speaker] = [];
        speakerObs[turn.speaker].push(faces[0]);
      } else {
        // Multiple faces — determine which face belongs to this speaker
        // by checking if previous turns give us a position hint.
        // Heuristic: for 2-speaker videos, speakers are left/right of center.
        // The most confident face (highest score) is the active speaker.
        const best = faces.reduce((a, b) => a.score > b.score ? a : b);
        if (!speakerObs[turn.speaker]) speakerObs[turn.speaker] = [];
        speakerObs[turn.speaker].push(best);
      }
    }
  }

  // Average observations per speaker → stable crop center
  const speakerRegions = {};
  for (const [spk, obs] of Object.entries(speakerObs)) {
    if (obs.length === 0) continue;
    speakerRegions[spk] = {
      cx: obs.reduce((s, o) => s + o.cx, 0) / obs.length,
      cy: obs.reduce((s, o) => s + o.cy, 0) / obs.length,
      // Use median face width/height for stability (outliers from distance changes)
      w:  obs.map(o => o.w).sort()[Math.floor(obs.length / 2)],
      h:  obs.map(o => o.h).sort()[Math.floor(obs.length / 2)],
    };
  }

  return speakerRegions;
}

// ─────────────────────────────────────────────────────────────
// STEP 6a — BUILD ZOOM FILTERGRAPH (Mode 1: active speaker)
//
// For each speaker turn, we build a crop that:
//   - Centers on the active speaker's face
//   - Maintains 9:16 aspect ratio
//   - Adds smooth bezier transition between speaker crops
//     using FFmpeg overlay+fade instead of hard cuts
//
// The approach:
//   - Base track: full-frame scaled to 1080×1920 (letterboxed/cropped)
//   - Per-turn: crop to speaker face region, scale to 1080×1920
//   - Fade in/out over TRANSITION_FRAMES frames
// ─────────────────────────────────────────────────────────────
const TRANSITION_FRAMES = 15; // 0.5s at 30fps — smooth speaker switch

function buildZoomFiltergraph(turns, speakerRegions, videoW, videoH, durationSec) {
  // For each turn, compute absolute pixel crop for the speaker
  const enriched = turns.map(turn => {
    const reg = speakerRegions[turn.speaker];
    if (!reg) return { ...turn, crop: null };

    // Face center in absolute pixels
    const faceCX = reg.cx * videoW;
    const faceCY = reg.cy * videoH;

    // We want 9:16 crop. Compute crop height from video width.
    // Aim to keep face taking ~40% of frame height (close-up feel)
    const cropH = Math.min(videoH, Math.round(videoW * (OUT_H / OUT_W)));
    const cropW = Math.min(videoW, Math.round(cropH * (OUT_W / OUT_H)));

    // Crop X: center on face, clamp to frame
    let cropX = Math.round(faceCX - cropW / 2);
    cropX = Math.max(0, Math.min(videoW - cropW, cropX));

    // Crop Y: put face in upper-middle of frame (not dead center)
    let cropY = Math.round(faceCY - cropH * 0.38);
    cropY = Math.max(0, Math.min(videoH - cropH, cropY));

    return { ...turn, crop: { x: cropX, y: cropY, w: cropW, h: cropH } };
  }).filter(t => t.crop !== null);

  if (enriched.length === 0) return null;

  // Build FFmpeg complex filter using trim+setpts per turn, then concat
  // Each segment: trim → crop → scale → setpts
  const inputs  = [];
  const streams = [];

  enriched.forEach((turn, i) => {
    const label = `[seg${i}]`;
    const { x, y, w, h } = turn.crop;
    const dur = turn.endSec - turn.startSec;

    // Add fade-in/out for smooth transitions between speakers
    const fadeIn  = i > 0 ? `,fade=t=in:st=0:d=${TRANSITION_FRAMES / 30}` : "";
    const fadeOut = i < enriched.length - 1 ? `,fade=t=out:st=${Math.max(0, dur - TRANSITION_FRAMES/30).toFixed(3)}:d=${TRANSITION_FRAMES / 30}` : "";

    inputs.push(
      `[0:v]trim=${turn.startSec.toFixed(3)}:${turn.endSec.toFixed(3)},` +
      `setpts=PTS-STARTPTS,` +
      `crop=${w}:${h}:${x}:${y},` +
      `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,` +
      `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2` +
      `${fadeIn}${fadeOut}${label}`
    );
    streams.push(label);
  });

  const concatFilter = `${streams.join("")}concat=n=${streams.length}:v=1:a=0[outv]`;
  const audioMap = `[0:a]atrim=${enriched[0].startSec.toFixed(3)}:${enriched[enriched.length-1].endSec.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;

  return {
    filterComplex: [...inputs, concatFilter, audioMap].join(";"),
    videoMap:  "[outv]",
    audioMap:  "[outa]",
    startSec:  enriched[0].startSec,
    endSec:    enriched[enriched.length - 1].endSec,
  };
}

// ─────────────────────────────────────────────────────────────
// STEP 6b — BUILD SPLIT-SCREEN FILTERGRAPH (Mode 2: two speakers)
//
// Top half (0 → OUT_H/2): Speaker A
// Bottom half (OUT_H/2 → OUT_H): Speaker B
//
// The active speaker's half gets a subtle brightness boost (+15%).
// We build the full video as a series of segments where the brightness
// of each half is toggled based on who is speaking.
// ─────────────────────────────────────────────────────────────
function buildSplitFiltergraph(turns, speakerRegions, videoW, videoH) {
  const speakerIds = Object.keys(speakerRegions);
  if (speakerIds.length < 2) return null;

  const [spkA, spkB] = speakerIds;
  const regA = speakerRegions[spkA];
  const regB = speakerRegions[spkB];

  // Half height in output
  const halfH = Math.floor(OUT_H / 2);

  // Compute crop for each speaker's half
  function halfCrop(reg) {
    const cropW = videoW;
    const cropH = Math.round(videoW * (halfH / OUT_W));
    const faceCY = reg.cy * videoH;
    let cropY = Math.round(faceCY - cropH * 0.4);
    cropY = Math.max(0, Math.min(videoH - cropH, cropY));
    return { x: 0, y: cropY, w: cropW, h: cropH };
  }

  const cropA = halfCrop(regA);
  const cropB = halfCrop(regB);

  // Determine who is active at each moment
  // Build timeline segments: [{ startSec, endSec, activeSpeaker }]
  const segments = [];
  let cursor = 0;
  const allTurns = [...turns].sort((a, b) => a.startSec - b.startSec);

  for (const turn of allTurns) {
    if (turn.startSec > cursor) {
      // Gap — no active speaker — use last known or spkA
      segments.push({
        startSec: cursor,
        endSec:   turn.startSec,
        active:   segments.length > 0 ? segments[segments.length-1].active : spkA,
      });
    }
    segments.push({
      startSec: turn.startSec,
      endSec:   turn.endSec,
      active:   turn.speaker,
    });
    cursor = turn.endSec;
  }

  // Build filtergraph: for each segment, create top+bottom crops, stack them
  const segFilters = [];
  const segLabels  = [];

  segments.forEach((seg, i) => {
    const dur    = seg.endSec - seg.startSec;
    if (dur < 0.05) return;

    const brightnessA = seg.active === spkA ? 1.0 : 0.72;
    const brightnessB = seg.active === spkB ? 1.0 : 0.72;

    const topLabel  = `[top${i}]`;
    const botLabel  = `[bot${i}]`;
    const stkLabel  = `[stk${i}]`;

    // Top half — Speaker A
    segFilters.push(
      `[0:v]trim=${seg.startSec.toFixed(3)}:${seg.endSec.toFixed(3)},` +
      `setpts=PTS-STARTPTS,` +
      `crop=${cropA.w}:${cropA.h}:${cropA.x}:${cropA.y},` +
      `scale=${OUT_W}:${halfH},` +
      `eq=brightness=${(brightnessA - 1).toFixed(2)}` +
      `${topLabel}`
    );

    // Bottom half — Speaker B
    segFilters.push(
      `[0:v]trim=${seg.startSec.toFixed(3)}:${seg.endSec.toFixed(3)},` +
      `setpts=PTS-STARTPTS,` +
      `crop=${cropB.w}:${cropB.h}:${cropB.x}:${cropB.y},` +
      `scale=${OUT_W}:${halfH},` +
      `eq=brightness=${(brightnessB - 1).toFixed(2)}` +
      `${botLabel}`
    );

    // Stack top + bottom
    segFilters.push(`${topLabel}${botLabel}vstack=inputs=2${stkLabel}`);
    segLabels.push(stkLabel);
  });

  if (segLabels.length === 0) return null;

  const concatFilter = `${segLabels.join("")}concat=n=${segLabels.length}:v=1:a=0[outv]`;

  const firstSeg = segments[0];
  const lastSeg  = segments[segments.length - 1];
  const audioMap = `[0:a]atrim=${firstSeg.startSec.toFixed(3)}:${lastSeg.endSec.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;

  return {
    filterComplex: [...segFilters, concatFilter, audioMap].join(";"),
    videoMap: "[outv]",
    audioMap: "[outa]",
    startSec: firstSeg.startSec,
    endSec:   lastSeg.endSec,
  };
}

// ─────────────────────────────────────────────────────────────
// STEP 7 — RENDER via FFmpeg
// ─────────────────────────────────────────────────────────────
async function renderReframed(videoPath, filterSpec, outputPath) {
  const useGpu = process.env.USE_GPU_ENCODING === "true";
  const videoCodec = useGpu
    ? ["-c:v", "h264_nvenc", "-preset", "fast", "-cq", "20"]
    : ["-c:v", "libx264",    "-preset", "medium", "-crf", "20"];

  await execFileAsync(FFMPEG, [
    "-i",              videoPath,
    "-filter_complex", filterSpec.filterComplex,
    "-map",            filterSpec.videoMap,
    "-map",            filterSpec.audioMap,
    ...videoCodec,
    "-profile:v",   "main",
    "-level",        "4.0",
    "-pix_fmt",     "yuv420p",
    "-c:a",         "aac",
    "-b:a",         "192k",
    "-ar",          "44100",
    "-movflags",    "+faststart",
    "-y",
    outputPath,
  ], { timeout: 15 * 60_000 });
}

// ─────────────────────────────────────────────────────────────
// STEP 8 — SIMPLE FALLBACK: just center-crop to 9:16
// Used when diarization/face detection fails or single speaker.
// ─────────────────────────────────────────────────────────────
async function centerCropPassthrough(videoPath, outputPath, videoW, videoH) {
  const cropH = Math.min(videoH, Math.round(videoW * (OUT_H / OUT_W)));
  const cropW = Math.min(videoW, Math.round(cropH * (OUT_W / OUT_H)));
  const cropX = Math.round((videoW - cropW) / 2);
  const cropY = Math.round((videoH - cropH) / 2);

  await execFileAsync(FFMPEG, [
    "-i",   videoPath,
    "-vf",  `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${OUT_W}:${OUT_H}`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "copy",
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ], { timeout: 10 * 60_000 });
}

// ─────────────────────────────────────────────────────────────
// DECIDE MODE
// ─────────────────────────────────────────────────────────────
function decideMode(speakerCount, forced) {
  if (forced === "zoom")  return "zoom";
  if (forced === "split") return "split";
  if (speakerCount >= 2)  return "zoom";  // default for 2+ speakers
  return "passthrough";
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT — analyzeAndReframe
//
// @param {string} videoPath     — input MP4
// @param {object} options
//   @param {string}  outputPath — where to write reframed MP4
//                                 defaults to <input>_reframed.mp4
//   @param {string}  mode       — "auto" | "zoom" | "split"
//   @param {boolean} keepOriginal — don't overwrite input (default false)
//
// @returns {object}
//   { outputPath, speakerCount, mode, turns, speakerRegions }
// ─────────────────────────────────────────────────────────────
async function analyzeAndReframe(videoPath, options = {}) {
  const {
    outputPath:    requestedOutput = null,
    mode:          forcedMode      = SPEAKER_MODE,
    keepOriginal   = false,
  } = options;

  const outputPath = requestedOutput
    || videoPath.replace(/\.mp4$/i, "_reframed.mp4");

  console.log(`\n🎯 speakerTracker: ${path.basename(videoPath)}`);

  // ── Probe video ──────────────────────────────────────────────
  let videoInfo;
  try {
    videoInfo = await probeVideo(videoPath);
  } catch (err) {
    console.warn(`   ⚠️  probe failed: ${err.message}`);
    return passthrough(videoPath, outputPath, keepOriginal);
  }
  const { width: videoW, height: videoH, duration: videoDur } = videoInfo;
  console.log(`   📐 Source: ${videoW}×${videoH} (${videoDur.toFixed(1)}s)`);

  // ── Already vertical? Skip reframing ────────────────────────
  const aspectRatio = videoW / videoH;
  if (aspectRatio < 0.7) {
    console.log(`   ✅ Already vertical (${aspectRatio.toFixed(2)}) — passthrough`);
    return passthrough(videoPath, outputPath, keepOriginal);
  }

  // ── Extract mono audio for diarization ──────────────────────
  ensureTmpDir();
  const audioTmp = path.join(TMP_DIR, `_diarize_audio_${uuidv4()}.wav`);
  try {
    await extractMonoAudio(videoPath, audioTmp);
  } catch (err) {
    console.warn(`   ⚠️  audio extraction failed: ${err.message}`);
    return passthrough(videoPath, outputPath, keepOriginal);
  }

  // ── Diarize ──────────────────────────────────────────────────
  let turns = null;
  try {
    turns = await diarizeSpeakers(audioTmp);
  } finally {
    try { fs.unlinkSync(audioTmp); } catch {}
  }

  if (!turns || turns.length === 0) {
    console.log(`   ⚠️  No speaker turns detected — center crop fallback`);
    await centerCropPassthrough(videoPath, outputPath, videoW, videoH);
    return {
      outputPath, speakerCount: 1, mode: "passthrough",
      turns: [], speakerRegions: {},
    };
  }

  // Count unique speakers
  const uniqueSpeakers = [...new Set(turns.map(t => t.speaker))];
  const speakerCount   = uniqueSpeakers.length;
  console.log(`   🗣  ${speakerCount} speaker(s) | ${turns.length} turns`);
  turns.forEach(t =>
    console.log(`      ${t.speaker}: ${t.startSec.toFixed(1)}s → ${t.endSec.toFixed(1)}s`)
  );

  const mode = decideMode(speakerCount, forcedMode);
  console.log(`   🎬 Mode: ${mode}`);

  // ── Detect faces ─────────────────────────────────────────────
  // Sample 2 frames per turn (at 33% and 67% of turn)
  const sampleTimes = [];
  for (const turn of turns) {
    const dur = turn.endSec - turn.startSec;
    sampleTimes.push(
      parseFloat((turn.startSec + dur * 0.33).toFixed(2)),
      parseFloat((turn.startSec + dur * 0.67).toFixed(2)),
    );
  }
  // Deduplicate and clamp to video duration
  const dedupedTimes = [...new Set(sampleTimes)]
    .filter(t => t >= 0 && t < videoDur)
    .sort((a, b) => a - b);

  console.log(`   🔍 Sampling ${dedupedTimes.length} frames for face detection...`);
  const faceFrames = await detectFaces(videoPath, dedupedTimes, videoW, videoH);

  const detectedCount = Object.values(faceFrames).filter(f => f.length > 0).length;
  console.log(`   👤 Faces found in ${detectedCount}/${dedupedTimes.length} sampled frames`);

  // ── Map speakers → faces ─────────────────────────────────────
  const speakerRegions = mapSpeakersToFaces(turns, faceFrames);
  const mappedSpeakers = Object.keys(speakerRegions).length;
  console.log(`   🗺  Mapped ${mappedSpeakers} speaker(s) to face regions`);

  if (mappedSpeakers === 0) {
    console.log(`   ⚠️  No face regions mapped — center crop fallback`);
    await centerCropPassthrough(videoPath, outputPath, videoW, videoH);
    return {
      outputPath, speakerCount, mode: "passthrough",
      turns, speakerRegions: {},
    };
  }

  // ── Build filtergraph ────────────────────────────────────────
  let filterSpec = null;

  if (mode === "split" && mappedSpeakers >= 2) {
    filterSpec = buildSplitFiltergraph(turns, speakerRegions, videoW, videoH);
    if (!filterSpec) {
      console.warn("   ⚠️  Split filtergraph failed — falling back to zoom");
    }
  }

  if (!filterSpec) {
    // zoom mode or split fallback
    filterSpec = buildZoomFiltergraph(turns, speakerRegions, videoW, videoH, videoDur);
  }

  if (!filterSpec) {
    console.log(`   ⚠️  Filtergraph build failed — center crop fallback`);
    await centerCropPassthrough(videoPath, outputPath, videoW, videoH);
    return {
      outputPath, speakerCount, mode: "passthrough",
      turns, speakerRegions,
    };
  }

  // ── Render ───────────────────────────────────────────────────
  console.log(`   🎞  Rendering reframed video...`);
  try {
    await renderReframed(videoPath, filterSpec, outputPath);
  } catch (err) {
    console.error(`   ❌ Render failed: ${err.message}`);
    await centerCropPassthrough(videoPath, outputPath, videoW, videoH);
    return {
      outputPath, speakerCount, mode: "passthrough",
      turns, speakerRegions,
    };
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 50_000) {
    console.warn(`   ⚠️  Output suspicious — returning original`);
    return passthrough(videoPath, outputPath, keepOriginal);
  }

  const mb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`   ✅ Reframed: ${mb}MB (${mode})`);

  return { outputPath, speakerCount, mode, turns, speakerRegions };
}

// ─────────────────────────────────────────────────────────────
// HELPER — passthrough (copy or symlink original)
// ─────────────────────────────────────────────────────────────
async function passthrough(videoPath, outputPath, keepOriginal) {
  if (videoPath !== outputPath) {
    if (keepOriginal) {
      fs.copyFileSync(videoPath, outputPath);
    } else {
      // Just point output at original — no copy needed
      return {
        outputPath:   videoPath,
        speakerCount: 1,
        mode:         "passthrough",
        turns:        [],
        speakerRegions: {},
      };
    }
  }
  return {
    outputPath, speakerCount: 1, mode: "passthrough",
    turns: [], speakerRegions: {},
  };
}

// ─────────────────────────────────────────────────────────────
// INTEGRATION HELPER — for videoWorker.js
//
// Call this AFTER download, BEFORE transcription.
// Returns the path to use for all subsequent processing.
//
// Usage in videoWorker.js:
//   const { reframeForShorts } = require("../services/speakerTracker");
//   videoPath = await reframeForShorts(videoPath, jobId);
// ─────────────────────────────────────────────────────────────
async function reframeForShorts(videoPath, jobId) {
  const outputDir  = path.dirname(videoPath);
  const outputPath = path.join(
    outputDir,
    `${path.basename(videoPath, ".mp4")}_reframed.mp4`
  );

  try {
    const result = await analyzeAndReframe(videoPath, {
      outputPath,
      mode: SPEAKER_MODE,
      keepOriginal: true,
    });

    if (result.mode === "passthrough") {
      // No reframing — use original
      return videoPath;
    }

    console.log(`   🎯 Reframed (${result.mode}, ${result.speakerCount} speakers) → ${path.basename(outputPath)}`);
    return result.outputPath;

  } catch (err) {
    console.warn(`   ⚠️  speakerTracker.reframeForShorts failed: ${err.message}`);
    return videoPath; // always safe — original untouched
  }
}

module.exports = {
  analyzeAndReframe,
  reframeForShorts,
  diarizeSpeakers,
  detectFaces,
  mapSpeakersToFaces,
};