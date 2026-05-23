/* eslint-disable no-empty */
/* eslint-disable preserve-caught-error */
/* eslint-disable no-undef */
const { execFile, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const util = require("util");

const execFileAsync = util.promisify(execFile);
const execAsync = util.promisify(exec);
const PYTHON = process.env.PYTHON_PATH || "python3";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";
const WHISPER_THREADS = Math.max(
  1,
  Number.isFinite(Number.parseInt(process.env.WHISPER_THREADS || "4", 10))
    ? Number.parseInt(process.env.WHISPER_THREADS || "4", 10)
    : 4,
);

function getFFmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  return "ffmpeg";
}

/**
 * Extract audio from video and transcribe with Whisper.
 * Returns: Array of { start, end, text, words } segments.
 * words = [{ word, start, end }] — actual word-level timestamps.
 */
async function transcribeVideo(videoPath) {
  const ffmpeg = getFFmpegPath();
  const audioPath = videoPath.replace(/\.[^.]+$/, ".mp3");
  const outputDir = path.dirname(audioPath);

  try {
    // ── Step 1: Extract audio ────────────────────────────────
    console.log("🔊 Extracting audio...");
    await execFileAsync(ffmpeg, [
      "-i", videoPath,
      "-q:a", "0",
      "-map", "a",
      "-y",
      audioPath,
    ]);
    console.log(`✅ Audio extracted`);

    // ── Step 2: Run Whisper with word timestamps ──────────────
    // --word_timestamps True gives us per-word timing — critical
    // for caption sync. Without this we only get segment-level timing.
    console.log(`🎙️  Transcribing with Whisper (model=${WHISPER_MODEL}, threads=${WHISPER_THREADS})...`);

    const whisperCmd = `${PYTHON} -m whisper "${audioPath}" --model ${WHISPER_MODEL} --output_format json --output_dir "${outputDir}" --word_timestamps True --threads ${WHISPER_THREADS} --verbose False`;

    await execAsync(whisperCmd, {
      timeout: 30 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });

    // ── Step 3: Read JSON output ──────────────────────────────
    const audioBaseName = path.basename(audioPath, ".mp3");
    const jsonPath = path.join(outputDir, `${audioBaseName}.json`);
    const finalJsonPath = fs.existsSync(jsonPath)
      ? jsonPath
      : audioPath.replace(".mp3", ".json");

    if (!fs.existsSync(finalJsonPath)) {
      throw new Error(`Whisper JSON not found at: ${finalJsonPath}`);
    }

    const raw = JSON.parse(fs.readFileSync(finalJsonPath, "utf8"));

    // ── Step 4: Extract segments WITH word-level timestamps ───
    const segments = (raw.segments || [])
      .filter((seg) => seg.text && seg.text.trim().length > 0)
      .map((seg) => {
        // Extract word-level timestamps if available
        const words = (seg.words || []).map((w) => ({
          word: (w.word || "").trim(),
          start: parseFloat(w.start),
          end: parseFloat(w.end),
        })).filter((w) => w.word.length > 0);

        return {
          start: parseFloat(seg.start),
          end: parseFloat(seg.end),
          text: seg.text.trim(),
          words, // ← word-level timestamps array
        };
      });

    if (segments.length === 0) {
      throw new Error("Whisper returned no segments");
    }

    // Count how many words have precise timestamps
    const totalWords = segments.reduce((sum, s) => sum + s.words.length, 0);
    console.log(`✅ Transcribed ${segments.length} segments, ${totalWords} words with timestamps`);

    // ── Step 5: Cleanup ───────────────────────────────────────
    [audioPath, finalJsonPath].forEach((f) => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });

    return segments;

  } catch (err) {
    console.error("Transcription error:", err.message);
    try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch {}
    throw new Error(`Transcription failed: ${err.message}`);
  }
}

function segmentsToText(segments) {
  return segments.map((s) => s.text).join(" ");
}

/**
 * Extract word-level timings for a specific clip time range.
 * Uses actual Whisper word timestamps — perfectly synced.
 * Falls back to even distribution only if word timestamps unavailable.
 *
 * TIMING FIX:
 * - Removed the +1s tolerance on w.end that was letting next-sentence words
 *   bleed into the current clip, causing captions to appear ~1s early.
 * - Words must START within [clipStartSec, clipEndSec] with no slack.
 * - Each word's endSec is strictly clamped to min(w.end, clipEndSec).
 * - Zero-duration words (startSec === endSec after clamping) are dropped.
 * - Inter-word gap repair: if a word's startSec < previous endSec (overlap),
 *   its startSec is nudged forward so captions never go backward in time.
 */
function extractWordTimingsForClip(segments, clipStartSec, clipEndSec) {
  const clipDuration = clipEndSec - clipStartSec;
  const wordTimings = [];

  // First try: use actual Whisper word-level timestamps
  for (const seg of segments) {
    // Only process segments that overlap with this clip
    if (seg.end < clipStartSec || seg.start > clipEndSec) continue;

    if (seg.words && seg.words.length > 0) {
      for (const w of seg.words) {
        // STRICT: word must START inside the clip window — no +1s slack
        if (w.start < clipStartSec || w.start >= clipEndSec) continue;

        const relStart = w.start - clipStartSec;
        // END is clamped to clip boundary — never beyond it
        const relEnd = Math.min(w.end - clipStartSec, clipDuration);

        // Drop zero/negative duration words (can happen at segment boundaries)
        if (relEnd <= relStart) continue;

        wordTimings.push({
          word: w.word.replace(/[^\w\s'''-]/g, "").trim(),
          startSec: relStart,
          endSec: relEnd,
        });
      }
    } else {
      // No word timestamps for this segment — distribute evenly within segment
      const segText = seg.text.trim();
      const words = segText.split(/\s+/).filter((w) => w.length > 0);
      if (words.length === 0) continue;

      // Clamp segment bounds to clip window
      const segStart = Math.max(seg.start, clipStartSec) - clipStartSec;
      const segEnd = Math.min(seg.end, clipEndSec) - clipStartSec;
      if (segEnd <= segStart) continue;

      const timePerWord = (segEnd - segStart) / words.length;

      words.forEach((word, i) => {
        wordTimings.push({
          word: word.replace(/[^\w\s'''-]/g, "").trim(),
          startSec: segStart + i * timePerWord,
          endSec: segStart + (i + 1) * timePerWord,
        });
      });
    }
  }

  // Sort by start time, drop empties
  const sorted = wordTimings
    .filter((w) => w.word.length > 0)
    .sort((a, b) => a.startSec - b.startSec);

  // Repair overlaps: each word's startSec must be >= previous word's endSec
  // This prevents captions from jumping backward (which causes the "missing words" look)
  let prevEnd = 0;
  const repaired = [];
  for (const w of sorted) {
    const start = Math.max(w.startSec, prevEnd);
    // After nudging, ensure the word still has positive duration
    if (w.endSec <= start) continue;
    repaired.push({ ...w, startSec: start });
    prevEnd = w.endSec;
  }

  return repaired.map((w, i) => ({ ...w, index: i }));
}

module.exports = { transcribeVideo, segmentsToText, extractWordTimingsForClip };