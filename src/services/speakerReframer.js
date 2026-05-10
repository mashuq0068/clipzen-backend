"use strict";

/**
 * speakerReframer.js  —  Clipzen v3
 *
 * CHANGES vs v2:
 *   1. Python script now returns per-frame scene-change flag via histogram
 *      correlation. Transitional frames get 0.3 vote weight instead of 1.0,
 *      so lighting pops / exposure shifts can't flip a stable layout decision.
 *   2. classifyFrame() now returns face_left / face_right for 2-face frames
 *      that don't qualify as a clean split. These let downstream cuts animate
 *      between the focused speaker rather than always picking the biggest face.
 *   3. isWideLayout flag on split decisions when faces are >50% apart (complex
 *      panel seating — 2 people left, 2 right). clipCutter uses this to apply
 *      less zoom so edge speakers are never cropped out.
 *   4. globalVote() does weighted voting and normalises face_left/face_right
 *      into the "face" bucket for dominant-mode comparison.
 *   5. smoothTimeline() treats face / face_left / face_right identically in
 *      hysteresis smoothing via _isFaceMode() helper.
 *   6. buildFullVideoLayoutMap() now samples at 3 s intervals (was 1 s) and
 *      caps at 300 samples — ~3× cheaper on long videos with equal coarse accuracy.
 *   7. _runPythonChunk() unpacks the new { faces, sceneChange } dict format
 *      from Python and stores sceneChange alongside the face array.
 *   8. analyzeClipTimeline() and buildFullVideoLayoutMap() both propagate
 *      sceneChange into classifyFrame() and the raw timeline.
 */

const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const util = require("util");

const execAsync = util.promisify(exec);

// ─── Config ───────────────────────────────────────────────────────────────────
const PYTHON = process.env.PYTHON_PATH ||
  (process.platform === "win32"
    ? "C:\\Users\\ASUS\\AppData\\Local\\Python\\bin\\python.exe"
    : "python3");

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

// Per-clip dense scan interval. 1.0 s = good balance of accuracy vs CPU.
const SAMPLE_INTERVAL = parseFloat(process.env.REFRAMER_SAMPLE_INTERVAL || "1.0");

// Full-video SPARSE scan interval (used only for layout map / clip scoring).
// 3.0 s is ~3× cheaper and still catches all camera cuts.
const LAYOUT_MAP_INTERVAL = parseFloat(process.env.LAYOUT_MAP_INTERVAL || "3.0");

// Minimum consecutive seconds a layout must hold before we commit to it.
const MIN_HOLD_SECS = parseFloat(process.env.REFRAMER_MIN_HOLD || "1.5");

// What fraction of frames must agree on a mode for it to win the global vote.
const GLOBAL_VOTE_THRESHOLD = 0.55;

// Split: minimum horizontal separation between face centers (normalized 0-1).
const SPLIT_MIN_CX_DIFF = 0.18;

// Split: maximum vertical separation — prevents top/bottom stacking being called "split"
const SPLIT_MAX_CY_DIFF = 0.40;

// Split: minimum area ratio between larger and smaller face.
const SPLIT_MIN_AREA_RATIO = 0.20;

// Split: minimum individual face area (normalized).
const SPLIT_MIN_FACE_AREA = 0.010;

// Split: if faces are this far apart horizontally, flag as wide-layout panel.
// clipCutter uses SPLIT_ZOOM_WIDE instead of SPLIT_ZOOM for these.
const SPLIT_WIDE_LAYOUT_CX_DIFF = 0.50;

// Face: minimum area to be considered a "dominant" single speaker.
const FACE_MIN_AREA = 0.008;

// Scene-change: histogram correlation below (1 - this threshold) = likely transition.
// Frames flagged as scene changes count as 0.3 votes in globalVote.
const SCENE_CHANGE_HIST_THRESH = 0.42;

const TMP_DIR = process.env.TMP_DIR
  ? path.resolve(process.env.TMP_DIR)
  : path.resolve(__dirname, "../../tmp");

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

// ─── Python face detection script ─────────────────────────────────────────────
// Returns per-frame data: { "t": { faces: [...], sceneChange: bool } }
// Face IDs are assigned in JS (not Python) for stability.
// sceneChange is set when the grayscale histogram correlation with the
// previous sample drops below the threshold — catches lighting pops,
// exposure shifts, and camera cuts between frames.
const FACE_SCRIPT = `
import sys, json, warnings, os
warnings.filterwarnings("ignore")

video_path = sys.argv[1]
times_file = sys.argv[2]

with open(times_file) as f:
    sample_times = json.load(f)

SCENE_HIST_THRESH = ${SCENE_CHANGE_HIST_THRESH}

try:
    import cv2
    from ultralytics import YOLO
    import logging
    logging.getLogger("ultralytics").setLevel(logging.ERROR)

    CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "yolov8-face")
    MODEL_PATH = os.path.join(CACHE_DIR, "yolov8n-face.pt")
    MODEL_URL = "https://github.com/akanametov/yolo-face/releases/download/1.0.0/yolov8n-face.pt"

    if not os.path.exists(MODEL_PATH):
        import urllib.request
        os.makedirs(CACHE_DIR, exist_ok=True)
        sys.stderr.write("[yolo] downloading yolov8n-face.pt...\\n")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        sys.stderr.write("[yolo] model downloaded\\n")

    model = YOLO(MODEL_PATH)
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    out = {}
    prev_hist = None

    for t in sample_times:
        frame_idx = int(t * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ok, frame = cap.read()
        if not ok:
            out[str(t)] = {"faces": [], "sceneChange": False}
            prev_hist = None
            continue

        # ── Scene-change detection via grayscale histogram correlation ──────────
        scene_change = False
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hist = cv2.calcHist([gray], [0], None, [64], [0, 256])
        cv2.normalize(hist, hist)
        if prev_hist is not None:
            corr = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL)
            # corr near 1.0 = same scene, near 0 = very different
            scene_change = corr < (1.0 - SCENE_HIST_THRESH)
        prev_hist = hist

        h, w = frame.shape[:2]

        results = model(frame, conf=0.40, imgsz=640, verbose=False)[0]

        candidates = []
        if results.boxes is not None and len(results.boxes) > 0:
            boxes_xyxy = results.boxes.xyxy.cpu().tolist()
            boxes_conf = results.boxes.conf.cpu().tolist()

            for idx, box in enumerate(boxes_xyxy):
                x1, y1, x2, y2 = box[:4]
                conf = boxes_conf[idx] if idx < len(boxes_conf) else 0.5

                x1 = max(0.0, x1); y1 = max(0.0, y1)
                x2 = min(float(w), x2); y2 = min(float(h), y2)
                if x2 <= x1 or y2 <= y1:
                    continue

                bw = (x2 - x1) / w
                bh = (y2 - y1) / h
                area = bw * bh

                if area < 0.004:
                    continue

                aspect = bw / bh if bh > 0 else 0
                if aspect > 2.0 or aspect < 0.25:
                    continue

                if y1 < 2:
                    continue

                cx = ((x1 + x2) / 2) / w
                cy = ((y1 + y2) / 2) / h
                candidates.append({
                    "cx": round(cx, 4),
                    "cy": round(cy, 4),
                    "w":  round(bw, 4),
                    "h":  round(bh, 4),
                    "area": round(area, 5),
                    "conf": round(conf, 3),
                })

        # Deduplicate — keep the larger of any two very close detections
        candidates.sort(key=lambda f: f["area"], reverse=True)
        deduped = []
        for c in candidates:
            is_dup = False
            for kept in deduped:
                if abs(c["cx"] - kept["cx"]) < 0.09 and abs(c["cy"] - kept["cy"]) < 0.09:
                    is_dup = True
                    break
            if not is_dup:
                deduped.append(c)

        out[str(t)] = {"faces": deduped[:4], "sceneChange": scene_change}

    cap.release()
    print(json.dumps({"ok": True, "frames": out}))

except Exception as e:
    import traceback
    print(json.dumps({"ok": False, "error": str(e), "traceback": traceback.format_exc()}))
`.trim();

function getFaceScriptPath() {
  ensureTmp();
  const p = path.join(TMP_DIR, "_reframe_faces_v30.py");
  if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== FACE_SCRIPT) {
    fs.writeFileSync(p, FACE_SCRIPT);
  }
  return p;
}

// ─── FFprobe ──────────────────────────────────────────────────────────────────
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

// ─── Python runner ────────────────────────────────────────────────────────────
// Max frames per single Python call. Keeps memory usage bounded on CPU machines.
const MAX_FRAMES_PER_CHUNK = parseInt(process.env.REFRAMER_CHUNK_SIZE || "30", 10);

async function _runPythonChunk(videoPath, chunkTimes) {
  const scriptPath = getFaceScriptPath();
  const tmpJson = path.join(TMP_DIR, `_ftimes_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpJson, JSON.stringify(chunkTimes));

  try {
    const { stdout, stderr } = await execAsync(
      `"${PYTHON}" "${scriptPath}" "${videoPath}" "${tmpJson}"`,
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
    );
    if (stderr && stderr.trim()) {
      const firstLine = stderr.trim().split("\n")[0];
      if (!firstLine.includes("FutureWarning") && !firstLine.includes("DeprecationWarning")) {
        console.log("[reframer/python]", firstLine);
      }
    }
    const lastLine = stdout.trim().split("\n").pop();
    const result = JSON.parse(lastLine);
    if (!result.ok) {
      console.warn("[reframer] chunk error:", result.error?.split("\n")[0]);
      return null;
    }

    // Unpack new dict format: { "t": { faces: [...], sceneChange: bool } }
    // Also accepts old array format gracefully for backward compatibility.
    const raw = result.frames;
    const unpacked = {};
    for (const [key, val] of Object.entries(raw)) {
      if (Array.isArray(val)) {
        // Old format — upgrade transparently
        unpacked[key] = { faces: val, sceneChange: false };
      } else {
        unpacked[key] = { faces: val.faces || [], sceneChange: val.sceneChange === true };
      }
    }
    return unpacked;
  } catch (e) {
    const msg    = (e.message  || "").trim();
    const stderr = (e.stderr   || "").trim().slice(0, 800);
    const stdout = (e.stdout   || "").trim().slice(0, 400);
    console.warn("[reframer] chunk failed —", msg.split("\n")[0]);
    if (stderr) console.warn("[reframer] chunk stderr:", stderr);
    if (stdout) console.warn("[reframer] chunk stdout:", stdout);
    return null;
  } finally {
    try { fs.unlinkSync(tmpJson); } catch {}
  }
}

/**
 * detectFaces — splits sampleTimes into MAX_FRAMES_PER_CHUNK sized chunks,
 * runs each chunk independently, then merges results.
 * Returns { "timestamp": { faces: [...], sceneChange: bool } }
 *
 * Retry strategy:
 *   1. Halve the chunk on first failure (less memory pressure)
 *   2. Every-other-frame on second failure
 *   3. Empty arrays as final fallback — never kills the whole clip
 */
async function detectFaces(videoPath, sampleTimes) {
  if (sampleTimes.length === 0) return {};

  const chunks = [];
  for (let i = 0; i < sampleTimes.length; i += MAX_FRAMES_PER_CHUNK) {
    chunks.push(sampleTimes.slice(i, i + MAX_FRAMES_PER_CHUNK));
  }

  console.log(`[reframer] ${sampleTimes.length} frames → ${chunks.length} chunk(s) of ≤${MAX_FRAMES_PER_CHUNK}`);

  const merged = {};
  const EMPTY = (t) => ({ [String(t)]: { faces: [], sceneChange: false } });

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    let result = await _runPythonChunk(videoPath, chunk);

    // Retry 1: halve the chunk
    if (!result && chunk.length > 4) {
      console.warn(`[reframer] chunk ${ci + 1}/${chunks.length} failed — retrying with half-size chunks`);
      const half = Math.ceil(chunk.length / 2);
      const rA = await _runPythonChunk(videoPath, chunk.slice(0, half));
      const rB = await _runPythonChunk(videoPath, chunk.slice(half));
      if (rA || rB) {
        result = { ...(rA || {}), ...(rB || {}) };
        for (const t of chunk) {
          if (!(String(t) in result)) Object.assign(result, EMPTY(t));
        }
      }
    }

    // Retry 2: sparse fallback — every other frame
    if (!result) {
      console.warn(`[reframer] chunk ${ci + 1}/${chunks.length} still failing — trying sparse (every 2nd frame)`);
      const sparse = chunk.filter((_, i) => i % 2 === 0);
      const rSparse = await _runPythonChunk(videoPath, sparse);
      if (rSparse) {
        result = {};
        for (let i = 0; i < chunk.length; i++) {
          const t = chunk[i];
          const nearestSparseT = sparse[Math.min(Math.floor(i / 2), sparse.length - 1)];
          result[String(t)] = rSparse[String(nearestSparseT)] || { faces: [], sceneChange: false };
        }
      }
    }

    // Final fallback: empty entries for this chunk
    if (!result) {
      console.warn(`[reframer] chunk ${ci + 1}/${chunks.length} completely failed — passthrough for this range`);
      result = {};
      for (const t of chunk) Object.assign(result, EMPTY(t));
    }

    Object.assign(merged, result);
  }

  return merged;
}

// ─── Face Identity Tracker ────────────────────────────────────────────────────
// Tracks faces across frames using IoU + proximity.
// Returns consistent face IDs across time so a face drifting slightly
// never flips between "face" and "split" modes.

class FaceTracker {
  constructor() {
    this.tracks = []; // { id, cx, cy, w, h, lastSeen }
    this.nextId = 1;
  }

  _iou(a, b) {
    const ax1 = a.cx - a.w / 2, ay1 = a.cy - a.h / 2;
    const ax2 = a.cx + a.w / 2, ay2 = a.cy + a.h / 2;
    const bx1 = b.cx - b.w / 2, by1 = b.cy - b.h / 2;
    const bx2 = b.cx + b.w / 2, by2 = b.cy + b.h / 2;
    const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
    if (ix2 <= ix1 || iy2 <= iy1) return 0;
    const inter = (ix2 - ix1) * (iy2 - iy1);
    const aArea = (ax2 - ax1) * (ay2 - ay1);
    const bArea = (bx2 - bx1) * (by2 - by1);
    return inter / (aArea + bArea - inter);
  }

  update(faces, t) {
    const matched = new Set();
    const result  = [];

    for (const face of faces) {
      let bestId = null, bestScore = 0;

      for (const track of this.tracks) {
        if (matched.has(track.id)) continue;
        const iou  = this._iou(face, track);
        const dist = Math.hypot(face.cx - track.cx, face.cy - track.cy);
        const score = iou > 0 ? iou : Math.max(0, 1 - dist / 0.3);
        if (score > bestScore && score > 0.15) { bestScore = score; bestId = track.id; }
      }

      if (bestId !== null) {
        const track = this.tracks.find(tr => tr.id === bestId);
        track.cx = track.cx * 0.6 + face.cx * 0.4;
        track.cy = track.cy * 0.6 + face.cy * 0.4;
        track.w  = track.w  * 0.6 + face.w  * 0.4;
        track.h  = track.h  * 0.6 + face.h  * 0.4;
        track.lastSeen = t;
        matched.add(bestId);
        result.push({ ...face, id: bestId });
      } else {
        const newId = this.nextId++;
        this.tracks.push({ id: newId, cx: face.cx, cy: face.cy, w: face.w, h: face.h, lastSeen: t });
        matched.add(newId);
        result.push({ ...face, id: newId });
      }
    }

    // Prune stale tracks (not seen for more than 5 seconds)
    this.tracks = this.tracks.filter(tr => t - tr.lastSeen < 5.0);
    return result;
  }
}

// ─── Helper: is this a face-family mode? ─────────────────────────────────────
function _isFaceMode(mode) {
  return mode === "face" || mode === "face_left" || mode === "face_right";
}

// ─── Per-frame layout classifier ──────────────────────────────────────────────
// Takes tracked faces (with IDs) and an optional sceneChange flag,
// returns a raw layout decision.
//
// Modes:
//   face          — one dominant speaker, position unknown relative to others
//   face_left     — speaker is the left person of a 2-person frame
//   face_right    — speaker is the right person of a 2-person frame
//   split         — clean side-by-side, both people shown in split panels
//   blur_overlay  — 3+ faces, crowd/panel — fit-in-frame with blurred BG
//   passthrough   — no usable faces detected
//
// face_left / face_right are produced when exactly 2 faces are detected but
// they don't qualify as a clean split (e.g. one is much larger / they're too
// close together). The directional label lets clipCutter produce editorial
// "cut to speaker" moments rather than always defaulting to the biggest face.

function classifyFrame(trackedFaces, sceneChange = false) {
  const faces = trackedFaces || [];

  if (faces.length === 0) {
    return { mode: "passthrough", sceneChange };
  }

  const significant = faces.filter(f =>
    f.area >= FACE_MIN_AREA && (f.conf === undefined || f.conf >= 0.40)
  );

  if (significant.length === 0) {
    return { mode: "passthrough", sceneChange };
  }

  const sorted = [...significant].sort((a, b) => b.area - a.area);

  // Single significant face — or second face is tiny relative to first
  if (sorted.length === 1 || (sorted.length >= 2 && sorted[1].area / sorted[0].area < 0.12)) {
    return {
      mode:       "face",
      faceCxNorm: sorted[0].cx,
      faceCyNorm: sorted[0].cy,
      faceId:     sorted[0].id,
      sceneChange,
    };
  }

  // 3+ significant faces → blur overlay (crowd/panel scene)
  if (sorted.length >= 3) {
    return { mode: "blur_overlay", sceneChange };
  }

  // Exactly 2 significant faces — test split criteria
  const left  = sorted[0].cx < sorted[1].cx ? sorted[0] : sorted[1];
  const right = sorted[0].cx < sorted[1].cx ? sorted[1] : sorted[0];

  const cxDiff    = right.cx - left.cx;
  const cyDiff    = Math.abs(left.cy - right.cy);
  const areaRatio = Math.min(left.area, right.area) / Math.max(left.area, right.area);

  const bothBigEnough = left.area  >= SPLIT_MIN_FACE_AREA && right.area >= SPLIT_MIN_FACE_AREA;
  const wideEnough    = cxDiff     >= SPLIT_MIN_CX_DIFF;
  const notStacked    = cyDiff     <= SPLIT_MAX_CY_DIFF;
  const similarSize   = areaRatio  >= SPLIT_MIN_AREA_RATIO;

  if (bothBigEnough && wideEnough && notStacked && similarSize) {
    // Wide-layout flag: faces are very far apart (e.g. 2-left / 2-right panel).
    // clipCutter uses SPLIT_ZOOM_WIDE (1.05) instead of SPLIT_ZOOM (1.15) for
    // these so edge speakers are never cropped out.
    const isWideLayout = cxDiff >= SPLIT_WIDE_LAYOUT_CX_DIFF;

    return {
      mode:         "split",
      leftCxNorm:   left.cx,
      leftCyNorm:   left.cy,
      leftId:       left.id,
      rightCxNorm:  right.cx,
      rightCyNorm:  right.cy,
      rightId:      right.id,
      isWideLayout,
      sceneChange,
    };
  }

  // 2 faces that are NOT a clean side-by-side split.
  // Return face_left or face_right so clipCutter can produce intentional
  // "cut to speaker" moments when the timeline switches between them.
  const primary   = sorted[0]; // largest = presumed speaker
  const secondary = sorted[1];
  const faceMode  = primary.cx < secondary.cx ? "face_left" : "face_right";

  return {
    mode:        faceMode,
    faceCxNorm:  primary.cx,
    faceCyNorm:  primary.cy,
    faceId:      primary.id,
    otherCxNorm: secondary.cx,
    otherCyNorm: secondary.cy,
    otherId:     secondary.id,
    sceneChange,
  };
}

// ─── Global vote: decide the DOMINANT layout for the whole clip ───────────────
// face_left and face_right are merged into "face" for dominant-mode comparison
// but tracked separately in rawVotes for diagnostic logging.
// Scene-change frames count as 0.3 votes (real but uncertain).

function globalVote(rawFrames) {
  const rawVotes   = { face: 0, face_left: 0, face_right: 0, split: 0, blur_overlay: 0, passthrough: 0 };
  const facePositions  = [];
  const splitPositions = [];

  for (const frame of rawFrames) {
    const mode   = frame.decision.mode;
    const weight = frame.decision.sceneChange === true ? 0.3 : 1.0;

    rawVotes[mode] = (rawVotes[mode] || 0) + weight;

    if (_isFaceMode(mode)) {
      facePositions.push({ cx: frame.decision.faceCxNorm, cy: frame.decision.faceCyNorm });
    }
    if (mode === "split") {
      splitPositions.push({
        lcx: frame.decision.leftCxNorm,
        rcx: frame.decision.rightCxNorm,
        lcy: frame.decision.leftCyNorm,
        rcy: frame.decision.rightCyNorm,
        wide: frame.decision.isWideLayout === true,
      });
    }
  }

  // Merge face variants for dominant-mode decision
  const mergedVotes = {
    face:         (rawVotes.face || 0) + (rawVotes.face_left || 0) + (rawVotes.face_right || 0),
    split:        rawVotes.split        || 0,
    blur_overlay: rawVotes.blur_overlay || 0,
    passthrough:  rawVotes.passthrough  || 0,
  };

  const total        = Object.values(mergedVotes).reduce((s, v) => s + v, 0) || 1;
  const dominant     = Object.entries(mergedVotes).sort((a, b) => b[1] - a[1])[0];
  const dominantMode = dominant[0];
  const dominantFrac = dominant[1] / total;

  const avg = (arr, key) => arr.length ? arr.reduce((s, p) => s + p[key], 0) / arr.length : undefined;

  // Wide-layout majority vote across all split frames
  const avgSplitWide = splitPositions.length > 0
    && splitPositions.filter(p => p.wide).length / splitPositions.length >= 0.5;

  return {
    dominantMode,
    dominantFrac,
    votes:        mergedVotes,
    rawVotes,
    avgFaceCx:    avg(facePositions, "cx")   ?? 0.5,
    avgFaceCy:    avg(facePositions, "cy")   ?? 0.4,
    avgSplitLcx:  avg(splitPositions, "lcx") ?? 0.25,
    avgSplitRcx:  avg(splitPositions, "rcx") ?? 0.75,
    avgSplitLcy:  avg(splitPositions, "lcy") ?? 0.4,
    avgSplitRcy:  avg(splitPositions, "rcy") ?? 0.4,
    avgSplitWide,
  };
}

// ─── Timeline smoother with hysteresis ────────────────────────────────────────
// Pass 1: Remove any run shorter than MIN_HOLD_SECS by merging into neighbors.
// Pass 2: Face position smoothing (sliding median on cx/cy).
// Pass 3: Split position smoothing.
// face / face_left / face_right are treated as the same "family" in Pass 1
// so a face_left→face_right switch that lasts <MIN_HOLD_SECS is suppressed,
// but a face_left→split switch is NOT suppressed (different families).

function smoothTimeline(rawTimeline, globalStats) {
  if (rawTimeline.length === 0) return [];

  let result = rawTimeline.map(e => ({ ...e }));

  // ── Pass 1: Duration-based run smoothing ─────────────────────────────────────
  let changed = true;
  let passes  = 0;
  while (changed && passes < 15) {
    changed = false;
    passes++;

    let i = 0;
    while (i < result.length) {
      const runMode = result[i].decision.mode;
      let j = i;
      while (j < result.length && result[j].decision.mode === runMode) j++;

      const runEnd = j < result.length ? result[j].clipTimeSec : Infinity;
      const runDur = runEnd - result[i].clipTimeSec;

      if (runDur < MIN_HOLD_SECS) {
        const prevRun = i > 0             ? result[i - 1].decision : null;
        const nextRun = j < result.length ? result[j].decision     : null;
        let replacement = prevRun || nextRun;

        if (prevRun && nextRun) {
          let prevRunLen = 0;
          for (let k = i - 1; k >= 0 && result[k].decision.mode === prevRun.mode; k--) prevRunLen++;
          let nextRunLen = 0;
          for (let k = j; k < result.length && result[k].decision.mode === nextRun.mode; k++) nextRunLen++;
          replacement = nextRunLen >= prevRunLen ? nextRun : prevRun;
        }

        // Never suppress a real split run if split has significant global presence.
        const splitGlobalFrac = globalStats?.votes
          ? (globalStats.votes.split || 0) / (rawTimeline.length || 1)
          : 0;
        if (runMode === "split" && splitGlobalFrac >= 0.20 && replacement && _isFaceMode(replacement.mode)) {
          i = j;
          continue;
        }

        // Never merge face_left→face_right or face_right→face_left into a
        // neighbor if the neighbor is from the OTHER direction — those are
        // intentional speaker-switch cuts, not noise.
        if (_isFaceMode(runMode) && replacement && _isFaceMode(replacement.mode)) {
          // Only suppress if directions match (or both are plain "face")
          const sameDir = runMode === replacement.mode
            || runMode === "face"
            || replacement.mode === "face";
          if (!sameDir) {
            i = j;
            continue;
          }
        }

        if (replacement) {
          for (let k = i; k < j; k++) {
            result[k] = { ...result[k], decision: { ...replacement } };
          }
          changed = true;
        }
      }

      i = j;
    }
  }

  // ── Pass 2: Face position smoothing ──────────────────────────────────────────
  const SMOOTH_WIN = 3;
  const half = Math.floor(SMOOTH_WIN / 2);

  for (let i = 0; i < result.length; i++) {
    if (!_isFaceMode(result[i].decision.mode)) continue;

    const cxWindow = [], cyWindow = [];
    for (let k = Math.max(0, i - half); k <= Math.min(result.length - 1, i + half); k++) {
      if (_isFaceMode(result[k].decision.mode)) {
        cxWindow.push(result[k].decision.faceCxNorm ?? 0.5);
        cyWindow.push(result[k].decision.faceCyNorm ?? 0.4);
      }
    }

    if (cxWindow.length > 0) {
      cxWindow.sort((a, b) => a - b);
      cyWindow.sort((a, b) => a - b);
      const mid = Math.floor(cxWindow.length / 2);
      result[i] = {
        ...result[i],
        decision: {
          ...result[i].decision,
          faceCxNorm: cxWindow[mid],
          faceCyNorm: cyWindow[mid],
        },
      };
    }
  }

  // ── Pass 3: Split position smoothing ─────────────────────────────────────────
  for (let i = 0; i < result.length; i++) {
    if (result[i].decision.mode !== "split") continue;

    const lcxWindow = [], rcxWindow = [];
    for (let k = Math.max(0, i - half); k <= Math.min(result.length - 1, i + half); k++) {
      if (result[k].decision.mode === "split") {
        lcxWindow.push(result[k].decision.leftCxNorm  ?? 0.25);
        rcxWindow.push(result[k].decision.rightCxNorm ?? 0.75);
      }
    }

    if (lcxWindow.length > 0) {
      lcxWindow.sort((a, b) => a - b);
      rcxWindow.sort((a, b) => a - b);
      const mid = Math.floor(lcxWindow.length / 2);
      result[i] = {
        ...result[i],
        decision: {
          ...result[i].decision,
          leftCxNorm:  lcxWindow[mid],
          rightCxNorm: rcxWindow[mid],
        },
      };
    }
  }

  return result;
}

// ─── MAIN EXPORT: analyzeClipTimeline ────────────────────────────────────────
async function analyzeClipTimeline(videoPath, startSec, endSec) {
  // 1. Probe video dimensions
  let info;
  try {
    info = await probe(videoPath);
  } catch (e) {
    console.warn("[reframer] probe failed:", e.message);
    return { timeline: [], srcW: 1920, srcH: 1080, isAlreadyVertical: false };
  }

  const isAlreadyVertical = info.w / info.h < 0.75;
  if (isAlreadyVertical) {
    console.log("[reframer] already vertical → passthrough");
    return { timeline: [], srcW: info.w, srcH: info.h, isAlreadyVertical: true };
  }

  const clipDur = endSec - startSec;
  if (clipDur <= 0) {
    return { timeline: [], srcW: info.w, srcH: info.h, isAlreadyVertical: false };
  }

  // 2. Build sample times at 1s density across the clip
  const totalSamples = Math.max(2, Math.ceil(clipDur / SAMPLE_INTERVAL));
  const sampleTimes  = Array.from({ length: totalSamples }, (_, i) =>
    parseFloat((startSec + (i * clipDur) / (totalSamples - 1 || 1)).toFixed(2))
  );

  console.log(`[reframer] scanning ${sampleTimes.length} frames for clip ${startSec.toFixed(1)}s→${endSec.toFixed(1)}s`);

  // 3. Run YOLO face detection
  const faceFrames = await detectFaces(videoPath, sampleTimes);
  if (!faceFrames) {
    return { timeline: [], srcW: info.w, srcH: info.h, isAlreadyVertical: false };
  }

  // 4. Assign stable face IDs via tracker and unpack scene-change flag
  const tracker      = new FaceTracker();
  const trackedFrames = sampleTimes.map(t => {
    const frameData  = faceFrames[String(t)] || { faces: [], sceneChange: false };
    const rawFaces   = Array.isArray(frameData) ? frameData : frameData.faces;
    const sceneChg   = Array.isArray(frameData) ? false : (frameData.sceneChange === true);
    const tracked    = tracker.update(rawFaces, t);
    return { t, faces: tracked, sceneChange: sceneChg };
  });

  // 5. Classify each frame
  const rawTimeline = trackedFrames.map(({ t, faces, sceneChange }) => {
    const clipT = parseFloat((t - startSec).toFixed(2));
    return {
      videoTimeSec: t,
      clipTimeSec:  clipT,
      faceCount:    faces.length,
      decision:     classifyFrame(faces, sceneChange),
    };
  });

  // 6. Global vote — understand the overall clip structure
  const gStats = globalVote(rawTimeline);
  console.log(
    `[reframer] global vote: ${JSON.stringify(gStats.votes)} rawVotes: ${JSON.stringify(gStats.rawVotes)} | dominant: ${gStats.dominantMode} (${(gStats.dominantFrac * 100).toFixed(0)}%)`
  );

  // 7. Smooth the timeline
  const timeline = smoothTimeline(rawTimeline, gStats);

  // 8. Conservative global override — only replace PASSTHROUGH frames in
  //    overwhelmingly homogeneous clips (≥90%). Never override face/split
  //    transitions — those carry real editorial meaning.
  const OVERRIDE_THRESHOLD = 0.90;
  if (gStats.dominantFrac >= OVERRIDE_THRESHOLD && gStats.dominantMode !== "passthrough") {
    let overrideDecision = null;

    if (gStats.dominantMode === "face") {
      overrideDecision = {
        mode: "face",
        faceCxNorm: gStats.avgFaceCx,
        faceCyNorm: gStats.avgFaceCy,
      };
    } else if (gStats.dominantMode === "split") {
      overrideDecision = {
        mode:         "split",
        leftCxNorm:   gStats.avgSplitLcx,
        leftCyNorm:   gStats.avgSplitLcy,
        rightCxNorm:  gStats.avgSplitRcx,
        rightCyNorm:  gStats.avgSplitRcy,
        isWideLayout: gStats.avgSplitWide,
      };
    }

    if (overrideDecision) {
      let overridden = 0;
      for (let i = 0; i < timeline.length; i++) {
        if (timeline[i].decision.mode === "passthrough") {
          timeline[i] = { ...timeline[i], decision: { ...overrideDecision } };
          overridden++;
        }
      }
      if (overridden > 0) {
        console.log(`[reframer] global override: replaced ${overridden} passthrough frame(s) with dominant "${gStats.dominantMode}"`);
      }
    }
  }

  // 9. Log final mode distribution
  const modeCounts = {};
  for (const entry of timeline) {
    modeCounts[entry.decision.mode] = (modeCounts[entry.decision.mode] || 0) + 1;
  }
  console.log("[reframer] final timeline modes:", JSON.stringify(modeCounts));

  return { timeline, srcW: info.w, srcH: info.h, isAlreadyVertical: false };
}

// ─── Legacy export (used by older paths that call analyzeSpeakers directly) ───
async function analyzeSpeakers(videoPath) {
  let info;
  try { info = await probe(videoPath); } catch { return { mode: "passthrough" }; }
  if (info.w / info.h < 0.75) return { mode: "passthrough" };

  const totalSamples = Math.min(60, Math.ceil(info.dur / 2.0));
  const sampleTimes  = Array.from({ length: totalSamples }, (_, i) =>
    parseFloat(((i * info.dur) / totalSamples).toFixed(2))
  );

  const faceFrames = await detectFaces(videoPath, sampleTimes);
  if (!faceFrames) return { mode: "passthrough" };

  const tracker      = new FaceTracker();
  const trackedFrames = sampleTimes.map(t => {
    const fd     = faceFrames[String(t)] || { faces: [], sceneChange: false };
    const faces  = Array.isArray(fd) ? fd : fd.faces;
    const scChg  = Array.isArray(fd) ? false : fd.sceneChange === true;
    return { t, faces: tracker.update(faces, t), sceneChange: scChg };
  });

  const rawTimeline = trackedFrames.map(({ t, faces, sceneChange }) => ({
    videoTimeSec: t,
    clipTimeSec:  t,
    faceCount:    faces.length,
    decision:     classifyFrame(faces, sceneChange),
  }));

  const gStats = globalVote(rawTimeline);

  if (gStats.dominantMode === "split" && gStats.dominantFrac >= 0.25) {
    return { mode: "blur_overlay" };
  }

  if (gStats.dominantMode === "face") {
    return { mode: "face", faceCxNorm: gStats.avgFaceCx, faceCyNorm: gStats.avgFaceCy };
  }

  return { mode: "passthrough" };
}

// ─── Full-video layout scan for clip selection ────────────────────────────────
/**
 * buildFullVideoLayoutMap
 *
 * Runs a SPARSE YOLO scan across the entire video (3 s intervals, 300 sample
 * cap) and returns a timeline array that clipSelector.buildLayoutMap() can
 * convert to { [integerSec]: mode }.
 *
 * Sparse scan rationale:
 *   - A 2-hour video at 1 s = ~7 200 YOLO calls before any clips are selected.
 *   - At 3 s = ~2 400 calls, capped at 300 = at most 300 calls regardless of length.
 *   - This is enough to see "crowd shot here / two-person split here" for
 *     block-level scoring. The per-clip dense scan (1 s) handles frame rendering.
 */
async function buildFullVideoLayoutMap(videoPath) {
  let info;
  try {
    info = await probe(videoPath);
  } catch (e) {
    console.warn("[reframer/layoutMap] probe failed:", e.message);
    return [];
  }

  if (info.w / info.h < 0.75) {
    console.log("[reframer/layoutMap] already vertical → all-passthrough map");
    return [];
  }

  if (info.dur <= 0) return [];

  const maxSamples   = 300;
  const totalSamples = Math.min(maxSamples, Math.max(2, Math.ceil(info.dur / LAYOUT_MAP_INTERVAL)));
  const sampleTimes  = Array.from({ length: totalSamples }, (_, i) =>
    parseFloat(((i * info.dur) / (totalSamples - 1 || 1)).toFixed(2))
  );

  console.log(`[reframer/layoutMap] sparse scan: ${sampleTimes.length} frames @ ${LAYOUT_MAP_INTERVAL}s intervals across ${info.dur.toFixed(0)}s video`);

  const faceFrames = await detectFaces(videoPath, sampleTimes);
  if (!faceFrames) {
    console.warn("[reframer/layoutMap] face detection failed — returning empty map");
    return [];
  }

  const tracker      = new FaceTracker();
  const rawTimeline  = sampleTimes.map(t => {
    const fd      = faceFrames[String(t)] || { faces: [], sceneChange: false };
    const faces   = Array.isArray(fd) ? fd : fd.faces;
    const scChg   = Array.isArray(fd) ? false : fd.sceneChange === true;
    const tracked = tracker.update(faces, t);
    return {
      videoTimeSec: t,
      clipTimeSec:  t,
      faceCount:    tracked.length,
      decision:     classifyFrame(tracked, scChg),
    };
  });

  // Light smoothing — collapse short noise runs so a single bad frame doesn't
  // create an artificial instability spike in clip scoring.
  const gStats  = globalVote(rawTimeline);
  const smoothed = smoothTimeline(rawTimeline, gStats);

  const modeCounts = {};
  for (const e of smoothed) {
    modeCounts[e.decision.mode] = (modeCounts[e.decision.mode] || 0) + 1;
  }
  console.log("[reframer/layoutMap] full-video modes:", JSON.stringify(modeCounts));

  return smoothed;
}

module.exports = { analyzeClipTimeline, analyzeSpeakers, buildFullVideoLayoutMap };