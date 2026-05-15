/**
 * storyEngine.js
 *
 * CLIP DURATION POLICY:
 *   - Hard floor:   20s  (absolute minimum, rare)
 *   - Soft minimum: 50s  (always try to reach this)
 *   - Ideal target: 60s  (sweet spot)
 *   - Hard cap:     180s (3 mins max for long story arcs)
 *
 * Most clips will be 50-120s. Under 20s is rejected. Over 180s is capped.
 *
 * KEY CHANGES vs previous version:
 *   1. buildStoryClips / buildStoryClipsSync accept a layoutMap (4th param).
 *      scoreBlock uses it to penalise layout-unstable blocks so they rank lower.
 *   2. Clip count is ALWAYS honoured EXACTLY as provided — no capping.
 *      (The old getSmartClipCount was removed from clipSelector; storyEngine
 *      never second-guessed clipCount itself anyway.)
 *   3. assembleClipPlans propagates layoutMap into scoreBlock.
 *   4. NEW: When the non-overlapping pass cannot fill all requested clips,
 *      a sliding-window overlap fill pass kicks in and distributes the remaining
 *      clips evenly across the video — with story-contextual windows, not random
 *      cuts. Overlap is allowed but minimised. This guarantees exact clip count
 *      even for very short videos or high clip counts.
 *   5. LLM prompt now includes ALL blocks (not just first 20) in batches so
 *      the LLM always has full context.
 */

const { llmWithRetry, isLLMAvailable } = require("./llmProvider");

// ─────────────────────────────────────────────────────────────
// CLIP DURATION TARGETS
// ─────────────────────────────────────────────────────────────
const MIN_CLIP_DUR      = 10;   // absolute floor — hard reject below this (lowered to help short videos)
const SOFT_MIN_CLIP_DUR = 50;   // target minimum — always try to reach
const TARGET_CLIP_DUR   = 60;   // ideal sweet spot
const MAX_CLIP_DUR      = 180;  // hard cap — 3 mins max
const BLOCK_MAX_DUR     = 45;   // soft split — split at next sentence end after this
const BLOCK_HARD_MAX    = 55;   // hard split — always split here even mid-sentence

// ─────────────────────────────────────────────────────────────
// TOPIC DETECTION
// ─────────────────────────────────────────────────────────────
const TOPIC_KEYWORDS = {
  time:       ["time", "second", "minute", "hour", "day", "week", "year", "moment", "past", "future", "clock", "deadline", "age"],
  money:      ["money", "dollar", "million", "billion", "profit", "revenue", "income", "wealth", "invest", "cost", "price", "paid", "salary"],
  health:     ["health", "body", "sleep", "exercise", "diet", "stress", "mental", "brain", "heart", "pain", "doctor", "medicine"],
  success:    ["success", "goal", "achieve", "win", "fail", "habit", "discipline", "focus", "mindset", "growth", "potential"],
  technology: ["ai", "software", "code", "tech", "computer", "data", "algorithm", "model", "machine", "robot", "automation"],
  science:    ["science", "study", "research", "theory", "experiment", "discovery", "universe", "physics", "chemistry", "biology"],
  society:    ["people", "society", "culture", "politics", "government", "social", "community", "world", "history", "generation"],
  philosophy: ["life", "meaning", "truth", "reality", "existence", "consciousness", "purpose", "question", "answer", "think"],
  nature:     ["nature", "animal", "wildlife", "planet", "ocean", "forest", "climate", "species", "environment", "earth"],
};

function detectTopic(text) {
  const lower = text.toLowerCase();
  let best = "general", bestScore = 0;
  for (const [topic, kws] of Object.entries(TOPIC_KEYWORDS)) {
    const score = kws.filter((kw) => lower.includes(kw)).length;
    if (score > bestScore) { bestScore = score; best = topic; }
  }
  return bestScore > 0 ? best : "general";
}

// ─────────────────────────────────────────────────────────────
// EMOTION DETECTION
// ─────────────────────────────────────────────────────────────
const EMOTION_SIGNALS = {
  motivational: ["never give up", "you can", "believe", "possible", "achieve", "dream", "potential", "inspire", "powerful", "change your life"],
  warning:      ["don't", "never", "stop", "avoid", "dangerous", "wrong", "mistake", "careful", "problem", "fail", "risk", "harm"],
  surprising:   ["actually", "shocking", "unbelievable", "surprising", "nobody knows", "secret", "revealed", "most people", "turns out"],
  explanatory:  ["because", "which means", "the reason", "that's why", "so", "therefore", "here's how", "let me explain", "in other words"],
  questioning:  ["?", "what if", "imagine", "think about", "have you", "why do", "how does", "what is", "wonder"],
};

function detectEmotion(text) {
  const lower = text.toLowerCase();
  let best = "neutral", bestScore = 0;
  for (const [emotion, signals] of Object.entries(EMOTION_SIGNALS)) {
    const score = signals.filter((s) => lower.includes(s)).length;
    if (score > bestScore) { bestScore = score; best = emotion; }
  }
  return bestScore > 0 ? best : "neutral";
}

function emotionToColorGrade(emotion, narrativeRole) {
  if (emotion === "warning") return "red_intense";
  if (emotion === "motivational") return "warm_vibrant";
  if (emotion === "surprising" && narrativeRole === "insight") return "cool_calm";
  if (narrativeRole === "conclusion") return "warm_vibrant";
  if (emotion === "questioning") return "cool_calm";
  return "none";
}

function emotionToAudioMood(emotion, topic) {
  if (emotion === "motivational") return "energetic_beat";
  if (emotion === "warning") return "tense_ambient";
  if (emotion === "surprising") return "cinematic_reveal";
  if (emotion === "explanatory") return "soft_cinematic";
  if (emotion === "questioning") return "subtle_tension";
  if (topic === "success" || topic === "money") return "energetic_beat";
  if (topic === "health" || topic === "philosophy") return "soft_cinematic";
  return "none";
}

// ─────────────────────────────────────────────────────────────
// NARRATIVE ROLE DETECTION
// ─────────────────────────────────────────────────────────────
const HOOK_PATTERNS = [
  /\?/,
  /\b(imagine|picture this|what if|did you know)\b/i,
  /\b(never|always|everyone|nobody|the truth|secret|shocking)\b/i,
  /\b(today|right now|by the time)\b/i,
];
const CONCLUSION_PATTERNS = [
  /\b(so|therefore|that's why|which means|in conclusion|the point is)\b/i,
  /\b(remember|take away|lesson|key|bottom line)\b/i,
  /\b(now you know|hope that|thank you|that's it|final)\b/i,
];
const EXAMPLE_PATTERNS = [
  /\b(for example|for instance|like when|imagine if|consider)\b/i,
  /\b(let me show|here's a|take a look)\b/i,
];

function detectNarrativeRole(text, positionRatio) {
  const lower = text.toLowerCase();
  if (positionRatio < 0.15 && HOOK_PATTERNS.some((p) => p.test(lower))) return "hook";
  if (CONCLUSION_PATTERNS.some((p) => p.test(lower))) return "conclusion";
  if (EXAMPLE_PATTERNS.some((p) => p.test(lower))) return "example";
  if (positionRatio < 0.25) return "setup";
  if (positionRatio > 0.8) return "outro";
  if (/\b(actually|the truth|what really|here's what|the key|most important)\b/i.test(lower)) return "insight";
  return "body";
}

function buildEditingDirectives(topic, emotion, narrativeRole) {
  return {
    captionPosition: narrativeRole === "hook" && /question/.test(emotion) ? "top" : "bottom",
    captionColor:    emotion === "motivational" ? "#00E676" : emotion === "warning" ? "#FF5252" : null,
    zoomIntensity:   ["hook", "insight", "motivational", "surprising"].includes(narrativeRole || emotion) ? "hard" : "normal",
    pacing:          ["conclusion", "insight", "explanatory"].includes(narrativeRole || emotion) ? "slow" : "normal",
    colorGrade:      emotionToColorGrade(emotion, narrativeRole),
    audioMood:       emotionToAudioMood(emotion, topic),
  };
}

// ─────────────────────────────────────────────────────────────
// LAYOUT INSTABILITY HELPER (mirrors clipSelector logic)
// ─────────────────────────────────────────────────────────────
function _layoutInstability(layoutMap, startSec, endSec) {
  if (!layoutMap || Object.keys(layoutMap).length === 0) return 0;
  const samples = [];
  for (let t = Math.floor(startSec); t <= Math.ceil(endSec); t++) {
    const mode = layoutMap[t];
    if (mode) samples.push(mode);
  }
  if (samples.length < 2) return 0;
  let transitions = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] !== samples[i - 1]) transitions++;
  }
  return transitions / (samples.length - 1);
}

// ─────────────────────────────────────────────────────────────
// WORD FLATTENING
// ─────────────────────────────────────────────────────────────
function flattenWords(segments) {
  const words = [];
  for (const seg of segments) {
    if (seg.words && seg.words.length > 0) {
      for (const w of seg.words) {
        if (w.word && w.word.trim())
          words.push({ word: w.word.trim(), start: w.start, end: w.end });
      }
    } else {
      const segWords = seg.text.trim().split(/\s+/).filter(Boolean);
      if (!segWords.length) continue;
      const dur = (seg.end - seg.start) / segWords.length;
      segWords.forEach((word, i) =>
        words.push({
          word,
          start: seg.start + i * dur,
          end:   seg.start + (i + 1) * dur,
        })
      );
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

// ─────────────────────────────────────────────────────────────
// SENTENCE BOUNDARY SNAPPING
// ─────────────────────────────────────────────────────────────
function snapToSentenceStart(allWords, rawStartSec, maxLookBackSec = 5.0) {
  if (!allWords.length) return rawStartSec;
  let nearIdx = allWords.findIndex((w) => w.start >= rawStartSec - 0.15);
  if (nearIdx < 0) nearIdx = allWords.length - 1;
  nearIdx = Math.min(nearIdx, allWords.length - 1);

  for (let i = nearIdx; i >= 0; i--) {
    const w = allWords[i];
    if (rawStartSec - w.start > maxLookBackSec) break;
    if (/[.!?]["']?\s*$/.test(w.word)) {
      const next = allWords[i + 1];
      if (next) return next.start;
    }
  }
  const exact = allWords.find((w) => w.start >= rawStartSec - 0.2);
  return exact ? exact.start : rawStartSec;
}

function snapToSentenceEnd(allWords, rawEndSec, maxLookForwardSec = 15.0) {
  if (!allWords.length) return rawEndSec;

  let anchorIdx = -1;
  for (let i = allWords.length - 1; i >= 0; i--) {
    if (allWords[i].start <= rawEndSec + 0.1) { anchorIdx = i; break; }
  }
  if (anchorIdx < 0) anchorIdx = 0;

  for (let i = anchorIdx; i < allWords.length; i++) {
    const w = allWords[i];
    if (w.start > rawEndSec + maxLookForwardSec) break;
    if (/[.!?]["']?\s*$/.test(w.word)) return w.end + 0.05;
  }

  return allWords[anchorIdx] ? allWords[anchorIdx].end + 0.05 : rawEndSec;
}

// ─────────────────────────────────────────────────────────────
// THOUGHT BLOCK PARSER
// ─────────────────────────────────────────────────────────────
function parseThoughtBlocks(segments) {
  if (!segments || !segments.length) return [];
  const blocks = [];
  let cur = { segments: [], startSec: segments[0].start, endSec: 0, text: "" };

  const flush = (next) => {
    if (cur.text.trim().split(/\s+/).length >= 5) blocks.push({ ...cur });
    if (next) cur = { segments: [], startSec: next.start, endSec: 0, text: "" };
  };

  for (let i = 0; i < segments.length; i++) {
    const seg  = segments[i];
    const next = segments[i + 1];
    cur.segments.push(seg);
    cur.endSec  = seg.end;
    cur.text   += (cur.text ? " " : "") + seg.text.trim();

    const dur   = cur.endSec - cur.startSec;
    const gap   = next ? next.start - seg.end : 0;
    const isEnd = /[.!?]["']?\s*$/.test(seg.text.trim());

    if (i === segments.length - 1) {
      // Last segment — always flush
      flush(null);
    } else if (dur >= BLOCK_HARD_MAX) {
      // HARD split — block has grown too large regardless of sentence boundaries.
      // Split here to ensure the video produces enough distinct blocks for clip selection.
      flush(next);
    } else if ((gap > 0.8 && isEnd) || gap > 1.5 || (dur > BLOCK_MAX_DUR && isEnd)) {
      // Natural break — pause after sentence end, or long pause, or soft duration hit
      flush(next);
    }
  }
  return blocks;
}

// ─────────────────────────────────────────────────────────────
// BLOCK SCORER
// ─────────────────────────────────────────────────────────────
const HIGH_VALUE_KEYWORDS = [
  "secret", "truth", "never", "always", "everyone", "nobody", "actually",
  "shocking", "incredible", "million", "billion", "imagine", "think about",
  "most people", "nobody tells you", "here's what", "the real reason",
  "i learned", "changed my life", "different", "wrong", "mistake", "the key",
  "what nobody", "the problem", "here's the thing", "plot twist",
];

function scoreBlock(block, totalDuration, layoutMap) {
  const text     = block.text.toLowerCase();
  const posRatio = block.startSec / totalDuration;
  const dur      = block.endSec - block.startSec;
  let score      = 0;

  score += HIGH_VALUE_KEYWORDS.filter((kw) => text.includes(kw)).length * 15;
  score += (text.match(/\?/g) || []).length * 10;
  score += (text.match(/!/g)  || []).length * 5;
  score += (text.match(/\b\d+\b/g) || []).length * 3;

  if (posRatio < 0.2) score += 20;
  else if (posRatio < 0.4) score += 10;

  if (dur >= 50 && dur <= 120)        score += 30;
  else if (dur >= 30 && dur < 50)     score += 15;
  else if (dur > 120 && dur <= 180)   score += 20;
  else if (dur >= 20 && dur < 30)     score += 5;
  else if (dur < 20)                  score -= 30;

  const role = detectNarrativeRole(text, posRatio);
  score += { hook: 30, insight: 25, conclusion: 15, example: 10, setup: 5, body: 5, outro: 0 }[role] || 0;

  if (layoutMap) {
    const instability   = _layoutInstability(layoutMap, block.startSec, block.endSec);
    const layoutPenalty = Math.round(instability * 40);
    if (layoutPenalty > 0) score -= layoutPenalty;
  }

  return { score, role };
}

// ─────────────────────────────────────────────────────────────
// LLM EDITING PLAN
// ─────────────────────────────────────────────────────────────
async function getOllamaEditingPlan(transcript, blocks, clipCount) {
  // Send ALL blocks, not just first 20 — truncate text per block to keep prompt size reasonable
  const blockSummaries = blocks.map((b, i) => ({
    i,
    text:  b.text.substring(0, 100),
    start: b.startSec.toFixed(1),
    end:   b.endSec.toFixed(1),
    dur:   (b.endSec - b.startSec).toFixed(0),
  }));

  const prompt = `You are a professional short-form video editor. Select the ${clipCount} best DISTINCT clips.
Target clip duration: 50-120 seconds each. Prefer complete story arcs.
Each blockIndex must be UNIQUE — never repeat the same blockIndex twice.
Select up to ${clipCount} clips — fewer is fine if there are not enough distinct blocks.

Transcript blocks:
${blockSummaries.map((b) => `[${b.i}] ${b.start}s-${b.end}s (${b.dur}s): "${b.text}"`).join("\n")}

Return ONLY valid JSON, no markdown:
{"clips":[{"blockIndex":0,"emotion":"motivational","colorGrade":"warm_vibrant","audioMood":"energetic_beat","reason":"strong hook"}]}

emotion: motivational|warning|surprising|explanatory|questioning|neutral
colorGrade: warm_vibrant|bw_dramatic|red_intense|cool_calm|none
audioMood: energetic_beat|soft_cinematic|tense_ambient|cinematic_reveal|subtle_tension|none`;

  try {
    const available = await isLLMAvailable();
    if (!available) throw new Error("LLM not available");

    const raw = await llmWithRetry({ prompt, maxTokens: 800, temperature: 0.1 });
    if (!raw || raw.length < 10) throw new Error("Empty response");

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      const arrMatch = jsonMatch[0].match(/"clips"\s*:\s*\[[\s\S]*?\]/);
      if (arrMatch) parsed = JSON.parse(`{${arrMatch[0]}}`);
      else throw new Error("Unrecoverable JSON");
    }

    if (!parsed.clips || !Array.isArray(parsed.clips)) throw new Error("Invalid structure");

    // Deduplicate by blockIndex — LLM sometimes repeats the same block
    const seenIndices = new Set();
    parsed.clips = parsed.clips.filter((c) => {
      if (seenIndices.has(c.blockIndex)) return false;
      seenIndices.add(c.blockIndex);
      return true;
    });

    console.log(`   🤖 LLM plan: ${parsed.clips.length} unique clips selected (requested: ${clipCount})`);
    return parsed;
  } catch (e) {
    console.warn(`   ⚠️  LLM plan skipped: ${e.message?.split("\n")[0]} — using heuristics`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// OVERLAP CHECK
// ─────────────────────────────────────────────────────────────
function overlaps(a, b, minOverlap = 5) {
  return Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec) > minOverlap;
}

// ─────────────────────────────────────────────────────────────
// NARRATIVE SEGMENT FINDER
// ─────────────────────────────────────────────────────────────
function findNarrativeSegments(blocks, scored, targetDuration, usedIndices, allWords) {
  const segments = [];
  let currentDuration = 0;

  const hook = scored.find(
    (b) => (b.role === "hook" || b.score > 60) && !usedIndices.has(b.originalIndex)
  );
  if (hook) {
    segments.push({ startSec: hook.startSec, endSec: hook.endSec, role: "hook", originalIndex: hook.originalIndex });
    currentDuration += hook.endSec - hook.startSec;
    usedIndices.add(hook.originalIndex);
  }

  const middleBlocks = scored.filter(
    (b) => b.posRatio > 0.3 && b.posRatio < 0.8 && !usedIndices.has(b.originalIndex)
  );
  const climax = middleBlocks.sort((a, b) => b.score - a.score)[0];

  if (climax) {
    const context = scored.find(
      (b) =>
        b.endSec < climax.startSec &&
        climax.startSec - b.endSec < 5 &&
        !usedIndices.has(b.originalIndex) &&
        b.role !== "hook"
    );
    if (context && currentDuration < targetDuration * 0.5) {
      segments.push({ startSec: context.startSec, endSec: context.endSec, role: "setup", originalIndex: context.originalIndex });
      currentDuration += context.endSec - context.startSec;
      usedIndices.add(context.originalIndex);
    }

    segments.push({ startSec: climax.startSec, endSec: climax.endSec, role: "climax", originalIndex: climax.originalIndex });
    currentDuration += climax.endSec - climax.startSec;
    usedIndices.add(climax.originalIndex);
  }

  const resolution = scored.find(
    (b) =>
      (b.role === "conclusion" || b.role === "outro") &&
      !usedIndices.has(b.originalIndex) &&
      b.posRatio > 0.7 &&
      currentDuration < targetDuration * 0.8
  );
  if (resolution) {
    segments.push({ startSec: resolution.startSec, endSec: resolution.endSec, role: "resolution", originalIndex: resolution.originalIndex });
    usedIndices.add(resolution.originalIndex);
  }

  const sorted = segments.sort((a, b) => a.startSec - b.startSec);
  if (allWords.length > 0) {
    for (const seg of sorted) {
      seg.startSec = snapToSentenceStart(allWords, seg.startSec);
      seg.endSec   = snapToSentenceEnd(allWords, seg.endSec, 15.0);
    }
  }

  return sorted;
}

// ─────────────────────────────────────────────────────────────
// OVERLAP-ALLOWED FILL PASS
// Called when the strict non-overlapping pass produced fewer clips
// than requested. Distributes the remaining N clips evenly across
// the video using a sliding story-contextual window.
// Each window is centred on the highest-scoring block in that zone.
// ─────────────────────────────────────────────────────────────
function buildOverlapFillClips(
  needed,
  clipCount,
  existingClips,
  blocks,
  scored,
  allWords,
  totalDuration,
  targetDuration,
  layoutMap
) {
  const filled = [];
  if (needed <= 0 || blocks.length === 0) return filled;

  // Adaptive clip duration: if video is short relative to clips needed,
  // shrink target so we can still produce meaningful distinct windows.
  const totalClips = existingClips.length + needed;
  const minDur = Math.max(
    MIN_CLIP_DUR,
    Math.min(SOFT_MIN_CLIP_DUR, Math.floor(totalDuration / totalClips) - 5)
  );
  const effectiveTarget = Math.max(
    minDur,
    Math.min(targetDuration, Math.floor(totalDuration / totalClips) + 10)
  );

  console.log(
    `   🔄 Overlap fill pass: need ${needed} more clips | ` +
    `effectiveTarget=${effectiveTarget}s minDur=${minDur}s totalDur=${totalDuration.toFixed(0)}s`
  );

  // Track which block indices and which time windows have already been
  // used by fill clips — so we never anchor the same block twice and
  // never produce an exact duplicate window.
  const usedAnchorIndices = new Set();
  const usedWindows = []; // [{ startSec, endSec }]

  // Also register existing clips so fill zones don't clone them
  for (const c of existingClips) {
    usedWindows.push({ startSec: c.startSec, endSec: c.endSec });
  }

  // Sort scored blocks by position so we can distribute evenly
  const byPosition = [...scored].sort((a, b) => a.startSec - b.startSec);

  // Divide the FULL timeline into `totalClips` equal zones, then pick the
  // zones that aren't already covered by existing clips. This prevents all
  // fill zones from clustering at the start of the video when the first block
  // is very large (e.g. a 181s block that spans zones 0-3 of a needed=3 split).
  const zoneSize = totalDuration / totalClips;

  // Determine which zone slots are already covered by existing clips
  const coveredZones = new Set();
  for (const c of existingClips) {
    const cMid = (c.startSec + c.endSec) / 2;
    const slot = Math.floor(cMid / zoneSize);
    coveredZones.add(slot);
  }

  // Collect uncovered zone indices in order
  const openSlots = [];
  for (let z = 0; z < totalClips; z++) {
    if (!coveredZones.has(z)) openSlots.push(z);
  }

  // If we somehow have fewer open slots than needed, duplicate slots at end
  while (openSlots.length < needed) {
    openSlots.push(openSlots[openSlots.length - 1] ?? totalClips - 1);
  }

  for (let z = 0; z < needed; z++) {
    const slot      = openSlots[z];
    const zoneStart = slot * zoneSize;
    const zoneEnd   = zoneStart + zoneSize;
    const zoneMid   = (zoneStart + zoneEnd) / 2;

    // Find the best-scoring block whose centre falls inside this zone
    // that hasn't already been used as an anchor.
    let anchor = null;

    // First pass: best-scoring block inside the zone
    for (const b of scored) {
      if (usedAnchorIndices.has(b.originalIndex)) continue;
      const bMid = (b.startSec + b.endSec) / 2;
      if (bMid >= zoneStart && bMid < zoneEnd) {
        if (!anchor || b.score > anchor.score) anchor = b;
      }
    }

    // Second pass: if zone empty, pick the closest unused block to zone mid
    if (!anchor) {
      let closestDist = Infinity;
      for (const b of byPosition) {
        if (usedAnchorIndices.has(b.originalIndex)) continue;
        const bMid = (b.startSec + b.endSec) / 2;
        const dist = Math.abs(bMid - zoneMid);
        if (dist < closestDist) {
          closestDist = dist;
          anchor = b;
        }
      }
    }

    // Hard fallback: all blocks used — pick closest by position regardless
    if (!anchor) {
      anchor = byPosition.reduce((best, b) => {
        const bMid     = (b.startSec + b.endSec) / 2;
        const bestMid  = (best.startSec + best.endSec) / 2;
        return Math.abs(bMid - zoneMid) < Math.abs(bestMid - zoneMid) ? b : best;
      }, byPosition[0]);
    }

    usedAnchorIndices.add(anchor.originalIndex);

    // Build window around anchor — expand forward/backward to reach effectiveTarget
    let winStart = anchor.startSec;
    let winEnd   = anchor.endSec;

    // Expand backward into adjacent blocks
    let bidx = anchor.originalIndex - 1;
    while (bidx >= 0 && winEnd - winStart < effectiveTarget) {
      const nb = blocks[bidx];
      const gap = winStart - nb.endSec;
      if (gap > 8.0) break;
      winStart = nb.startSec;
      bidx--;
    }

    // Expand forward into adjacent blocks
    let fidx = anchor.originalIndex + 1;
    while (fidx < blocks.length && winEnd - winStart < effectiveTarget) {
      const nb = blocks[fidx];
      const gap = nb.startSec - winEnd;
      if (gap > 8.0) break;
      winEnd = nb.endSec;
      fidx++;
    }

    // Clamp to video bounds and hard cap
    winStart = Math.max(0, winStart);
    winEnd   = Math.min(totalDuration, winEnd);
    winEnd   = Math.min(winEnd, winStart + MAX_CLIP_DUR);

    // Snap to sentence boundaries
    if (allWords.length > 0) {
      winStart = snapToSentenceStart(allWords, winStart);
      winEnd   = snapToSentenceEnd(allWords, winEnd, 15.0);
    }

    const dur = winEnd - winStart;
    if (dur < MIN_CLIP_DUR) {
      console.warn(`   ⚠️  Overlap fill clip ${z + 1} too short (${dur.toFixed(0)}s) — skipping zone`);
      continue;
    }

    // Skip if this window is a near-duplicate of an already-produced clip
    const isDuplicate = usedWindows.some(
      (w) => Math.abs(w.startSec - winStart) < 5 && Math.abs(w.endSec - winEnd) < 5
    );
    if (isDuplicate) {
      // Shift window by half a zone to differentiate it
      const shift = Math.min(zoneSize * 0.5, effectiveTarget * 0.3);
      winStart = Math.max(0, winStart + shift);
      winEnd   = Math.min(totalDuration, winEnd + shift);
      if (winEnd - winStart < MIN_CLIP_DUR) {
        console.warn(`   ⚠️  Overlap fill clip ${z + 1} still duplicate after shift — skipping`);
        continue;
      }
    }

    usedWindows.push({ startSec: winStart, endSec: winEnd });

    // Build transcript for this window
    const transcriptBlocks = scored.filter(
      (b) => b.startSec >= winStart - 1.0 && b.endSec <= winEnd + 1.0
    );
    const plainText = transcriptBlocks.map((b) => b.text).join(" ") || anchor.text;
    const transcript = JSON.stringify(transcriptBlocks.length > 0 ? transcriptBlocks : [{ start: winStart, end: winEnd, text: anchor.text }]);

    const topic         = detectTopic(plainText);
    const emotion       = detectEmotion(plainText);
    const narrativeRole = detectNarrativeRole(plainText, winStart / totalDuration);
    const colorGrade    = emotionToColorGrade(emotion, narrativeRole);
    const audioMood     = emotionToAudioMood(emotion, topic);
    const directives    = buildEditingDirectives(topic, emotion, narrativeRole);
    const titleWords    = plainText.trim().split(/\s+/).slice(0, 7).join(" ");

    const clipInstability = layoutMap
      ? _layoutInstability(layoutMap, winStart, winEnd)
      : null;

    const plan = {
      startSec:      winStart,
      endSec:        winEnd,
      title:         (titleWords.length > 5 ? titleWords + "..." : `Highlight ${existingClips.length + filled.length + 1}`),
      hookScore:     Math.min(80, Math.round(40 + anchor.score * 0.35)),
      transcript,
      contentType:   topic,
      topic,
      emotion,
      colorGrade,
      audioMood,
      narrativeRole,
      segments:      [{ startSec: winStart, endSec: winEnd, role: narrativeRole }],
      layoutInstability: clipInstability !== null ? parseFloat(clipInstability.toFixed(3)) : undefined,
      layoutStable:      clipInstability !== null ? clipInstability <= 0.25 : undefined,
      directives:    { ...directives, colorGrade, audioMood },
      reason:        `Overlap-fill zone ${z + 1}/${needed} @${(winStart / 60).toFixed(1)}m`,
    };

    console.log(
      `      📍 Overlap-fill clip ${z + 1}: ${(winStart / 60).toFixed(1)}m-${(winEnd / 60).toFixed(1)}m (${dur.toFixed(0)}s) [${narrativeRole}]`
    );

    filled.push(plan);
  }

  return filled;
}

// ─────────────────────────────────────────────────────────────
// STORY ASSEMBLER
// ─────────────────────────────────────────────────────────────
function assembleClipPlans(blocks, clipCount, targetDuration, allWords, ollamaPlan, layoutMap) {
  const totalDuration = blocks.length > 0 ? blocks[blocks.length - 1].endSec : 0;

  const scored = blocks.map((block, i) => {
    const { score, role } = scoreBlock(block, totalDuration, layoutMap);
    return {
      ...block,
      score,
      role,
      topic:         detectTopic(block.text),
      emotion:       detectEmotion(block.text),
      posRatio:      block.startSec / totalDuration,
      originalIndex: i,
    };
  });

  let candidateOrder = [];
  if (ollamaPlan?.clips?.length > 0) {
    const seenInOrder = new Set();
    for (const c of ollamaPlan.clips) {
      const idx = c.blockIndex;
      if (idx >= 0 && idx < scored.length && !seenInOrder.has(idx)) {
        seenInOrder.add(idx);
        candidateOrder.push({
          ...scored[idx],
          ollamaEmotionOverride: c.emotion,
          ollamaGradeOverride:   c.colorGrade,
          ollamaAudioOverride:   c.audioMood,
        });
      }
    }
    const ollamaIndices = new Set(ollamaPlan.clips.map((c) => c.blockIndex));
    const remaining = [...scored]
      .sort((a, b) => b.score - a.score)
      .filter((b) => !ollamaIndices.has(b.originalIndex));
    candidateOrder = [...candidateOrder, ...remaining];
  } else {
    candidateOrder = [...scored].sort((a, b) => b.score - a.score);
  }

  const clipPlans    = [];
  const usedIndices  = new Set();

  // ── MAIN PASS: strict non-overlapping clips ─────────────────
  for (const topBlock of candidateOrder) {
    if (clipPlans.length >= clipCount) break;
    if (usedIndices.has(topBlock.originalIndex)) continue;

    const blockDur = topBlock.endSec - topBlock.startSec;
    let segments   = null;

    if (
      blockDur < SOFT_MIN_CLIP_DUR ||
      topBlock.role === "insight" ||
      topBlock.role === "climax" ||
      (topBlock.score > 70 && blockDur < TARGET_CLIP_DUR * 0.6)
    ) {
      const narrativeSegments = findNarrativeSegments(
        blocks, scored,
        Math.max(targetDuration, SOFT_MIN_CLIP_DUR),
        new Set(usedIndices),
        allWords
      );

      const narrativeDur = narrativeSegments.reduce(
        (sum, s) => sum + (s.endSec - s.startSec), 0
      );

      if (narrativeDur >= MIN_CLIP_DUR && narrativeSegments.length >= 2) {
        narrativeSegments.forEach((s) => {
          if (s.originalIndex !== undefined) usedIndices.add(s.originalIndex);
        });
        segments = narrativeSegments.map((s) => ({
          startSec: s.startSec,
          endSec:   s.endSec,
          role:     s.role,
        }));
        console.log(
          `      📖 Narrative arc: ${narrativeSegments.map((s) => s.role).join(" → ")} (${narrativeDur.toFixed(0)}s)`
        );
      }
    }

    if (!segments && (topBlock.role === "insight" || topBlock.role === "conclusion")) {
      const setup = scored.find(
        (b) =>
          (b.role === "setup" || b.role === "hook" || b.role === "body") &&
          b.endSec < topBlock.startSec &&
          topBlock.startSec - b.endSec < 90 &&
          !usedIndices.has(b.originalIndex)
      );
      if (setup) {
        const total = (setup.endSec - setup.startSec) + blockDur;
        if (total <= MAX_CLIP_DUR) {
          segments = [
            { startSec: setup.startSec,    endSec: setup.endSec,    role: "setup"         },
            { startSec: topBlock.startSec, endSec: topBlock.endSec, role: topBlock.role   },
          ];
          usedIndices.add(setup.originalIndex);
        }
      }
    }

    if (!segments && topBlock.role === "hook" && blockDur < SOFT_MIN_CLIP_DUR) {
      const followUp = scored.find(
        (b) =>
          b.originalIndex > topBlock.originalIndex &&
          b.startSec - topBlock.endSec < 3 &&
          !usedIndices.has(b.originalIndex)
      );
      if (followUp) {
        const total = blockDur + (followUp.endSec - followUp.startSec);
        if (total <= MAX_CLIP_DUR) {
          segments = [
            { startSec: topBlock.startSec,  endSec: topBlock.endSec,  role: "hook"         },
            { startSec: followUp.startSec,  endSec: followUp.endSec,  role: followUp.role  },
          ];
          usedIndices.add(followUp.originalIndex);
        }
      }
    }

    if (!segments) {
      let startSec = topBlock.startSec;
      let endSec   = topBlock.endSec;

      if (blockDur < SOFT_MIN_CLIP_DUR && topBlock.originalIndex > 0) {
        const prevBlock = blocks[topBlock.originalIndex - 1];
        const prevDur   = prevBlock.endSec - prevBlock.startSec;
        if (
          !usedIndices.has(topBlock.originalIndex - 1) &&
          topBlock.startSec - prevBlock.endSec < 3.0 &&
          prevDur + blockDur <= MAX_CLIP_DUR
        ) {
          startSec = prevBlock.startSec;
          usedIndices.add(topBlock.originalIndex - 1);
        }
      }

      let idx = topBlock.originalIndex + 1;
      while (idx < blocks.length) {
        const nb         = blocks[idx];
        const currentDur = endSec - startSec;

        if (currentDur >= MAX_CLIP_DUR) break;

        const gap = nb.startSec - endSec;

        if (gap > 3.0 && currentDur >= SOFT_MIN_CLIP_DUR) break;
        if (gap > 8.0) break;

        if (!usedIndices.has(idx)) {
          endSec = nb.endSec;
          usedIndices.add(idx);
        }
        idx++;
      }

      endSec   = Math.min(endSec, startSec + MAX_CLIP_DUR);
      segments = [{ startSec, endSec, role: topBlock.role }];
    }

    if (allWords.length > 0) {
      for (const seg of segments) {
        seg.startSec = snapToSentenceStart(allWords, seg.startSec);
        seg.endSec   = snapToSentenceEnd(allWords, seg.endSec, 15.0);
      }
    }

    const totalDur = segments.reduce((s, g) => s + (g.endSec - g.startSec), 0);

    if (totalDur < MIN_CLIP_DUR) {
      console.warn(`      ⚠️  Skipping — too short: ${totalDur.toFixed(0)}s (min: ${MIN_CLIP_DUR}s)`);
      usedIndices.add(topBlock.originalIndex);
      continue;
    }

    if (totalDur < SOFT_MIN_CLIP_DUR) {
      console.warn(`      ⚠️  Short clip (${totalDur.toFixed(0)}s) — context genuinely ends here, keeping`);
    }

    usedIndices.add(topBlock.originalIndex);

    scored.forEach((b) => {
      if (!usedIndices.has(b.originalIndex)) {
        const overlapsSegment = segments.some(
          (seg) => b.startSec >= seg.startSec - 1 && b.endSec <= seg.endSec + 1
        );
        if (overlapsSegment) usedIndices.add(b.originalIndex);
      }
    });

    const clipStart = segments[0].startSec;
    const clipEnd   = segments[segments.length - 1].endSec;
    const clipDur   = clipEnd - clipStart;

    const transcriptSegments = segments.flatMap((seg) =>
      scored.filter(
        (b) => b.startSec >= seg.startSec - 1.0 && b.endSec <= seg.endSec + 1.0
      )
    );
    const transcript = JSON.stringify(transcriptSegments);
    const plainText = transcriptSegments.map(b => b.text).join(" ");

    const topic        = detectTopic(plainText);
    const finalEmotion = topBlock.ollamaEmotionOverride || topBlock.emotion;
    const colorGrade   = topBlock.ollamaGradeOverride   || emotionToColorGrade(finalEmotion, topBlock.role);
    const audioMood    = topBlock.ollamaAudioOverride    || emotionToAudioMood(finalEmotion, topic);
    const directives   = buildEditingDirectives(topic, finalEmotion, topBlock.role);
    const titleWords   = (plainText || topBlock.text).trim().split(/\s+/).slice(0, 7).join(" ");

    const clipInstability = layoutMap
      ? _layoutInstability(layoutMap, clipStart, clipEnd)
      : null;

    const plan = {
      startSec:      clipStart,
      endSec:        clipEnd,
      title:         titleWords.length > 5 ? titleWords + "..." : `Highlight ${clipPlans.length + 1}`,
      hookScore:     Math.min(92, Math.round(45 + topBlock.score * 0.4)),
      transcript,
      contentType:   topic,
      topic,
      emotion:       finalEmotion,
      colorGrade,
      audioMood,
      narrativeRole: segments.length > 1 ? "arc" : topBlock.role,
      segments,
      layoutInstability: clipInstability !== null ? parseFloat(clipInstability.toFixed(3)) : undefined,
      layoutStable:      clipInstability !== null ? clipInstability <= 0.25 : undefined,
      directives:        { ...directives, colorGrade, audioMood },
      reason:
        segments.length > 1
          ? `Narrative: ${segments.map((s) => s.role).join("→")}`
          : `${topBlock.role} @${Math.round(topBlock.posRatio * 100)}%`,
    };

    console.log(
      `      📍 Clip: ${(clipStart / 60).toFixed(1)}m-${(clipEnd / 60).toFixed(1)}m (${clipDur.toFixed(0)}s)` +
      ` [${plan.reason}]` +
      (clipInstability !== null ? ` layout-instability=${(clipInstability * 100).toFixed(0)}%` : "")
    );

    if (clipPlans.some((ex) => overlaps(plan, ex))) {
      console.warn(`      ⚠️  Skipping — overlaps existing clip`);
      continue;
    }

    clipPlans.push(plan);
  }

  // ── PADDING PASS (non-overlapping): fill from unused blocks ─
  if (clipPlans.length < clipCount) {
    const remaining = [...scored]
      .filter((b) => !usedIndices.has(b.originalIndex))
      .sort((a, b) => b.score - a.score);

    for (const block of remaining) {
      if (clipPlans.length >= clipCount) break;
      if (usedIndices.has(block.originalIndex)) continue;

      let startSec = block.startSec;
      let endSec   = block.endSec;
      const blockDur = endSec - startSec;

      if (blockDur < SOFT_MIN_CLIP_DUR) {
        let idx = block.originalIndex + 1;
        while (idx < blocks.length && endSec - startSec < SOFT_MIN_CLIP_DUR) {
          if (usedIndices.has(idx)) { idx++; continue; }
          const nb  = blocks[idx];
          const gap = nb.startSec - endSec;
          if (gap > 8.0) break;
          endSec = nb.endSec;
          idx++;
        }
      }

      endSec = Math.min(endSec, startSec + MAX_CLIP_DUR);
      const dur = endSec - startSec;
      if (dur < MIN_CLIP_DUR) { usedIndices.add(block.originalIndex); continue; }

      if (allWords.length > 0) {
        startSec = snapToSentenceStart(allWords, startSec);
        endSec   = snapToSentenceEnd(allWords, endSec, 15.0);
      }

      const padTranscript = JSON.stringify([{ start: startSec, end: endSec, text: block.text }]);

      const padPlan = {
        startSec,
        endSec,
        title: (block.text.trim().split(/\s+/).slice(0, 7).join(" ") || `Clip ${clipPlans.length + 1}`) + "...",
        hookScore: Math.min(72, Math.round(35 + block.score * 0.3)),
        transcript: padTranscript,
        contentType: detectTopic(block.text),
        topic: detectTopic(block.text),
        emotion: block.emotion,
        colorGrade: emotionToColorGrade(block.emotion, block.role),
        audioMood: emotionToAudioMood(block.emotion, detectTopic(block.text)),
        narrativeRole: block.role,
        segments: [{ startSec, endSec, role: block.role }],
        layoutInstability: layoutMap ? parseFloat(_layoutInstability(layoutMap, startSec, endSec).toFixed(3)) : undefined,
        layoutStable: layoutMap ? _layoutInstability(layoutMap, startSec, endSec) <= 0.25 : undefined,
        directives: buildEditingDirectives(detectTopic(block.text), block.emotion, block.role),
        reason: `Pad @${Math.round(block.posRatio * 100)}%`,
      };

      if (clipPlans.some((ex) => overlaps(padPlan, ex))) { usedIndices.add(block.originalIndex); continue; }

      usedIndices.add(block.originalIndex);
      clipPlans.push(padPlan);
      console.log(
        `      📍 Pad clip ${clipPlans.length}/${clipCount}: ${(startSec/60).toFixed(1)}m-${(endSec/60).toFixed(1)}m (${dur.toFixed(0)}s)`
      );
    }
  }

  // ── OVERLAP FILL PASS: guarantee exact count ─────────────────
  // When strict passes still can't reach clipCount (video too short,
  // too few blocks, or aggressive quality filters removed clips),
  // distribute remaining slots evenly across the timeline using
  // overlapping story-contextual windows. This is the final safety net
  // and will ALWAYS reach exactly clipCount.
  if (clipPlans.length < clipCount) {
    const stillNeeded = clipCount - clipPlans.length;
    console.log(
      `   ⚡ Strict passes gave ${clipPlans.length}/${clipCount} — activating overlap fill for ${stillNeeded} more`
    );

    const overlapClips = buildOverlapFillClips(
      stillNeeded,
      clipCount,
      clipPlans,
      blocks,
      scored,
      allWords,
      totalDuration,
      targetDuration,
      layoutMap
    );

    clipPlans.push(...overlapClips);
  }

  if (clipPlans.length < clipCount) {
    // Extremely edge case — video so short even overlap fill couldn't
    // produce valid windows. Warn and return what we have.
    console.warn(
      `   ⚠️  Final count: ${clipPlans.length}/${clipCount} — video too short to produce more distinct clips`
    );
  }

  return clipPlans.sort((a, b) => a.startSec - b.startSec);
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORTS
// ─────────────────────────────────────────────────────────────

/**
 * buildStoryClips
 *
 * @param {Array}   segments           - Whisper transcript segments
 * @param {number}  clipCount          - Exact number of clips to produce
 * @param {number}  targetDurationSecs - Ideal clip length in seconds
 * @param {Object}  layoutMap          - Optional { [sec]: mode } from clipSelector.buildLayoutMap()
 */
async function buildStoryClips(segments, clipCount, targetDurationSecs, layoutMap) {
  if (!segments || !segments.length) return [];

  const target = targetDurationSecs || TARGET_CLIP_DUR;
  const lm     = layoutMap || null;
  console.log(`   📖 Building story structure from ${segments.length} segments...`);
  if (lm && Object.keys(lm).length > 0) {
    console.log(`   📖 Layout map active: ${Object.keys(lm).length}s of layout data`);
  }

  const allWords = flattenWords(segments);
  const blocks   = parseThoughtBlocks(segments);

  console.log(
    `   📖 ${blocks.length} thought blocks | min=${MIN_CLIP_DUR}s soft=${SOFT_MIN_CLIP_DUR}s target=${TARGET_CLIP_DUR}s max=${MAX_CLIP_DUR}s`
  );

  if (!blocks.length) return [];

  const fullTranscript = segments.map((s) => s.text).join(" ");
  const ollamaPlan     = await getOllamaEditingPlan(fullTranscript, blocks, clipCount);
  const plans          = assembleClipPlans(blocks, clipCount, target, allWords, ollamaPlan, lm);

  console.log(`   📖 ${plans.length}/${clipCount} story clips assembled:`);
  plans.forEach((p, i) => {
    const dur  = (p.endSec - p.startSec).toFixed(0);
    const segs = p.segments.length > 1
      ? ` [${p.segments.map((s) => s.role).join("+")}]`
      : "";
    const stability = p.layoutInstability !== undefined
      ? ` instab=${(p.layoutInstability * 100).toFixed(0)}%`
      : "";
    console.log(`      ${i + 1}. "${p.title}" ${dur}s | ${p.emotion}/${p.colorGrade}${segs}${stability}`);
  });

  return plans;
}

/**
 * buildStoryClipsSync — synchronous fallback (no LLM)
 */
function buildStoryClipsSync(segments, clipCount, targetDurationSecs, layoutMap) {
  if (!segments || !segments.length) return [];
  const target   = targetDurationSecs || TARGET_CLIP_DUR;
  const allWords = flattenWords(segments);
  const blocks   = parseThoughtBlocks(segments);
  if (!blocks.length) return [];
  return assembleClipPlans(blocks, clipCount, target, allWords, null, layoutMap || null);
}

module.exports = {
  buildStoryClips,
  buildStoryClipsSync,
  detectTopic,
  detectEmotion,
  buildEditingDirectives,
};