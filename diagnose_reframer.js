/* eslint-disable no-undef */
/**
 * diagnose_reframer.js
 *
 * Usage:
 *   node diagnose_reframer.js "D:\path\to\video.mp4"
 *
 * Tweak TUNING below to test different thresholds instantly.
 */

"use strict";

const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const util = require("util");
const execAsync = util.promisify(exec);

// ╔══════════════════════════════════════════════════════════════╗
// ║                  🎛️  TUNING PARAMETERS                      ║
// ║  Change these and re-run to test different behaviours        ║
// ╚══════════════════════════════════════════════════════════════╝
const TUNING = {
  // ── Detection thresholds (Python/YOLO) ──────────────────────────────────
  CONF_THRESH: 0.5, // YOLO confidence cutoff
  // Lower = more detections (more false positives)
  // Higher = fewer detections (may miss real faces)
  // Range: 0.20–0.80  |  Recommended: 0.40–0.60

  MIN_AREA: 0.035, // Min face area as fraction of frame (width*height)
  // Removes tiny background/ghost faces
  // Lower = detects smaller faces
  // Range: 0.005–0.05  |  Recommended: 0.012–0.020

  MIN_BH: 0.12, // Min face HEIGHT as fraction of frame height
  // Removes wide/short false positives (hands, shoulders, patterns)
  // Lower = allows shorter faces
  // Range: 0.05–0.20  |  Recommended: 0.10–0.15

  DEDUP_DIST: 0.08, // Max cx/cy distance to treat two detections as the same face
  // Lower = keeps more detections separate
  // Higher = merges more aggressively
  // Range: 0.05–0.15  |  Recommended: 0.07–0.10

  MAX_FACES: 4, // Max faces to keep per frame after dedup
  // 2 = podcast only | 4 = supports 2x2 grid detection

  // ── Decision thresholds (Node.js split/blur logic) ───────────────────────
  SPLIT_CX_DIFF: 0.38, // Min horizontal separation between 2 faces to trigger split
  // Higher = stricter (fewer splits)
  // Range: 0.25–0.50  |  Recommended: 0.35–0.42

  SPLIT_AREA_RATIO: 0.45, // Min size similarity between 2 faces (smaller/larger area)
  // 1.0 = must be identical size. 0.0 = any difference OK
  // Range: 0.25–0.70  |  Recommended: 0.40–0.55

  SPLIT_CY_FACTOR: 0.8, // Max vertical drift allowed as fraction of cxDiff
  // Ensures both faces are on roughly the same horizontal line
  // Lower = stricter alignment required
  // Range: 0.50–1.20  |  Recommended: 0.70–0.90

  MIN_SPLIT_AREA: 0.04, // Each face must cover at least this fraction of frame to split
  // Prevents distant/small faces from triggering split mode
  // Range: 0.02–0.10  |  Recommended: 0.03–0.06

  MAJORITY_THRESHOLD: 0.8, // If this % of frames agree on one mode, force entire clip
  // Lower = majority vote triggers more often
  // Range: 0.60–0.95  |  Recommended: 0.75–0.85

  // ── Sampling ─────────────────────────────────────────────────────────────
  SAMPLE_POINTS: [0.1, 0.2, 0.4, 0.6, 0.8], // Fractions of video duration to sample
  // Add more points for complex videos
};

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PYTHON = "C:\\Users\\ASUS\\AppData\\Local\\Python\\bin\\python.exe";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const TMP_DIR = path.resolve(__dirname, "tmp");
// ─────────────────────────────────────────────────────────────────────────────

const VIDEO = process.argv[2];

function hr(char = "─", len = 60) {
  return char.repeat(len);
}
function label(text) {
  console.log(`\n${hr("═")}\n ${text}\n${hr("═")}`);
}
function section(text) {
  console.log(`\n${hr()}\n ${text}\n${hr()}`);
}

async function check(desc, fn) {
  process.stdout.write(`  ${desc}... `);
  try {
    const result = await fn();
    console.log(`✅  ${result || "ok"}`);
    return { ok: true, value: result };
  } catch (e) {
    console.log(`❌  FAILED\n     → ${e.message.split("\n")[0]}`);
    return { ok: false, error: e.message };
  }
}

// ── DECISION ENGINE — mirrors speakerReframer.js using TUNING values ─────────
function decideMomentMode(faces) {
  if (!faces || faces.length === 0)
    return { mode: "passthrough", reason: "no faces detected" };

  // Grid check — faces in both top and bottom halves = multi-person grid call
  const topFaces = faces.filter((f) => f.cy < 0.5);
  const botFaces = faces.filter((f) => f.cy >= 0.5);
  if (topFaces.length >= 1 && botFaces.length >= 1)
    return {
      mode: "blur_overlay",
      reason: `grid layout — ${topFaces.length} top, ${botFaces.length} bottom`,
    };

  if (faces.length >= 3)
    return {
      mode: "blur_overlay",
      reason: `${faces.length} faces detected (3+)`,
    };

  if (faces.length === 1)
    return {
      mode: "face",
      faceCxNorm: faces[0].cx,
      faceCyNorm: faces[0].cy,
      reason: `single face at cx=${faces[0].cx}, cy=${faces[0].cy}`,
    };

  // Exactly 2 faces — evaluate all split conditions
  const top2 = [...faces]
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, 2)
    .sort((a, b) => a.cx - b.cx);

  const cxDiff = Math.abs(top2[0].cx - top2[1].cx);
  const cyDiff = Math.abs(top2[0].cy - top2[1].cy);
  const areaRatio =
    Math.min(top2[0].w * top2[0].h, top2[1].w * top2[1].h) /
    Math.max(top2[0].w * top2[0].h, top2[1].w * top2[1].h);
  const bothLarge =
    top2[0].w * top2[0].h > TUNING.MIN_SPLIT_AREA &&
    top2[1].w * top2[1].h > TUNING.MIN_SPLIT_AREA;

  const checks = {
    cxDiff: {
      pass: cxDiff > TUNING.SPLIT_CX_DIFF,
      val: cxDiff.toFixed(3),
      need: `>${TUNING.SPLIT_CX_DIFF}`,
    },
    areaRatio: {
      pass: areaRatio > TUNING.SPLIT_AREA_RATIO,
      val: areaRatio.toFixed(3),
      need: `>${TUNING.SPLIT_AREA_RATIO}`,
    },
    cyDiff: {
      pass: cyDiff < cxDiff * TUNING.SPLIT_CY_FACTOR,
      val: cyDiff.toFixed(3),
      need: `<${(cxDiff * TUNING.SPLIT_CY_FACTOR).toFixed(3)}`,
    },
    bothLarge: {
      pass: bothLarge,
      val: bothLarge ? "yes" : "no",
      need: `each area>${TUNING.MIN_SPLIT_AREA}`,
    },
  };

  const allPass = Object.values(checks).every((c) => c.pass);

  if (allPass) {
    return {
      mode: "split",
      leftCxNorm: top2[0].cx,
      leftCyNorm: top2[0].cy,
      rightCxNorm: top2[1].cx,
      rightCyNorm: top2[1].cy,
      reason: `2 faces side-by-side — all checks passed`,
      checks,
    };
  }

  const failed = Object.entries(checks)
    .filter(([, c]) => !c.pass)
    .map(([k, c]) => `${k}=${c.val} (need ${c.need})`)
    .join(", ");

  return {
    mode: "blur_overlay",
    reason: `2 faces but failed: ${failed}`,
    checks,
  };
}

// ── PYTHON DETECTION SCRIPT ───────────────────────────────────────────────────
const DEBUG_SCRIPT = `
import sys, json, warnings, os
warnings.filterwarnings("ignore")

video_path   = sys.argv[1]
sample_times = json.loads(sys.argv[2])
conf_thresh  = float(sys.argv[3])
min_area     = float(sys.argv[4])
min_bh       = float(sys.argv[5])
dedup_dist   = float(sys.argv[6])
max_faces    = int(sys.argv[7])

try:
    import cv2
    from ultralytics import YOLO
    import logging
    logging.getLogger("ultralytics").setLevel(logging.ERROR)

    CACHE_DIR  = os.path.join(os.path.expanduser("~"), ".cache", "yolov8-face")
    MODEL_PATH = os.path.join(CACHE_DIR, "yolov8n-face.pt")
    MODEL_URL  = "https://github.com/akanametov/yolo-face/releases/download/1.0.0/yolov8n-face.pt"

    if not os.path.exists(MODEL_PATH):
        import urllib.request
        os.makedirs(CACHE_DIR, exist_ok=True)
        sys.stderr.write("[yolo] downloading model...\\n")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)

    model = YOLO(MODEL_PATH)
    cap   = cv2.VideoCapture(video_path)
    fps   = cap.get(cv2.CAP_PROP_FPS) or 25.0
    W     = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H     = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    results_out = {}

    for t in sample_times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        ok, frame = cap.read()
        if not ok:
            results_out[str(t)] = {"faces":[],"raw_detections":0,"filtered_out":[],"candidates":[]}
            continue

        h, w = frame.shape[:2]
        results = model(frame, conf=conf_thresh, imgsz=640, verbose=False)[0]
        raw_count = len(results.boxes) if results.boxes is not None else 0
        candidates = []
        filtered_out = []

        if results.boxes is not None:
            for box in results.boxes.xyxy.cpu().tolist():
                x1,y1,x2,y2 = box[:4]
                x1=max(0.0,x1); y1=max(0.0,y1)
                x2=min(float(w),x2); y2=min(float(h),y2)
                if x2<=x1 or y2<=y1: continue

                bw   = (x2-x1)/w
                bh_  = (y2-y1)/h
                area = bw*bh_
                cx   = ((x1+x2)/2)/w
                cy   = ((y1+y2)/2)/h
                aspect = bw/bh_ if bh_>0 else 0

                reject_reason = None
                if area < min_area:            reject_reason = f"area={area:.4f} < min_area={min_area}"
                elif bh_ < min_bh:             reject_reason = f"bh={bh_:.4f} < min_bh={min_bh}"
                elif aspect>1.8 or aspect<0.3: reject_reason = f"aspect={aspect:.2f} out of [0.3,1.8]"

                entry = {"cx":round(cx,4),"cy":round(cy,4),"w":round(bw,4),"h":round(bh_,4),"area":round(area,5),"aspect":round(aspect,3)}
                if reject_reason:
                    entry["reject_reason"] = reject_reason
                    filtered_out.append(entry)
                else:
                    candidates.append(entry)

        candidates.sort(key=lambda f: f["area"], reverse=True)
        deduped = []
        for c in candidates:
            is_dup = any(abs(c["cx"]-k["cx"])<dedup_dist and abs(c["cy"]-k["cy"])<dedup_dist for k in deduped)
            if not is_dup: deduped.append(c)

        faces = [{"cx":f["cx"],"cy":f["cy"],"w":f["w"],"h":f["h"]} for f in deduped[:max_faces]]
        results_out[str(t)] = {"faces":faces,"raw_detections":raw_count,"candidates":candidates,"filtered_out":filtered_out}

    cap.release()
    print(json.dumps({"ok":True,"fps":fps,"W":W,"H":H,"frames":results_out}))

except Exception as e:
    import traceback
    print(json.dumps({"ok":False,"error":str(e),"traceback":traceback.format_exc()}))
`.trim();

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  label("🔍 Reframer Full Diagnostic");

  // Print active tuning values
  section("🎛️  Active TUNING values");
  console.log(
    `  CONF_THRESH:          ${TUNING.CONF_THRESH}    — YOLO confidence`,
  );
  console.log(
    `  MIN_AREA:             ${TUNING.MIN_AREA}   — min face area fraction`,
  );
  console.log(
    `  MIN_BH:               ${TUNING.MIN_BH}    — min face height fraction`,
  );
  console.log(
    `  DEDUP_DIST:           ${TUNING.DEDUP_DIST}    — dedup distance`,
  );
  console.log(
    `  MAX_FACES:            ${TUNING.MAX_FACES}       — max faces per frame`,
  );
  console.log(
    `  SPLIT_CX_DIFF:        ${TUNING.SPLIT_CX_DIFF}    — min horizontal gap for split`,
  );
  console.log(
    `  SPLIT_AREA_RATIO:     ${TUNING.SPLIT_AREA_RATIO}    — min size similarity for split`,
  );
  console.log(
    `  SPLIT_CY_FACTOR:      ${TUNING.SPLIT_CY_FACTOR}     — max vertical drift factor`,
  );
  console.log(
    `  MIN_SPLIT_AREA:       ${TUNING.MIN_SPLIT_AREA}    — each face min area for split`,
  );
  console.log(
    `  MAJORITY_THRESHOLD:   ${TUNING.MAJORITY_THRESHOLD}     — majority vote threshold`,
  );
  console.log(
    `  SAMPLE_POINTS:        ${JSON.stringify(TUNING.SAMPLE_POINTS)}`,
  );

  section("① Input video");
  if (!VIDEO) {
    console.log(
      `  ❌  Usage: node diagnose_reframer.js "D:\\path\\to\\video.mp4"`,
    );
    process.exit(1);
  }
  if (!fs.existsSync(VIDEO)) {
    console.log(`  ❌  Not found: ${VIDEO}`);
    process.exit(1);
  }
  console.log(
    `  ✅  ${VIDEO} (${(fs.statSync(VIDEO).size / 1024 / 1024).toFixed(1)} MB)`,
  );

  section("② tmp directory");
  await check("Create tmp", () => {
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    return TMP_DIR;
  });

  section("③ ffprobe");
  let videoInfo = null;
  await check("ffprobe binary", async () => {
    const { stdout } = await execAsync(`"${FFPROBE}" -version`, {
      timeout: 5000,
    });
    return stdout.split("\n")[0];
  });
  await check("video metadata", async () => {
    const { stdout } = await execAsync(
      `"${FFPROBE}" -v quiet -print_format json -show_streams -select_streams v:0 "${VIDEO}"`,
      { timeout: 10_000 },
    );
    const s = JSON.parse(stdout).streams?.[0] || {};
    videoInfo = {
      w: parseInt(s.width || 1920, 10),
      h: parseInt(s.height || 1080, 10),
      dur: parseFloat(s.duration || 60),
      fps: s.r_frame_rate,
    };
    const isVertical = videoInfo.w / videoInfo.h < 0.75;
    return `${videoInfo.w}x${videoInfo.h}, ${videoInfo.dur.toFixed(1)}s, ${videoInfo.fps}fps${isVertical ? " [VERTICAL → passthrough]" : ""}`;
  });

  if (videoInfo && videoInfo.w / videoInfo.h < 0.75) {
    console.log("\n  ⚠️  Already vertical — passthrough, no detection needed.");
    process.exit(0);
  }

  section("④ Python & dependencies");
  await check("Python", async () => {
    const { stdout } = await execAsync(`"${PYTHON}" --version`, {
      timeout: 5000,
    });
    return stdout.trim();
  });
  await check("cv2", async () => {
    const { stdout } = await execAsync(
      `"${PYTHON}" -c "import cv2; print(cv2.__version__)"`,
      { timeout: 10_000 },
    );
    return `v${stdout.trim()}`;
  });
  await check("ultralytics", async () => {
    const { stdout } = await execAsync(
      `"${PYTHON}" -c "import ultralytics; print(ultralytics.__version__)"`,
      { timeout: 15_000 },
    );
    return `v${stdout.trim()}`;
  });

  section("⑤ YOLO model");
  const MODEL_PATH = path.join(
    process.env.USERPROFILE || process.env.HOME || ".",
    ".cache",
    "yolov8-face",
    "yolov8n-face.pt",
  );
  await check("yolov8n-face.pt", () => {
    if (!fs.existsSync(MODEL_PATH)) throw new Error(`Not found: ${MODEL_PATH}`);
    return `${(fs.statSync(MODEL_PATH).size / 1024 / 1024).toFixed(1)} MB`;
  });

  section("⑥ Running YOLO detection");
  const scriptPath = path.join(TMP_DIR, "_diag_full.py");
  fs.writeFileSync(scriptPath, DEBUG_SCRIPT, "utf8");

  const sampleTimes = TUNING.SAMPLE_POINTS.map((r) =>
    parseFloat((r * videoInfo.dur).toFixed(2)),
  );
  console.log(
    `  Sampling: ${sampleTimes.map((t) => t.toFixed(1) + "s").join(", ")}`,
  );

  const timesJson = JSON.stringify(sampleTimes).replace(/"/g, '\\"');
  const cmd = `"${PYTHON}" "${scriptPath}" "${VIDEO}" "${timesJson}" ${TUNING.CONF_THRESH} ${TUNING.MIN_AREA} ${TUNING.MIN_BH} ${TUNING.DEDUP_DIST} ${TUNING.MAX_FACES}`;

  let detectionResult = null;
  const { ok: cmdOk } = await check("YOLO inference", async () => {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      shell: true,
    });
    if (stderr?.trim()) {
      const l = stderr.trim().split("\n")[0];
      if (!l.includes("WARNING") && !l.includes("ultralytics"))
        console.log(`\n     stderr: ${l}`);
    }
    const lastLine = stdout.trim().split("\n").pop();
    detectionResult = JSON.parse(lastLine);
    if (!detectionResult.ok) throw new Error(detectionResult.error);
    return `${detectionResult.W}x${detectionResult.H} @ ${detectionResult.fps.toFixed(1)}fps`;
  });

  if (!cmdOk || !detectionResult?.ok) return;

  section("⑦ Per-frame analysis");
  const allDecisions = [];

  for (const [tStr, fd] of Object.entries(detectionResult.frames)) {
    const t = parseFloat(tStr);
    console.log(`\n  ┌─ t=${t.toFixed(1)}s ` + "─".repeat(45));
    console.log(
      `  │  Raw detections: ${fd.raw_detections}  →  passed: ${fd.candidates?.length || 0}  rejected: ${fd.filtered_out?.length || 0}`,
    );

    if (fd.filtered_out?.length > 0) {
      console.log(`  │  Rejected:`);
      for (const f of fd.filtered_out)
        console.log(
          `  │    cx=${f.cx} cy=${f.cy} area=${f.area} bh=${f.h}  →  ${f.reject_reason}`,
        );
    }

    if (fd.faces.length > 0) {
      console.log(`  │  Accepted (${fd.faces.length}):`);
      for (const f of fd.faces) {
        const half = f.cy < 0.5 ? "TOP" : "BOT";
        console.log(
          `  │    [${half}] cx=${f.cx} cy=${f.cy} w=${f.w} h=${f.h} area=${(f.w * f.h).toFixed(4)}`,
        );
      }
    } else {
      console.log(`  │  Accepted: none`);
    }

    const decision = decideMomentMode(fd.faces);
    allDecisions.push(decision.mode);
    const emoji =
      { passthrough: "⬜", face: "🟦", split: "🟩", blur_overlay: "🟨" }[
        decision.mode
      ] || "❓";

    console.log(`  │`);
    console.log(`  │  ${emoji} Decision: ${decision.mode.toUpperCase()}`);
    console.log(`  │  Reason:   ${decision.reason}`);

    if (decision.checks) {
      console.log(`  │  Split checks:`);
      for (const [k, c] of Object.entries(decision.checks))
        console.log(
          `  │    ${c.pass ? "✅" : "❌"} ${k.padEnd(12)}: ${String(c.val).padEnd(8)} (need ${c.need})`,
        );
    }
    console.log(`  └${"─".repeat(50)}`);
  }

  section("⑧ Summary & majority vote");
  const modeCounts = {};
  for (const m of allDecisions) modeCounts[m] = (modeCounts[m] || 0) + 1;
  const [[dominant, dominantCount]] = Object.entries(modeCounts).sort(
    (a, b) => b[1] - a[1],
  );
  const ratio = dominantCount / allDecisions.length;

  console.log(`  Frames sampled:       ${allDecisions.length}`);
  console.log(`  Mode breakdown:       ${JSON.stringify(modeCounts)}`);
  console.log(
    `  Dominant mode:        ${dominant} (${(ratio * 100).toFixed(0)}%)`,
  );
  console.log(
    `  Majority vote result: ${
      ratio >= TUNING.MAJORITY_THRESHOLD
        ? `✅ Would force entire clip to "${dominant}"`
        : `⚠️  No majority (${(ratio * 100).toFixed(0)}% < ${TUNING.MAJORITY_THRESHOLD * 100}%) — timeline will vary per frame`
    }`,
  );

  section("⑨ Diagnosis & tips");
  const hasGrid = Object.values(detectionResult.frames).some(
    (f) =>
      f.faces.filter((x) => x.cy < 0.5).length >= 1 &&
      f.faces.filter((x) => x.cy >= 0.5).length >= 1,
  );
  if (hasGrid)
    console.log(
      `  ✅ Grid layout correctly detected (faces top+bottom) → blur_overlay`,
    );
  if (
    Object.values(detectionResult.frames).some(
      (f) => f.filtered_out?.length > 0,
    )
  )
    console.log(
      `  ℹ️  Faces filtered by thresholds — background/ghost faces removed (correct)`,
    );
  if (allDecisions.every((m) => m === "passthrough"))
    console.log(
      `  ⚠️  All passthrough — no faces found.\n     → Try: CONF_THRESH=0.35, MIN_AREA=0.008, MIN_BH=0.08`,
    );
  if (allDecisions.includes("split"))
    console.log(
      `  ℹ️  Split detected — verify cx values above look like real side-by-side people`,
    );
  if (allDecisions.includes("blur_overlay") && !hasGrid)
    console.log(
      `  ℹ️  blur_overlay without grid — likely 2 faces that failed split checks`,
    );

  const debugOut = path.join(TMP_DIR, "debug_result.json");
  fs.writeFileSync(
    debugOut,
    JSON.stringify(
      { TUNING, videoInfo, detectionResult, allDecisions, modeCounts },
      null,
      2,
    ),
  );
  console.log(`\n  📄 Full debug saved to: ${debugOut}`);

  label(
    "✅ Done — edit TUNING at top of file and re-run to test different values",
  );
}

main().catch((e) => {
  console.error("\n❌ Error:", e.message);
  process.exit(1);
});
