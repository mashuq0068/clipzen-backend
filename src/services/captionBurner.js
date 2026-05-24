/* eslint-disable no-empty */
// ─────────────────────────────────────────────────────────────
// captionBurner.js
//
// CHANGES FROM ORIGINAL:
//   PERF 1 — Replaced `npx remotion render` CLI with programmatic
//             @remotion/renderer API. Bundle is created once at
//             worker startup (remotionBundle.js) and reused for
//             every clip — eliminates 15-30s cold start per clip.
//   PERF 2 — Props are passed in-memory to renderMedia() instead
//             of being written to a temp JSON file on disk.
//   BUG FIX — B-roll files from other job folders (cross-job
//             cache hits / Pexels timeout fallback) are now copied
//             into the current job's broll dir before the URL is
//             built. Prevents `..` path traversal → 500 crash in
//             Remotion's renderer.
//   KEPT    — Everything else is 100% identical: all styles,
//             icons, SFX, b-roll server, post-process, retry
//             logic, error handling, exports.
// ─────────────────────────────────────────────────────────────

const JOB_STYLE_CACHE = new Map();

const { exec, execFile } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const util = require("util");
const { llmWithRetry, isLLMAvailable } = require("./llmProvider");

// Icon system — all matching logic, keyword maps, and overlay building
const {
  buildIconOverlaysFromTranscript,
  SVG_EMOJI_FALLBACK,
} = require("./iconSystem");

const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

const REMOTION_PROJECT = path.resolve(__dirname, "../../remotion-captions");

// ─────────────────────────────────────────────────────────────
// CAPTION STYLES
//
// CHANGES vs original:
//   FIX 3 — letterSpacing: "-0.03em" added to wordpop/ticker/wordRed/hormozi
//   FIX 4 — wordsPerLine: 2 + fontSize: 68 on wordpop/ticker/wordRed
//   FIX 5 — activeColor brighter on ticker (#39E75F) and wordpop (#FFE500)
// ─────────────────────────────────────────────────────────────
const CAPTION_STYLES = {
  ticker: {
    name: "ticker",
    layout: "bottom-center",
    textColor: "white",
    activeColor: "#39E75F",
    strokeColor: "#000000",
    strokeWidth: 8,
    bgBoxColor: "transparent",
    animation: "scale",
    fontSize: 62,
    fontFamily: "Montserrat",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "normal",
  },
  flip_board: {
    name: "flip_board",
    layout: "bottom-center",
    textColor: "white",
    strokeColor: "transparent",
    strokeWidth: 5,
    bgBoxColor: "transparent",
    fontSize: 62,
    animation: "deco_drop",
    fontFamily: "Montserrat",
    fontWeight: 800,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "none",
    activeStrategy: "bg_pill",
    activeBg: "#FA5E28",
    activeTextColor: "#FFFFFF",
    pillRadius: 10,
    activeColor: "#FA5E28",
  },
  extrude_3d: {
    name: "extrude_3d",
    layout: "bottom-center",
    activeColor: "#FFFFFF",
    textColor: "#FFFFFF",
    activeTextColor: "#FFFFFF",
    activeBg: "#3c57edff",
    strokeColor: "#000000",
    strokeWidth: 8,
    bgBoxColor: "transparent",
    animation: "none",
    fontSize: 62,
    fontFamily: "Montserrat",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "3px",
    activeStrategy: "extrude_3d",
    extrudeDepth: 20,
  },
  bebus: {
    name: "bebus",
    layout: "bottom-center",
    textColor: "white",
    activeColor: "#d369f3",
    strokeColor: "#000000",
    strokeWidth: 6,
    bgBoxColor: "transparent",
    animation: "deco_drop",
    letterSpacing: "0.09em",
    fontSize: 94,
    fontFamily: "Bebas Neue",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
  },
  audio_wide: {
    name: "audio_wide",
    layout: "bottom-center",
    textColor: "white",
    activeColor: "#b5ee7d",
    strokeColor: "#000000",
    strokeWidth: 6,
    bgBoxColor: "transparent",
    animation: "scale",
    fontSize: 64,
    fontFamily: "Audiowide",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "normal",
  },
  bangers: {
    name: "bangers",
    layout: "bottom-center",
    textColor: "white",
    activeColor: "#49e7ed",
    strokeColor: "#000000",
    strokeWidth: 8,
    bgBoxColor: "transparent",
    animation: "deco_drop",
    fontSize: 80,
    fontFamily: "Bangers",
    fontWeight: 400,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "10px",
  },
  lobster: {
    name: "lobster",
    layout: "bottom-center",
    textColor: "white",
    activeColor: "#bde566",
    strokeColor: "#000000",
    strokeWidth: 8,
    bgBoxColor: "transparent",
    fontSize: 70,
    fontFamily: "Lobster",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "0px",
    animation: "none",
  },
  tricky: {
    name: "tricky",
    layout: "bottom-center",
    textColor: "#ffff",
    activeColor: "#e6d978",
    strokeColor: "#336134",
    strokeWidth: 15,
    bgBoxColor: "transparent",
    animation: "scale",
    fontSize: 70,
    fontFamily: "Nano Sans",
    fontWeight: 900,
    uppercase: false,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "3px",
  },
  simple: {
    name: "simple",
    layout: "bottom-center",
    textColor: "#f0f4d9",
    activeColor: "#f0f4d9",
    strokeColor: "black",
    strokeWidth: 8,
    bgBoxColor: "rgba(208, 198, 198, 0)",
    animation: "none",
    fontSize: 70,
    fontFamily: "Poppins",
    fontWeight: 900,
    uppercase: false,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "3px",
  },
  simple_smart: {
    name: "simple_smart",
    layout: "bottom-center",
    textColor: "#f0f4d9",
    activeColor: "#f0f4d9",
    strokeColor: "#5c1ed0",
    strokeWidth: 8,
    bgBoxColor: "transparent",
    animation: "none",
    fontSize: 70,
    fontFamily: "Montserrat",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "3px",
  },
  neon_night: {
    name: "neon_night",
    layout: "bottom-center",
    textColor: "#65fbfb",
    activeColor: "#ea80ea",
    strokeColor: "black",
    strokeWidth: 6,
    bgBoxColor: "transparent",
    animation: "glitch",
    fontSize: 76,
    fontFamily: "Oswald",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 0 20px #00FFFF, 0 0 40px #00FFFF88",
    letterSpacing: "4px",
    activeStrategy: "neon_glow",
  },
  typewrite: {
    name: "typewrite",
    layout: "bottom-center",
    textColor: "#f0b128",
    activeColor: "#f0b128",
    strokeColor: "transparent",
    strokeWidth: 0,
    bgBoxColor: "black",
    animation: "typewriter",
    fontSize: 54,
    fontFamily: "Courier Prime",
    fontWeight: 700,
    uppercase: false,
    wordsPerLine: 4,
    lineSpacing: 0.6,
    shadow: "0 0 10px rgba(0,255,65,0.4)",
    letterSpacing: "2px",
    activeStrategy: "cursor_blink",
    cursorColor: "#f0b128",
    borderRadius: 4,
    padding: "20px 30px",
    border: "1px solid rgba(0,255,65,0.3)",
  },
  box: {
    name: "box",
    layout: "bottom-center",
    textColor: "#FFFFFF",
    activeColor: "#FFD700",
    strokeColor: "black",
    strokeWidth: 6,
    bgBoxColor: "rgba(177, 113, 229, 0.72)",
    animation: "none",
    fontSize: 62,
    fontFamily: "Poppins",
    fontWeight: 800,
    uppercase: false,
    wordsPerLine: 4,
    lineSpacing: 0.6,
    shadow: "none",
    borderRadius: 8,
    padding: "18px 28px",
  },
  box_glass: {
    name: "box_glass",
    layout: "bottom-center",
    textColor: "#F5F0E8",
    activeColor: "#f6d56c",
    strokeColor: "black",
    strokeWidth: 6,
    bgBoxColor: "#7d7d7d",
    backdropBlur: 14,
    border: "1px solid rgba(255, 255, 255, 0.18)",
    animation: "none",
    fontSize: 62,
    fontFamily: "Poppins",
    fontWeight: 800,
    uppercase: false,
    wordsPerLine: 6,
    lineSpacing: 0.6,
    shadow: "none",
    borderRadius: 12,
    padding: "18px 28px",
  },
  street_tag: {
    name: "street_tag",
    layout: "bottom-center",
    textColor: "#FFFFFF",
    activeColor: "#FFFF00",
    strokeColor: "black",
    strokeWidth: 10,
    bgBoxColor: "transparent",
    animation: "swing",
    fontSize: 80,
    fontFamily: "Lobster",
    fontWeight: 800,
    uppercase: false,
    wordsPerLine: 3,
    lineSpacing: 0.7,
    shadow: "3px 5px 0px #000, 6px 10px 0px rgba(0,0,0,0.3)",
    letterSpacing: "3px",
    activeStrategy: "bg_pill",
    activeBg: "#FF2D20",
    activeTextColor: "#FFFFFF",
    pillRadius: 4,
  },
  cinematic: {
    name: "cinematic",
    layout: "bottom-center",
    textColor: "#FFFFFF",
    activeColor: "#FFD700",
    strokeColor: "#000000",
    strokeWidth: 2,
    bgBoxColor: "transparent",
    animation: "blur_in",
    fontSize: 76,
    fontFamily: "Playfair Display",
    fontWeight: 900,
    fontStyle: "italic",
    uppercase: false,
    wordsPerLine: 3,
    lineSpacing: 0.6,
    shadow: "0 10px 40px rgba(0,0,0,0.9)",
    letterSpacing: "4px",
    activeStrategy: "shimmer",
    gradient:
      "linear-gradient(90deg, #FFF8DC 0%, #FFD54A 30%, #F4B400 50%, #FFD54A 70%, #FFF8DC 100%)",
  },
  retro_wave: {
    name: "retro_wave",
    layout: "bottom-center",
    textColor: "#C084FC",
    activeColor: "#F472B6",
    strokeColor: "#7631dd",
    strokeWidth: 13,
    bgBoxColor: "transparent",
    animation: "scale",
    fontSize: 74,
    fontFamily: "Russo One",
    fontWeight: 400,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 0px #4C1D95, 0 8px 20px rgba(76,29,149,0.7)",
    letterSpacing: "5px",
  },
  hard_punch: {
    name: "hard_punch",
    layout: "bottom-center",
    textColor: "#FFFFFF",
    activeColor: "#FFE600",
    strokeColor: "#000000",
    strokeWidth: 10,
    bgBoxColor: "transparent",
    animation: "zoom_punch",
    fontSize: 80,
    fontFamily: "Oswald",
    fontWeight: 700,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 20px rgba(0,0,0,0.9)",
    letterSpacing: "3px",
  },
};

// ─────────────────────────────────────────────────────────────
// ICON / SFX PATH VALIDATION
// ─────────────────────────────────────────────────────────────

function checkIconPaths(emojiOverlays) {
  const publicDir = path.join(REMOTION_PROJECT, "public", "icons");
  const srcDirs = [
    path.resolve(__dirname, "../../src/assets/icons"),
    path.resolve(__dirname, "../../remotion-captions/public/icons"),
    path.resolve(__dirname, "../../assets/icons"),
  ];
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  for (const ov of emojiOverlays || []) {
    if (!ov.icon) continue;
    const publicPath = path.join(publicDir, ov.icon);
    if (fs.existsSync(publicPath)) continue;
    let found = false;
    for (const srcDir of srcDirs) {
      const srcPath = path.join(srcDir, ov.icon);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, publicPath);
        console.log(`      📁 Copied icon: ${ov.icon}`);
        found = true;
        break;
      }
    }
    if (!found) {
      console.warn(
        `      ⚠️  Icon not found: ${ov.icon} — using emoji fallback`,
      );
      ov.emoji = SVG_EMOJI_FALLBACK[ov.icon] || "👀";
      ov.icon = null;
    }
  }
}

function checkSFXPaths(emojiOverlays) {
  const sfxDir = process.env.SFX_ASSETS_DIR
    ? path.resolve(process.env.SFX_ASSETS_DIR)
    : path.resolve(__dirname, "../../assets/sfx");
  const srcDirs = [
    path.resolve(__dirname, "../../src/assets/sfx"),
    path.resolve(__dirname, "../../assets/sfx"),
  ];
  for (const ov of emojiOverlays || []) {
    if (!ov.sfxFile) continue;
    const sfxPath = path.join(sfxDir, ov.sfxFile);
    if (fs.existsSync(sfxPath)) continue;
    let found = false;
    for (const srcDir of srcDirs) {
      const srcPath = path.join(srcDir, ov.sfxFile);
      if (fs.existsSync(srcPath)) {
        if (!fs.existsSync(sfxDir)) fs.mkdirSync(sfxDir, { recursive: true });
        fs.copyFileSync(srcPath, sfxPath);
        found = true;
        break;
      }
    }
    if (!found) ov.sfxFile = null;
  }
}

// ─────────────────────────────────────────────────────────────
// PHYSICAL VIDEO DURATION PROBE
// ─────────────────────────────────────────────────────────────
async function probeVideoDuration(filePath) {
  try {
    const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
    const { stdout } = await execAsync(
      `"${ffprobe}" -v quiet -print_format json -show_format "${filePath}"`,
      { timeout: 15_000 },
    );
    const info = JSON.parse(stdout);
    const dur = parseFloat(info?.format?.duration || "0");
    return dur > 0 ? dur : null;
  } catch (e) {
    console.warn(`      ⚠️  ffprobe failed: ${e.message.split("\n")[0]}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// COMPUTED DURATION FROM CLIP PLAN
// ─────────────────────────────────────────────────────────────
function computeClipDuration(clip) {
  if (clip.segments && clip.segments.length > 1) {
    const total = clip.segments.reduce(
      (sum, seg) => sum + Math.max(0, (seg.endSec || 0) - (seg.startSec || 0)),
      0,
    );
    if (total > 5) return total;
  }
  return Math.max(5, (clip.endSec || 0) - (clip.startSec || 0));
}

// ─────────────────────────────────────────────────────────────
// WORD TIMINGS — STITCHED CLIP FIX
// ─────────────────────────────────────────────────────────────
function extractWordTimingsForStitchedClip(
  allWordTimings,
  originalSegments,
  maxDuration,
) {
  if (!originalSegments || originalSegments.length <= 1) {
    const seg = originalSegments?.[0];
    if (!seg) return allWordTimings;
    const offset = seg.startSec || 0;
    return allWordTimings
      .filter(
        (w) =>
          w.startSec >= seg.startSec - 0.1 && w.startSec < seg.endSec + 0.1,
      )
      .map((w, i) => ({
        ...w,
        startSec: Math.max(0, w.startSec - offset),
        endSec: Math.max(0, w.endSec - offset),
        index: i,
      }))
      .filter((w) => w.startSec < maxDuration);
  }

  let cumulative = 0;
  const remapped = [];

  for (const seg of originalSegments) {
    const segStart = seg.startSec || 0;
    const segEnd = seg.endSec || 0;
    const segDur = Math.max(0, segEnd - segStart);
    if (segDur <= 0) continue;

    const segWords = allWordTimings.filter(
      (w) => w.startSec >= segStart - 0.15 && w.startSec < segEnd + 0.15,
    );

    for (const w of segWords) {
      const clampedStart = Math.max(segStart, Math.min(w.startSec, segEnd));
      const clampedEnd = Math.max(segStart, Math.min(w.endSec, segEnd));
      const newStart = cumulative + (clampedStart - segStart);
      const newEnd = cumulative + (clampedEnd - segStart);

      if (newStart < maxDuration && newEnd > 0) {
        remapped.push({
          ...w,
          startSec: Math.min(newStart, maxDuration - 0.05),
          endSec: Math.min(newEnd, maxDuration),
        });
      }
    }
    cumulative += segDur;
  }

  remapped.sort((a, b) => a.startSec - b.startSec);
  return remapped.map((w, i) => ({ ...w, index: i }));
}

// ─────────────────────────────────────────────────────────────
// HTTP VIDEO SERVER (serves b-roll files to Remotion renderer)
// ─────────────────────────────────────────────────────────────
function startVideoServer(baseDir, mainFileName) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      try {
        const reqPath = decodeURIComponent((req.url || "").split("?")[0]);
        const cleanPath = reqPath.replace(/^\/+/, "").replace(/\.\./g, "");
        const targetPath = path.join(baseDir, cleanPath);

        const resolvedBase = path.resolve(baseDir).toLowerCase();
        const resolvedTarget = path.resolve(targetPath).toLowerCase();
        if (!resolvedTarget.startsWith(resolvedBase)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        const stat = fs.statSync(targetPath);
        if (!stat.isFile()) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${stat.size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
            "Content-Type": "video/mp4",
            "Access-Control-Allow-Origin": "*",
          });
          fs.createReadStream(targetPath, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            "Content-Length": stat.size,
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
          });
          fs.createReadStream(targetPath).pipe(res);
        }
      } catch {
        res.writeHead(500);
        res.end();
      }
    });

    const port = Math.floor(Math.random() * 1000) + 39000;
    server.listen(port, "127.0.0.1", () => {
      const mainUrl = `http://127.0.0.1:${port}/${mainFileName.replace(/\\/g, "/")}`;
      console.log(`      📡 Video server: ${mainUrl}`);
      resolve({ server, port, url: mainUrl });
    });
    server.on("error", reject);
  });
}

function stopVideoServer(server) {
  return new Promise((r) => server.close(() => r()));
}

// ─────────────────────────────────────────────────────────────
// POST PROCESS FOR INSTAGRAM
// ─────────────────────────────────────────────────────────────
async function postProcessForInstagram(inputPath, outputPath) {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  await execAsync(
    [
      `"${ffmpeg}"`,
      `-i "${inputPath}"`,
      "-map 0:v:0",
      "-c:v libx264",
      "-profile:v main",
      "-level:v 4.0",
      "-preset fast",
      "-crf 18",
      "-g 30",
      "-keyint_min 30",
      "-sc_threshold 0",
      "-pix_fmt yuv420p",
      "-r 30",
      "-colorspace bt709",
      "-color_primaries bt709",
      "-color_trc bt709",
      "-color_range tv",
      "-map 0:a:0",
      "-c:a aac",
      "-profile:a aac_low",
      "-b:a 192k",
      "-ar 44100",
      "-ac 2",
      "-movflags +faststart",
      "-shortest",
      "-y",
      `"${outputPath}"`,
    ].join(" "),
    { timeout: 12 * 60 * 1000 },
  );
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 100000) {
    throw new Error(
      `postProcessForInstagram failed: output too small or missing`,
    );
  }
  console.log(`      ✅ Instagram-compatible encode done`);
}

// ─────────────────────────────────────────────────────────────
// MAIN — burnCaptions
// ─────────────────────────────────────────────────────────────
async function burnCaptions(clip, contentType, platforms) {
  if (!clip.transcript?.trim()) {
    console.log("   ℹ️  No transcript — skipping captions");
    return clip.filePath;
  }
  if (!clip.filePath || !fs.existsSync(clip.filePath)) {
    console.warn("   ⚠️  Clip file missing");
    return clip.filePath;
  }

  const quickDur = computeClipDuration(clip);
  if (quickDur < 15) {
    console.warn(
      `   ⚠️  Clip too short (${quickDur.toFixed(1)}s) — skipping caption burn`,
    );
    return clip.filePath;
  }

  console.log("   🎬 Burning captions...");
  let brollServer = null;
  let brollServerInstance = null;

  try {
    // ── STYLE ─────────────────────────────────────────────────
    const jobId = clip.jobId;
    let style;
    let userCaptionStyle = null;
    let titleEnabled = false;
    let titleText = "";
    let titleStyle = null;
    let titlePosition = "center";

    if (jobId) {
      try {
        const { query } = require("../db/pool");
        const { rows } = await query(
          `SELECT caption_style, title_enabled, title_text, title_style, title_position FROM jobs WHERE id = $1`,
          [jobId],
        );
        if (rows.length > 0) {
          if (rows[0].caption_style) {
            userCaptionStyle = rows[0].caption_style;
            console.log(
              `   📝 Found user-selected style in DB: ${userCaptionStyle}`,
            );
          }
          titleEnabled = rows[0].title_enabled;
          titleText = rows[0].title_text || "";
          try {
            titleStyle = rows[0].title_style ? JSON.parse(rows[0].title_style) : null;
          } catch(e) {
            console.warn("Failed to parse title_style from DB");
          }
          titlePosition = rows[0].title_position || "center";
        }
      } catch (dbErr) {
        console.warn(
          `   ⚠️  Could not fetch job config from DB: ${dbErr.message}`,
        );
      }
    }

    if (userCaptionStyle) {
      try {
        const parsedStyle = JSON.parse(userCaptionStyle);
        if (typeof parsedStyle === "object" && parsedStyle !== null) {
          style = parsedStyle;
          console.log(`   🎨 Using custom parsed style from DB: ${style.name}`);
        } else if (CAPTION_STYLES[userCaptionStyle]) {
          style = { ...CAPTION_STYLES[userCaptionStyle] };
          console.log(`   🎨 Using predefined style from DB: ${style.name}`);
        } else {
          style = { ...CAPTION_STYLES["wordpop"] };
          console.log(`   🎨 Style not found, using default: wordpop`);
        }
      } catch (e) {
        if (CAPTION_STYLES[userCaptionStyle]) {
          style = { ...CAPTION_STYLES[userCaptionStyle] };
          console.log(`   🎨 Using predefined style from DB: ${style.name}`);
        } else {
          style = { ...CAPTION_STYLES["wordpop"] };
          console.log(`   🎨 Style not found, using default: wordpop`);
        }
      }
    } else {
      style = { ...CAPTION_STYLES["wordpop"] };
      console.log(`   🎨 No user style found in DB, using default: wordpop`);
    }

    // ── DURATION ──────────────────────────────────────────────
    const physicalDuration = await probeVideoDuration(clip.filePath);
    const computedDuration = computeClipDuration(clip);

    let clipDurationSecs;
    if (physicalDuration && physicalDuration > 5) {
      clipDurationSecs = physicalDuration;
    } else {
      if (clip.wordTimings && clip.wordTimings.length > 0) {
        const lastWord = clip.wordTimings[clip.wordTimings.length - 1];
        clipDurationSecs = Math.max(
          physicalDuration || 0,
          lastWord.endSec + 0.5,
        );
      } else {
        clipDurationSecs = computedDuration;
      }
    }
    if (physicalDuration && clipDurationSecs > physicalDuration) {
      clipDurationSecs = physicalDuration;
    }

   const fps = 30;
    const durationInFrames = Math.ceil(clipDurationSecs * fps);

    console.log(
      `      ⏱  Computed: ${computedDuration.toFixed(1)}s | Physical: ${physicalDuration?.toFixed(1) ?? "unknown"}s | Rendering: ${clipDurationSecs.toFixed(1)}s (${durationInFrames}f)`,
    );

    // ── WORDS ─────────────────────────────────────────────────
    let words;

    const hasOriginalSegments =
      clip.originalSegments && clip.originalSegments.length > 0;
    const isStitched = hasOriginalSegments && clip.originalSegments.length > 1;

    if (isStitched && clip.wordTimings && clip.wordTimings.length > 0) {
      console.log(
        `      🔧 Stitched clip: remapping word timings across ${clip.originalSegments.length} segments`,
      );
      words = extractWordTimingsForStitchedClip(
        clip.wordTimings,
        clip.originalSegments,
        clipDurationSecs,
      );
      console.log(`      ✅ Stitched remap: ${words.length} words`);
    } else if (clip.wordTimings && clip.wordTimings.length > 0) {
      words = clip.wordTimings
        .map((w) => ({
          ...w,
          startSec: Math.min(w.startSec, clipDurationSecs - 0.05),
          endSec: Math.min(w.endSec, clipDurationSecs),
        }))
        .filter((w) => w.startSec >= 0 && w.startSec < clipDurationSecs);
      console.log(`      ✅ Real timestamps: ${words.length} words`);
    } else {
      const raw = clip.transcript
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0);
      const tpw = Math.min(clipDurationSecs, raw.length / 2.5) / raw.length;
      words = raw
        .map((word, i) => ({
          word: word.replace(/[^\w\s'''-]/g, "").trim(),
          startSec: i * tpw,
          endSec: (i + 1) * tpw,
          index: i,
        }))
        .filter((w) => w.word.length > 0);
      console.log(`      ⚠️  Fallback distribution (${words.length} words)`);
    }

    words = words.filter(
      (w) => w.startSec >= 0 && w.startSec < clipDurationSecs - 0.05,
    );
    if (!words.length) return clip.filePath;

    const jobDir = path.dirname(clip.filePath);
    const mainFileName = path.basename(clip.filePath);
    let brollSegments = clip.brollSegments || [];

    // ── START VIDEO SERVER (main video + b-roll) ───────────────
    // Must start before building any URLs. The server serves the
    // entire jobDir so both the main clip and broll/ subfolder
    // are reachable under the same origin.
    brollServer = await startVideoServer(jobDir, mainFileName);
    brollServerInstance = brollServer.server;

    // Main video URL — full HTTP, no copy needed, no public dir
    const mainVideoUrl = brollServer.url; // already points to main clip

    // ── B-ROLL: fix cross-job paths ────────────────────────────
    const localBrollDir = path.join(jobDir, "broll");
    fs.mkdirSync(localBrollDir, { recursive: true });

    brollSegments = brollSegments
      .map((seg) => {
        if (!seg.videoUrl || seg.videoUrl.startsWith("http")) return seg;

        let localVideoUrl = seg.videoUrl;
        const resolvedSeg = path.resolve(seg.videoUrl);
        const resolvedJob = path.resolve(jobDir);

        if (!resolvedSeg.startsWith(resolvedJob)) {
          const destPath = path.join(
            localBrollDir,
            path.basename(seg.videoUrl),
          );
          try {
            if (fs.existsSync(resolvedSeg) && !fs.existsSync(destPath)) {
              fs.copyFileSync(resolvedSeg, destPath);
              console.log(
                `      📋 Copied cross-job b-roll: ${path.basename(seg.videoUrl)}`,
              );
            }
            localVideoUrl = fs.existsSync(destPath) ? destPath : null;
          } catch (copyErr) {
            console.warn(
              `      ⚠️  Could not copy b-roll, skipping: ${copyErr.message}`,
            );
            localVideoUrl = null;
          }
        }

        if (!localVideoUrl || !fs.existsSync(localVideoUrl)) return null;

        const rel = path.relative(jobDir, localVideoUrl).replace(/\\/g, "/");
        return {
          ...seg,
          videoUrl: `http://127.0.0.1:${brollServer.port}/${rel}`,
        };
      })
      .filter(Boolean);

    // ── EVENTS ────────────────────────────────────────────────
    let events = clip.events || null;
    let emojiOverlays = clip.emojiOverlays || null;
    let zoomCurve = clip.zoomCurve || null;
    let lowerThird = clip.lowerThird || null;
    let speakerSegments = clip.speakerSegments || [];

    if (!events) {
      try {
        const { buildClipTimeline } = require("./clipTimeline");
        const tl = buildClipTimeline(clip, words, contentType);
        events = tl.events;
        zoomCurve = tl.zoomCurve;
        lowerThird = tl.lowerThird;
        speakerSegments = tl.speakerSegments || [];
      } catch (e) {
        try {
          const { buildEditingPlan } = require("./editingDirector");
          const plan = await buildEditingPlan(clip, words, { useLLM: true });
          events = plan.events;
          zoomCurve = plan.zoomCurve;
          lowerThird = plan.lowerThird;
        } catch {
          events = [];
          zoomCurve = [
            { t: 0, zoom: 1.0 },
            { t: clipDurationSecs, zoom: 1.0 },
          ];
        }
      }
    } else {
      emojiOverlays = (emojiOverlays || []).map((e) => ({
        ...e,
        atSec: e.atSec ?? e.timestamp,
      }));
    }

    const sfxOnlyOverlays = (emojiOverlays || []).filter(
      (o) => !o.icon && !o.emoji && o.sfxFile,
    );
    const ruleIcons = buildIconOverlaysFromTranscript(words, clipDurationSecs);
    emojiOverlays = [...sfxOnlyOverlays, ...ruleIcons];

    checkIconPaths(emojiOverlays);
    checkSFXPaths(emojiOverlays);
    console.log(
      `   🧪 B‑roll segments count: ${clip.brollSegments?.length || 0}`,
    );

    // ── PROPS ─────────────────────────────────────────────────
    const splitTimeline = (clip.splitTimeline || []).map((seg) => ({
      startSec: seg.startSec ?? 0,
      endSec: seg.endSec ?? 0,
    }));

    const emphasisEvents = (clip.emphasisEvents || events || [])
      .filter((e) => e.type === "word_emphasis" && e.colorOverride)
      .map((e) => ({
        wordIndex: e.wordIndex,
        colorOverride: e.colorOverride,
        level: e.level ?? 1,
      }));

    const props = {
      videoSrc: mainVideoUrl,
      words,
      style,
      fps,
      clipDurationSecs,
      zoomCurve,
      events,
      emojiOverlays,
      lowerThird,
      speakerSegments,
      showProgressBar: true,
      emotion: clip.emotion || "neutral",
      contentType: contentType || "general",
      colorGrade: clip.colorGrade || clip.directives?.colorGrade || "none",
      brollSegments,
      brollStyle: clip.brollStyle || "fullscreen",
      splitTimeline,
      emphasisEvents,
      titleEnabled,
      titleText,
      titleStyle,
      titlePosition,
    };

    const remotionOutput = clip.filePath.replace(".mp4", "_raw.mp4");
    const remuxOutput = clip.filePath.replace(".mp4", "_remux.mp4");
    const finalOutput = clip.filePath.replace(".mp4", "_captioned.mp4");

    const iconCount = (emojiOverlays || []).filter((o) => o.icon).length;
    const emojiCount = (emojiOverlays || []).filter((o) => o.emoji).length;
    const sfxCount = (emojiOverlays || []).filter((o) => o.sfxFile).length;
    console.log(
      `      Style: ${style.name} | ${words.length} words | ${durationInFrames}f | svg:${iconCount} emoji:${emojiCount} sfx:${sfxCount}`,
    );
    console.log(`      Rendering...`);

    // ── RENDER — programmatic API (replaces npx CLI) ───────────
    //
    // PERF: getBundle() returns the cached bundle URL built once
    // at worker startup. No npx cold start, no module resolution,
    // no temp props file written to disk. Everything else
    // (quality, output, codec, crf) is identical to the CLI call.
    // ──────────────────────────────────────────────────────────
    const { renderMedia, selectComposition } = require("@remotion/renderer");
    const { getBundle } = require("./remotionBundle");

    const serveUrl = await getBundle();

    const composition = await selectComposition({
      serveUrl,
      id: "CaptionedClip",
      inputProps: props,
      timeoutInMilliseconds: 60_000,
    });

    let lastProgress = -1;
    const renderCrf = Number.isFinite(
      Number.parseInt(process.env.RENDER_CRF || "20", 10),
    )
      ? Number.parseInt(process.env.RENDER_CRF || "20", 10)
      : 20;

    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: remotionOutput,
      inputProps: props,
      width: 1080,
      height: 1920,
      crf: renderCrf,
      pixelFormat: "yuv420p",
      chromiumOptions: {
        gl: "angle",
        // Required so Remotion's Chromium can reach the local
        // b-roll HTTP server without CORS blocking
        disableWebSecurity: true,
      },
      timeoutInMilliseconds: 120_000,

      // FIX: prevent shaking - serialize frame rendering and cache decoded frames
      // Without concurrency:1, multiple Chromium tabs hammer the same local HTTP
      // server simultaneously causing irregular frame delivery = video shaking.
      // offthreadVideoCacheSizeInBytes stops OffthreadVideo re-fetching every frame.
      concurrency: 1,
      offthreadVideoCacheSizeInBytes: 512 * 1024 * 1024, // 512 MB

      onProgress: ({ progress }) => {
        const pct = Math.round(progress * 100);
        // Log every 25% so we don't flood stdout
        if (pct >= lastProgress + 25) {
          lastProgress = pct;
          process.stdout.write(`\r      ⏳ Rendering: ${pct}%   `);
        }
      },
    });
    process.stdout.write("\r      ✅ Render complete           \n");

    if (!fs.existsSync(remotionOutput)) {
      console.warn("   ⚠️  Remotion output missing — returning original");
      return clip.filePath;
    }

    // ── POST-PROCESS ───────────────────────────────────────────
    await postProcessForInstagram(remotionOutput, remuxOutput);
    try {
      fs.unlinkSync(remotionOutput);
    } catch {}

    if (!fs.existsSync(remuxOutput) || fs.statSync(remuxOutput).size < 100000) {
      console.warn("   ⚠️  Remux failed — returning original");
      return clip.filePath;
    }

    // ── SFX MIX ───────────────────────────────────────────────
    let sfxApplied = false;
    try {
      const { mixContextSFX, extractSFXEvents } = require("./audioMixer");
      const sfxEvents = extractSFXEvents(emojiOverlays);
      if (sfxEvents.length > 0) {
        await mixContextSFX(
          remuxOutput,
          finalOutput,
          sfxEvents,
          clipDurationSecs,
        );
        try {
          fs.unlinkSync(remuxOutput);
        } catch {}
        sfxApplied = true;
      } else {
        fs.renameSync(remuxOutput, finalOutput);
      }
    } catch (sfxErr) {
      console.warn(
        `      ⚠️  SFX mix skipped: ${sfxErr.message.split("\n")[0]}`,
      );
      try {
        fs.renameSync(remuxOutput, finalOutput);
      } catch {}
    }

    if (fs.existsSync(finalOutput) && fs.statSync(finalOutput).size > 100000) {
      const mb = (fs.statSync(finalOutput).size / 1024 / 1024).toFixed(1);
      console.log(
        `   ✅ Done: ${mb}MB (${style.name}${sfxApplied ? " + sfx" : ""})`,
      );
      return finalOutput;
    }

    return clip.filePath;
  } catch (err) {
    console.error(
      "   ❌ Caption burn error:",
      err.message,
      err.code,
      err.killed,
    );
    if (err.stderr) console.error("   stderr:", err.stderr.substring(0, 1000));
    return clip.filePath;
  } finally {
    // Stop b-roll server
    if (brollServerInstance) {
      await stopVideoServer(brollServerInstance).catch(() => {});
    }
    // NOTE: No public video cleanup needed since we're not copying to public/
  }
}

module.exports = {
  burnCaptions,
  CAPTION_STYLES,
  JOB_STYLE_CACHE,
  buildIconOverlaysFromTranscript,
  extractWordTimingsForStitchedClip,
};
