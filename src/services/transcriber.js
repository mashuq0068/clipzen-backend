/* eslint-disable no-empty */
/* eslint-disable preserve-caught-error */
/* eslint-disable no-undef */
const { execFile, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const util = require("util");
const axios = require("axios");
const FormData = require("form-data");

const execFileAsync = util.promisify(execFile);
const execAsync = util.promisify(exec);

// ── Speechmatics config ─────────────────────────────────────────────
// Batch API. Docs: https://docs.speechmatics.com/speech-to-text/batch
const SM_API_KEY = process.env.SPEECHMATICS_API_KEY;
const SM_BASE_URL = (process.env.SPEECHMATICS_API_URL || "https://asr.api.speechmatics.com/v2").replace(/\/+$/, "");
// "enhanced" = highest accuracy, "standard" = faster/cheaper.
const SM_OPERATING_POINT = process.env.SPEECHMATICS_OPERATING_POINT || "enhanced";
// How long to wait for a batch job to finish before giving up.
const SM_POLL_TIMEOUT_MS = Number.parseInt(process.env.SPEECHMATICS_POLL_TIMEOUT_MS || `${30 * 60 * 1000}`, 10);
const SM_POLL_INTERVAL_MS = Number.parseInt(process.env.SPEECHMATICS_POLL_INTERVAL_MS || "4000", 10);
// Split a segment when the gap between two consecutive words exceeds this.
// Acts as a fallback sentence boundary for languages/audio with little punctuation.
const MAX_SEGMENT_GAP_SEC = Number.parseFloat(process.env.SPEECHMATICS_MAX_GAP_SEC || "1.5");

// ── Engine toggle ───────────────────────────────────────────────────
// IS_WHISPER=true  → force the local Whisper setup (previous setup).
// Otherwise        → Speechmatics (current default), with Whisper as a
//                    fallback only when no Speechmatics key is present.
const USE_WHISPER =
  String(process.env.IS_WHISPER || "").toLowerCase().trim() === "true";

// ── Whisper config (forced engine or fallback) ──────────────────────
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
 * Extract audio from video and transcribe.
 *
 * Primary engine: Speechmatics Batch API (55+ languages, word-level timing).
 * Fallback engine: local Whisper (only when SPEECHMATICS_API_KEY is unset).
 *
 * @param {string} videoPath  Path to the source video/audio file.
 * @param {string} [language] Speechmatics language code (e.g. "en", "es", "hi").
 *                            Use "auto" for automatic language identification.
 *                            Defaults to "en".
 * Returns: Array of { start, end, text, words } segments.
 * words = [{ word, start, end }] — actual word-level timestamps.
 */
async function transcribeVideo(videoPath, language = "en") {
  const ffmpeg = getFFmpegPath();
  const audioPath = videoPath.replace(/\.[^.]+$/, ".mp3");
  const outputDir = path.dirname(audioPath);
  const lang = (language || "en").toString().trim() || "en";

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

    // ── Step 2: Transcribe ────────────────────────────────────
    let segments;
    if (USE_WHISPER) {
      console.log("🎙️  IS_WHISPER=true → using local Whisper");
      segments = await transcribeWithWhisper(audioPath, outputDir);
    } else if (SM_API_KEY) {
      segments = await transcribeWithSpeechmatics(audioPath, lang);
    } else {
      console.warn("⚠️  SPEECHMATICS_API_KEY not set — falling back to local Whisper");
      segments = await transcribeWithWhisper(audioPath, outputDir);
    }

    if (!segments || segments.length === 0) {
      throw new Error("Transcription returned no segments");
    }

    const totalWords = segments.reduce((sum, s) => sum + s.words.length, 0);
    console.log(`✅ Transcribed ${segments.length} segments, ${totalWords} words with timestamps`);

    // ── Step 3: Cleanup ───────────────────────────────────────
    try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch {}

    return segments;

  } catch (err) {
    console.error("Transcription error:", err.message);
    try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch {}
    throw new Error(`Transcription failed: ${err.message}`);
  }
}

/**
 * Transcribe an audio file with the Speechmatics Batch API.
 * Submits the job, polls until done, fetches the json-v2 transcript and
 * converts it into the segment/word shape the rest of the app expects.
 */
async function transcribeWithSpeechmatics(audioPath, language) {
  console.log(`🎙️  Transcribing with Speechmatics (language=${language}, operating_point=${SM_OPERATING_POINT})...`);

  const transcription_config = {
    language,
    operating_point: SM_OPERATING_POINT,
  };
  // "auto" enables Speechmatics language identification.
  if (language === "auto") {
    transcription_config.language = "auto";
  }

  const config = { type: "transcription", transcription_config };

  const authHeader = { Authorization: `Bearer ${SM_API_KEY}` };

  // ── Submit job ────────────────────────────────────────────
  const form = new FormData();
  form.append("data_file", fs.createReadStream(audioPath));
  form.append("config", JSON.stringify(config));

  let jobId;
  try {
    const submitRes = await axios.post(`${SM_BASE_URL}/jobs/`, form, {
      headers: { ...form.getHeaders(), ...authHeader },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 5 * 60 * 1000,
    });
    jobId = submitRes.data && submitRes.data.id;
  } catch (err) {
    throw new Error(`Speechmatics job submission failed: ${describeAxiosError(err)}`);
  }

  if (!jobId) throw new Error("Speechmatics did not return a job id");
  console.log(`   📨 Speechmatics job submitted: ${jobId}`);

  // ── Poll for completion ───────────────────────────────────
  const deadline = Date.now() + SM_POLL_TIMEOUT_MS;
  let status = "running";
  while (Date.now() < deadline) {
    await sleep(SM_POLL_INTERVAL_MS);
    let job;
    try {
      const statusRes = await axios.get(`${SM_BASE_URL}/jobs/${jobId}`, {
        headers: authHeader,
        timeout: 30 * 1000,
      });
      job = statusRes.data && statusRes.data.job;
    } catch (err) {
      // Transient errors during polling shouldn't kill the job — retry until deadline.
      console.warn(`   ⚠️  Poll error (will retry): ${describeAxiosError(err)}`);
      continue;
    }

    status = job && job.status;
    if (status === "done") break;
    if (status === "rejected") {
      const errs = (job && job.errors) ? JSON.stringify(job.errors) : "no detail";
      throw new Error(`Speechmatics rejected the job: ${errs}`);
    }
    // status === "running" → keep polling
  }

  if (status !== "done") {
    throw new Error(`Speechmatics job ${jobId} did not finish in time (last status: ${status})`);
  }

  // ── Fetch transcript (json-v2) ────────────────────────────
  let transcript;
  try {
    const trRes = await axios.get(
      `${SM_BASE_URL}/jobs/${jobId}/transcript?format=json-v2`,
      { headers: authHeader, timeout: 60 * 1000 },
    );
    transcript = trRes.data;
  } catch (err) {
    throw new Error(`Speechmatics transcript fetch failed: ${describeAxiosError(err)}`);
  }

  return convertSpeechmaticsToSegments(transcript);
}

/**
 * Convert a Speechmatics json-v2 transcript into the app's segment shape:
 *   [{ start, end, text, words: [{ word, start, end }] }]
 *
 * Speechmatics returns a flat `results` array of word/punctuation/entity items
 * with per-item timing. We group consecutive words into sentence-like segments,
 * splitting on end-of-sentence punctuation (is_eos) and on long silences.
 */
function convertSpeechmaticsToSegments(transcript) {
  const results = Array.isArray(transcript && transcript.results) ? transcript.results : [];
  const segments = [];

  let curWords = [];
  let curText = "";
  let curStart = null;
  let curEnd = null;
  let lastWordEnd = null;

  const closeSegment = () => {
    const text = curText.trim();
    if (text.length > 0 && curWords.length > 0) {
      segments.push({
        start: curStart != null ? curStart : curWords[0].start,
        end: curEnd != null ? curEnd : curWords[curWords.length - 1].end,
        text,
        words: curWords.slice(),
      });
    }
    curWords = [];
    curText = "";
    curStart = null;
    curEnd = null;
  };

  for (const item of results) {
    const alt = item && Array.isArray(item.alternatives) ? item.alternatives[0] : null;
    if (!alt) continue;
    const content = (alt.content || "").trim();
    if (!content) continue;

    if (item.type === "punctuation") {
      const attaches = item.attaches_to || "previous";
      if (attaches === "previous" || attaches === "both") {
        curText += content; // glue directly to the preceding word (no space)
      } else {
        curText += (curText.length > 0 ? " " : "") + content;
      }
      if (item.is_eos) closeSegment();
      continue;
    }

    // type === "word" (or "entity"/unknown that carries timing) → treat as a token
    const start = parseFloat(item.start_time);
    const end = parseFloat(item.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    // Fallback sentence boundary: long silence between words.
    if (
      curWords.length > 0 &&
      lastWordEnd != null &&
      start - lastWordEnd > MAX_SEGMENT_GAP_SEC
    ) {
      closeSegment();
    }

    if (curStart == null) curStart = start;
    curEnd = end;
    lastWordEnd = end;
    curWords.push({ word: content, start, end });
    curText += (curText.length > 0 ? " " : "") + content;
  }

  closeSegment();
  return segments;
}

/**
 * Legacy local Whisper transcription. Kept as a fallback for environments
 * without a Speechmatics API key. Reads the audio that was already extracted.
 */
async function transcribeWithWhisper(audioPath, outputDir) {
  console.log(`🎙️  Transcribing with Whisper (model=${WHISPER_MODEL}, threads=${WHISPER_THREADS})...`);

  const whisperCmd = `${PYTHON} -m whisper "${audioPath}" --model ${WHISPER_MODEL} --output_format json --output_dir "${outputDir}" --word_timestamps True --threads ${WHISPER_THREADS} --verbose False`;

  await execAsync(whisperCmd, {
    timeout: 30 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const audioBaseName = path.basename(audioPath, ".mp3");
  const jsonPath = path.join(outputDir, `${audioBaseName}.json`);
  const finalJsonPath = fs.existsSync(jsonPath)
    ? jsonPath
    : audioPath.replace(".mp3", ".json");

  if (!fs.existsSync(finalJsonPath)) {
    throw new Error(`Whisper JSON not found at: ${finalJsonPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(finalJsonPath, "utf8"));

  const segments = (raw.segments || [])
    .filter((seg) => seg.text && seg.text.trim().length > 0)
    .map((seg) => {
      const words = (seg.words || []).map((w) => ({
        word: (w.word || "").trim(),
        start: parseFloat(w.start),
        end: parseFloat(w.end),
      })).filter((w) => w.word.length > 0);

      return {
        start: parseFloat(seg.start),
        end: parseFloat(seg.end),
        text: seg.text.trim(),
        words,
      };
    });

  try { if (fs.existsSync(finalJsonPath)) fs.unlinkSync(finalJsonPath); } catch {}

  return segments;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeAxiosError(err) {
  if (err && err.response) {
    const body = typeof err.response.data === "object"
      ? JSON.stringify(err.response.data)
      : String(err.response.data);
    return `HTTP ${err.response.status} ${body}`;
  }
  return err && err.message ? err.message : String(err);
}

function segmentsToText(segments) {
  return segments.map((s) => s.text).join(" ");
}

/**
 * Extract word-level timings for a specific clip time range.
 * Uses actual word timestamps — perfectly synced.
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

  // First try: use actual word-level timestamps
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
          word: w.word.replace(/[^\p{L}\p{M}\p{N}\s'''-]/gu, "").trim(),
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
          word: word.replace(/[^\p{L}\p{M}\p{N}\s'''-]/gu, "").trim(),
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
