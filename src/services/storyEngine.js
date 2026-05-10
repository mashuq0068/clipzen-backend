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
 *   2. Clip count is ALWAYS honoured exactly as provided — no capping.
 *      (The old getSmartClipCount was removed from clipSelector; storyEngine
 *      never second-guessed clipCount itself anyway.)
 *   3. assembleClipPlans propagates layoutMap into scoreBlock.
 */

const { llmWithRetry, isLLMAvailable } = require("./llmProvider");

// ─────────────────────────────────────────────────────────────
// CLIP DURATION TARGETS
// ─────────────────────────────────────────────────────────────
const MIN_CLIP_DUR      = 20;   // absolute floor — hard reject below this
const SOFT_MIN_CLIP_DUR = 50;   // target minimum — always try to reach
const TARGET_CLIP_DUR   = 60;   // ideal sweet spot
const MAX_CLIP_DUR      = 180;  // hard cap — 3 mins max
const BLOCK_MAX_DUR     = 60;   // max single thought block before splitting

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
/**
 * Count mode transitions per second inside [startSec, endSec].
 * Returns 0 (stable) … 1 (constant switching).
 * layoutMap: { [integerSec]: "face"|"split"|"passthrough"|"blur_overlay" }
 */
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

  for (let i = 0; i < segments.length; i++) {
    const seg  = segments[i];
    const next = segments[i + 1];
    cur.segments.push(seg);
    cur.endSec  = seg.end;
    cur.text   += (cur.text ? " " : "") + seg.text.trim();

    const dur   = cur.endSec - cur.startSec;
    const gap   = next ? next.start - seg.end : 0;
    const isEnd = /[.!?]["']?\s*$/.test(seg.text.trim());

    if (
      (gap > 0.8 && isEnd) ||
      gap > 1.5 ||
      (dur > BLOCK_MAX_DUR && isEnd) ||
      dur > BLOCK_MAX_DUR + 12
    ) {
      if (cur.text.trim().split(/\s+/).length >= 5) blocks.push({ ...cur });
      if (next) cur = { segments: [], startSec: next.start, endSec: 0, text: "" };
    } else if (i === segments.length - 1) {
      if (cur.text.trim().split(/\s+/).length >= 5) blocks.push({ ...cur });
    }
  }
  return blocks;
}

// ─────────────────────────────────────────────────────────────
// BLOCK SCORER
// layoutMap is optional — when provided, unstable blocks are penalised.
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

  // ── Layout stability penalty ────────────────────────────────
  // A block whose layout switches constantly is much harder to edit cleanly.
  // Penalise it proportionally so stable blocks are preferred.
  if (layoutMap) {
    const instability    = _layoutInstability(layoutMap, block.startSec, block.endSec);
    const layoutPenalty  = Math.round(instability * 40); // up to -40 pts (max instability=1)
    if (layoutPenalty > 0) {
      score -= layoutPenalty;
      // Optional trace — uncomment when debugging:
      // console.log(`   [scoreBlock] ${block.startSec.toFixed(0)}s-${block.endSec.toFixed(0)}s instability=${(instability*100).toFixed(0)}% → -${layoutPenalty}pts`);
    }
  }

  return { score, role };
}

// ─────────────────────────────────────────────────────────────
// LLM EDITING PLAN
// ─────────────────────────────────────────────────────────────
async function getOllamaEditingPlan(transcript, blocks, clipCount) {
  const blockSummaries = blocks.slice(0, 20).map((b, i) => ({
    i,
    text:  b.text.substring(0, 120),
    start: b.startSec.toFixed(1),
    end:   b.endSec.toFixed(1),
    dur:   (b.endSec - b.startSec).toFixed(0),
  }));

  const prompt = `You are a professional short-form video editor. Select exactly ${clipCount} best clips.
Target clip duration: 50-120 seconds each. Prefer longer, complete story arcs.
You MUST return exactly ${clipCount} clips — no more, no less.

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

    const raw = await llmWithRetry({ prompt, maxTokens: 500, temperature: 0.1 });
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
    console.log(`   🤖 LLM plan: ${parsed.clips.length} clips selected (requested: ${clipCount})`);
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
// STORY ASSEMBLER
// layoutMap is now threaded through so block scoring can use it.
// clipCount is ALWAYS honoured exactly.
// ─────────────────────────────────────────────────────────────
function assembleClipPlans(blocks, clipCount, targetDuration, allWords, ollamaPlan, layoutMap) {
  const totalDuration = blocks.length > 0 ? blocks[blocks.length - 1].endSec : 0;

  const scored = blocks.map((block, i) => {
    // Pass layoutMap into scoreBlock so unstable regions are penalised
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
    for (const c of ollamaPlan.clips) {
      const idx = c.blockIndex;
      if (idx >= 0 && idx < scored.length) {
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

  for (const topBlock of candidateOrder) {
    // EXACT count — never stop early, never over-produce
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

    const transcript = segments
      .map((seg) =>
        scored
          .filter((b) => b.startSec >= seg.startSec - 1.0 && b.endSec <= seg.endSec + 1.0)
          .map((b) => b.text)
          .join(" ")
      )
      .join(" ")
      .trim() || topBlock.text;

    const topic        = detectTopic(transcript);
    const finalEmotion = topBlock.ollamaEmotionOverride || topBlock.emotion;
    const colorGrade   = topBlock.ollamaGradeOverride   || emotionToColorGrade(finalEmotion, topBlock.role);
    const audioMood    = topBlock.ollamaAudioOverride    || emotionToAudioMood(finalEmotion, topic);
    const directives   = buildEditingDirectives(topic, finalEmotion, topBlock.role);
    const titleWords   = topBlock.text.trim().split(/\s+/).slice(0, 7).join(" ");

    // Layout instability of the assembled clip (spans all its segments)
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
      // Layout metadata for downstream consumers (clipSelector, videoWorker)
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

  // ── PADDING PASS ────────────────────────────────────────────────────────────
  // If the main loop produced fewer clips than requested (e.g. not enough high-
  // scoring blocks), fill up with any remaining unused blocks in score order.
  // This ensures clip_count from the DB is always honoured exactly.
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

      // Expand short blocks forward using adjacent unused blocks
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

      const padPlan = {
        startSec,
        endSec,
        title: (block.text.trim().split(/\s+/).slice(0, 7).join(" ") || `Clip ${clipPlans.length + 1}`) + "...",
        hookScore: Math.min(72, Math.round(35 + block.score * 0.3)),
        transcript: block.text,
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

  if (clipPlans.length < clipCount) {
    console.warn(`   ⚠️  Only ${clipPlans.length}/${clipCount} clips possible — not enough non-overlapping content`);
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
 * buildStoryClipsSync — synchronous fallback (no LLM, no layout map needed here
 * since the async path is always tried first; layoutMap still accepted for parity).
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