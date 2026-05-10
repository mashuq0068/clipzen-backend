"use strict";

const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const util = require("util");

const execAsync = util.promisify(exec);

// ─── YOUR PYTHON PATH — same as before ───────────────────────────────────────
const PYTHON = "C:\\Users\\ASUS\\AppData\\Local\\Python\\bin\\python.exe";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const SAMPLE_INTERVAL = 1.0;

/**
 * HOW SPLIT WORKS:
 * Two people are considered "side-by-side" (podcast style) when their
 * horizontal centres are far apart (cx diff > 0.25).
 * We only use split mode if that layout is sustained for a meaningful
 * fraction of the video — SPLIT_THRESHOLD_RATIO of total sampled frames.
 */
const SPLIT_THRESHOLD_RATIO = 0.30; // 30% of sampled frames must show side-by-side

const TMP_DIR = process.env.TMP_DIR
  ? path.resolve(process.env.TMP_DIR)
  : path.resolve(__dirname, "../../tmp");

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

// ─── YOLOv8-face inline Python script ────────────────────────────────────────
// Replaces the old MediaPipe BlazeFace script.
// YOLOv8-face handles:
//   - Faces far from camera (podcast/interview setups)
//   - Side angles, partial occlusions
//   - Multiple faces at different scales
//   - Low-contrast / mixed lighting conditions
//
// Model: yolov8n-face.pt (~6 MB, auto-downloaded once to ~/.cache/yolov8-face/)
// Source: https://github.com/akanametov/yolov8-face
// ─────────────────────────────────────────────────────────────────────────────
const FACE_SCRIPT = `
import sys, json, warnings, os
warnings.filterwarnings("ignore")

video_path = sys.argv[1]
times_file = sys.argv[2]

with open(times_file) as f:
    sample_times = json.load(f)

try:
    import cv2
    from ultralytics import YOLO

    # ── Model: download once, cache forever ──────────────────────────────────
    CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "yolov8-face")
    MODEL_PATH = os.path.join(CACHE_DIR, "yolov8n-face.pt")
    MODEL_URL = "https://github.com/akanametov/yolo-face/releases/download/1.0.0/yolov8n-face.pt"

    if not os.path.exists(MODEL_PATH):
        import urllib.request
        os.makedirs(CACHE_DIR, exist_ok=True)
        sys.stderr.write("[yolo] downloading yolov8n-face.pt (~6 MB)...\\n")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        sys.stderr.write("[yolo] model downloaded\\n")

    # Load model — suppress ultralytics console spam
    import logging
    logging.getLogger("ultralytics").setLevel(logging.ERROR)
    model = YOLO(MODEL_PATH)

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0

    out = {}

    for t in sample_times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        ok, frame = cap.read()
        if not ok:
            out[str(t)] = []
            continue

        h, w = frame.shape[:2]

        # ── Run YOLOv8 inference ─────────────────────────────────────────────
        # conf=0.30  → catches more faces; lower = more false positives
        # imgsz=640  → standard YOLO input size, good balance of speed/accuracy
        # verbose=False → suppress per-frame console output
        results = model(frame, conf=0.30, imgsz=640, verbose=False)[0]

        faces = []
        if results.boxes is not None and len(results.boxes) > 0:
            candidates = []
            for box in results.boxes.xyxy.cpu().tolist():
                x1, y1, x2, y2 = box[:4]

                # Clamp to frame bounds
                x1 = max(0.0, x1); y1 = max(0.0, y1)
                x2 = min(float(w), x2); y2 = min(float(h), y2)

                if x2 <= x1 or y2 <= y1:
                    continue  # degenerate box, skip

                bw = (x2 - x1) / w
                bh = (y2 - y1) / h
                area = bw * bh

                # Filter out background/audience/tiny faces.
                # Real speaker faces are typically >0.5% of frame area.
                # Background faces (audience, posters, screens) are <0.1%.
                if area < 0.005:
                    continue

                cx = ((x1 + x2) / 2) / w
                cy = ((y1 + y2) / 2) / h
                candidates.append({
                    "cx":  round(cx, 4),
                    "cy":  round(cy, 4),
                    "w":   round(bw, 4),
                    "h":   round(bh, 4),
                    "area": area,
                })

            # Keep only the 2 largest faces (main speakers), discard the rest
            candidates.sort(key=lambda f: f["area"], reverse=True)
            for f in candidates[:2]:
                faces.append({"cx": f["cx"], "cy": f["cy"], "w": f["w"], "h": f["h"]})

        out[str(t)] = faces

    cap.release()
    print(json.dumps({"ok": True, "frames": out}))

except Exception as e:
    import traceback
    print(json.dumps({
        "ok": False,
        "error": str(e),
        "traceback": traceback.format_exc()
    }))
`.trim();

// ─── Script file management ───────────────────────────────────────────────────
// Bumped to v8 so Node regenerates the .py file on next run.
function getFaceScriptPath() {
  ensureTmp();
  const p = path.join(TMP_DIR, "_reframe_faces_v8.py");
  if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== FACE_SCRIPT) {
    fs.writeFileSync(p, FACE_SCRIPT);
  }
  return p;
}

// ─── ffprobe helper ───────────────────────────────────────────────────────────
async function probe(videoPath) {
  const { stdout } = await execAsync(
    `"${FFPROBE}" -v quiet -print_format json -show_streams -select_streams v:0 "${videoPath}"`,
    { timeout: 15_000 }
  );
  const s = JSON.parse(stdout).streams?.[0] || {};
  return {
    w:   parseInt(s.width    || 1920, 10),
    h:   parseInt(s.height   || 1080, 10),
    dur: parseFloat(s.duration || 60),
  };
}

// ─── Run the Python face-detector ─────────────────────────────────────────────
async function detectFaces(videoPath, sampleTimes) {
  const scriptPath = getFaceScriptPath();
  const tmpJson = path.join(TMP_DIR, `_ftimes_${Date.now()}.json`);
  fs.writeFileSync(tmpJson, JSON.stringify(sampleTimes));

  try {
    const { stdout, stderr } = await execAsync(
      `"${PYTHON}" "${scriptPath}" "${videoPath}" "${tmpJson}"`,
      { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }
    );

    // Print any stderr (model download progress, warnings) to our console
    if (stderr && stderr.trim()) {
      console.log("[reframer/python]", stderr.trim().split("\n")[0]);
    }

    // The Python script always prints JSON as the last line
    const lastLine = stdout.trim().split("\n").pop();
    const result = JSON.parse(lastLine);

    if (!result.ok) {
      console.warn("[reframer] face detect error:", result.error);
      if (result.traceback) console.warn(result.traceback);
      return null;
    }

    return result.frames;
  } catch (e) {
    console.warn("[reframer] face detect failed:", e.message.split("\n")[0]);
    return null;
  } finally {
    try { fs.unlinkSync(tmpJson); } catch {}
  }
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────
/**
 * Analyze speakers and return crop instructions for clipCutter.
 *
 * Returns one of:
 *   { mode: "passthrough" }
 *     → already vertical, or no faces detected
 *
 *   { mode: "face", faceCxNorm: 0.6 }
 *     → single dominant face; pan horizontally to keep it centred
 *
 *   { mode: "blur_overlay" }
 *     → 2 faces that are NOT consistently side-by-side
 *       blurred background + letterboxed foreground
 *
 *   { mode: "split", leftCyNorm, rightCyNorm, leftCxNorm, rightCxNorm }
 *     → 2 faces consistently side-by-side (podcast layout)
 *       top half = left speaker, bottom half = right speaker
 */
async function analyzeSpeakers(videoPath) {
  let info;
  try {
    info = await probe(videoPath);
  } catch (e) {
    console.warn("[reframer] probe failed:", e.message);
    return { mode: "passthrough" };
  }

  // Already vertical — nothing to do
  if (info.w / info.h < 0.75) {
    console.log("[reframer] already vertical → passthrough");
    return { mode: "passthrough" };
  }

  const totalSamples = Math.min(120, Math.ceil(info.dur / SAMPLE_INTERVAL));
  const sampleTimes = Array.from({ length: totalSamples }, (_, i) =>
    parseFloat(((i * info.dur) / totalSamples).toFixed(2))
  );

  console.log(`[reframer] YOLOv8-face: scanning ${sampleTimes.length} frames…`);
  const faceFrames = await detectFaces(videoPath, sampleTimes);
  if (!faceFrames) return { mode: "passthrough" };

  // ── Tally face counts across all sampled frames ───────────────────────────
  const counts = Object.values(faceFrames).map(f => f.length);
  const total  = counts.length;
  const zero   = counts.filter(c => c === 0).length;
  const one    = counts.filter(c => c === 1).length;
  const two    = counts.filter(c => c >= 2).length;
  console.log(`[reframer] face counts — 0:${zero}  1:${one}  2+:${two}  (of ${total} frames)`);

  // ── No faces at all ───────────────────────────────────────────────────────
  if (zero === total) {
    console.log("[reframer] no faces → passthrough");
    return { mode: "passthrough" };
  }

  // ── Check for 2-person scene FIRST ───────────────────────────────────────
  // Even if single-face frames outnumber two-face frames, a substantial
  // two-face ratio (>=25%) means this is a 2-person video (interview/podcast).
  // We evaluate split eligibility before falling back to single-face mode.
  const twoFaceRatio = two / total;
  console.log(`[reframer] two-face ratio: ${(twoFaceRatio * 100).toFixed(1)}%`);

  if (twoFaceRatio >= 0.25) {
    let sideBySideFrames = 0;
    const leftCys = [], rightCys = [], leftCxs = [], rightCxs = [];

    for (const faces of Object.values(faceFrames)) {
      if (faces.length < 2) continue;
      const top2 = [...faces]
        .sort((a, b) => (b.w * b.h) - (a.w * a.h))
        .slice(0, 2)
        .sort((a, b) => a.cx - b.cx);
      const cxDiff = Math.abs(top2[0].cx - top2[1].cx);
      if (cxDiff > 0.25) {
        sideBySideFrames++;
        leftCys.push(top2[0].cy);
        rightCys.push(top2[1].cy);
        leftCxs.push(top2[0].cx);
        rightCxs.push(top2[1].cx);
      }
    }

    const sideBySideRatio = sideBySideFrames / total;
    console.log(`[reframer] side-by-side: ${sideBySideFrames}/${total} (${(sideBySideRatio * 100).toFixed(1)}%)`);

    if (sideBySideRatio >= SPLIT_THRESHOLD_RATIO && leftCys.length > 0) {
      const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
      const result = {
        mode:        "split",
        leftCyNorm:  avg(leftCys),
        rightCyNorm: avg(rightCys),
        leftCxNorm:  avg(leftCxs),
        rightCxNorm: avg(rightCxs),
      };
      console.log(`[reframer] split mode — left cx:${result.leftCxNorm.toFixed(3)} cy:${result.leftCyNorm.toFixed(3)} right cx:${result.rightCxNorm.toFixed(3)} cy:${result.rightCyNorm.toFixed(3)}`);
      return result;
    }

    console.log("[reframer] blur+overlay mode (2-face ratio met, not consistently side-by-side)");
    return { mode: "blur_overlay" };
  }

  // ── Single-face dominant ──────────────────────────────────────────────────
  if (one >= zero) {
    const oneFaceFrames = Object.values(faceFrames).filter(f => f.length === 1);
    const avgCx = oneFaceFrames.reduce((s, f) => s + f[0].cx, 0) / oneFaceFrames.length;
    console.log(`[reframer] single-face mode  avg cx: ${avgCx.toFixed(3)}`);
    return { mode: "face", faceCxNorm: avgCx };
  }

  console.log("[reframer] no clear face → passthrough");
  return { mode: "passthrough" };
}

module.exports = { analyzeSpeakers };