/**
 * iconDirector.js
 *
 * LLM-DRIVEN EMOJI / ICON SELECTION
 *
 * Picks the most context-relevant emoji for a clip's transcript and places
 * each one at the exact moment its concept is spoken — using the real
 * word-level timestamps. The LLM only returns emoji ("text icons"); it does
 * NOT need to know which SVG files exist.
 *
 * Design goals (from product spec):
 *   ✅ Most relevant emoji for the content (no random/repeated icons)
 *   ✅ Placed at the perfect time of the matching words
 *   ✅ Spread across the whole clip, varied
 *   ✅ Each icon gets a varied entrance animation so it looks lively
 *   ✅ If the LLM is unavailable/garbage → returns null so the caller can
 *      fall back to the rule-based iconSystem.
 *
 * Output shape matches iconSystem overlays exactly:
 *   { emoji, atSec, x, y, size, anim }
 */

const { llmWithRetry, isLLMAvailable } = require("./llmProvider");
const { buildIconOverlaysFromTranscript } = require("./iconSystem");

// Entrance animations cycled across icons so consecutive ones differ.
// These are interpreted by the Remotion renderer (CaptionedVideo.tsx).
const ANIM_CYCLE = ["pop", "drop", "bounce", "spin", "zoom", "float"];

// Spacing / placement guards — tuned for a DENSE cadence (~1 icon every 2–3s)
const MIN_GAP_SEC = 2.0; // no two icons closer than this
const DEDUPE_WINDOW_SEC = 6; // same emoji not allowed to repeat within this
// After LLM placement, fill any region this far from the nearest icon using
// the rule-based (keyword-relevant) engine, so the whole clip stays lively.
const FILL_WHEN_FARTHER_THAN = 3.0;
const ICON_X = 0.5;
const ICON_Y = 0.68;
const ICON_SIZE = 100;

// Matches a single emoji / pictographic grapheme (incl. ZWJ sequences,
// variation selectors, keycaps, skin-tone modifiers, regional-indicator flags).
// ️ = variation selector-16, ⃣ = combining keycap.
const EMOJI_RE =
  /(?:\p{Extended_Pictographic}(?:\u{200D}\p{Extended_Pictographic}|[️⃣\u{1F3FB}-\u{1F3FF}])*|[\u{1F1E6}-\u{1F1FF}]{2})/u;

/**
 * Group flat word timings into short timed phrases for the prompt.
 * Each line: { atSec, text } where atSec = start of the first word.
 */
function buildTimedTranscript(words, wordsPerLine = 4) {
  const lines = [];
  let cur = [];
  let curStart = null;
  for (const w of words) {
    const word = (w.word || "").trim();
    if (!word) continue;
    if (curStart == null) curStart = w.startSec;
    cur.push(word);
    if (cur.length >= wordsPerLine) {
      lines.push({ atSec: curStart, text: cur.join(" ") });
      cur = [];
      curStart = null;
    }
  }
  if (cur.length) lines.push({ atSec: curStart ?? 0, text: cur.join(" ") });
  return lines;
}

/** Pull the first valid emoji grapheme out of an arbitrary string. */
function extractEmoji(raw) {
  if (!raw || typeof raw !== "string") return null;
  const m = raw.match(EMOJI_RE);
  return m ? m[0] : null;
}

/**
 * Snap a timestamp to the nearest word onset so icons align with speech.
 * Only snaps when a word starts within 1.2s — otherwise keeps the original.
 */
function snapToWordStart(atSec, wordStarts) {
  if (!wordStarts || wordStarts.length === 0) return atSec;
  let best = atSec;
  let bestDelta = Infinity;
  for (const s of wordStarts) {
    const d = Math.abs(s - atSec);
    if (d < bestDelta) {
      bestDelta = d;
      best = s;
    }
  }
  return bestDelta <= 1.2 ? best : atSec;
}

/** Coerce a number from a number or messy string ("2.1s", "2,1", "at 2.1"). */
function coerceNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string") {
    const m = v.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }
  return NaN;
}

/** Robustly pull a JSON array out of an LLM response that may include prose. */
function parseJsonArray(text) {
  if (!text) return null;
  // Strip code fences
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function buildPrompt(lines, duration, targetCount) {
  const transcript = lines
    .map((l) => `[${l.atSec.toFixed(1)}] ${l.text}`)
    .join("\n");

  return `You are an expert short-form video editor adding emoji overlays that pop on screen exactly when each idea is spoken.

The transcript below is split into timed segments. Each line starts with the timestamp in seconds when those words are spoken:

${transcript}

The clip is ${duration.toFixed(1)} seconds long.

TASK: Add a steady stream of emoji that visually represent what is being SAID, keeping the clip lively from start to finish.

RELEVANCE (most important):
- For each moment, read the actual words and pick the SINGLE emoji that best depicts the key noun, verb, or concept being said right there.
- Examples of good matching: money/salary/profit → 💰, growth/increase → 📈, decline/loss → 📉, idea/realize → 💡, time/years/deadline → ⏰, win/best/champion → 🏆, danger/mistake/warning → ⚠️, love/family → ❤️, fight/war/rival → ⚔️, food → 🍔, travel/world → 🌍, tech/AI → 🤖, question → ❓, fire/viral/hot → 🔥, fear/shock → 😱, study/learn → 📚.
- The emoji must MATCH the meaning — never decorative or random.

DENSITY:
- Place an emoji roughly every 2 to 3 seconds so there is almost always something on screen. Aim for about ${targetCount} emoji total, spread evenly across the WHOLE clip (including the beginning and the end).
- Anchor each emoji to the timestamp where its matching words are spoken.

VARIETY:
- Use lots of DIFFERENT emoji. Do NOT repeat the same emoji within a few seconds. Never spam one emoji.

OUTPUT:
- "emoji" must contain ONLY a real emoji character (like 💰) — never words, names, codes, or shortcodes like :money:.
- "atSec" must be a plain number of seconds, with NO units (write 4.6, not "4.6s").
- Return ONLY a JSON array, no explanation:
[{"atSec": 2.1, "emoji": "💰"}, {"atSec": 4.6, "emoji": "📈"}, {"atSec": 7.0, "emoji": "💡"}]`;
}

/**
 * Clamp, validate, sort, de-duplicate and space out raw LLM picks, then
 * map them to overlay objects with cycling entrance animations.
 */
function normalizePlacements(rawPicks, duration, wordStarts = []) {
  const cleaned = [];
  for (const p of rawPicks) {
    if (!p || typeof p !== "object") continue;
    // Accept the emoji under several possible key names
    const emojiRaw = p.emoji ?? p.icon ?? p.symbol ?? p.e;
    const emoji = extractEmoji(typeof emojiRaw === "string" ? emojiRaw : "");
    if (!emoji) continue;
    // Accept the timestamp under several names; tolerate "2.1s" / "2,1" strings
    let atSec = coerceNumber(
      p.atSec ?? p.at ?? p.time ?? p.timestamp ?? p.sec ?? p.second ?? p.t,
    );
    if (!Number.isFinite(atSec)) continue;
    // Snap to the nearest spoken-word onset so the icon lands ON the word
    // (not a couple seconds early from coarse line timestamps).
    atSec = snapToWordStart(atSec, wordStarts);
    // Keep inside the clip, away from the very edges
    atSec = Math.max(0.5, Math.min(atSec, Math.max(0.5, duration - 1)));
    cleaned.push({ atSec, emoji });
  }

  cleaned.sort((a, b) => a.atSec - b.atSec);

  const spaced = [];
  let lastSec = -Infinity;
  const recent = []; // [{emoji, atSec}] within DEDUPE_WINDOW_SEC
  for (const p of cleaned) {
    if (p.atSec - lastSec < MIN_GAP_SEC) continue; // enforce spacing
    // skip if same emoji used very recently
    const dup = recent.some(
      (r) => r.emoji === p.emoji && p.atSec - r.atSec < DEDUPE_WINDOW_SEC,
    );
    if (dup) continue;
    spaced.push(p);
    lastSec = p.atSec;
    recent.push(p);
    while (recent.length && p.atSec - recent[0].atSec >= DEDUPE_WINDOW_SEC) {
      recent.shift();
    }
  }

  return spaced.map((p) => ({
    emoji: p.emoji,
    atSec: p.atSec,
    x: ICON_X,
    y: ICON_Y,
    size: ICON_SIZE,
  }));
}

/**
 * Keep the clip dense: wherever the LLM left a region farther than
 * FILL_WHEN_FARTHER_THAN from any icon, drop in a relevant keyword-matched
 * icon from the rule-based engine. LLM picks always win; rule icons only
 * patch the empty stretches. Min-gap and no-immediate-repeat are enforced.
 */
function densify(primary, filler) {
  const placed = [...primary].sort((a, b) => a.atSec - b.atSec);

  for (const f of [...filler].sort((a, b) => a.atSec - b.atSec)) {
    let nearest = Infinity;
    for (const p of placed) {
      const d = Math.abs(p.atSec - f.atSec);
      if (d < nearest) nearest = d;
    }
    // Only add filler in genuinely sparse regions
    if (nearest >= FILL_WHEN_FARTHER_THAN) {
      placed.push(f);
      placed.sort((a, b) => a.atSec - b.atSec);
    }
  }

  // Final pass: enforce min-gap + no immediate duplicate icon, assign anims
  const out = [];
  let lastSec = -Infinity;
  let lastKey = null;
  let i = 0;
  for (const o of placed) {
    if (o.atSec - lastSec < MIN_GAP_SEC) continue;
    const key = o.emoji || o.icon;
    if (key && key === lastKey) continue;
    out.push({
      emoji: o.emoji,
      icon: o.icon,
      atSec: o.atSec,
      x: ICON_X,
      y: ICON_Y,
      size: o.size ?? ICON_SIZE,
      anim: ANIM_CYCLE[i % ANIM_CYCLE.length],
    });
    lastSec = o.atSec;
    lastKey = key;
    i++;
  }
  return out;
}

/**
 * Main entry — returns an array of icon overlays, or null on any failure
 * (so the caller falls back to the rule-based iconSystem).
 *
 * @param {Array}  words            word timings [{ word, startSec, endSec }]
 * @param {number} clipDurationSecs clip length in seconds
 */
async function buildIconOverlaysLLM(words, clipDurationSecs) {
  try {
    if (!words || words.length === 0) return null;
    const duration = clipDurationSecs || 30;

    if (!(await isLLMAvailable())) {
      console.warn("      🎭 Icons (LLM): provider unavailable — using rule fallback");
      return null;
    }

    const lines = buildTimedTranscript(words);
    if (lines.length === 0) return null;

    // Dense cadence: ~1 icon every 2.8s, clamped to a sane range
    const targetCount = Math.max(5, Math.min(90, Math.round(duration / 2.8)));

    const prompt = buildPrompt(lines, duration, targetCount);

    const response = await llmWithRetry(
      { prompt, maxTokens: 1200, temperature: 0.35 },
      1, // 1 retry — keep render latency low
      1500,
    );

    const rawPicks = parseJsonArray(response);
    if (!rawPicks || rawPicks.length === 0) {
      console.warn("      🎭 Icons (LLM): no parseable picks — using rule fallback");
      return null;
    }

    const wordStarts = words
      .map((w) => w.startSec)
      .filter((s) => Number.isFinite(s))
      .sort((a, b) => a - b);
    const llmOverlays = normalizePlacements(rawPicks, duration, wordStarts);
    if (llmOverlays.length === 0) {
      // Show what the model actually returned so the failure is debuggable
      const sample = JSON.stringify(rawPicks.slice(0, 3));
      console.warn(
        `      🎭 Icons (LLM): all ${rawPicks.length} picks invalid (sample: ${sample.slice(0, 160)}) — using rule fallback`,
      );
      return null;
    }

    // Fill any sparse stretches with relevant rule-based icons so the clip
    // keeps a steady ~2–3s cadence end-to-end.
    let ruleFiller = [];
    try {
      ruleFiller = buildIconOverlaysFromTranscript(words, duration) || [];
    } catch {
      ruleFiller = [];
    }
    const overlays = densify(llmOverlays, ruleFiller);

    console.log(
      `      🎭 Icons (LLM+fill): ${overlays.length} (llm:${llmOverlays.length}) | ${overlays
        .map((o) => `${o.emoji || o.icon}@${o.atSec.toFixed(1)}s`)
        .join(" ")}`,
    );
    return overlays;
  } catch (err) {
    console.warn(
      `      🎭 Icons (LLM) failed: ${err?.message?.split("\n")[0]} — using rule fallback`,
    );
    return null;
  }
}

module.exports = { buildIconOverlaysLLM };
