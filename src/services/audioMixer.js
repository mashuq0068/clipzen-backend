/* eslint-disable no-undef */
/**
 * audioMixer.js
 *
 * Context-aware SFX mixer — NOT background music.
 *
 * Philosophy:
 * - No long background loops. Only short contextual SFX (1.5-3s)
 * - Each SFX fires when its matching icon appears on screen
 * - money icon → "cha-ching" for 2s
 * - clock icon → ticking for 2s
 * - trophy icon → victory fanfare for 2s
 * - alert icon → warning sound for 1.5s
 *
 * SFX assets: process.env.SFX_ASSETS_DIR || ./assets/sfx/
 * Icon assets: process.env.ICONS_ASSETS_DIR || ./src/assets/icons/
 * SFX files: money.mp3, clock.mp3, alert.mp3, win.mp3, idea.mp3, sword.mp3
 *
 * Speech dominates — SFX at -18dB (subtle, never distracting)
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const util = require("util");

const execFileAsync = util.promisify(execFile);

const SFX_DIR = process.env.SFX_ASSETS_DIR
  ? path.resolve(process.env.SFX_ASSETS_DIR)
  : path.resolve(__dirname, "../../assets/sfx");

function getFFmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

const SFX_VOLUME_DB = -18; // subtle — never competes with speech

/**
 * Mix SFX events into a clip.
 * Each event fires at atSec and plays for durationSecs.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Array}  sfxEvents - [{ file, atSec, durationSecs }]
 * @param {number} clipDurationSecs
 */
async function mixContextSFX(
  inputPath,
  outputPath,
  sfxEvents,
  clipDurationSecs,
) {
  const validEvents = (sfxEvents || []).filter((e) => {
    if (!e.file) return false;
    return fs.existsSync(path.join(SFX_DIR, e.file));
  });

  if (validEvents.length === 0) {
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  const ffmpeg = getFFmpegPath();
  const linearVol = Math.pow(10, SFX_VOLUME_DB / 20).toFixed(4);

  try {
    const inputs = ["-i", inputPath];
    for (const e of validEvents) {
      inputs.push("-i", path.join(SFX_DIR, e.file));
    }

    // Each SFX: trim to duration, set volume, delay to firing time
    const sfxFilters = validEvents.map((e, i) => {
      const dur = Math.min(
        e.durationSecs || 2.0,
        Math.max(0.5, clipDurationSecs - e.atSec),
      );
      const delaySamples = Math.round(e.atSec * 44100);
      return `[${i + 1}:a]atrim=0:${dur.toFixed(3)},volume=${linearVol},adelay=${delaySamples}|${delaySamples}[sfx${i}]`;
    });

    const sfxLabels = validEvents.map((_, i) => `[sfx${i}]`).join("");
    const amix = `[0:a]${sfxLabels}amix=inputs=${validEvents.length + 1}:duration=first:dropout_transition=0.3[outa]`;
    const filterComplex = [...sfxFilters, amix].join(";");

    await execFileAsync(
      ffmpeg,
      [
        ...inputs,
        "-filter_complex",
        filterComplex,
        "-map",
        "0:v",
        "-map",
        "[outa]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "44100",
        "-t",
        clipDurationSecs.toString(),
        "-movflags",
        "+faststart",
        "-y",
        outputPath,
      ],
      { timeout: 3 * 60 * 1000 },
    );

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100000) {
      console.log(`      🔊 SFX: ${validEvents.map((e) => e.file).join(", ")}`);
      return outputPath;
    }
    throw new Error("Output too small after SFX mix");
  } catch (err) {
    console.warn(`      ⚠️  SFX mix failed: ${err.message.split("\n")[0]}`);
    if (!fs.existsSync(outputPath)) fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
}

/**
 * Build SFX events from icon overlays.
 * iconOverlays come from clipTimeline.buildIconOverlays()
 */
function extractSFXEvents(iconOverlays) {
  return (iconOverlays || [])
    .filter((ov) => ov.sfxFile)
    .map((ov) => ({
      file: ov.sfxFile,
      atSec: ov.atSec,
      durationSecs: ov.sfxDuration || 2.0,
    }));
}

function listAvailableSFX() {
  const files = [
    "money.mp3",
    "clock.mp3",
    "alert.mp3",
    "win.mp3",
    "idea.mp3",
    "sword.mp3",
  ];
  if (!fs.existsSync(SFX_DIR)) {
    console.log(`   🔊 SFX dir missing: ${SFX_DIR}`);
    console.log(`   🔊 Create it and add: ${files.join(", ")}`);
    return;
  }
  files.forEach((f) => {
    const ok = fs.existsSync(path.join(SFX_DIR, f));
    console.log(`   🔊 ${ok ? "✅" : "❌"} ${f}`);
  });
}

// Legacy compat — old code that calls mixAudio() won't crash
async function mixAudio(inputPath, audioMood, durationSecs, outputPath) {
  fs.copyFileSync(inputPath, outputPath);
  return outputPath;
}

module.exports = {
  mixContextSFX,
  extractSFXEvents,
  listAvailableSFX,
  mixAudio,
  SFX_DIR,
};
