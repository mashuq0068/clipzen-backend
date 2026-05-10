/* eslint-disable no-undef */
/**
 * brollEngine.js — REWRITTEN
 *
 * Guaranteed b‑roll placements using rule‑based detection + fallback anchors.
 * Downloads Pexels videos to local disk before returning URLs.
 */

const { llmWithRetry, isLLMAvailable } = require("./llmProvider");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const stream = require("stream");
const util = require("util");

const pipeline = util.promisify(stream.pipeline);
const PEXELS_BASE = "https://api.pexels.com/videos/search";
const _remoteCache = new Map(); // keyword → remote URL array
const _localCache = new Map(); // keyword → local file path
const { exec } = require("child_process");
const execAsync = util.promisify(exec);

// ─────────────────────────────────────────────────────────────
// ELIGIBILITY
// ─────────────────────────────────────────────────────────────
const NO_BROLL_TYPES = new Set(["interview", "podcast", "debate"]);

function eligibilityCheck(clip, contentType, brollEnabled) {
  if (!brollEnabled) return false;
  if (NO_BROLL_TYPES.has(contentType)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// KEYWORD TABLES
// ─────────────────────────────────────────────────────────────
const TOPIC_KEYWORD_POOLS = {
  nature: [
    "aerial ocean waves",
    "forest sunlight trees",
    "mountain landscape",
    "river flowing",
    "wildlife nature",
  ],
  technology: [
    "computer code screen",
    "server data center",
    "smartphone closeup",
    "circuit board",
    "futuristic abstract",
  ],
  health: [
    "person exercising gym",
    "healthy food vegetables",
    "meditation yoga calm",
    "doctor hospital",
    "sleeping rest",
  ],
  science: [
    "laboratory experiment",
    "microscope research",
    "space stars galaxy",
    "chemistry lab",
    "research scientist",
  ],
  society: [
    "city crowd people",
    "urban street lifestyle",
    "diverse community",
    "busy market",
    "business meeting office",
  ],
  money: [
    "stock market trading",
    "cash money business",
    "professional office success",
    "entrepreneur laptop",
    "financial growth chart",
  ],
  fitness: [
    "gym workout weights",
    "running athlete outdoors",
    "fitness training",
    "sports performance",
    "strength training",
  ],
  general: [
    "cinematic nature aerial",
    "urban city lifestyle",
    "modern office work",
    "outdoor scenic landscape",
    "inspiring background video",
  ],
};

const CONTEXT_REFINERS = [
  {
    pattern: /\b(ocean|sea|beach|wave|water|lake|river)\b/i,
    keyword: "ocean waves beach aerial",
  },
  {
    pattern: /\b(mountain|forest|tree|sky|cloud|sunset|sun)\b/i,
    keyword: "nature landscape aerial",
  },
  {
    pattern: /\b(gym|workout|muscle|lift|exercise|squat|bench)\b/i,
    keyword: "gym workout weights training",
  },
  {
    pattern: /\b(food|eat|diet|nutrition|meal|cook|recipe)\b/i,
    keyword: "healthy food cooking kitchen",
  },
  {
    pattern: /\b(sleep|rest|bed|tired|recover|relax)\b/i,
    keyword: "sleeping rest calm bedroom",
  },
  {
    pattern: /\b(money|cash|invest|profit|dollar|earn|income)\b/i,
    keyword: "money cash business success",
  },
  {
    pattern: /\b(code|software|app|tech|computer|program)\b/i,
    keyword: "coding screen developer technology",
  },
  {
    pattern: /\b(brain|mind|think|mental|cognitive|focus)\b/i,
    keyword: "brain thinking abstract mind",
  },
  {
    pattern: /\b(city|urban|street|crowd|traffic|downtown)\b/i,
    keyword: "city lifestyle people urban",
  },
  {
    pattern: /\b(science|lab|research|study|data|experiment)\b/i,
    keyword: "laboratory science research",
  },
  {
    pattern: /\b(run|running|sprint|cardio|jog|marathon)\b/i,
    keyword: "running athlete outdoor fitness",
  },
  {
    pattern: /\b(space|star|planet|galaxy|universe|astronaut)\b/i,
    keyword: "space stars galaxy universe",
  },
  {
    pattern: /\b(success|goal|achieve|win|fail|habit)\b/i,
    keyword: "success motivation achievement",
  },
];

async function faststartRemux(inputPath) {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const tmp = inputPath.replace(".mp4", "_fixed.mp4");
  try {
    await execAsync(
      `"${ffmpeg}" -i "${inputPath}" -c:v libx264 -preset fast -crf 23 -r 30 -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p -movflags +faststart -an -y "${tmp}"`,
      { timeout: 120000 },
    );
    fs.unlinkSync(inputPath);
    fs.renameSync(tmp, inputPath);
    console.log(`      ⚡ B-roll re-encoded: ${path.basename(inputPath)}`);
  } catch (e) {
    console.warn(`      ⚠️  B-roll encode failed: ${e.message.split("\n")[0]}`);
  }
  return inputPath;
}
function pickKeyword(windowText, topic) {
  for (const refiner of CONTEXT_REFINERS) {
    if (refiner.pattern.test(windowText)) return refiner.keyword;
  }
  const pool = TOPIC_KEYWORD_POOLS[topic] || TOPIC_KEYWORD_POOLS.general;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─────────────────────────────────────────────────────────────
// MOMENT DETECTION
// ─────────────────────────────────────────────────────────────
function detectBrollMoments(words, clipDurationSecs, topic, preferredStyle) {
  if (!words || words.length < 3) return [];

  const MIN_GAP = 0.2;
  const MIN_APART = 18;
  const MAX_BROLLS = Math.max(
    1,
    Math.min(4, Math.floor(clipDurationSecs / 18)),
  );

  const moments = [];
  let lastAt = -999;

  for (let i = 0; i < words.length - 1; i++) {
    if (moments.length >= MAX_BROLLS) break;
    const w = words[i];
    const next = words[i + 1];
    const t = w.endSec || w.startSec + 0.1;
    const gap = (next.startSec || 0) - t;
    if (t < 4) continue;
    if (t > clipDurationSecs - 4) break;
    if (t - lastAt < MIN_APART) continue;
    if (gap < MIN_GAP) continue;

    const windowStart = Math.max(0, i - 12);
    const windowWords = words.slice(windowStart, i + 2);
    const windowText = windowWords.map((x) => x.word || "").join(" ");
    const keyword = pickKeyword(windowText, topic);
    const brollDur = 6;
    const style = preferredStyle || "fullscreen";

    moments.push({ startSec: t + 0.05, durationSec: brollDur, keyword, style });
    lastAt = t;
  }

  if (moments.length === 0 && clipDurationSecs >= 12) {
    const anchors = [0.2, 0.5, 0.8];
    for (let i = 0; i < anchors.length && moments.length < MAX_BROLLS; i++) {
      const anchorT = clipDurationSecs * anchors[i];
      if (anchorT < 3 || anchorT > clipDurationSecs - 3) continue;
      const keyword = pickKeyword("", topic);
      moments.push({
        startSec: anchorT,
        durationSec: 4,
        keyword,
        style: "fullscreen",
      });
    }
  }

  moments.sort((a, b) => a.startSec - b.startSec);
  const filtered = [];
  for (const m of moments) {
    if (filtered.length === 0) {
      filtered.push(m);
      continue;
    }
    const last = filtered[filtered.length - 1];
    if (m.startSec - last.startSec < MIN_APART) continue;
    filtered.push(m);
  }
  return filtered;
}

// ─────────────────────────────────────────────────────────────
// PEXELS FETCH (remote URL)
// ─────────────────────────────────────────────────────────────
async function fetchPexelsVideoRemote(keyword) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.warn("⚠️  PEXELS_API_KEY not set — b‑roll will use fallback placeholder");
    return null;
  }
  if (_remoteCache.has(keyword)) {
    const urls = _remoteCache.get(keyword);
    return urls[Math.floor(Math.random() * urls.length)];
  }
  const url = `${PEXELS_BASE}?query=${encodeURIComponent(keyword)}&per_page=8&orientation=portrait&size=medium`;
  try {
    const res = await axios.get(url, {
      headers: { Authorization: apiKey },
      timeout: 20000,
    });
    const data = res.data;
    if (!data.videos?.length) {
      console.warn(`⚠️  No Pexels for "${keyword}" – trying fallback "cinematic nature"`);
      return fetchPexelsVideoRemote("cinematic nature");
    }
    const videoUrls = data.videos
      .map(v => {
        const mp4 = (v.video_files || [])
          .filter(f => f.file_type === "video/mp4" && f.link)
          .sort((a, b) => {
            const aP = a.width < a.height ? 1 : 0;
            const bP = b.width < b.height ? 1 : 0;
            if (bP !== aP) return bP - aP;
            return a.width - b.width;
          });
        return mp4[0]?.link || null;
      })
      .filter(Boolean);
    if (!videoUrls.length) return null;
    _remoteCache.set(keyword, videoUrls);
    return videoUrls[Math.floor(Math.random() * videoUrls.length)];
  } catch (err) {
    console.warn(`⚠️  Pexels fetch error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// DOWNLOAD TO LOCAL DISK
// ─────────────────────────────────────────────────────────────
async function downloadVideoToLocal(remoteUrl, outputDir) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 8)}.mp4`;
  const outputPath = path.join(outputDir, filename);
  const response = await axios({
    method: "GET",
    url: remoteUrl,
    responseType: "stream",
    timeout: 60000, // 60 seconds per video
  });
  await pipeline(response.data, fs.createWriteStream(outputPath));
  console.log(`      📥 Downloaded b-roll: ${outputPath}`);
  return outputPath;
}

// ─────────────────────────────────────────────────────────────
// LLM MOMENT SELECTION (optional)
// ─────────────────────────────────────────────────────────────
async function selectMomentsWithLLM(words, clipDurationSecs, topic) {
  const available = await isLLMAvailable();
  if (!available) return null;

  // Sample every 3rd word (more context than every 5th)
  const sample = words
    .filter((_, i) => i % 3 === 0)
    .map((w) => `[${w.startSec.toFixed(1)}s] ${w.word}`)
    .join(" ");

  const MAX_BROLLS = Math.max(1, Math.min(4, Math.floor(clipDurationSecs / 25)));

  const prompt = `You are a professional video editor choosing b-roll cutaway moments for a short-form video clip.

RULES for good b-roll placement:
- Pick moments at the END of a sentence or thought (natural pause), NOT mid-sentence
- The keyword must be a VISUAL concept searchable on a stock footage site (Pexels)
- Keywords must be concrete and visual: "person running beach" not "motivation" or "feel good"
- Space moments at least 20 seconds apart
- Avoid the first 5 seconds and last 5 seconds of the clip
- Match the keyword to what the speaker is LITERALLY describing, not the abstract theme

Transcript (sampled with timestamps):
${sample}

Topic: ${topic}
Clip duration: ${clipDurationSecs.toFixed(0)}s
Number of b-roll moments to pick: ${MAX_BROLLS}

Respond ONLY with a valid JSON array. No explanation, no markdown, no extra text.
Format: [{"startSec": number, "keyword": "3-5 word stock footage search"}]
Example: [{"startSec": 18.0, "keyword": "person sitting alone thinking"}, {"startSec": 45.5, "keyword": "city traffic night aerial"}]`;

  try {
    const raw = await llmWithRetry({ prompt, maxTokens: 150, temperature: 0.1 });
    const clean = raw.replace(/```json|```/g, "").trim();
    
    // Find JSON array even if LLM adds text around it
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) return null;
    
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    
    return parsed
      .filter((m) => typeof m.startSec === "number" && typeof m.keyword === "string")
      .filter((m) => m.startSec > 5 && m.startSec < clipDurationSecs - 5)
      .map((m) => ({
        startSec: m.startSec,
        durationSec: 6,
        keyword: m.keyword.trim(),
        style: "fullscreen",
      }));
  } catch (e) {
    console.warn(`   🎥 LLM b-roll selection failed, falling back to rules: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────
async function buildBrollSegments(
  clip,
  words,
  topic,
  contentType,
  brollEnabled,
  preferredStyle,
  jobOutputDir,
) {
  if (!eligibilityCheck(clip, contentType, brollEnabled)) return [];

  const clipDurationSecs =
    clip.segments?.length > 1
      ? clip.segments.reduce((s, seg) => s + (seg.endSec - seg.startSec), 0)
      : (clip.endSec || 0) - (clip.startSec || 0);

  let moments = await selectMomentsWithLLM(
    words,
    clipDurationSecs,
    topic || "general",
  );
  if (!moments || !moments.length) {
    moments = detectBrollMoments(
      words,
      clipDurationSecs,
      topic || "general",
      preferredStyle || "fullscreen",
    );
  } else {
    console.log(`   🎥 B‑roll: LLM selected ${moments.length} moments`);
  }

  if (!moments.length) {
    console.log(`   🎥 B‑roll: no moments detected → no b‑roll for this clip`);
    return [];
  }

  console.log(
    `   🎥 B‑roll: ${moments.length} moments (${clipDurationSecs.toFixed(0)}s clip)`,
  );

  // Create per‑job b‑roll folder
  const brollOutputDir = path.join(jobOutputDir, "broll");
  if (!fs.existsSync(brollOutputDir))
    fs.mkdirSync(brollOutputDir, { recursive: true });

  // First, fetch all remote URLs (parallel)
  const uniqueKeywords = [...new Set(moments.map((m) => m.keyword))];
  const remoteUrlMap = new Map();
  for (const kw of uniqueKeywords) {
    const remoteUrl = await fetchPexelsVideoRemote(kw);
    if (remoteUrl) remoteUrlMap.set(kw, remoteUrl);
  }

  // Then download each unique video (or reuse if same keyword appears)
  const localUrlMap = new Map();
  for (const [kw, remoteUrl] of remoteUrlMap.entries()) {
    if (!_localCache.has(kw)) {
      const localPath = await downloadVideoToLocal(remoteUrl, brollOutputDir);
      await faststartRemux(localPath); // ← ADD THIS LINE
      _localCache.set(kw, localPath);
    }
    localUrlMap.set(kw, _localCache.get(kw));
  }

  const segments = [];
  for (const moment of moments) {
    const localUrl = localUrlMap.get(moment.keyword);
    if (!localUrl) {
      console.warn(`      ↳ No local video for "${moment.keyword}" – skipping`);
      continue;
    }
    segments.push({
      keyword: moment.keyword,
      videoUrl: localUrl,
      startSec: moment.startSec,
      durationSec: moment.durationSec,
      style: moment.style,
      position: "bottom",
    });
    console.log(
      `      ↳ "${moment.keyword}" @ ${moment.startSec.toFixed(1)}s [${moment.durationSec}s, ${moment.style}] → ${localUrl}`,
    );
  }

  return segments;
}

module.exports = { buildBrollSegments };
