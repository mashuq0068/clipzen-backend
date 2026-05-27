/* eslint-disable no-undef */
/**
 * editingDirector.js
 *
 * The editing intelligence layer.
 *
 * Input:  transcript + word timestamps + content metadata
 * Output: structured EditingPlan JSON that Remotion consumes directly
 *
 * Architecture:
 * - Fast keyword analysis runs first (zero latency, always works)
 * - Ollama enriches the plan with creative decisions (optional, non-blocking)
 * - Designed so Claude/Gemini can replace Ollama with zero code changes
 *
 * The output JSON drives ALL visual decisions:
 * zoom timing, word emphasis, color theme, emojis, caption position,
 * background blur, lower thirds, pacing — nothing is hardcoded.
 */

const axios = require("axios");

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";

// ─────────────────────────────────────────────────────────────
// THEME SYSTEM
// Each theme is a complete visual language applied to the whole clip
// ─────────────────────────────────────────────────────────────
const THEMES = {
  energy: {
    name: "energy",
    primaryColor: "#FF4500",
    activeWordColor: "#FFD700",
    captionStroke: "#000000",
    strokeWidth: 8,
    fontSize: 64,
    fontFamily: "Anton",
    fontWeight: 900,
    uppercase: true,
    bgBoxColor: "transparent",
    captionPosition: "bottom",
    progressBarColor: "#FFD700",
    desc: "Sports, fitness, hype content",
  },
  viral: {
    name: "viral",
    primaryColor: "#FFFFFF",
    activeWordColor: "#FFE000",
    captionStroke: "#000000",
    strokeWidth: 8,
    fontSize: 62,
    fontFamily: "Montserrat",
    fontWeight: 900,
    uppercase: true,
    bgBoxColor: "transparent",
    captionPosition: "bottom",
    progressBarColor: "#FFE000",
    desc: "MrBeast style, general viral",
  },
  authority: {
    name: "authority",
    primaryColor: "#FFFFFF",
    activeWordColor: "#FF4500",
    captionStroke: "#000000",
    strokeWidth: 10,
    fontSize: 76,
    fontFamily: "Anton",
    fontWeight: 900,
    uppercase: true,
    bgBoxColor: "transparent",
    captionPosition: "top",
    progressBarColor: "#FF4500",
    desc: "Business, motivation, Hormozi style",
  },
  clean: {
    name: "clean",
    primaryColor: "rgba(255,255,255,0.5)",
    activeWordColor: "#FFFFFF",
    captionStroke: "transparent",
    strokeWidth: 0,
    fontSize: 46,
    fontFamily: "Inter",
    fontWeight: 700,
    uppercase: false,
    bgBoxColor: "rgba(15,15,15,0.82)",
    captionPosition: "bottom",
    progressBarColor: "#FFFFFF",
    desc: "Podcast, education, calm content",
  },
  dramatic: {
    name: "dramatic",
    primaryColor: "#FFFFFF",
    activeWordColor: "#FF0040",
    captionStroke: "transparent",
    strokeWidth: 0,
    fontSize: 60,
    fontFamily: "Space Grotesk",
    fontWeight: 800,
    uppercase: true,
    bgBoxColor: "transparent",
    captionPosition: "bottom",
    progressBarColor: "#FF0040",
    desc: "Mystery, news, suspense, reveals",
  },
  warm: {
    name: "warm",
    primaryColor: "#FF6B35",
    activeWordColor: "#FFD700",
    captionStroke: "#000000",
    strokeWidth: 6,
    fontSize: 66,
    fontFamily: "Anton",
    fontWeight: 900,
    uppercase: true,
    bgBoxColor: "transparent",
    captionPosition: "bottom",
    progressBarColor: "#FFD700",
    desc: "Cooking, lifestyle, food content",
  },
  playful: {
    name: "playful",
    primaryColor: "#FFE000",
    activeWordColor: "#FF69B4",
    captionStroke: "#000000",
    strokeWidth: 8,
    fontSize: 60,
    fontFamily: "Montserrat",
    fontWeight: 900,
    uppercase: true,
    bgBoxColor: "transparent",
    captionPosition: "bottom",
    progressBarColor: "#FF69B4",
    desc: "Comedy, celebrations, fun content",
  },
  techy: {
    name: "techy",
    primaryColor: "#FFFFFF",
    activeWordColor: "#00FF41",
    captionStroke: "transparent",
    strokeWidth: 0,
    fontSize: 58,
    fontFamily: "Space Grotesk",
    fontWeight: 800,
    uppercase: true,
    bgBoxColor: "transparent",
    captionPosition: "bottom",
    progressBarColor: "#00FF41",
    desc: "Gaming, tech, cyberpunk",
  },
};

// ─────────────────────────────────────────────────────────────
// SIGNAL DETECTION — keyword-level analysis
// ─────────────────────────────────────────────────────────────
const WORD_SIGNALS = {
  // Zoom in hard + scale caption 1.4x + beat hold before
  peak3: [
    "insane",
    "unbelievable",
    "shocking",
    "impossible",
    "never",
    "always",
    "everyone",
    "nobody",
    "million",
    "billion",
    "thousand",
    "zero",
    "died",
    "fired",
    "quit",
    "broke",
    "bankrupt",
    "lost",
    "won",
    "secret",
    "truth",
    "lie",
    "exposed",
    "finally",
  ],
  // Zoom in soft + yellow caption
  peak2: [
    "amazing",
    "incredible",
    "important",
    "massive",
    "huge",
    "perfect",
    "terrible",
    "best",
    "worst",
    "free",
    "expensive",
    "easy",
    "hard",
    "wrong",
    "right",
    "money",
    "rich",
    "poor",
    "success",
    "failure",
    "love",
    "hate",
    "fear",
    "powerful",
  ],
  // Light pulse
  peak1: [
    "actually",
    "literally",
    "basically",
    "honestly",
    "seriously",
    "exactly",
    "truly",
  ],
  // Beat hold before this word (pause = drama)
  beatHold: [
    "but",
    "however",
    "wait",
    "actually",
    "the thing is",
    "plot twist",
    "guess what",
    "except",
    "unless",
    "yet",
    "still",
  ],
};

const TOPIC_SIGNATURES = {
  time: [
    "time",
    "second",
    "minute",
    "hour",
    "clock",
    "moment",
    "past",
    "future",
    "age",
    "deadline",
  ],
  money: [
    "money",
    "dollar",
    "million",
    "billion",
    "profit",
    "revenue",
    "income",
    "invest",
    "wealth",
  ],
  health: [
    "health",
    "body",
    "sleep",
    "exercise",
    "diet",
    "stress",
    "brain",
    "pain",
    "doctor",
  ],
  success: [
    "success",
    "goal",
    "achieve",
    "win",
    "fail",
    "habit",
    "discipline",
    "mindset",
    "growth",
  ],
  technology: [
    "ai",
    "software",
    "code",
    "tech",
    "computer",
    "data",
    "algorithm",
    "model",
    "machine",
  ],
  science: [
    "science",
    "research",
    "theory",
    "experiment",
    "discovery",
    "universe",
    "physics",
  ],
  philosophy: [
    "life",
    "meaning",
    "truth",
    "reality",
    "consciousness",
    "purpose",
    "existence",
  ],
  sports: [
    "game",
    "match",
    "goal",
    "score",
    "team",
    "player",
    "win",
    "champion",
    "stadium",
  ],
  fitness: [
    "workout",
    "gym",
    "rep",
    "muscle",
    "strength",
    "cardio",
    "protein",
    "training",
  ],
  cooking: [
    "recipe",
    "cook",
    "ingredient",
    "bake",
    "fry",
    "flavor",
    "taste",
    "chef",
    "dish",
  ],
  comedy: [
    "funny",
    "joke",
    "laugh",
    "prank",
    "hilarious",
    "meme",
    "roast",
    "comedy",
  ],
  business: [
    "business",
    "startup",
    "revenue",
    "marketing",
    "sales",
    "customer",
    "brand",
    "roi",
  ],
  gaming: [
    "game",
    "player",
    "level",
    "boss",
    "fps",
    "esports",
    "stream",
    "console",
  ],
};

const EMOTION_SIGNATURES = {
  motivational: [
    "never give up",
    "you can",
    "believe",
    "possible",
    "achieve",
    "dream",
    "potential",
    "inspire",
  ],
  warning: [
    "don't",
    "never do",
    "stop",
    "avoid",
    "dangerous",
    "wrong",
    "mistake",
    "careful",
    "problem",
  ],
  surprising: [
    "actually",
    "shocking",
    "nobody knows",
    "secret",
    "revealed",
    "most people",
    "truth",
  ],
  explanatory: [
    "because",
    "which means",
    "that's why",
    "so",
    "therefore",
    "here's how",
  ],
  questioning: [
    "?",
    "what if",
    "imagine",
    "have you",
    "why do",
    "how does",
    "what is",
  ],
};

const EMOJI_TRIGGERS = [
  {
    words: ["million", "billion", "dollar", "money", "rich", "wealth"],
    emoji: "💰",
  },
  { words: ["fire", "hot", "insane", "crazy", "wild", "unreal"], emoji: "🔥" },
  {
    words: ["won", "win", "champion", "record", "first", "victory"],
    emoji: "🏆",
  },
  {
    words: ["amazing", "mindblowing", "unbelievable", "shocking"],
    emoji: "🤯",
  },
  {
    words: ["strong", "workout", "muscle", "gym", "gains", "power"],
    emoji: "💪",
  },
  {
    words: ["idea", "secret", "hack", "tip", "method", "strategy"],
    emoji: "💡",
  },
  { words: ["goal", "target", "focus", "vision", "dream"], emoji: "🎯" },
  { words: ["love", "heart", "passion", "care"], emoji: "❤️" },
  { words: ["dead", "died", "death", "destroy", "end"], emoji: "💀" },
  { words: ["game", "play", "gaming", "level", "score"], emoji: "🎮" },
  { words: ["time", "clock", "second", "minute", "hour"], emoji: "⏰" },
  { words: ["food", "eat", "cook", "taste", "delicious"], emoji: "🍽️" },
  { words: ["warning", "careful", "danger", "stop", "mistake"], emoji: "⚠️" },
  { words: ["music", "song", "beat", "rhythm", "vibe"], emoji: "🎵" },
  { words: ["science", "research", "discovery", "study"], emoji: "🔬" },
];

// ─────────────────────────────────────────────────────────────
// KEYWORD ANALYSIS (fast, deterministic, runs in <5ms)
// ─────────────────────────────────────────────────────────────
function analyzeKeywords(transcript) {
  const text = transcript.toLowerCase();

  // Topic
  let topTopic = "general";
  let topScore = 0;
  for (const [topic, keywords] of Object.entries(TOPIC_SIGNATURES)) {
    const score = keywords.filter((kw) => text.includes(kw)).length;
    if (score > topScore) {
      topScore = score;
      topTopic = score >= 2 ? topic : "general";
    }
  }

  // Emotion
  let topEmotion = "neutral";
  let emotScore = 0;
  for (const [emotion, signals] of Object.entries(EMOTION_SIGNATURES)) {
    const score = signals.filter((s) => text.includes(s)).length;
    if (score > emotScore) {
      emotScore = score;
      topEmotion = score >= 1 ? emotion : "neutral";
    }
  }

  // Theme from topic + emotion
  const themeMap = {
    sports: "energy",
    fitness: "energy",
    gaming: "techy",
    technology: "techy",
    cooking: "warm",
    comedy: "playful",
    business: "authority",
    success: "authority",
    money: "authority",
    philosophy: "clean",
    science: "clean",
    time: "dramatic",
    health: "clean",
    general: "viral",
  };
  let theme = themeMap[topTopic] || "viral";
  if (topEmotion === "motivational") theme = "authority";
  if (topEmotion === "warning") theme = "dramatic";
  if (topEmotion === "surprising") theme = "viral";

  return { topic: topTopic, emotion: topEmotion, theme };
}

// ─────────────────────────────────────────────────────────────
// WORD-LEVEL EVENT BUILDER
// Scans every word and attaches editing events
// ─────────────────────────────────────────────────────────────
function buildWordEvents(words) {
  const events = [];
  const emojiCooldown = { lastTime: -999 };
  const usedEmojis = new Set();

  words.forEach((word, i) => {
    const w = word.word.toLowerCase().replace(/[^a-z]/g, "");
    const t = word.startSec;
    const dur = word.endSec - word.startSec;
    const nextWord = words[i + 1];

    // ── EMPHASIS LEVEL ──────────────────────────────────────
    if (
      WORD_SIGNALS.peak3.some(
        (kw) => w === kw || word.word.toLowerCase().includes(kw),
      )
    ) {
      // Rotate through creative layouts so peak3 words don't all look the same
      const peak3Count = events.filter(
        (e) => e.type === "word_emphasis" && e.level === 3,
      ).length;
      // Floating keyword every other peak3 word — cinematic "lifted word" effect
      const shouldFloat = peak3Count % 2 === 0;
      // Alternate animation types for visual rhythm
      const animTypes = ["punch_in", "slam_down", "zoom_burst", "punch_in"];
      const animationType = animTypes[peak3Count % animTypes.length];

      events.push({
        timestamp: t,
        type: "word_emphasis",
        wordIndex: word.index,
        level: 3,
        scale: 1.45,
        emphasisScale: 1.55,
        colorOverride: "#FFFFFF",
        strokeBoost: 6,
        beatHoldBefore: 0.18,
        floatKeyword: shouldFloat,
        animationType,
        captionLayout: shouldFloat ? "float_top" : "impact_center",
      });
      // Hard zoom IN — starts 0.1s early so it lands ON the word
      events.push({
        timestamp: Math.max(0, t - 0.1),
        type: "zoom_in",
        intensity: 0.9,
        durationSecs: Math.max(dur + 0.5, 0.9),
      });
      events.push({
        timestamp: word.endSec + 0.55,
        type: "zoom_reset",
        durationSecs: 0.5,
      });
    } else if (
      WORD_SIGNALS.peak2.some(
        (kw) => w === kw || word.word.toLowerCase().includes(kw),
      )
    ) {
      events.push({
        timestamp: t,
        type: "word_emphasis",
        wordIndex: word.index,
        level: 2,
        scale: 1.2,
        emphasisScale: 1.28,
        colorOverride: "#FFE000",
        strokeBoost: 0,
        beatHoldBefore: 0,
        floatKeyword: false,
        animationType: "scale_pop",
        captionLayout: "inline_hero",
      });
      events.push({
        timestamp: Math.max(0, t - 0.05),
        type: "zoom_in",
        intensity: 0.45,
        durationSecs: Math.max(dur + 0.3, 0.6),
      });
      events.push({
        timestamp: word.endSec + 0.4,
        type: "zoom_reset",
        durationSecs: 0.55,
      });
    } else if (WORD_SIGNALS.peak1.some((kw) => w === kw)) {
      events.push({
        timestamp: t,
        type: "word_emphasis",
        wordIndex: word.index,
        level: 1,
        scale: 1.08,
        emphasisScale: 1.12,
        colorOverride: null,
        strokeBoost: 0,
        beatHoldBefore: 0,
        floatKeyword: false,
        animationType: "pulse",
        captionLayout: "inline",
      });
    }

    // ── NUMBERS — always yellow + slightly larger ────────────
    if (/\b\d[\d,\.]*/.test(word.word)) {
      events.push({
        timestamp: t,
        type: "word_emphasis",
        wordIndex: word.index,
        level: 2,
        scale: 1.18,
        emphasisScale: 1.22,
        colorOverride: "#FFE000",
        strokeBoost: 0,
        beatHoldBefore: 0,
        floatKeyword: false,
        animationType: "scale_pop",
        captionLayout: "inline_hero",
      });
    }

    // ── SILENCE GAP — dramatic beat ──────────────────────────
    if (nextWord && nextWord.startSec - word.endSec > 0.5) {
      events.push({
        timestamp: word.endSec,
        type: "silence_gap",
        durationSecs: nextWord.startSec - word.endSec,
      });
    }

    // ── EMOJI OVERLAYS ───────────────────────────────────────
    if (t - emojiCooldown.lastTime > 4.0) {
      // min 4s between emojis
      for (const { words: triggers, emoji } of EMOJI_TRIGGERS) {
        if (usedEmojis.has(emoji)) continue;
        if (triggers.some((kw) => w.includes(kw))) {
          const x = [0.12, 0.7, 0.75, 0.15][
            events.filter((e) => e.type === "emoji").length % 4
          ];
          const y =
            0.18 + events.filter((e) => e.type === "emoji").length * 0.07;
          events.push({
            timestamp: t,
            type: "emoji",
            emoji,
            x,
            y,
            size: 85,
          });
          usedEmojis.add(emoji);
          emojiCooldown.lastTime = t;
          break;
        }
      }
    }
  });

  // Deduplicate zoom events (no two zooms within 1.8s)
  const result = [];
  let lastZoom = -999;
  for (const e of events.sort((a, b) => a.timestamp - b.timestamp)) {
    if (e.type === "zoom_in") {
      if (e.timestamp - lastZoom < 1.8) continue;
      lastZoom = e.timestamp;
    }
    result.push(e);
  }

  // ═════════════════════════════════════════════════════════════
  // EMPHASIS COLOR ENRICHMENT (deterministic, per word)
  // ═════════════════════════════════════════════════════════════
  const EMPHASIS_WORDS = new Set([
    "million","billion","trillion","thousand","hundred","percent","zero",
    "never","always","secret","truth","actually","nobody","everyone",
    "impossible","shocking","insane","literally","danger","hidden","exposed",
    "unbelievable","surprising","crazy","mindblowing",
    "win","won","best","greatest","first","record","champion","top","elite",
    "legendary","perfect","genius","incredible","amazing",
    "stop","wrong","mistake","dead","die","fail","failure","worse","worst",
    "toxic","avoid","scam","fraud","fake","lie","trap",
    "now","today","immediately","free","new","only","last","limited",
    "power","money","rich","success","change","transform","broke","poor",
    "hack","simple","easy","hard","real",
  ]);

  const EMPHASIS_COLORS = [
    "#FFE000", "#FFE000", "#FFE000",   // yellow (60% weight)
    "#FF4500",                         // orange-red
    "#00E5FF",                         // cyan
    "#FF69B4",                         // pink
    "#00FF87",                         // green
  ];

  function _emphasisColorFor(word) {
    const clean = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!EMPHASIS_WORDS.has(clean)) return null;
    const idx = word.charCodeAt(0) % EMPHASIS_COLORS.length;
    return EMPHASIS_COLORS[idx];
  }

  // Enrich existing word_emphasis events (level >= 2) with colorOverride
  for (const e of result) {
    if (e.type === "word_emphasis" && e.level >= 2) {
      const w = words[e.wordIndex];
      if (w) {
        const ec = _emphasisColorFor(w.word);
        if (ec) e.colorOverride = ec;
      }
    }
  }
  // ═════════════════════════════════════════════════════════════

  return result;
}

// ─────────────────────────────────────────────────────────────
// ZOOM CURVE BUILDER
// Converts zoom events into smooth keyframe array
// ─────────────────────────────────────────────────────────────
function buildZoomCurve(events, clipDurationSecs) {
  const keyframes = [{ t: 0, zoom: 1.0 }];

  for (const e of events) {
    if (e.type === "zoom_in") {
      const target = 1.0 + (e.intensity || 0.3) * 0.15;
      keyframes.push({ t: e.timestamp, zoom: target });
      keyframes.push({
        t: e.timestamp + (e.durationSecs || 0.6),
        zoom: target * 0.98,
      });
    }
    if (e.type === "zoom_reset") {
      keyframes.push({ t: e.timestamp + (e.durationSecs || 0.5), zoom: 1.0 });
    }
    if (e.type === "zoom_pulse") {
      const pZoom = 1.0 + (e.intensity || 0.15) * 0.1;
      keyframes.push({ t: e.timestamp, zoom: pZoom });
      keyframes.push({ t: e.timestamp + (e.durationSecs || 0.6), zoom: 1.0 });
    }
  }

  keyframes.push({ t: clipDurationSecs, zoom: 1.0 });
  return keyframes
    .sort((a, b) => a.t - b.t)
    .filter((kf, i, arr) => i === 0 || Math.abs(kf.t - arr[i - 1].t) > 0.04);
}

// ─────────────────────────────────────────────────────────────
// ARC EVENTS — structural rhythm
// ─────────────────────────────────────────────────────────────
function buildArcEvents(clipDurationSecs, existingEvents) {
  const arc = [];

  // Intro — gentle zoom in first ~12% of clip
  arc.push({
    timestamp: 0,
    type: "zoom_in",
    intensity: 0.15,
    durationSecs: clipDurationSecs * 0.12,
  });
  arc.push({
    timestamp: clipDurationSecs * 0.12,
    type: "zoom_reset",
    durationSecs: 0.6,
  });

  // Rhythm fill — every 9s with no other zoom event
  const INTERVAL = 9;
  for (
    let t = clipDurationSecs * 0.18;
    t < clipDurationSecs * 0.8;
    t += INTERVAL
  ) {
    const hasNearby = existingEvents.some(
      (e) =>
        (e.type === "zoom_in" || e.type === "word_emphasis") &&
        Math.abs(e.timestamp - t) < 2.5,
    );
    if (!hasNearby) {
      arc.push({
        timestamp: t,
        type: "zoom_pulse",
        intensity: 0.18,
        durationSecs: 0.7,
      });
    }
  }

  // Retention hook at 50% — danger zone
  const mid = clipDurationSecs * 0.5;
  const hasMid = existingEvents.some(
    (e) =>
      e.type === "zoom_in" &&
      Math.abs(e.timestamp - mid) < 4 &&
      (e.intensity || 0) > 0.3,
  );
  if (!hasMid) {
    arc.push({
      timestamp: mid - 0.1,
      type: "zoom_in",
      intensity: 0.5,
      durationSecs: 1.4,
    });
    arc.push({ timestamp: mid + 1.3, type: "zoom_reset", durationSecs: 0.6 });
  }

  return arc;
}

// ─────────────────────────────────────────────────────────────
// LOWER THIRD BUILDER
// ─────────────────────────────────────────────────────────────
function buildLowerThird(clip, topic) {
  const showFor = [
    "philosophy",
    "science",
    "business",
    "technology",
    "health",
    "success",
  ];
  if (!showFor.includes(topic)) return null;

  const title = (clip.title || "")
    .replace(/\.\.\.$/, "")
    .replace(/["']/g, "")
    .trim()
    .substring(0, 42);
  if (title.split(" ").length < 3) return null;

  const clipDur = clip.endSec - clip.startSec;
  return {
    title,
    subtitle: null,
    showAtSec: 1.0,
    hideAtSec: Math.min(5.5, clipDur * 0.28),
  };
}

// ─────────────────────────────────────────────────────────────
// LLM ENRICHMENT — optional, Ollama by default
// Designed so you can swap to Claude/Gemini with zero other changes:
//
//   const plan = await enrichWithLLM(basePlan, transcript, "claude-sonnet");
//
// The function signature and return shape never change.
// ─────────────────────────────────────────────────────────────
async function enrichWithLLM(basePlan, transcript, model = null) {
  const llmModel = model || OLLAMA_MODEL;
  const excerpt = transcript.substring(0, 400);

  const prompt = `You are a professional viral video editor. Analyze this transcript and improve the editing plan.

Transcript: "${excerpt}"
Current theme: ${basePlan.theme.name}
Current topic: ${basePlan.meta.topic}
Current emotion: ${basePlan.meta.emotion}

Answer these questions with short answers only:

1. Better theme? (choose one: energy, viral, authority, clean, dramatic, warm, playful, techy, or "keep current")
2. Caption position? (top or bottom)
3. One powerful emoji for this content (single emoji character only)
4. One specific word in transcript to emphasize most (exact word)
5. Is this content motivational, warning, surprising, or neutral?

Reply in this exact format:
THEME: [answer]
POSITION: [answer]
EMOJI: [answer]
KEYWORD: [answer]
TONE: [answer]`;

  try {
    const res = await axios.post(
      `${OLLAMA_URL}/api/generate`,
      {
        model: llmModel,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: 80 },
      },
      { timeout: 25000 },
    );

    const text = res.data?.response || "";
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const get = (key) => {
      const line = lines.find((l) => l.startsWith(`${key}:`));
      return line ? line.replace(`${key}:`, "").trim() : null;
    };

    const themeSuggestion = get("THEME")
      ?.toLowerCase()
      .replace(/[^a-z]/g, "");
    const positionSuggestion = get("POSITION")?.toLowerCase();
    const emojiSuggestion = get("EMOJI");
    const keywordSuggestion = get("KEYWORD")?.toLowerCase();
    const toneSuggestion = get("TONE")?.toLowerCase();

    // Apply valid suggestions
    if (
      themeSuggestion &&
      themeSuggestion !== "keep" &&
      THEMES[themeSuggestion]
    ) {
      basePlan.theme = THEMES[themeSuggestion];
      console.log(`      🤖 LLM theme override: ${themeSuggestion}`);
    }
    if (positionSuggestion === "top" || positionSuggestion === "bottom") {
      basePlan.theme.captionPosition = positionSuggestion;
    }
    if (
      emojiSuggestion &&
      emojiSuggestion.length <= 4 &&
      basePlan.emojiOverlays.length < 3
    ) {
      // Add LLM-suggested emoji at the most impactful moment (first peak3 event)
      const firstPeak = basePlan.events.find(
        (e) => e.type === "word_emphasis" && e.level === 3,
      );
      if (firstPeak) {
        basePlan.emojiOverlays.push({
          timestamp: firstPeak.timestamp,
          type: "emoji",
          emoji: emojiSuggestion,
          x: 0.72,
          y: 0.22,
          size: 90,
        });
      }
    }
    if (keywordSuggestion) {
      basePlan.meta.llmKeyword = keywordSuggestion;
    }
    if (toneSuggestion === "warning") {
      basePlan.theme.activeWordColor = "#FF5252"; // red for warnings
    }
    if (toneSuggestion === "motivational") {
      basePlan.theme.activeWordColor = "#00E676"; // green for motivation
    }

    basePlan.meta.llmEnriched = true;
  } catch (e) {
    // Non-blocking — keyword analysis is good enough
    console.warn(
      `      ⚠️  LLM enrichment skipped: ${e.message?.split("\n")[0]}`,
    );
    basePlan.meta.llmEnriched = false;
  }

  return basePlan;
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT — buildEditingPlan
//
// Returns the complete EditingPlan JSON that Remotion consumes.
// This is the single source of truth for ALL visual decisions.
// ─────────────────────────────────────────────────────────────
async function buildEditingPlan(clip, words, options = {}) {
  const {
    useLLM = true, // set false to skip Ollama enrichment
    llmModel = null, // override model: "claude-sonnet-4-5" etc
  } = options;

  const transcript = clip.transcript || "";
  const clipDurationSecs = clip.endSec - clip.startSec;

  console.log(
    `      🎬 Building editing plan (${words.length} words, ${clipDurationSecs.toFixed(1)}s)...`,
  );

  // ── Step 1: Fast keyword analysis ───────────────────────
  const { topic, emotion, theme: themeName } = analyzeKeywords(transcript);
  const theme = { ...(THEMES[themeName] || THEMES.viral) };

  // Apply emotion overrides to theme
  if (emotion === "warning") theme.activeWordColor = "#FF5252";
  if (emotion === "motivational") theme.activeWordColor = "#00E676";

  // ── Step 2: Word-level events ────────────────────────────
  const wordEvents = buildWordEvents(words);

  // ── Step 3: Arc events (structural rhythm) ───────────────
  const arcEvents = buildArcEvents(clipDurationSecs, wordEvents);

  // ── Step 4: Merge all events ─────────────────────────────
  const allEvents = [...wordEvents, ...arcEvents].sort(
    (a, b) => a.timestamp - b.timestamp,
  );

  // ── Step 5: Zoom curve ───────────────────────────────────
  const zoomCurve = buildZoomCurve(allEvents, clipDurationSecs);

  // ── Step 6: Extract emoji and emphasis events for Remotion ─
  const emojiOverlays = allEvents.filter((e) => e.type === "emoji");
  const emphasisEvents = allEvents.filter((e) => e.type === "word_emphasis");

  // ── Step 7: Lower third ──────────────────────────────────
  const lowerThird = buildLowerThird(clip, topic);

  // ── Step 8: Assemble base plan ───────────────────────────
  const plan = {
    // Visual theme — drives ALL caption styling
    theme,

    // Structural data for Remotion
    zoomCurve,
    events: allEvents,
    emojiOverlays,
    emphasisEvents,
    lowerThird: lowerThird || undefined,
    showProgressBar: true,
    clipDurationSecs,

    // Caption position from theme (can be overridden by LLM)
    captionPosition: theme.captionPosition,

    // Metadata (for logging and future use)
    meta: {
      topic,
      emotion,
      themeName,
      wordCount: words.length,
      peakCount: emphasisEvents.filter((e) => e.level === 3).length,
      emojiCount: emojiOverlays.length,
      zoomKeyframes: zoomCurve.length,
      llmEnriched: false,
    },
  };

  // ── Step 9: Optional LLM enrichment ─────────────────────
  // This is where Claude/Gemini adds creative judgment on top
  if (useLLM) {
    await enrichWithLLM(plan, transcript, llmModel);
  }

  console.log(
    `      ✅ Plan: theme=${plan.theme.name} | topic=${topic} | emotion=${emotion}`,
  );
  console.log(
    `         zooms=${zoomCurve.length}kf | emphasis=${emphasisEvents.length} | emojis=${emojiOverlays.length}`,
  );

  return plan;
}

module.exports = { buildEditingPlan, THEMES, analyzeKeywords };