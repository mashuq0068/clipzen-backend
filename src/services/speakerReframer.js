"use strict";

/**
 * speakerReframer.js  —  Clipora v6
 *
 * ARCHITECTURE: Single-pass YOLO scan (no histogram pre-pass)
 *
 * How it works:
 *   1. Sample every SCAN_INTERVAL seconds across the full clip with YOLO face detection.
 *      Uses CAP_PROP_POS_MSEC (time-based seeking) — stable on Windows, no frame-seek crashes.
 *   2. Classify each sampled frame independently → per-frame layout decision.
 *   3. Group consecutive frames with the same layout into segments using a
 *      change-detection pass (a new segment starts when the mode flips and holds
 *      for at least BOUNDARY_CONFIRM_FRAMES in a row — avoids noise-induced splits).
 *   4. Each segment independently votes from its own frames → segment winner.
 *   5. Merge segments shorter than MIN_SEGMENT_SECS into their neighbour.
 *   6. Expand segments into a per-second timeline for clipCutter.
 *   7. Inject variety (occasional left/right/face focus) inside long stable segments.
 *
 * Layout classification rules (from images):
 *   Image 1 — 4-person Zoom grid (faces in 2×2 tile rows+cols) → blur_overlay
 *   Image 2 — 4-person physical round-table (same height, spread L→R) → split
 *   Image 3 — 2-person interview (L and R, facing each other) → split
 *
 * Grid vs panel distinction:
 *   - Grid: cy std-dev HIGH (faces stacked in rows) AND cx spread HIGH → blur_overlay
 *   - Panel: cy std-dev LOW (everyone at same table height) → split
 *
 * Performance:
 *   - No histogram Python process at all (was crashing on Windows anyway)
 *   - YOLO frames chunked to MAX_FRAMES_PER_CHUNK (default 30) per subprocess call
 *   - Sequential MSEC seeking inside each subprocess → no random-seek crash
 *   - Short clips (≤ DENSE_SCAN_MAX_SECS) use 1s interval directly (same code path)
 *   - Longer clips use 2s interval to halve the number of YOLO calls
 */

const { exec }  = require("child_process");
const path      = require("path");
const fs        = require("fs");
const util      = require("util");

const execAsync     = util.promisify(exec);
const execFileAsync = util.promisify(require("child_process").execFile);

// ─── Config ───────────────────────────────────────────────────────────────────
const PYTHON  = process.env.PYTHON_PATH ||
  (process.platform === "win32"
    ? "C:\\Users\\ASUS\\AppData\\Local\\Python\\bin\\python.exe"
    : "python3");

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

// How many seconds between YOLO samples for clips > DENSE_SCAN_MAX_SECS
const SCAN_INTERVAL_LONG  = parseFloat(process.env.SCAN_INTERVAL_LONG  || "2.0");
// How many seconds between YOLO samples for short clips
const SCAN_INTERVAL_SHORT = parseFloat(process.env.SCAN_INTERVAL_SHORT || "1.0");
// Clips ≤ this duration use the short interval
const DENSE_SCAN_MAX_SECS = parseFloat(process.env.DENSE_SCAN_MAX_SECS || "30.0");

// How many consecutive frames of a *new* mode before we commit a segment boundary.
// Prevents single noisy frames from creating fake boundaries.
const BOUNDARY_CONFIRM_FRAMES = parseInt(process.env.BOUNDARY_CONFIRM_FRAMES || "2", 10);

// Merge segments shorter than this into neighbour (seconds)
const MIN_SEGMENT_SECS = parseFloat(process.env.MIN_SEGMENT_SECS || "4.0");

// Minimum layout hold for timeline smoother
const MIN_HOLD_SECS = parseFloat(process.env.REFRAMER_MIN_HOLD || "1.5");

// Max YOLO frames per subprocess call
const MAX_FRAMES_PER_CHUNK = parseInt(process.env.REFRAMER_CHUNK_SIZE || "30", 10);

// ─── Variety injection config ─────────────────────────────────────────────────
const VARIETY_MIN_SECS      = parseFloat(process.env.VARIETY_MIN_SECS      || "15.0");
const VARIETY_INTERVAL_SECS = parseFloat(process.env.VARIETY_INTERVAL_SECS || "12.0");
const VARIETY_HOLD_SECS     = parseFloat(process.env.VARIETY_HOLD_SECS     || "4.0");

// ─── Split / face thresholds ──────────────────────────────────────────────────
const SPLIT_MIN_CX_DIFF         = 0.14;
const SPLIT_MAX_CY_DIFF         = 0.40;
const SPLIT_MIN_AREA_RATIO      = 0.15;
const SPLIT_MIN_FACE_AREA       = 0.006;
const SPLIT_WIDE_LAYOUT_CX_DIFF = 0.50;
const FACE_MIN_AREA             = 0.006;
// FIXED: raised from 0.18 → 0.25 so a second face needs to be at least 25%
// of the primary face's area to be counted as a real second person.
// At 0.18, background faces or partial detections were triggering split
// even in genuine 1-person shots.
const SECOND_FACE_TINY_RATIO    = 0.25;
const SCENE_CHANGE_VOTE_WEIGHT  = 0.3;

// ─── Grid vs in-person panel thresholds ──────────────────────────────────────
const GRID_CY_STDDEV_THRESH = 0.12;
const GRID_CX_SPREAD_THRESH = 0.40;

const TMP_DIR = process.env.TMP_DIR
  ? path.resolve(process.env.TMP_DIR)
  : path.resolve(__dirname, "../../tmp");

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

// ─── Python YOLO face detection script ───────────────────────────────────────
// Uses CAP_PROP_POS_MSEC for seeking — stable on Windows FFMPEG backend.
// Receives a list of timestamps (seconds), returns per-timestamp face arrays.
const FACE_SCRIPT = `
import sys, json, warnings, os, traceback
warnings.filterwarnings("ignore")

def log_debug(msg):
    print(f"DEBUG: {msg}", file=sys.stderr)
    sys.stderr.flush()

def fatal(msg, tb=None):
    out = {"ok": False, "error": msg, "traceback": tb or ""}
    try:
        print(json.dumps(out))
        sys.stdout.flush()
    except Exception:
        pass
    sys.exit(0)

def _excepthook(exc_type, exc_value, exc_tb):
    fatal(str(exc_value), "".join(traceback.format_exception(exc_type, exc_value, exc_tb)))
sys.excepthook = _excepthook

try:
    if len(sys.argv) < 3:
        fatal(f"Missing arguments. Expected video_path and args_file, got: {sys.argv}")

    video_path = sys.argv[1]
    args_file  = sys.argv[2]

    log_debug(f"Starting YOLO script for {video_path}")

    with open(args_file, encoding="utf-8") as f:
        payload = json.load(f)

    sample_times = payload.get("sample_times", payload) if isinstance(payload, dict) else payload

    try:
        import cv2
    except ImportError as e:
        fatal(f"cv2 import failed: {e}")
    except Exception as e:
        fatal(f"cv2 import error: {e}", traceback.format_exc())

    try:
        from ultralytics import YOLO
        import logging
        logging.getLogger("ultralytics").setLevel(logging.ERROR)
    except ImportError as e:
        fatal(f"ultralytics import failed — pip install ultralytics ({e})")
    except Exception as e:
        fatal(f"ultralytics import error — {e}", traceback.format_exc())

    log_debug(f"OpenCV {cv2.__version__} and YOLO imported")

    CACHE_DIR  = os.path.join(os.path.expanduser("~"), ".cache", "yolov8-face")
    MODEL_PATH = os.path.join(CACHE_DIR, "yolov8n-face.pt")
    MODEL_URL  = "https://github.com/akanametov/yolo-face/releases/download/1.0.0/yolov8n-face.pt"

    if not os.path.exists(MODEL_PATH):
        import urllib.request
        os.makedirs(CACHE_DIR, exist_ok=True)
        log_debug("Downloading yolov8n-face model...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        log_debug("Model downloaded")

    model = YOLO(MODEL_PATH)

    # Use FFMPEG backend + MSEC seeking — avoids Windows frame-seek crash
    cap = cv2.VideoCapture(video_path, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        fatal(f"VideoCapture could not open: {video_path}")

    out = {}

    for t in sample_times:
        # MSEC-based seeking — stable on Windows, avoids CAP_PROP_POS_FRAMES crash
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            out[str(t)] = []
            continue

        h, w    = frame.shape[:2]
        results = model(frame, conf=0.25, imgsz=640, verbose=False)[0]
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

                bw   = (x2 - x1) / w
                bh   = (y2 - y1) / h
                area = bw * bh

                if area < 0.003:
                    continue
                aspect = bw / bh if bh > 0 else 0
                if aspect > 2.0 or aspect < 0.30:
                    continue
                if y1 < 2:
                    continue

                cx = ((x1 + x2) / 2) / w
                cy = ((y1 + y2) / 2) / h
                candidates.append({
                    "cx":   round(cx, 4),
                    "cy":   round(cy, 4),
                    "w":    round(bw, 4),
                    "h":    round(bh, 4),
                    "area": round(area, 5),
                    "conf": round(conf, 3),
                })

        candidates.sort(key=lambda f: f["area"], reverse=True)
        deduped = []
        for c in candidates:
            is_dup = any(
                abs(c["cx"] - k["cx"]) < 0.09 and abs(c["cy"] - k["cy"]) < 0.09
                for k in deduped
            )
            if not is_dup:
                deduped.append(c)

        out[str(t)] = deduped[:6]

    cap.release()
    print(json.dumps({"ok": True, "frames": out}))
    sys.stdout.flush()

except Exception as e:
    fatal(str(e), traceback.format_exc())
`.trim();

// ─── Script path helper ───────────────────────────────────────────────────────
function getFaceScriptPath() {
  ensureTmp();
  const p = path.join(TMP_DIR, "_reframe_faces_v60.py");
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

// ─── Scene-cut detection ──────────────────────────────────────────────────────
// One decode-only FFmpeg pass over [startSec, endSec]. Returns the absolute
// video timestamps (seconds) of hard cuts. Used to snap layout boundaries to the
// exact frame a scene changes (instead of the coarse YOLO sample grid).
// Soft dissolves / UI-FX don't produce a sharp scene spike → no cut → we fall
// back to the sample grid (honoring the "noise passes through" design).
const SCENE_CUT_THRESHOLD = parseFloat(process.env.REFRAMER_SCENE_THRESHOLD || "0.30");

async function detectSceneCuts(videoPath, startSec, endSec) {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const dur = Math.max(0, endSec - startSec);
  if (dur <= 0) return [];
  try {
    // -ss before -i = input seek; output pts_time restarts near 0 → add startSec.
    const { stderr } = await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-ss", String(startSec),
        "-t", String(dur),
        "-i", videoPath,
        "-vf", `select='gt(scene,${SCENE_CUT_THRESHOLD})',showinfo`,
        "-an", "-f", "null", "-",
      ],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const text = stderr || "";
    const cuts = [];
    const re = /pts_time:([0-9.]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const rel = parseFloat(m[1]);
      if (Number.isFinite(rel)) cuts.push(parseFloat((startSec + rel).toFixed(3)));
    }
    cuts.sort((a, b) => a - b);
    console.log(`[reframer/scene] ${cuts.length} scene cut(s) in ${startSec.toFixed(1)}→${endSec.toFixed(1)}s`);
    return cuts;
  } catch (e) {
    console.warn(`[reframer/scene] detection failed: ${(e.message || e).split("\n")[0]}`);
    return [];
  }
}

// First scene cut strictly inside the (lo, hi] gap between two samples, or null.
function findCutInGap(cuts, lo, hi) {
  for (const c of cuts) {
    if (c > lo + 0.04 && c <= hi + 0.001) return c;
    if (c > hi) break; // cuts are sorted
  }
  return null;
}

// ─── Generic Python script runner ─────────────────────────────────────────────
async function _runScript(scriptPath, videoPath, payload) {
  ensureTmp();
  const tmpJson = path.join(
    TMP_DIR,
    `_args_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(tmpJson, JSON.stringify(payload));

  function _parseStdout(raw) {
    if (!raw?.trim()) return null;
    const lines = raw.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("{")) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.ok === "boolean") return r;
      } catch {}
    }
    return null;
  }

  function _logStderr(raw, label = "[reframer/py]") {
    if (!raw?.trim()) return;
    const NOISE = ["FutureWarning", "DeprecationWarning", "UserWarning",
                   "site-packages", "warnings.warn("];
    const lines = raw.trim().split("\n")
      .filter(l => !NOISE.some(n => l.includes(n)));
    if (lines.length) console.warn(`${label} stderr:\n${lines.join("\n")}`);
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON,
      [scriptPath, videoPath, tmpJson],
      {
        timeout:   180_000,
        maxBuffer: 16 * 1024 * 1024,
        env:       { ...process.env, PYTHONIOENCODING: "utf-8" },
      }
    );

    _logStderr(stderr);
    const result = _parseStdout(stdout);

    if (!result) {
      console.error("[reframer] script produced no JSON output.");
      if (stderr?.trim()) console.error("[reframer] FULL stderr:\n" + stderr.trim());
      return null;
    }
    if (!result.ok) {
      console.warn("[reframer] script error:", result.error);
      if (result.traceback) console.warn(result.traceback);
      return null;
    }
    return result;

  } catch (e) {
    const result = _parseStdout(e.stdout);
    if (result) {
      if (result.ok) return result;
      console.warn("[reframer] script error:", result.error);
      return null;
    }
    console.error("[reframer] script failed:", e.message || e);
    if (e.stderr?.trim()) console.error("[reframer] FULL stderr:\n" + e.stderr.trim());
    return null;

  } finally {
    try { fs.unlinkSync(tmpJson); } catch {}
  }
}

// ─── YOLO runner with chunking + retry ────────────────────────────────────────
async function detectFaces(videoPath, sampleTimes) {
  if (!sampleTimes.length) return {};
  const script = getFaceScriptPath();
  const chunks = [];
  for (let i = 0; i < sampleTimes.length; i += MAX_FRAMES_PER_CHUNK) {
    chunks.push(sampleTimes.slice(i, i + MAX_FRAMES_PER_CHUNK));
  }
  console.log(`[reframer/yolo] ${sampleTimes.length} frames → ${chunks.length} chunk(s)`);

  const merged = {};
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk  = chunks[ci];
    let   result = await _runScript(script, videoPath, { sample_times: chunk });

    if (!result && chunk.length > 4) {
      console.warn(`[reframer/yolo] chunk ${ci + 1} failed — retrying halved`);
      const half = Math.ceil(chunk.length / 2);
      const rA   = await _runScript(script, videoPath, { sample_times: chunk.slice(0, half) });
      const rB   = await _runScript(script, videoPath, { sample_times: chunk.slice(half) });
      if (rA || rB) {
        result = { ok: true, frames: { ...(rA?.frames || {}), ...(rB?.frames || {}) } };
      }
    }

    if (!result) {
      for (const t of chunk) merged[String(t)] = [];
    } else {
      Object.assign(merged, result.frames);
    }
  }
  return merged;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _isFaceMode(mode) {
  return mode === "face" || mode === "face_left" || mode === "face_right";
}
function _normMode(mode) {
  return _isFaceMode(mode) ? "face" : mode;
}

// ─── Grid layout classifier ───────────────────────────────────────────────────
/**
 * Determines if a set of faces is a VIDEO-CALL GRID (→ blur_overlay)
 * vs a TRUE SIDE-BY-SIDE PODCAST/INTERVIEW LAYOUT (→ split).
 *
 * Works for ANY number of faces including exactly 2.
 *
 * GRID signals (all of these lean toward blur_overlay):
 *   1. Face area is small — each person only occupies a tile/quadrant,
 *      not half the screen. In a real podcast the faces are large.
 *   2. Significant vertical offset — faces are in different rows (top tile
 *      vs bottom tile). In a side-by-side podcast both faces are at the
 *      same height.
 *   3. Faces positioned near quadrant centres (cx ≈ 0.25/0.75,
 *      cy ≈ 0.25/0.75) rather than centred on the left/right halves.
 *
 * PODCAST/INTERVIEW signals (→ split):
 *   1. Both faces are LARGE (area ≥ SPLIT_MIN_FACE_AREA_PODCAST) —
 *      occupying a significant portion of the frame each.
 *   2. Both faces at ROUGHLY THE SAME HEIGHT (low |cy diff|).
 *   3. Spread horizontally across the frame (high cx diff).
 *
 * Returns "grid" | "panel"
 */

// ── Grid vs Podcast face-area thresholds ─────────────────────────────────────
//
// KEY INSIGHT: The only reliable signal for 2-face grid vs 2-face podcast is
// VERTICAL OFFSET (cy diff). In a grid (Google Meet 2×2), one tile is on top
// and one is on the bottom → large cy diff. In a podcast, both people sit at
// the same table height → tiny cy diff.
//
// Face area is NOT reliable for 2-face cases because a wide-angle podcast
// shot pulls back far enough that even large in-person faces have small
// normalised area (0.015–0.04). Grid tiles are similarly small.
// So area alone cannot distinguish them — we must use cy diff as primary signal.
//
const GRID_MIN_CY_DIFF_2FACE = 0.20;  // 2-face grid: vertical offset ≥ this → grid
                                        // (top tile cy≈0.25, bottom tile cy≈0.75 → diff≈0.50)
                                        // podcast: both at table → diff typically < 0.10

function isGridLayout(faces) {
  if (!faces.length) return false;

  // ── 3+ faces ─────────────────────────────────────────────────────────────
  if (faces.length >= 3) {
    const cxValues = faces.map(f => f.cx);
    const cyValues = faces.map(f => f.cy);
    const cyMean   = cyValues.reduce((s, v) => s + v, 0) / cyValues.length;
    const cyStdDev = Math.sqrt(
      cyValues.reduce((s, v) => s + (v - cyMean) ** 2, 0) / cyValues.length
    );
    const cxRange  = Math.max(...cxValues) - Math.min(...cxValues);
    const avgArea  = faces.reduce((s, f) => s + f.area, 0) / faces.length;

    // SIGNAL 1: Multi-row grid (2×2 Zoom style)
    // Faces in different rows → high cy std-dev AND spread horizontally
    if (cyStdDev >= GRID_CY_STDDEV_THRESH && cxRange >= GRID_CX_SPREAD_THRESH) {
      console.log(`[reframer/layout] 3+ faces → grid/multi-row (cyStdDev=${cyStdDev.toFixed(2)} cxRange=${cxRange.toFixed(2)})`);
      return true;
    }

    // SIGNAL 2: Single-row grid (3-column tile like the NGCW image)
    //
    // Layout: 3 (or 4) tiles in one row — each person in their own bordered box,
    // same height, evenly spaced across the full frame width.
    //
    // Distinguishing from a real round-table with 3 people:
    //
    //   A) FACE AREA — tile grids render each person small (confined to 1/N of
    //      the frame). Real in-person panels have large faces (person fills
    //      their half/third of the physical space). Threshold: avgArea < 0.07.
    //      (NGCW tiles: each face ~0.04–0.07; in-person podcast: 0.08–0.15)
    //
    //   B) EVEN SPACING — tile software (OBS, Zoom, Meet) spaces faces exactly.
    //      gapEvenness (maxGap / meanGap) ≈ 1.0 for tiles, higher for organic seating.
    //      We combine both: area < threshold OR very even spacing (≤ 1.3).
    //
    if (faces.length >= 3 && cyStdDev < GRID_CY_STDDEV_THRESH && cxRange >= GRID_CX_SPREAD_THRESH) {
      const sortedCx    = [...cxValues].sort((a, b) => a - b);
      const gaps        = sortedCx.slice(1).map((v, i) => v - sortedCx[i]);
      const meanGap     = gaps.reduce((s, v) => s + v, 0) / gaps.length;
      const maxGap      = Math.max(...gaps);
      const gapEvenness = meanGap > 0 ? maxGap / meanGap : 99;

      // Tile grid: small faces (each person in their own small box)
      // OR perfectly even spacing (software-enforced tile layout)
      const isSmallFaces  = avgArea < 0.07;
      const isPerfectGrid = gapEvenness <= 1.3;

      if (isSmallFaces || isPerfectGrid) {
        console.log(
          `[reframer/layout] 3+ faces → grid/single-row ` +
          `(cyStdDev=${cyStdDev.toFixed(2)} cxRange=${cxRange.toFixed(2)} ` +
          `gapEvenness=${gapEvenness.toFixed(2)} avgArea=${avgArea.toFixed(3)})`
        );
        return true;
      }
      console.log(
        `[reframer/layout] 3+ faces → panel (large faces + uneven gaps → physical table) ` +
        `(cyStdDev=${cyStdDev.toFixed(2)} cxRange=${cxRange.toFixed(2)} ` +
        `gapEvenness=${gapEvenness.toFixed(2)} avgArea=${avgArea.toFixed(3)})`
      );
      return false;
    }

    console.log(`[reframer/layout] 3+ faces → panel (cyStdDev=${cyStdDev.toFixed(2)} cxRange=${cxRange.toFixed(2)} avgArea=${avgArea.toFixed(3)})`);
    return false;
  }

  // ── Exactly 2 faces ───────────────────────────────────────────────────────
  // PRIMARY SIGNAL: vertical offset only.
  // Grid (2-tile): one person top-left, other bottom-right → cy diff large (≥ 0.20)
  // Podcast side-by-side: both at same table height → cy diff small (< 0.12)
  const [a, b] = faces;
  const cyDiff = Math.abs(a.cy - b.cy);
  const cxDiff = Math.abs(a.cx - b.cx);

  if (cyDiff >= GRID_MIN_CY_DIFF_2FACE) {
    console.log(`[reframer/layout] 2 faces → grid (vertical offset cyDiff=${cyDiff.toFixed(3)})`);
    return true;
  }

  console.log(`[reframer/layout] 2 faces → podcast/panel (cyDiff=${cyDiff.toFixed(3)} cxDiff=${cxDiff.toFixed(3)})`);
  return false;
}

// ─── Per-frame classifier ─────────────────────────────────────────────────────
function classifyFrame(trackedFaces, sceneChange = false) {
  const faces = trackedFaces || [];
  if (!faces.length) return { mode: "passthrough", sceneChange };

  const significant = faces.filter(
    f => f.area >= FACE_MIN_AREA && (f.conf === undefined || f.conf >= 0.25)
  );
  if (!significant.length) return { mode: "passthrough", sceneChange };

  const sorted = [...significant].sort((a, b) => b.area - a.area);

  // Single dominant face.
  // The tiny-ratio short-circuit collapses to 1 person when the 2nd face is
  // <25% of the primary's area — but that wrongly swallows ASYMMETRIC 2-person
  // shots (one speaker closer to camera). Exception: if the 2nd face is a clear
  // separate person — decent ABSOLUTE area AND horizontally separated — keep it
  // as 2 faces so split/face_left/right can trigger. Tiny background faces
  // (small absolute area or not separated) still collapse to 1.
  const secondIsRealPerson =
    sorted.length >= 2 &&
    sorted[1].area >= SPLIT_MIN_FACE_AREA &&
    Math.abs(sorted[1].cx - sorted[0].cx) >= SPLIT_MIN_CX_DIFF;

  if (
    sorted.length === 1 ||
    (sorted[1].area / sorted[0].area < SECOND_FACE_TINY_RATIO && !secondIsRealPerson)
  ) {
    return {
      mode: "face",
      faceCxNorm: sorted[0].cx, faceCyNorm: sorted[0].cy,
      faceId: sorted[0].id, sceneChange,
    };
  }

  // 2 or more faces — check grid first (works for both 2 and 3+)
  if (isGridLayout(sorted)) {
    return { mode: "blur_overlay", sceneChange };
  }

  // Not a grid → try split (use outermost two faces)
  const leftMost  = [...sorted].sort((a, b) => a.cx - b.cx)[0];
  const rightMost = [...sorted].sort((a, b) => b.cx - a.cx)[0];
  const cxDiff    = rightMost.cx - leftMost.cx;
  const cyDiff    = Math.abs(leftMost.cy - rightMost.cy);
  const areaRatio = Math.min(leftMost.area, rightMost.area) /
                    Math.max(leftMost.area, rightMost.area);
  const minArea   = Math.min(leftMost.area, rightMost.area);

  if (
    minArea    >= SPLIT_MIN_FACE_AREA   &&
    cxDiff     >= SPLIT_MIN_CX_DIFF     &&
    cyDiff     <= SPLIT_MAX_CY_DIFF     &&
    areaRatio  >= SPLIT_MIN_AREA_RATIO
  ) {
    return {
      mode:         "split",
      leftCxNorm:   leftMost.cx,  leftCyNorm:  leftMost.cy,  leftId:  leftMost.id,
      rightCxNorm:  rightMost.cx, rightCyNorm: rightMost.cy, rightId: rightMost.id,
      isWideLayout: cxDiff >= SPLIT_WIDE_LAYOUT_CX_DIFF,
      sceneChange,
    };
  }

  // Can't form a clean split → focus dominant speaker
  const primary   = sorted[0];
  const secondary = sorted[1];
  return {
    mode:        primary.cx < secondary.cx ? "face_left" : "face_right",
    faceCxNorm:  primary.cx,   faceCyNorm:  primary.cy,   faceId:    primary.id,
    otherCxNorm: secondary.cx, otherCyNorm: secondary.cy, otherId:   secondary.id,
    sceneChange,
  };
}

// ─── Face Identity Tracker ────────────────────────────────────────────────────
class FaceTracker {
  constructor() { this.tracks = []; this.nextId = 1; }

  _iou(a, b) {
    const ax1 = a.cx - a.w / 2, ay1 = a.cy - a.h / 2,
          ax2 = a.cx + a.w / 2, ay2 = a.cy + a.h / 2;
    const bx1 = b.cx - b.w / 2, by1 = b.cy - b.h / 2,
          bx2 = b.cx + b.w / 2, by2 = b.cy + b.h / 2;
    const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
    if (ix2 <= ix1 || iy2 <= iy1) return 0;
    const inter = (ix2 - ix1) * (iy2 - iy1);
    return inter / ((ax2-ax1)*(ay2-ay1) + (bx2-bx1)*(by2-by1) - inter);
  }

  update(faces, t) {
    const matched = new Set(), result = [];
    for (const face of faces) {
      let bestId = null, bestScore = 0;
      for (const track of this.tracks) {
        if (matched.has(track.id)) continue;
        const iou   = this._iou(face, track);
        const dist  = Math.hypot(face.cx - track.cx, face.cy - track.cy);
        const score = iou > 0 ? iou : Math.max(0, 1 - dist / 0.3);
        if (score > bestScore && score > 0.15) { bestScore = score; bestId = track.id; }
      }
      if (bestId !== null) {
        const tr = this.tracks.find(r => r.id === bestId);
        tr.cx = tr.cx * 0.6 + face.cx * 0.4;
        tr.cy = tr.cy * 0.6 + face.cy * 0.4;
        tr.w  = tr.w  * 0.6 + face.w  * 0.4;
        tr.h  = tr.h  * 0.6 + face.h  * 0.4;
        tr.lastSeen = t;
        matched.add(bestId);
        result.push({ ...face, id: bestId });
      } else {
        const newId = this.nextId++;
        this.tracks.push({
          id: newId, cx: face.cx, cy: face.cy,
          w: face.w, h: face.h, lastSeen: t,
        });
        matched.add(newId);
        result.push({ ...face, id: newId });
      }
    }
    this.tracks = this.tracks.filter(tr => t - tr.lastSeen < 5.0);
    return result;
  }
}

// ─── Core: single-pass segment builder ───────────────────────────────────────
/**
 * Given a map of { timestamp → [faces] }, classify each frame and group
 * consecutive frames with the same normalised mode into segments.
 *
 * A boundary is only committed when BOUNDARY_CONFIRM_FRAMES consecutive
 * frames all agree on the new mode (prevents noise from one bad frame
 * creating a fake boundary).
 *
 * Returns: [{ start, end, frames: [{t, decision}] }]
 */
function buildSegmentsFromFrames(sampleTimes, faceFrames, clipStartSec, sceneCuts = []) {
  const tracker = new FaceTracker();

  // 1. Classify every sampled frame
  const classified = sampleTimes.map(t => {
    const rawFaces = faceFrames[String(t)] || [];
    const tracked  = tracker.update(rawFaces, t);
    const decision = classifyFrame(tracked, false);
    return { t, decision, normMode: _normMode(decision.mode) };
  });

  if (!classified.length) return [];

  // 2. Segment with confirmation window.
  //    A boundary commits when the new mode is confirmed for BOUNDARY_CONFIRM_FRAMES
  //    OR when a real scene cut sits in the flip gap. A cut-aligned boundary is
  //    snapped to the cut timestamp and tagged hardCut (it bypasses the
  //    confirmation requirement and downstream merge/smooth erosion).
  const segments = [];
  let   segStart        = 0;    // index into classified
  let   pendingSnap     = null; // snapped start time for the segment beginning at segStart
  let   pendingHardCut  = false;

  let i = 0;
  while (i < classified.length) {
    const currentMode = classified[segStart].normMode;

    // Find where mode first flips
    let flipIdx = i;
    while (flipIdx < classified.length && classified[flipIdx].normMode === currentMode) {
      flipIdx++;
    }

    if (flipIdx >= classified.length) {
      // No flip found — rest of clip is same mode
      segments.push({ startIdx: segStart, endIdx: classified.length - 1, snapStart: pendingSnap, hardCut: pendingHardCut });
      break;
    }

    // Is there a real scene cut between the last old-mode sample and the new one?
    const gapLo = classified[flipIdx - 1].t;
    const gapHi = classified[flipIdx].t;
    const cut   = findCutInGap(sceneCuts, gapLo, gapHi);

    // Check if flip holds for BOUNDARY_CONFIRM_FRAMES
    const confirmEnd = Math.min(flipIdx + BOUNDARY_CONFIRM_FRAMES, classified.length);
    const newMode    = classified[flipIdx].normMode;
    const confirmed  = classified.slice(flipIdx, confirmEnd)
      .every(f => f.normMode === newMode);

    if (cut !== null || confirmed) {
      // Commit boundary. Cut present → snap new segment start to the cut & lock it.
      segments.push({ startIdx: segStart, endIdx: flipIdx - 1, snapStart: pendingSnap, hardCut: pendingHardCut });
      segStart       = flipIdx;
      pendingSnap    = cut;            // null when confirmed-without-cut
      pendingHardCut = cut !== null;
      i              = flipIdx;
      if (cut !== null) {
        console.log(`[reframer/seg] hard cut @ ${cut.toFixed(2)}s → snapping ${currentMode}→${newMode} boundary`);
      }
    } else {
      // Noise — skip past this blip and keep looking from flipIdx+1
      i = flipIdx + 1;
    }
  }

  // 3. For each segment: vote from its own frames, average positions
  return segments.map(seg => {
    const frames = classified.slice(seg.startIdx, seg.endIdx + 1);
    const votes  = { face: 0, split: 0, blur_overlay: 0, passthrough: 0 };
    const splitPos = [], facePos = [];

    for (const f of frames) {
      const m = _normMode(f.decision.mode);
      votes[m] = (votes[m] || 0) + 1;
      if (m === "face") {
        facePos.push({ cx: f.decision.faceCxNorm ?? 0.5, cy: f.decision.faceCyNorm ?? 0.4 });
      }
      if (m === "split") {
        splitPos.push({
          lcx: f.decision.leftCxNorm  ?? 0.25,
          lcy: f.decision.leftCyNorm  ?? 0.4,
          rcx: f.decision.rightCxNorm ?? 0.75,
          rcy: f.decision.rightCyNorm ?? 0.4,
          wide: f.decision.isWideLayout === true,
        });
      }
    }

    const total     = Object.values(votes).reduce((s, v) => s + v, 0) || 1;
    // Deterministic tie-break: on equal votes prefer the more informative
    // layout (split > blur_overlay > face > passthrough) instead of the old
    // insertion order which silently favoured "face".
    const TIE_ORDER = { split: 0, blur_overlay: 1, face: 2, passthrough: 3 };
    const [winMode] = Object.entries(votes)
      .sort((a, b) => b[1] - a[1] || (TIE_ORDER[a[0]] - TIE_ORDER[b[0]]))[0];
    const winFrac   = votes[winMode] / total;
    const avg       = (arr, key) =>
      arr.length ? arr.reduce((s, p) => s + p[key], 0) / arr.length : null;

    let decision;
    if (winMode === "split" && splitPos.length) {
      decision = {
        mode:         "split",
        leftCxNorm:   avg(splitPos, "lcx") ?? 0.25,
        leftCyNorm:   avg(splitPos, "lcy") ?? 0.4,
        rightCxNorm:  avg(splitPos, "rcx") ?? 0.75,
        rightCyNorm:  avg(splitPos, "rcy") ?? 0.4,
        isWideLayout: splitPos.filter(p => p.wide).length / splitPos.length >= 0.5,
      };
    } else if (winMode === "face" && facePos.length) {
      decision = {
        mode:       "face",
        faceCxNorm: avg(facePos, "cx") ?? 0.5,
        faceCyNorm: avg(facePos, "cy") ?? 0.4,
      };
    } else if (winMode === "blur_overlay") {
      decision = { mode: "blur_overlay" };
    } else {
      decision = { mode: "passthrough" };
    }

    const startT = frames[0].t;
    const endT   = frames[frames.length - 1].t;

    console.log(
      `[reframer/seg] ${startT.toFixed(1)}→${endT.toFixed(1)}s: ` +
      `votes=${JSON.stringify(votes)} → ${winMode} (${(winFrac * 100).toFixed(0)}%)`
    );

    return {
      start: startT,
      end:   endT,
      decision,
      votes,
      winFrac,
      // Boundary metadata for snapping + lock-through-merge/smooth
      snapStart: seg.snapStart ?? null,
      hardCut:   seg.hardCut === true,
    };
  });
}

// ─── Merge short segments ─────────────────────────────────────────────────────
/**
 * FIXED: When merging a short segment, we extend the neighbour's TIME RANGE
 * but KEEP THE NEIGHBOUR'S DECISION — we do NOT inherit the short segment's
 * layout. This means a 1-person (face) blip that is too short gets its time
 * absorbed by its neighbour, but the neighbour's layout (split, blur_overlay,
 * etc.) stays. Crucially, if the short segment is a different angle type than
 * its neighbours (e.g. "face" sandwiched between two "split" segments), we
 * choose the neighbour with the same mode if possible so we don't accidentally
 * flip a genuine 1-person angle into split.
 *
 * KEY RULE ADDED: A "face" segment (1 person) is NEVER merged into a "split"
 * segment if the face segment has at least MIN_FACE_PROTECT_SECS duration.
 * This protects legitimate 1-person camera angles from being overwritten.
 */
const MIN_FACE_PROTECT_SECS = parseFloat(process.env.MIN_FACE_PROTECT_SECS || "2.0");

function mergeShortSegments(segments, minSecs) {
  if (segments.length <= 1) return segments;

  let changed = true;
  let segs    = segments.map(s => ({ ...s }));

  while (changed) {
    changed = false;
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const dur  = segs[i].end - segs[i].start;
      const mode = segs[i].decision.mode;

      // Protect face segments that are long enough — never swallow them into split
      const isFaceProtected =
        (mode === "face" || _isFaceMode(mode)) &&
        dur >= MIN_FACE_PROTECT_SECS;

      // Protect cut-aligned segments — a real scene cut to a new layout must
      // survive even if it's shorter than MIN_SEGMENT_SECS.
      const isHardCut = segs[i].hardCut === true;

      if (dur < minSecs && segs.length > 1 && !isFaceProtected && !isHardCut) {
        const prevSeg = out.length > 0 ? out[out.length - 1] : null;
        const nextSeg = i + 1 < segs.length ? segs[i + 1] : null;

        // Prefer merging into a neighbour with the SAME mode (avoids cross-mode contamination)
        const prevSameMode = prevSeg && prevSeg.decision.mode === mode;
        const nextSameMode = nextSeg && nextSeg.decision.mode === mode;

        if (prevSameMode) {
          // Extend previous same-mode segment — its decision is already correct
          out[out.length - 1].end = segs[i].end;
          changed = true;
        } else if (nextSameMode) {
          // Extend next same-mode segment backward
          segs[i + 1] = { ...segs[i + 1], start: segs[i].start };
          changed = true;
        } else if (prevSeg) {
          // No same-mode neighbour — extend previous (its decision wins)
          out[out.length - 1].end = segs[i].end;
          changed = true;
        } else if (nextSeg) {
          segs[i + 1] = { ...segs[i + 1], start: segs[i].start };
          changed = true;
        }
        // Drop segs[i] by not pushing it
      } else {
        out.push({ ...segs[i] });
      }
    }
    segs = out;
  }
  return segs;
}

// ─── Expand segment decisions → per-second timeline ──────────────────────────
function expandToTimeline(segments, clipStartSec, clipEndSec) {
  const timeline = [];
  for (const seg of segments) {
    // Cut-aligned segments start exactly at the scene cut (snapStart), so the
    // new layout switches at the cut frame instead of the next sample tick.
    const segStartT = seg.snapStart != null ? seg.snapStart : seg.start;
    let t = segStartT;
    let first = true;
    while (t <= seg.end + 0.01 && t < clipEndSec + 0.01) {
      timeline.push({
        videoTimeSec: parseFloat(t.toFixed(2)),
        clipTimeSec:  parseFloat((t - clipStartSec).toFixed(2)),
        faceCount:    seg.decision.mode === "passthrough" ? 0 : 1,
        decision:     seg.decision,
        // Lock the cut boundary entry so smoothing can't erode it
        locked:       seg.hardCut === true && first,
      });
      first = false;
      t += 1.0;
    }
  }
  // Ensure at least one entry
  if (!timeline.length && segments.length) {
    const seg = segments[0];
    timeline.push({
      videoTimeSec: seg.start,
      clipTimeSec:  parseFloat((seg.start - clipStartSec).toFixed(2)),
      faceCount:    0,
      decision:     seg.decision,
    });
  }
  return timeline;
}

// ─── Timeline smoother ────────────────────────────────────────────────────────
// Absorbs single-frame blips shorter than MIN_HOLD_SECS that slipped through
// the confirmation window (edge case near clip boundaries).
function smoothTimeline(rawTimeline) {
  if (!rawTimeline.length) return [];
  let result  = rawTimeline.map(e => ({ ...e }));
  let changed = true, passes = 0;

  while (changed && passes < 10) {
    changed = false; passes++;
    let i = 0;
    while (i < result.length) {
      const runMode = result[i].decision.mode;
      let j = i;
      while (j < result.length && result[j].decision.mode === runMode) j++;

      const runEnd = j < result.length ? result[j].clipTimeSec : Infinity;
      const runDur = runEnd - result[i].clipTimeSec;

      // Never erode a run that contains a locked (scene-cut) entry — the cut
      // boundary must stay exactly where it is.
      const runLocked = result.slice(i, j).some(e => e.locked);

      if (runDur < MIN_HOLD_SECS && !runLocked) {
        const prevRun = i > 0             ? result[i - 1].decision : null;
        const nextRun = j < result.length ? result[j].decision     : null;
        let replacement = prevRun || nextRun;

        if (prevRun && nextRun) {
          // Pick whichever neighbour run is longer
          let pLen = 0, nLen = 0;
          for (let k = i - 1; k >= 0 && result[k].decision.mode === prevRun.mode; k--) pLen++;
          for (let k = j; k < result.length && result[k].decision.mode === nextRun.mode; k++) nLen++;
          replacement = nLen >= pLen ? nextRun : prevRun;
        }

        // Don't absorb a confirmed split blip back into face
        const splitFrac = (result.filter(e => e.decision.mode === "split").length) /
                          (result.length || 1);
        if (
          runMode === "split" && splitFrac >= 0.08 &&
          replacement && _isFaceMode(replacement.mode)
        ) {
          i = j; continue;
        }

        // FIXED: Symmetric guard — don't absorb a confirmed face (1-person angle)
        // blip into split. A real camera cut to 1 person should stay as face.
        const faceFrac = (result.filter(e => _isFaceMode(e.decision.mode)).length) /
                         (result.length || 1);
        if (
          _isFaceMode(runMode) && faceFrac >= 0.05 &&
          replacement && replacement.mode === "split"
        ) {
          i = j; continue;
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

  // Face + split position smoothing (sliding median, window=3)
  const HALF = 1;
  for (let i = 0; i < result.length; i++) {
    if (_isFaceMode(result[i].decision.mode)) {
      const cxW = [], cyW = [];
      for (let k = Math.max(0, i - HALF); k <= Math.min(result.length - 1, i + HALF); k++) {
        if (_isFaceMode(result[k].decision.mode)) {
          cxW.push(result[k].decision.faceCxNorm ?? 0.5);
          cyW.push(result[k].decision.faceCyNorm ?? 0.4);
        }
      }
      if (cxW.length) {
        cxW.sort((a, b) => a - b); cyW.sort((a, b) => a - b);
        const m = Math.floor(cxW.length / 2);
        result[i] = {
          ...result[i],
          decision: { ...result[i].decision, faceCxNorm: cxW[m], faceCyNorm: cyW[m] },
        };
      }
    }
    if (result[i].decision.mode === "split") {
      const lcxW = [], rcxW = [];
      for (let k = Math.max(0, i - HALF); k <= Math.min(result.length - 1, i + HALF); k++) {
        if (result[k].decision.mode === "split") {
          lcxW.push(result[k].decision.leftCxNorm  ?? 0.25);
          rcxW.push(result[k].decision.rightCxNorm ?? 0.75);
        }
      }
      if (lcxW.length) {
        lcxW.sort((a, b) => a - b); rcxW.sort((a, b) => a - b);
        const m = Math.floor(lcxW.length / 2);
        result[i] = {
          ...result[i],
          decision: { ...result[i].decision, leftCxNorm: lcxW[m], rightCxNorm: rcxW[m] },
        };
      }
    }
  }
  return result;
}

// ─── Variety injection ────────────────────────────────────────────────────────
/**
 * For long blur_overlay or split segments, periodically injects face-focus
 * shots (left / right / center) so the clip doesn't feel static.
 *
 * blur_overlay cycle: face_left → face_right → face_center
 * split cycle:        face_left → face_right
 */
function injectVariety(timeline) {
  if (!timeline.length) return timeline;
  const result = timeline.map(e => ({ ...e }));

  let i = 0;
  while (i < result.length) {
    const baseMode = result[i].decision.mode;
    if (baseMode !== "blur_overlay" && baseMode !== "split") { i++; continue; }

    // Find run extent
    let j = i;
    while (j < result.length && result[j].decision.mode === baseMode) j++;

    const runStart = result[i].clipTimeSec;
    const runEnd   = j < result.length
      ? result[j].clipTimeSec
      : (result[result.length - 1].clipTimeSec + 1);
    const runDur   = runEnd - runStart;

    if (runDur >= VARIETY_MIN_SECS) {
      const baseDec      = result[i].decision;
      const focusVariants = _buildFocusVariants(baseMode, baseDec);

      if (focusVariants.length) {
        let variantIdx = 0;
        let nextInject = runStart + VARIETY_INTERVAL_SECS;

        for (let k = i; k < j; k++) {
          const ct = result[k].clipTimeSec;
          if (ct >= nextInject && ct + VARIETY_HOLD_SECS <= runEnd) {
            for (let m = k; m < j && result[m].clipTimeSec < ct + VARIETY_HOLD_SECS; m++) {
              result[m] = { ...result[m], decision: { ...focusVariants[variantIdx] } };
            }
            variantIdx = (variantIdx + 1) % focusVariants.length;
            nextInject = ct + VARIETY_HOLD_SECS + VARIETY_INTERVAL_SECS;
          }
        }

        console.log(
          `[reframer/variety] injected into ${baseMode} ` +
          `${runStart.toFixed(1)}→${runEnd.toFixed(1)}s (${runDur.toFixed(0)}s)`
        );
      }
    }
    i = j;
  }
  return result;
}

function _buildFocusVariants(baseMode, baseDec) {
  if (baseMode === "split") {
    return [
      { mode: "face_left",  faceCxNorm: baseDec.leftCxNorm  ?? 0.25, faceCyNorm: baseDec.leftCyNorm  ?? 0.4 },
      { mode: "face_right", faceCxNorm: baseDec.rightCxNorm ?? 0.75, faceCyNorm: baseDec.rightCyNorm ?? 0.4 },
    ];
  }
  if (baseMode === "blur_overlay") {
    return [
      { mode: "face_left",   faceCxNorm: 0.25, faceCyNorm: 0.38 },
      { mode: "face_right",  faceCxNorm: 0.75, faceCyNorm: 0.38 },
      { mode: "face",        faceCxNorm: 0.50, faceCyNorm: 0.38 },
    ];
  }
  return [];
}

// ─── Boundary refinement helpers ──────────────────────────────────────────────
// Lightweight per-sample mode pass (fresh tracker) — used only to locate
// adjacent-sample mode flips so we can densely re-sample inside soft (no-cut)
// transition gaps.
function quickModes(sampleTimes, faceFrames) {
  const tracker = new FaceTracker();
  return sampleTimes.map((t) => {
    const tracked = tracker.update(faceFrames[String(t)] || [], t);
    return _normMode(classifyFrame(tracked, false).mode);
  });
}

// Dense sample times (~0.25s) inside any gap where the mode flips but NO scene
// cut pins it — lets buildSegmentsFromFrames place the boundary within ~0.25s
// for soft transitions (e.g. a second person walks into frame). Capped so we
// never explode the YOLO frame count.
const REFINE_STEP_SECS = parseFloat(process.env.REFRAMER_REFINE_STEP || "0.25");
const REFINE_MAX_FRAMES = parseInt(process.env.REFRAMER_REFINE_MAX || "48", 10);

function computeRefineTimes(sampleTimes, faceFrames, sceneCuts) {
  const modes = quickModes(sampleTimes, faceFrames);
  const out = [];
  for (let i = 1; i < sampleTimes.length && out.length < REFINE_MAX_FRAMES; i++) {
    if (modes[i] === modes[i - 1]) continue;
    const lo = sampleTimes[i - 1];
    const hi = sampleTimes[i];
    if (findCutInGap(sceneCuts, lo, hi) !== null) continue; // cut already pins it
    for (let t = lo + REFINE_STEP_SECS; t < hi - 0.01 && out.length < REFINE_MAX_FRAMES; t += REFINE_STEP_SECS) {
      out.push(parseFloat(t.toFixed(2)));
    }
  }
  return out;
}

// ─── MAIN EXPORT: analyzeClipTimeline ────────────────────────────────────────
/**
 * Scans a clip segment [startSec, endSec] of videoPath.
 * Returns { timeline, srcW, srcH, isAlreadyVertical }
 */
async function analyzeClipTimeline(videoPath, startSec, endSec) {
  let info;
  try { info = await probe(videoPath); }
  catch (e) {
    console.warn("[reframer] probe failed:", e.message);
    return { timeline: [], srcW: 1920, srcH: 1080, isAlreadyVertical: false };
  }

  if (info.w / info.h < 0.75) {
    console.log("[reframer] already vertical → passthrough");
    return { timeline: [], srcW: info.w, srcH: info.h, isAlreadyVertical: true };
  }

  const clipDur = endSec - startSec;
  if (clipDur <= 0) {
    return { timeline: [], srcW: info.w, srcH: info.h, isAlreadyVertical: false };
  }

  const interval = clipDur <= DENSE_SCAN_MAX_SECS
    ? SCAN_INTERVAL_SHORT
    : SCAN_INTERVAL_LONG;

  const totalSamples = Math.max(2, Math.ceil(clipDur / interval));
  const sampleTimes  = Array.from({ length: totalSamples }, (_, i) =>
    parseFloat((startSec + (i * clipDur) / (totalSamples - 1 || 1)).toFixed(2))
  );

  console.log(
    `[reframer] clip ${startSec.toFixed(1)}→${endSec.toFixed(1)}s ` +
    `(${clipDur.toFixed(1)}s) — single-pass YOLO @ ${interval}s interval, ` +
    `${sampleTimes.length} samples`
  );

  // Coarse YOLO scan + scene-cut pass (run together).
  const [faceFrames, sceneCuts] = await Promise.all([
    detectFaces(videoPath, sampleTimes),
    detectSceneCuts(videoPath, startSec, endSec),
  ]);

  // Refinement: for soft mode-flips with NO scene cut, densely re-sample inside
  // the gap so the boundary is pinned to ~0.25s instead of the coarse interval.
  let allTimes  = sampleTimes;
  let allFrames = faceFrames;
  const refineTimes = computeRefineTimes(sampleTimes, faceFrames, sceneCuts);
  if (refineTimes.length) {
    console.log(`[reframer] refining ${refineTimes.length} frame(s) around soft transitions`);
    const extra = await detectFaces(videoPath, refineTimes);
    allFrames = { ...faceFrames, ...extra };
    allTimes  = [...new Set([...sampleTimes, ...refineTimes])].sort((a, b) => a - b);
  }

  // Build segments with per-segment voting (boundaries snapped to scene cuts)
  let segments = buildSegmentsFromFrames(allTimes, allFrames, startSec, sceneCuts);

  if (!segments.length) {
    return { timeline: [], srcW: info.w, srcH: info.h, isAlreadyVertical: false };
  }

  // Merge short segments (noise)
  segments = mergeShortSegments(segments, MIN_SEGMENT_SECS);

  // Log final segment map
  console.log(
    `[reframer] ${segments.length} segment(s): ` +
    segments.map(s =>
      `${s.start.toFixed(1)}→${s.end.toFixed(1)}s:${s.decision.mode}`
    ).join(" | ")
  );

  const rawTimeline = expandToTimeline(segments, startSec, endSec);
  const smoothed    = smoothTimeline(rawTimeline);
  const timeline    = injectVariety(smoothed);

  const mc = {};
  for (const e of timeline) mc[e.decision.mode] = (mc[e.decision.mode] || 0) + 1;
  console.log("[reframer] final modes:", JSON.stringify(mc));

  return { timeline, srcW: info.w, srcH: info.h, isAlreadyVertical: false };
}

// ─── buildFullVideoLayoutMap ──────────────────────────────────────────────────
async function buildFullVideoLayoutMap(videoPath) {
  let info;
  try { info = await probe(videoPath); }
  catch (e) { console.warn("[reframer/layoutMap] probe failed:", e.message); return []; }

  if (info.w / info.h < 0.75) { console.log("[reframer/layoutMap] already vertical"); return []; }
  if (info.dur <= 0) return [];

  // For full-video scan, always use the long interval to keep it fast
  const interval     = SCAN_INTERVAL_LONG;
  const totalSamples = Math.max(2, Math.ceil(info.dur / interval));
  const sampleTimes  = Array.from({ length: totalSamples }, (_, i) =>
    parseFloat((i * info.dur / (totalSamples - 1 || 1)).toFixed(2))
  );

  console.log(
    `[reframer/layoutMap] full-video scan: ${info.dur.toFixed(0)}s, ` +
    `${sampleTimes.length} samples @ ${interval}s`
  );

  const [faceFrames, sceneCuts] = await Promise.all([
    detectFaces(videoPath, sampleTimes),
    detectSceneCuts(videoPath, 0, info.dur),
  ]);
  let   segments   = buildSegmentsFromFrames(sampleTimes, faceFrames, 0, sceneCuts);
  segments         = mergeShortSegments(segments, MIN_SEGMENT_SECS);

  const rawTimeline = expandToTimeline(segments, 0, info.dur);
  const smoothed    = smoothTimeline(rawTimeline);
  const timeline    = injectVariety(smoothed);

  const mc = {};
  for (const e of timeline) mc[e.decision.mode] = (mc[e.decision.mode] || 0) + 1;
  console.log("[reframer/layoutMap] full-video modes:", JSON.stringify(mc));
  return timeline;
}

// ─── Legacy: analyzeSpeakers ──────────────────────────────────────────────────
async function analyzeSpeakers(videoPath) {
  let info;
  try { info = await probe(videoPath); } catch { return { mode: "passthrough" }; }
  if (info.w / info.h < 0.75) return { mode: "passthrough" };

  const interval     = SCAN_INTERVAL_LONG;
  const totalSamples = Math.max(2, Math.ceil(info.dur / interval));
  const sampleTimes  = Array.from({ length: totalSamples }, (_, i) =>
    parseFloat((i * info.dur / (totalSamples - 1 || 1)).toFixed(2))
  );

  const faceFrames = await detectFaces(videoPath, sampleTimes);
  let   segments   = buildSegmentsFromFrames(sampleTimes, faceFrames, 0);
  segments         = mergeShortSegments(segments, MIN_SEGMENT_SECS);

  let faceDur = 0, splitDur = 0, blurDur = 0, totalDur = 0;
  let avgFaceCx = 0.5, avgFaceCy = 0.4;

  for (const seg of segments) {
    const d   = seg.end - seg.start;
    totalDur += d;
    if (seg.decision.mode === "face")         { faceDur  += d; avgFaceCx = seg.decision.faceCxNorm ?? 0.5; avgFaceCy = seg.decision.faceCyNorm ?? 0.4; }
    else if (seg.decision.mode === "split")   { splitDur += d; }
    else if (seg.decision.mode === "blur_overlay") { blurDur  += d; }
  }

  if (blurDur  / totalDur >= 0.20) return { mode: "blur_overlay" };
  if (splitDur / totalDur >= 0.20) return { mode: "blur_overlay" }; // treat split like overlay for legacy callers
  if (faceDur  / totalDur >= 0.40) return { mode: "face", faceCxNorm: avgFaceCx, faceCyNorm: avgFaceCy };
  return { mode: "passthrough" };
}

module.exports = { analyzeClipTimeline, analyzeSpeakers, buildFullVideoLayoutMap };