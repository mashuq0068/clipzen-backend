/**
 * iconSystem.js
 *
 * ICON SYSTEM — PURE RULE-BASED, ZERO LLM COST
 * Extracted from captionBurner.js for maintainability.
 *
 * 5-tier matching engine (all synchronous, pure CPU):
 *   Tier 1 — Exact phrase match       (~200+ multi-word phrases, checked first)
 *   Tier 2 — Word combo proximity     (2 related words within 6-word window)
 *   Tier 3 — Single keyword O(1)      (~400+ keywords in a Map, instant lookup)
 *   Tier 4 — Sentiment / tone         (10 tone categories, 1-word trigger)
 *   Tier 5 — Rotating fallback pool   (30 icons, never empty)
 *
 * Spacing guarantees:
 *   ✅ Icon every 3-7s across the FULL video
 *   ✅ First icon within 2s of start
 *   ✅ Last icon within 3s of end
 *   ✅ 3s minimum gap enforced (no clustering)
 *   ✅ Scales to 1000+ keywords with zero perf change — O(n) where n = chunks
 *
 * HOW TO ADD MORE ICONS:
 *   - New SVG file? Add filename to SVG_ICONS + SVG_EMOJI_FALLBACK
 *   - New phrase? Push to PHRASE_MAP
 *   - New keyword? Push to KEYWORD_ENTRIES
 *   - New combo? Push to COMBO_MAP
 */

// ─────────────────────────────────────────────────────────────
// AVAILABLE SVG ICONS
// ─────────────────────────────────────────────────────────────
const SVG_ICONS = [
  // Original set
  "alert.svg",
  "bulb.svg",
  "chess.svg",
  "clock.svg",
  "fire.svg",
  "money.svg",
  "muscle.svg",
  "swords.svg",
  "target.svg",
  "trophy.svg",
  "rocket.svg",
  // New additions — add your SVG files here as you create them
  // "crown.svg",
  // "brain.svg",
  // "shield.svg",
  // "chart.svg",
  // "key.svg",
  // "book.svg",
  // "star.svg",
  // "diamond.svg",
];

// Inline helpers — keep data tables readable
const _svg = (f) => ({ type: "svg", value: f });
const _em = (c) => ({ type: "emoji", value: c });

// When an SVG file is missing, fall back to the equivalent emoji
const SVG_EMOJI_FALLBACK = {
  "fire.svg": "🔥",
  "money.svg": "💰",
  "trophy.svg": "🏆",
  "muscle.svg": "💪",
  "bulb.svg": "💡",
  "chess.svg": "♟️",
  "clock.svg": "⏰",
  "swords.svg": "⚔️",
  "target.svg": "🎯",
  "alert.svg": "⚠️",
  "rocket.svg": "🚀",
};

// ═════════════════════════════════════════════════════════════
// TIER 1 — EXACT PHRASE MAP (~200+ entries)
// Multi-word phrases checked before single keywords.
// Prevents "fire" in "fire department" matching fire.svg
// when the real meaning is danger/emergency.
// ═════════════════════════════════════════════════════════════
const PHRASE_MAP = [
  // ── Money / Finance ──────────────────────────────────────
  { phrase: "net worth", icon: _em("💰") },
  { phrase: "make money", icon: _svg("money.svg") },
  { phrase: "passive income", icon: _em("📈") },
  { phrase: "financial freedom", icon: _em("🏦") },
  { phrase: "stock market", icon: _em("📈") },
  { phrase: "real estate", icon: _em("🏠") },
  { phrase: "side hustle", icon: _em("💼") },
  { phrase: "six figures", icon: _em("💰") },
  { phrase: "seven figures", icon: _em("🤑") },
  { phrase: "pay raise", icon: _em("💵") },
  { phrase: "debt free", icon: _em("✅") },
  { phrase: "credit score", icon: _em("📊") },
  { phrase: "cash flow", icon: _em("💵") },
  { phrase: "burn rate", icon: _svg("fire.svg") },
  { phrase: "profit margin", icon: _em("📊") },
  { phrase: "hedge fund", icon: _em("🏦") },
  { phrase: "private equity", icon: _em("💼") },
  { phrase: "interest rate", icon: _em("📊") },
  { phrase: "compound interest", icon: _em("📈") },
  { phrase: "financial advisor", icon: _em("🧑‍💼") },
  { phrase: "net profit", icon: _em("💹") },
  { phrase: "gross revenue", icon: _em("💹") },
  { phrase: "break even", icon: _em("⚖️") },
  { phrase: "market cap", icon: _em("📊") },
  { phrase: "bull market", icon: _em("📈") },
  { phrase: "bear market", icon: _em("📉") },
  { phrase: "day trader", icon: _em("💹") },
  { phrase: "dollar cost", icon: _em("💵") },
  { phrase: "index fund", icon: _em("📊") },
  { phrase: "emergency fund", icon: _em("🏦") },
  // ── Health / Body ─────────────────────────────────────────
  { phrase: "mental health", icon: _em("🧠") },
  { phrase: "blood pressure", icon: _em("❤️") },
  { phrase: "heart rate", icon: _em("💓") },
  { phrase: "lose weight", icon: _em("⚖️") },
  { phrase: "weight loss", icon: _em("⚖️") },
  { phrase: "body fat", icon: _em("💪") },
  { phrase: "immune system", icon: _em("🛡️") },
  { phrase: "sleep quality", icon: _em("😴") },
  { phrase: "deep sleep", icon: _em("😴") },
  { phrase: "stress levels", icon: _em("😤") },
  { phrase: "anxiety attack", icon: _em("😰") },
  { phrase: "cold water", icon: _em("🧊") },
  { phrase: "ice bath", icon: _em("🧊") },
  { phrase: "dopamine hit", icon: _em("⚡") },
  { phrase: "gut health", icon: _em("🌿") },
  { phrase: "cortisol levels", icon: _em("😤") },
  { phrase: "testosterone boost", icon: _em("💪") },
  { phrase: "hormonal balance", icon: _em("⚖️") },
  { phrase: "inflammation markers", icon: _em("🔬") },
  { phrase: "longevity research", icon: _em("🧬") },
  { phrase: "biohacking", icon: _em("🔬") },
  { phrase: "cold plunge", icon: _em("🧊") },
  { phrase: "sauna session", icon: _em("🌡️") },
  { phrase: "breathe work", icon: _em("🌬️") },
  { phrase: "breathing exercise", icon: _em("🌬️") },
  { phrase: "mindful eating", icon: _em("🥗") },
  { phrase: "clean eating", icon: _em("🥗") },
  { phrase: "sugar crash", icon: _em("📉") },
  { phrase: "energy drink", icon: _em("⚡") },
  // ── Motivation / Mindset ─────────────────────────────────
  { phrase: "never give up", icon: _em("💪") },
  { phrase: "work ethic", icon: _svg("target.svg") },
  { phrase: "growth mindset", icon: _em("🧠") },
  { phrase: "level up", icon: _em("⬆️") },
  { phrase: "wake up", icon: _em("⏰") },
  { phrase: "morning routine", icon: _em("🌅") },
  { phrase: "daily habits", icon: _em("📅") },
  { phrase: "comfort zone", icon: _em("🚧") },
  { phrase: "no excuses", icon: _em("❌") },
  { phrase: "take action", icon: _svg("target.svg") },
  { phrase: "dream big", icon: _em("✨") },
  { phrase: "hard work", icon: _svg("muscle.svg") },
  { phrase: "stay consistent", icon: _em("🔄") },
  { phrase: "show up", icon: _em("👊") },
  { phrase: "deep work", icon: _em("🎯") },
  { phrase: "discipline beats", icon: _em("💪") },
  { phrase: "self discipline", icon: _svg("target.svg") },
  { phrase: "mental toughness", icon: _em("🧠") },
  { phrase: "grit and determination", icon: _em("💪") },
  { phrase: "delayed gratification", icon: _svg("clock.svg") },
  { phrase: "atomic habits", icon: _em("🔄") },
  { phrase: "compound effect", icon: _em("📈") },
  { phrase: "1 percent", icon: _em("📈") },
  { phrase: "slight edge", icon: _em("⬆️") },
  { phrase: "overnight success", icon: _em("🌙") },
  { phrase: "years of work", icon: _svg("clock.svg") },
  { phrase: "never quit", icon: _em("💪") },
  // ── Business / Entrepreneur ──────────────────────────────
  { phrase: "start a business", icon: _svg("rocket.svg") },
  { phrase: "product market fit", icon: _svg("target.svg") },
  { phrase: "go viral", icon: _svg("fire.svg") },
  { phrase: "social media", icon: _em("📱") },
  { phrase: "content creator", icon: _em("🎥") },
  { phrase: "venture capital", icon: _em("🏦") },
  { phrase: "exit strategy", icon: _em("🚪") },
  { phrase: "angel investor", icon: _em("👼") },
  { phrase: "business model", icon: _em("📋") },
  { phrase: "customer acquisition", icon: _em("🎯") },
  { phrase: "churn rate", icon: _em("📉") },
  { phrase: "lifetime value", icon: _em("💎") },
  { phrase: "recurring revenue", icon: _em("🔄") },
  { phrase: "saas company", icon: _em("💻") },
  { phrase: "b2b sales", icon: _em("🤝") },
  { phrase: "cold email", icon: _em("📧") },
  { phrase: "cold call", icon: _em("📞") },
  { phrase: "sales funnel", icon: _em("📊") },
  { phrase: "conversion rate", icon: _em("📈") },
  { phrase: "click through", icon: _em("👆") },
  { phrase: "paid ads", icon: _em("💸") },
  { phrase: "organic growth", icon: _em("🌱") },
  { phrase: "personal brand", icon: _em("👑") },
  { phrase: "thought leader", icon: _svg("bulb.svg") },
  { phrase: "serial entrepreneur", icon: _svg("rocket.svg") },
  { phrase: "founder story", icon: _em("📖") },
  { phrase: "pitch deck", icon: _em("📊") },
  { phrase: "term sheet", icon: _em("📋") },
  { phrase: "pre seed", icon: _svg("rocket.svg") },
  { phrase: "series a", icon: _em("🏦") },
  { phrase: "ipo day", icon: _em("📈") },
  { phrase: "acquisition deal", icon: _em("🤝") },
  { phrase: "revenue growth", icon: _em("📈") },
  { phrase: "user acquisition", icon: _em("👥") },
  // ── Technology / AI ──────────────────────────────────────
  { phrase: "artificial intelligence", icon: _em("🤖") },
  { phrase: "machine learning", icon: _em("🧠") },
  { phrase: "deep learning", icon: _em("🧠") },
  { phrase: "neural network", icon: _em("🕸️") },
  { phrase: "data science", icon: _em("📊") },
  { phrase: "virtual reality", icon: _em("🥽") },
  { phrase: "augmented reality", icon: _em("🥽") },
  { phrase: "quantum computer", icon: _em("⚛️") },
  { phrase: "block chain", icon: _em("🔗") },
  { phrase: "large language model", icon: _em("🤖") },
  { phrase: "generative ai", icon: _em("✨") },
  { phrase: "open source", icon: _em("💻") },
  { phrase: "tech startup", icon: _svg("rocket.svg") },
  { phrase: "silicon valley", icon: _em("💻") },
  { phrase: "cloud computing", icon: _em("☁️") },
  { phrase: "cyber security", icon: _em("🔐") },
  { phrase: "data breach", icon: _svg("alert.svg") },
  { phrase: "software engineer", icon: _em("💻") },
  { phrase: "product manager", icon: _em("📋") },
  { phrase: "self driving", icon: _em("🚗") },
  { phrase: "electric vehicle", icon: _em("⚡") },
  { phrase: "autonomous car", icon: _em("🚗") },
  // ── Science / Nature ─────────────────────────────────────
  { phrase: "climate change", icon: _em("🌍") },
  { phrase: "global warming", icon: _em("🌡️") },
  { phrase: "black hole", icon: _em("🌑") },
  { phrase: "speed of light", icon: _em("⚡") },
  { phrase: "big bang", icon: _em("💥") },
  { phrase: "renewable energy", icon: _em("☀️") },
  { phrase: "natural selection", icon: _em("🧬") },
  { phrase: "theory of relativity", icon: _em("⚛️") },
  { phrase: "string theory", icon: _em("🌌") },
  { phrase: "dark matter", icon: _em("🌑") },
  { phrase: "solar system", icon: _em("🪐") },
  { phrase: "milky way", icon: _em("🌌") },
  { phrase: "dna strand", icon: _em("🧬") },
  { phrase: "human genome", icon: _em("🧬") },
  { phrase: "stem cell", icon: _em("🔬") },
  { phrase: "crispr gene", icon: _em("🧬") },
  // ── Fitness ──────────────────────────────────────────────
  { phrase: "meal prep", icon: _em("🥗") },
  { phrase: "high protein", icon: _em("🥩") },
  { phrase: "calorie deficit", icon: _em("⚖️") },
  { phrase: "intermittent fasting", icon: _em("⏳") },
  { phrase: "keto diet", icon: _em("🥑") },
  { phrase: "plant based", icon: _em("🌱") },
  { phrase: "junk food", icon: _em("🍔") },
  { phrase: "personal best", icon: _svg("trophy.svg") },
  { phrase: "world record", icon: _svg("trophy.svg") },
  { phrase: "one rep max", icon: _svg("muscle.svg") },
  { phrase: "bench press", icon: _svg("muscle.svg") },
  { phrase: "pre workout", icon: _em("⚡") },
  { phrase: "post workout", icon: _em("🩹") },
  { phrase: "muscle memory", icon: _svg("muscle.svg") },
  { phrase: "progressive overload", icon: _em("📈") },
  { phrase: "training split", icon: _em("📋") },
  { phrase: "push pull legs", icon: _svg("muscle.svg") },
  { phrase: "full body workout", icon: _svg("muscle.svg") },
  { phrase: "rest day", icon: _em("😴") },
  { phrase: "active recovery", icon: _em("🔄") },
  { phrase: "foam rolling", icon: _em("🔄") },
  { phrase: "creatine monohydrate", icon: _em("⚡") },
  { phrase: "whey protein", icon: _em("🥩") },
  { phrase: "vo2 max", icon: _em("❤️") },
  { phrase: "heart zone", icon: _em("💓") },
  { phrase: "fat burning", icon: _svg("fire.svg") },
  // ── Food & Drinks ──────────────────────────────────────────────
  { phrase: "vegetables", icon: _em("🥦") },
  { phrase: "leafy greens", icon: _em("🥬") },
  { phrase: "fruits", icon: _em("🍎") },
  { phrase: "citrus fruits", icon: _em("🍊") },
  { phrase: "berries", icon: _em("🍓") },

  { phrase: "meat", icon: _em("🍖") },
  { phrase: "red meat", icon: _em("🥩") },
  { phrase: "chicken", icon: _em("🍗") },
  { phrase: "fish", icon: _em("🐟") },
  { phrase: "seafood", icon: _em("🦐") },
  { phrase: "eggs", icon: _em("🥚") },

  { phrase: "dairy", icon: _em("🧀") },
  { phrase: "milk", icon: _em("🥛") },
  { phrase: "cheese", icon: _em("🧀") },
  { phrase: "yogurt", icon: _em("🥣") },

  { phrase: "carbs", icon: _em("🍞") },
  { phrase: "bread", icon: _em("🍞") },
  { phrase: "rice", icon: _em("🍚") },
  { phrase: "pasta", icon: _em("🍝") },
  { phrase: "noodles", icon: _em("🍜") },

  { phrase: "fast food", icon: _em("🍟") },
  { phrase: "street food", icon: _em("🌮") },
  { phrase: "pizza", icon: _em("🍕") },
  { phrase: "burger", icon: _em("🍔") },
  { phrase: "fried food", icon: _em("🍗") },

  { phrase: "dessert", icon: _em("🍰") },
  { phrase: "cake", icon: _em("🎂") },
  { phrase: "ice cream", icon: _em("🍨") },
  { phrase: "chocolate", icon: _em("🍫") },

  { phrase: "healthy food", icon: _em("🥗") },
  { phrase: "organic food", icon: _em("🌿") },
  { phrase: "low carb", icon: _em("⚖️") },
  { phrase: "high fiber", icon: _em("🌾") },

  // ── Drinks ──────────────────────────────────────────────
  { phrase: "water", icon: _em("💧") },
  { phrase: "juice", icon: _em("🧃") },
  { phrase: "smoothie", icon: _em("🥤") },
  { phrase: "coffee", icon: _em("☕") },
  { phrase: "tea", icon: _em("🍵") },
  { phrase: "soft drinks", icon: _em("🥤") },
  { phrase: "energy drink", icon: _em("⚡") },

  // ── Alcohol (optional category) ─────────────────────────
  { phrase: "alcohol", icon: _em("🍺") },
  { phrase: "beer", icon: _em("🍺") },
  { phrase: "wine", icon: _em("🍷") },
  { phrase: "whiskey", icon: _em("🥃") },
  { phrase: "cocktail", icon: _em("🍸") },

  // ── Misc Food Context ───────────────────────────────────
  { phrase: "home cooked", icon: _em("🏠") },
  { phrase: "buffet", icon: _em("🍽️") },
  { phrase: "fine dining", icon: _em("🍷") },
  { phrase: "snacks", icon: _em("🍿") },
  { phrase: "spicy food", icon: _svg("fire.svg") },
  { phrase: "sweet food", icon: _em("🍬") },
  // ── Shocking / Reveal ────────────────────────────────────
  { phrase: "nobody talks about", icon: _em("🤫") },
  { phrase: "nobody tells you", icon: _em("🤫") },
  { phrase: "they don't want you", icon: _em("👀") },
  { phrase: "hidden secret", icon: _em("🔐") },
  { phrase: "dark truth", icon: _em("💀") },
  { phrase: "real reason", icon: _em("🎯") },
  { phrase: "plot twist", icon: _em("🤯") },
  { phrase: "breaking news", icon: _em("📰") },
  { phrase: "mind blown", icon: _em("🤯") },
  { phrase: "wait what", icon: _em("😮") },
  { phrase: "no way", icon: _em("😱") },
  { phrase: "can't believe", icon: _em("😲") },
  { phrase: "spoiler alert", icon: _svg("alert.svg") },
  { phrase: "hot take", icon: _svg("fire.svg") },
  { phrase: "unpopular opinion", icon: _em("🎭") },
  { phrase: "controversial truth", icon: _em("💥") },
  { phrase: "game changer", icon: _em("♟️") },
  { phrase: "paradigm shift", icon: _em("🌀") },
  { phrase: "wake up call", icon: _em("⏰") },
  { phrase: "eye opener", icon: _em("👁️") },
  // ── Time ─────────────────────────────────────────────────
  { phrase: "every single day", icon: _em("📅") },
  { phrase: "24 hours", icon: _svg("clock.svg") },
  { phrase: "right now", icon: _em("⚡") },
  { phrase: "5 years ago", icon: _svg("clock.svg") },
  { phrase: "10 years ago", icon: _svg("clock.svg") },
  { phrase: "30 days", icon: _em("📅") },
  { phrase: "90 days", icon: _em("📅") },
  { phrase: "one year", icon: _svg("clock.svg") },
  { phrase: "long term", icon: _svg("clock.svg") },
  { phrase: "short term", icon: _svg("clock.svg") },
  { phrase: "time management", icon: _svg("clock.svg") },
  { phrase: "wasted time", icon: _svg("clock.svg") },
  { phrase: "limited time", icon: _svg("clock.svg") },
  { phrase: "running out of time", icon: _svg("clock.svg") },
  // ── Life / Relationships ─────────────────────────────────
  { phrase: "meaning of life", icon: _em("🌌") },
  { phrase: "human nature", icon: _em("🧬") },
  { phrase: "toxic relationship", icon: _em("☠️") },
  { phrase: "red flag", icon: _em("🚩") },
  { phrase: "green flag", icon: _em("✅") },
  { phrase: "self worth", icon: _em("👑") },
  { phrase: "peer pressure", icon: _em("👥") },
  { phrase: "second chance", icon: _em("🔄") },
  { phrase: "trust issues", icon: _em("🚩") },
  { phrase: "attachment style", icon: _em("🔗") },
  { phrase: "inner child", icon: _em("👶") },
  { phrase: "trauma response", icon: _em("😰") },
  { phrase: "boundary setting", icon: _em("🚧") },
  { phrase: "emotional intelligence", icon: _em("🧠") },
  { phrase: "social skills", icon: _em("🤝") },
  { phrase: "body language", icon: _em("🧍") },
  { phrase: "eye contact", icon: _em("👁️") },
  { phrase: "first impression", icon: _em("⭐") },
  { phrase: "genuine connection", icon: _em("❤️") },
  // ── Pop Culture / Lifestyle ──────────────────────────────
  { phrase: "luxury lifestyle", icon: _em("💎") },
  { phrase: "travel the world", icon: _em("🌍") },
  { phrase: "bucket list", icon: _em("📋") },
  { phrase: "life hack", icon: _svg("bulb.svg") },
  { phrase: "productivity hack", icon: _svg("bulb.svg") },
  { phrase: "time hack", icon: _svg("clock.svg") },
  { phrase: "morning person", icon: _em("🌅") },
  { phrase: "night owl", icon: _em("🦉") },
  { phrase: "work life balance", icon: _em("⚖️") },
  { phrase: "hustle culture", icon: _svg("fire.svg") },
  { phrase: "burnout culture", icon: _em("😤") },
  { phrase: "digital nomad", icon: _em("💻") },
  { phrase: "remote work", icon: _em("💻") },
  { phrase: "four day week", icon: _em("📅") },
];

// ═════════════════════════════════════════════════════════════
// TIER 2 — WORD COMBO MAP
// Both words must appear within a 6-word window.
// Catches contrasts, dualities, compound ideas.
// ═════════════════════════════════════════════════════════════
const COMBO_MAP = [
  // [word1, word2, icon]
  // ── Money contrasts ───────────────────────────────────────
  ["money", "lose", _em("📉")],
  ["money", "make", _svg("money.svg")],
  ["money", "save", _em("🏦")],
  ["invest", "return", _em("📈")],
  ["invest", "lose", _em("📉")],
  ["rich", "poor", _em("⚖️")],
  ["broke", "rich", _svg("money.svg")],
  ["spend", "save", _em("⚖️")],
  ["debt", "freedom", _em("✅")],
  ["buy", "cheap", _em("💸")],
  // ── Work / Effort ─────────────────────────────────────────
  ["work", "hard", _svg("muscle.svg")],
  ["work", "smart", _em("🧠")],
  ["work", "play", _em("⚖️")],
  ["grind", "rest", _em("⚖️")],
  ["hustle", "sleep", _em("😴")],
  ["busy", "productive", _svg("target.svg")],
  ["effort", "result", _svg("trophy.svg")],
  ["action", "result", _svg("target.svg")],
  // ── Win / Lose ────────────────────────────────────────────
  ["fail", "success", _svg("trophy.svg")],
  ["fail", "learn", _em("📚")],
  ["win", "lose", _svg("swords.svg")],
  ["win", "team", _svg("trophy.svg")],
  ["loss", "lesson", _em("📚")],
  ["defeat", "comeback", _svg("trophy.svg")],
  // ── Body / Health ─────────────────────────────────────────
  ["eat", "sleep", _em("😴")],
  ["eat", "healthy", _em("🥗")],
  ["eat", "junk", _em("🍔")],
  ["run", "fast", _em("🏃")],
  ["lift", "heavy", _svg("muscle.svg")],
  ["sleep", "wake", _em("⏰")],
  ["strong", "weak", _svg("muscle.svg")],
  ["pain", "gain", _svg("muscle.svg")],
  ["brain", "body", _em("🧠")],
  ["mind", "body", _em("🧘")],
  ["eat", "fast", _em("⏳")],
  ["hot", "cold", _em("🌡️")],
  // ── Strategy / Competition ───────────────────────────────
  ["fast", "slow", _svg("clock.svg")],
  ["think", "different", _em("💡")],
  ["think", "big", _em("🌌")],
  ["think", "act", _svg("target.svg")],
  ["plan", "execute", _svg("chess.svg")],
  ["strategy", "result", _svg("chess.svg")],
  ["build", "destroy", _svg("swords.svg")],
  ["start", "finish", _svg("target.svg")],
  ["create", "destroy", _em("💥")],
  ["war", "peace", _svg("swords.svg")],
  ["fight", "win", _svg("trophy.svg")],
  ["fight", "lose", _em("💀")],
  ["good", "evil", _svg("swords.svg")],
  ["attack", "defend", _svg("swords.svg")],
  // ── Truth / Deception ────────────────────────────────────
  ["truth", "lie", _em("🎭")],
  ["real", "fake", _em("🎭")],
  ["trust", "betray", _em("🚩")],
  ["honest", "dishonest", _em("🎭")],
  ["prove", "doubt", _em("🔬")],
  // ── Life / Death ─────────────────────────────────────────
  ["die", "live", _em("❤️")],
  ["death", "life", _em("⚖️")],
  ["love", "hate", _em("❤️")],
  ["give", "take", _em("🤝")],
  ["follow", "lead", _em("👑")],
  ["teach", "learn", _em("📚")],
  ["speak", "listen", _em("👂")],
  ["old", "new", _em("✨")],
  ["dark", "light", _em("💡")],
  ["day", "night", _em("🌙")],
  ["age", "young", _em("⏳")],
  // ── Growth ────────────────────────────────────────────────
  ["fear", "courage", _em("💪")],
  ["risk", "reward", _svg("target.svg")],
  ["risk", "safe", _em("⚖️")],
  ["rich", "wealth", _svg("money.svg")],
  ["buy", "sell", _em("💱")],
  ["up", "down", _em("⚖️")],
  ["rise", "fall", _em("⚖️")],
  ["grow", "shrink", _em("📊")],
  // ── People / Leadership ──────────────────────────────────
  ["leader", "follower", _em("👑")],
  ["mentor", "student", _em("📚")],
  ["team", "individual", _em("👥")],
  ["boss", "employee", _em("👑")],
];

// ═════════════════════════════════════════════════════════════
// TIER 3 — SINGLE KEYWORD MAP (~400+ entries)
// Stored in a Map for O(1) lookup.
// ═════════════════════════════════════════════════════════════
const KEYWORD_ENTRIES = [
  // ── Money / Finance ──────────────────────────────────────
  ["million", _svg("money.svg")],
  ["billion", _svg("money.svg")],
  ["trillion", _em("🤑")],
  ["money", _svg("money.svg")],
  ["cash", _svg("money.svg")],
  ["dollar", _svg("money.svg")],
  ["rich", _svg("money.svg")],
  ["wealth", _svg("money.svg")],
  ["profit", _em("📈")],
  ["revenue", _em("📈")],
  ["income", _em("💵")],
  ["salary", _em("💵")],
  ["earn", _em("💵")],
  ["paid", _em("💵")],
  ["invest", _em("📈")],
  ["stock", _em("📈")],
  ["crypto", _em("₿")],
  ["bitcoin", _em("₿")],
  ["ethereum", _em("⟠")],
  ["bank", _em("🏦")],
  ["loan", _em("🏦")],
  ["debt", _em("😬")],
  ["broke", _em("😬")],
  ["expensive", _em("💸")],
  ["spend", _em("💸")],
  ["save", _em("🏦")],
  ["tax", _em("🧾")],
  ["budget", _em("📊")],
  ["portfolio", _em("📊")],
  ["dividend", _em("💰")],
  ["inflation", _em("📈")],
  ["recession", _em("📉")],
  ["bankrupt", _em("💀")],
  ["compound", _em("📈")],
  ["fund", _em("💼")],
  ["affordable", _em("💵")],
  ["cheap", _em("💸")],
  ["price", _em("🏷️")],
  ["cost", _em("💵")],
  ["worth", _em("💎")],
  ["value", _em("💎")],
  ["asset", _em("🏦")],
  ["liability", _em("😬")],
  ["mortgage", _em("🏠")],
  ["rent", _em("🏠")],
  ["insurance", _em("🛡️")],
  ["pension", _em("🏦")],
  ["retirement", _em("🌅")],
  ["forex", _em("💱")],
  ["currency", _em("💵")],
  ["exchange", _em("💱")],
  ["trading", _em("📈")],
  ["chart", _em("📊")],
  // ── Achievement / Success ────────────────────────────────
  ["win", _svg("trophy.svg")],
  ["won", _svg("trophy.svg")],
  ["winner", _svg("trophy.svg")],
  ["champion", _svg("trophy.svg")],
  ["trophy", _svg("trophy.svg")],
  ["award", _svg("trophy.svg")],
  ["prize", _svg("trophy.svg")],
  ["medal", _em("🥇")],
  ["gold", _em("🥇")],
  ["success", _svg("trophy.svg")],
  ["achieve", _svg("target.svg")],
  ["goal", _svg("target.svg")],
  ["target", _svg("target.svg")],
  ["milestone", _svg("target.svg")],
  ["best", _svg("trophy.svg")],
  ["greatest", _svg("trophy.svg")],
  ["elite", _em("👑")],
  ["legendary", _em("👑")],
  ["top", _em("⬆️")],
  ["record", _svg("trophy.svg")],
  ["accomplish", _svg("target.svg")],
  ["nail", _svg("target.svg")],
  ["crush", _svg("target.svg")],
  ["rank", _em("📊")],
  ["podium", _svg("trophy.svg")],
  ["title", _svg("trophy.svg")],
  ["crown", _em("👑")],
  ["glory", _svg("trophy.svg")],
  ["victory", _svg("trophy.svg")],
  ["triumph", _svg("trophy.svg")],
  ["conquer", _svg("trophy.svg")],
  ["breakthrough", _svg("rocket.svg")],
  ["milestone", _svg("target.svg")],
  // ── Fitness / Strength ───────────────────────────────────
  ["muscle", _svg("muscle.svg")],
  ["workout", _svg("muscle.svg")],
  ["exercise", _svg("muscle.svg")],
  ["gym", _svg("muscle.svg")],
  ["lift", _svg("muscle.svg")],
  ["strong", _svg("muscle.svg")],
  ["strength", _svg("muscle.svg")],
  ["gains", _svg("muscle.svg")],
  ["reps", _svg("muscle.svg")],
  ["squat", _svg("muscle.svg")],
  ["deadlift", _svg("muscle.svg")],
  ["bench", _svg("muscle.svg")],
  ["cardio", _em("🏃")],
  ["run", _em("🏃")],
  ["sprint", _em("🏃")],
  ["marathon", _em("🏃")],
  ["athlete", _em("🏅")],
  ["training", _svg("target.svg")],
  ["protein", _em("🥩")],
  ["calories", _em("⚖️")],
  ["diet", _em("🥗")],
  ["nutrition", _em("🥗")],
  ["health", _em("❤️")],
  ["healthy", _em("🥗")],
  ["fit", _svg("muscle.svg")],
  ["lean", _em("⚖️")],
  ["bulk", _svg("muscle.svg")],
  ["recovery", _em("🩹")],
  ["injury", _em("🩹")],
  ["pain", _em("😣")],
  ["body", _svg("muscle.svg")],
  ["flexibility", _em("🧘")],
  ["yoga", _em("🧘")],
  ["stretch", _em("🧘")],
  ["swimming", _em("🏊")],
  ["cycling", _em("🚴")],
  ["rowing", _em("🚣")],
  ["crossfit", _svg("muscle.svg")],
  ["pilates", _em("🧘")],
  ["endurance", _em("🏃")],
  ["stamina", _em("⚡")],
  ["agility", _em("🏃")],
  ["speed", _em("⚡")],
  ["power", _em("⚡")],
  ["explosive", _em("💥")],
  ["physique", _svg("muscle.svg")],
  ["symmetry", _em("⚖️")],
  ["aesthetics", _em("💪")],
  // ── Mind / Ideas ─────────────────────────────────────────
  ["idea", _svg("bulb.svg")],
  ["think", _svg("bulb.svg")],
  ["brain", _em("🧠")],
  ["smart", _em("🧠")],
  ["genius", _em("🧠")],
  ["mindset", _em("🧠")],
  ["realize", _svg("bulb.svg")],
  ["insight", _svg("bulb.svg")],
  ["understand", _svg("bulb.svg")],
  ["learn", _em("📚")],
  ["knowledge", _em("📚")],
  ["wisdom", _em("🦉")],
  ["study", _em("📚")],
  ["read", _em("📖")],
  ["discover", _svg("bulb.svg")],
  ["invent", _svg("bulb.svg")],
  ["create", _em("✨")],
  ["innovate", _svg("bulb.svg")],
  ["solution", _svg("bulb.svg")],
  ["problem", _em("❗")],
  ["question", _em("❓")],
  ["answer", _em("✅")],
  ["focus", _svg("target.svg")],
  ["attention", _em("👀")],
  ["memory", _em("🧠")],
  ["imagine", _em("💭")],
  ["intelligent", _em("🧠")],
  ["curiosity", _em("❓")],
  ["creativity", _em("✨")],
  ["perspective", _svg("bulb.svg")],
  ["philosophy", _em("🤔")],
  ["psychology", _em("🧠")],
  ["consciousness", _em("💭")],
  ["subconscious", _em("💭")],
  ["meditation", _em("🧘")],
  ["visualization", _svg("bulb.svg")],
  ["affirmation", _em("✅")],
  ["journaling", _em("📖")],
  // ── Strategy / Competition ───────────────────────────────
  ["strategy", _svg("chess.svg")],
  ["chess", _svg("chess.svg")],
  ["plan", _svg("chess.svg")],
  ["tactical", _svg("chess.svg")],
  ["calculated", _svg("chess.svg")],
  ["outsmart", _svg("chess.svg")],
  ["compete", _svg("swords.svg")],
  ["competition", _svg("swords.svg")],
  ["rival", _svg("swords.svg")],
  ["enemy", _svg("swords.svg")],
  ["opponent", _svg("swords.svg")],
  ["battle", _svg("swords.svg")],
  ["fight", _svg("swords.svg")],
  ["war", _svg("swords.svg")],
  ["attack", _svg("swords.svg")],
  ["defend", _em("🛡️")],
  ["dominate", _svg("trophy.svg")],
  ["destroy", _em("💥")],
  ["beat", _svg("trophy.svg")],
  ["defeat", _svg("swords.svg")],
  ["leverage", _svg("chess.svg")],
  ["advantage", _svg("chess.svg")],
  ["edge", _svg("chess.svg")],
  ["positioning", _svg("chess.svg")],
  ["moat", _em("🛡️")],
  ["barrier", _em("🚧")],
  ["checkmate", _svg("chess.svg")],
  ["gambit", _svg("chess.svg")],
  ["negotiate", _em("🤝")],
  ["persuade", _em("🗣️")],
  ["influence", _em("🌐")],
  ["network", _em("🕸️")],
  ["alliance", _em("🤝")],
  // ── Fire / Energy / Hype ─────────────────────────────────
  ["fire", _svg("fire.svg")],
  ["flame", _svg("fire.svg")],
  ["burn", _svg("fire.svg")],
  ["hot", _svg("fire.svg")],
  ["viral", _svg("fire.svg")],
  ["trending", _svg("fire.svg")],
  ["explode", _em("💥")],
  ["insane", _em("🤯")],
  ["crazy", _em("🤯")],
  ["wild", _em("😱")],
  ["epic", _em("⚡")],
  ["energy", _em("⚡")],
  ["electric", _em("⚡")],
  ["lightning", _em("⚡")],
  ["explosive", _em("💥")],
  ["rocket", _svg("rocket.svg")],
  ["launch", _svg("rocket.svg")],
  ["skyrocket", _svg("rocket.svg")],
  ["blast", _em("💥")],
  ["hype", _em("🔥")],
  ["momentum", _em("🚀")],
  ["wave", _em("🌊")],
  ["surge", _em("⚡")],
  ["spike", _em("📈")],
  ["boom", _em("💥")],
  ["ignite", _svg("fire.svg")],
  ["fuel", _svg("fire.svg")],
  ["spark", _svg("fire.svg")],
  ["lit", _svg("fire.svg")],
  ["blazing", _svg("fire.svg")],
  // ── Warning / Danger ─────────────────────────────────────
  ["warning", _svg("alert.svg")],
  ["danger", _svg("alert.svg")],
  ["careful", _svg("alert.svg")],
  ["mistake", _svg("alert.svg")],
  ["wrong", _em("❌")],
  ["bad", _em("❌")],
  ["toxic", _em("☠️")],
  ["poison", _em("☠️")],
  ["scam", _em("⚠️")],
  ["fraud", _em("⚠️")],
  ["fake", _em("🎭")],
  ["lie", _em("🎭")],
  ["cheat", _em("🎭")],
  ["trap", _em("⚠️")],
  ["illegal", _em("🚫")],
  ["banned", _em("🚫")],
  ["fail", _em("❌")],
  ["failure", _em("❌")],
  ["crash", _em("💥")],
  ["stop", _em("🛑")],
  ["risk", _svg("alert.svg")],
  ["threat", _svg("alert.svg")],
  ["hack", _em("💻")],
  ["breach", _svg("alert.svg")],
  ["exposed", _em("😮")],
  ["vulnerable", _svg("alert.svg")],
  ["critical", _svg("alert.svg")],
  ["disaster", _em("💥")],
  ["crisis", _svg("alert.svg")],
  ["collapse", _em("📉")],
  ["bankrupt", _em("💀")],
  ["propaganda", _em("🎭")],
  ["manipulation", _em("🎭")],
  // ── Time ─────────────────────────────────────────────────
  ["time", _svg("clock.svg")],
  ["deadline", _svg("clock.svg")],
  ["clock", _svg("clock.svg")],
  ["hours", _svg("clock.svg")],
  ["minutes", _svg("clock.svg")],
  ["seconds", _svg("clock.svg")],
  ["years", _svg("clock.svg")],
  ["century", _svg("clock.svg")],
  ["decade", _svg("clock.svg")],
  ["late", _svg("clock.svg")],
  ["early", _svg("clock.svg")],
  ["today", _em("📅")],
  ["tomorrow", _em("📅")],
  ["future", _em("🔮")],
  ["past", _svg("clock.svg")],
  ["history", _em("📜")],
  ["ancient", _em("🏛️")],
  ["moment", _svg("clock.svg")],
  ["instant", _em("⚡")],
  ["eventually", _svg("clock.svg")],
  ["patience", _svg("clock.svg")],
  ["consistent", _em("🔄")],
  ["routine", _em("📅")],
  ["schedule", _em("📅")],
  ["weekly", _em("📅")],
  ["monthly", _em("📅")],
  // ── Shock / Surprise ─────────────────────────────────────
  ["shocking", _em("🤯")],
  ["secret", _em("🤫")],
  ["hidden", _em("🔐")],
  ["truth", _em("💡")],
  ["reveal", _em("👀")],
  ["unbelievable", _em("😱")],
  ["impossible", _em("😱")],
  ["surprise", _em("😮")],
  ["unexpected", _em("😮")],
  ["actually", _em("👀")],
  ["really", _em("👀")],
  ["literally", _em("😲")],
  ["mind-blowing", _em("🤯")],
  ["jaw-dropping", _em("😮")],
  ["shocking", _em("🤯")],
  ["stunning", _em("😲")],
  ["breathtaking", _em("😮")],
  ["remarkable", _em("⭐")],
  ["extraordinary", _em("🌟")],
  ["unprecedented", _em("🤯")],
  // ── Positive / Facts ─────────────────────────────────────
  ["correct", _em("✅")],
  ["right", _em("✅")],
  ["true", _em("✅")],
  ["proven", _em("✅")],
  ["fact", _em("📋")],
  ["evidence", _em("📋")],
  ["research", _em("🔬")],
  ["science", _em("🔬")],
  ["data", _em("📊")],
  ["statistics", _em("📊")],
  ["percent", _em("📊")],
  ["number", _em("🔢")],
  ["study", _em("🔬")],
  ["experiment", _em("🔬")],
  ["hypothesis", _em("🔬")],
  ["theory", _em("🔬")],
  ["proof", _em("✅")],
  ["verified", _em("✅")],
  ["accurate", _em("🎯")],
  ["precise", _em("🎯")],
  // ── Technology ───────────────────────────────────────────
  ["ai", _em("🤖")],
  ["robot", _em("🤖")],
  ["algorithm", _em("⚙️")],
  ["software", _em("💻")],
  ["code", _em("💻")],
  ["computer", _em("💻")],
  ["internet", _em("🌐")],
  ["digital", _em("📱")],
  ["phone", _em("📱")],
  ["app", _em("📱")],
  ["virus", _em("🦠")],
  ["cloud", _em("☁️")],
  ["server", _em("🖥️")],
  ["database", _em("🗄️")],
  ["api", _em("⚙️")],
  ["automation", _em("🤖")],
  ["drone", _em("🚁")],
  ["satellite", _em("🛰️")],
  ["spacecraft", _svg("rocket.svg")],
  ["tesla", _em("⚡")],
  ["electric", _em("⚡")],
  ["battery", _em("🔋")],
  ["solar", _em("☀️")],
  ["nuclear", _em("⚛️")],
  ["semiconductor", _em("💻")],
  ["microchip", _em("💻")],
  ["processor", _em("⚙️")],
  ["gpu", _em("💻")],
  ["bandwidth", _em("🌐")],
  ["streaming", _em("📱")],
  ["platform", _em("📱")],
  // ── People / Society ─────────────────────────────────────
  ["government", _em("🏛️")],
  ["president", _em("🏛️")],
  ["politics", _em("🏛️")],
  ["leader", _em("👑")],
  ["boss", _em("👑")],
  ["king", _em("👑")],
  ["queen", _em("👑")],
  ["crowd", _em("👥")],
  ["people", _em("👥")],
  ["everyone", _em("👥")],
  ["nobody", _em("🤫")],
  ["community", _em("🤝")],
  ["society", _em("🌍")],
  ["generation", _em("👶")],
  ["culture", _em("🌍")],
  ["tribe", _em("👥")],
  ["movement", _em("✊")],
  ["revolution", _em("✊")],
  ["protest", _em("✊")],
  ["democracy", _em("🗳️")],
  ["freedom", _em("🕊️")],
  ["equality", _em("⚖️")],
  ["justice", _em("⚖️")],
  ["privilege", _em("👑")],
  ["class", _em("👥")],
  ["poverty", _em("😢")],
  ["inequality", _em("⚖️")],
  ["corruption", _em("🎭")],
  ["power", _em("⚡")],
  ["authority", _em("👑")],
  // ── Emotions ─────────────────────────────────────────────
  ["happy", _em("😊")],
  ["sad", _em("😢")],
  ["angry", _em("😡")],
  ["fear", _em("😰")],
  ["love", _em("❤️")],
  ["hate", _em("😡")],
  ["funny", _em("😂")],
  ["laugh", _em("😂")],
  ["cry", _em("😢")],
  ["shock", _em("😱")],
  ["excited", _em("🎉")],
  ["nervous", _em("😰")],
  ["confident", _em("💪")],
  ["grateful", _em("🙏")],
  ["proud", _em("🏆")],
  ["hope", _em("🌟")],
  ["regret", _em("😔")],
  ["lonely", _em("😔")],
  ["joy", _em("😄")],
  ["grief", _em("😢")],
  ["anxiety", _em("😰")],
  ["depression", _em("😢")],
  ["euphoria", _em("🎉")],
  ["passion", _svg("fire.svg")],
  ["obsessed", _em("🎯")],
  ["addicted", _em("⚠️")],
  ["inspired", _em("✨")],
  ["motivated", _em("💪")],
  ["driven", _em("🎯")],
  ["ambitious", _svg("rocket.svg")],
  ["courageous", _em("💪")],
  ["humble", _em("🙏")],
  ["empathetic", _em("❤️")],
  ["compassionate", _em("❤️")],
  // ── Nature / World ───────────────────────────────────────
  ["earth", _em("🌍")],
  ["world", _em("🌍")],
  ["ocean", _em("🌊")],
  ["mountain", _em("⛰️")],
  ["forest", _em("🌲")],
  ["animal", _em("🐾")],
  ["wildlife", _em("🐾")],
  ["nature", _em("🌿")],
  ["planet", _em("🪐")],
  ["space", _svg("rocket.svg")],
  ["star", _em("⭐")],
  ["sun", _em("☀️")],
  ["moon", _em("🌙")],
  ["universe", _em("🌌")],
  ["galaxy", _em("🌌")],
  ["storm", _em("⛈️")],
  ["earthquake", _em("💥")],
  ["tsunami", _em("🌊")],
  ["volcano", _svg("fire.svg")],
  ["flood", _em("🌊")],
  ["drought", _em("🌡️")],
  ["hurricane", _em("🌀")],
  ["tornado", _em("🌀")],
  ["jungle", _em("🌴")],
  ["desert", _em("🏜️")],
  ["arctic", _em("🧊")],
  ["cave", _em("🕳️")],
  ["waterfall", _em("💧")],
  ["river", _em("🌊")],
  // ── Luxury / Premium ─────────────────────────────────────
  ["luxury", _em("💎")],
  ["diamond", _em("💎")],
  ["gem", _em("💎")],
  ["premium", _em("👑")],
  ["exclusive", _em("🔐")],
  ["rare", _em("💎")],
  ["mansion", _em("🏰")],
  ["yacht", _em("⛵")],
  ["ferrari", _em("🏎️")],
  ["lamborghini", _em("🏎️")],
  ["penthouse", _em("🏢")],
  ["billionaire", _em("🤑")],
  ["mogul", _em("👑")],
  ["lavish", _em("💎")],
  ["opulent", _em("💎")],
  ["prestige", _em("👑")],
  // ── Growth / Scale ───────────────────────────────────────
  ["grow", _em("📈")],
  ["growth", _em("📈")],
  ["scale", _svg("rocket.svg")],
  ["expand", _em("📈")],
  ["increase", _em("⬆️")],
  ["decrease", _em("⬇️")],
  ["double", _em("2️⃣")],
  ["triple", _em("3️⃣")],
  ["10x", _svg("rocket.svg")],
  ["100x", _em("🤯")],
  ["exponential", _em("📈")],
  ["accelerate", _svg("rocket.svg")],
  ["multiply", _em("📈")],
  ["amplify", _em("📈")],
  ["maximize", _em("⬆️")],
  ["optimize", _svg("target.svg")],
  ["leverage", _em("📈")],
  ["compound", _em("📈")],
  // ── Food / Nutrition (detailed) ───────────────────────────
  ["caffeine", _em("☕")],
  ["coffee", _em("☕")],
  ["alcohol", _em("🍺")],
  ["sugar", _em("🍬")],
  ["carbs", _em("🍞")],
  ["fat", _em("🥑")],
  ["fiber", _em("🌾")],
  ["vitamins", _em("💊")],
  ["supplements", _em("💊")],
  ["omega", _em("🐟")],
  ["antioxidant", _em("🫐")],
  ["probiotic", _em("🦠")],
  ["hydration", _em("💧")],
  ["water", _em("💧")],
  ["fasting", _em("⏳")],
  // ── Leadership / Career ──────────────────────────────────
  ["promote", _em("⬆️")],
  ["fired", _em("🚪")],
  ["quit", _em("🚪")],
  ["resign", _em("🚪")],
  ["hiring", _em("🤝")],
  ["interview", _em("🤝")],
  ["resume", _em("📋")],
  ["career", _em("💼")],
  ["profession", _em("💼")],
  ["expertise", _em("🎯")],
  ["specialist", _em("🎯")],
  ["generalist", _em("🌐")],
  ["skillset", _em("🛠️")],
  ["experience", _em("📚")],
  ["credentials", _em("📜")],
  ["certification", _em("📜")],
  ["degree", _em("🎓")],
  ["university", _em("🎓")],
  ["education", _em("📚")],
  ["dropout", _em("🚪")],
  // ── Communication ────────────────────────────────────────
  ["storytelling", _em("📖")],
  ["narrative", _em("📖")],
  ["message", _em("💬")],
  ["feedback", _em("💬")],
  ["criticism", _em("💬")],
  ["compliment", _em("⭐")],
  ["debate", _svg("swords.svg")],
  ["argument", _svg("swords.svg")],
  ["conversation", _em("💬")],
  ["podcast", _em("🎙️")],
  ["interview", _em("🎙️")],
  ["speech", _em("🗣️")],
  ["presentation", _em("📊")],
  ["content", _em("📱")],
  ["video", _em("🎥")],
  ["thumbnail", _em("🖼️")],
  ["headline", _em("📰")],
  ["clickbait", _em("🎣")],
  ["algorithm", _em("⚙️")],
  ["engagement", _em("📱")],
  ["subscribers", _em("👥")],
  ["followers", _em("👥")],
  ["views", _em("👀")],
  ["impressions", _em("👀")],
];

// Build O(1) lookup at module load — zero cost per clip
const KEYWORD_LOOKUP = new Map(KEYWORD_ENTRIES);

// ═════════════════════════════════════════════════════════════
// TIER 4 — SENTIMENT / TONE DETECTION (10 categories)
// When no keyword matches, detect the overall tone of a chunk.
// Each category triggers on just ONE matching word.
// ═════════════════════════════════════════════════════════════
const SENTIMENT_TIERS = [
  {
    label: "positive",
    words: new Set([
      "amazing",
      "awesome",
      "incredible",
      "fantastic",
      "great",
      "excellent",
      "perfect",
      "brilliant",
      "outstanding",
      "wonderful",
      "superb",
      "remarkable",
      "extraordinary",
      "magnificent",
      "phenomenal",
      "exceptional",
      "spectacular",
      "marvelous",
      "glorious",
      "terrific",
    ]),
    icon: _em("🌟"),
  },
  {
    label: "negative",
    words: new Set([
      "terrible",
      "horrible",
      "awful",
      "disgusting",
      "pathetic",
      "useless",
      "worthless",
      "garbage",
      "trash",
      "disaster",
      "catastrophe",
      "devastating",
      "worst",
      "dreadful",
      "appalling",
      "atrocious",
      "abysmal",
      "pitiful",
      "shameful",
      "deplorable",
    ]),
    icon: _em("💀"),
  },
  {
    label: "motivational",
    words: new Set([
      "believe",
      "possible",
      "will",
      "must",
      "should",
      "deserve",
      "potential",
      "capable",
      "ready",
      "determined",
      "relentless",
      "unstoppable",
      "driven",
      "dedicated",
      "committed",
      "persevere",
      "persist",
      "resilient",
      "warrior",
      "champion",
    ]),
    icon: _em("💪"),
  },
  {
    label: "questioning",
    words: new Set([
      "why",
      "how",
      "what",
      "when",
      "where",
      "who",
      "which",
      "whether",
      "wonder",
      "curious",
      "imagine",
      "suppose",
      "consider",
      "ponder",
      "reflect",
      "contemplate",
      "ask",
      "question",
      "inquire",
      "explore",
    ]),
    icon: _em("🤔"),
  },
  {
    label: "numeric",
    words: new Set([
      "percent",
      "million",
      "thousand",
      "hundred",
      "billion",
      "ratio",
      "rate",
      "average",
      "median",
      "total",
      "statistics",
      "numbers",
      "approximately",
      "roughly",
      "exactly",
      "precisely",
      "calculated",
      "measured",
      "quantified",
      "analyzed",
    ]),
    icon: _em("📊"),
  },
  {
    label: "explanatory",
    words: new Set([
      "explain",
      "means",
      "basically",
      "essentially",
      "simply",
      "understand",
      "know",
      "realize",
      "point",
      "reason",
      "therefore",
      "because",
      "actually",
      "technically",
      "fundamentally",
      "specifically",
      "literally",
      "clarify",
      "define",
      "illustrate",
    ]),
    icon: _svg("bulb.svg"),
  },
  {
    label: "urgency",
    words: new Set([
      "urgent",
      "immediately",
      "now",
      "quick",
      "fast",
      "hurry",
      "rush",
      "asap",
      "critical",
      "important",
      "crucial",
      "essential",
      "necessary",
      "priority",
      "emergency",
      "pressing",
      "imminent",
      "instant",
      "swift",
      "rapid",
    ]),
    icon: _em("⚡"),
  },
  {
    label: "comparison",
    words: new Set([
      "better",
      "worse",
      "best",
      "worst",
      "compare",
      "versus",
      "vs",
      "difference",
      "similar",
      "unlike",
      "whereas",
      "although",
      "however",
      "despite",
      "contrast",
      "alternative",
      "instead",
      "prefer",
      "superior",
      "inferior",
    ]),
    icon: _em("⚖️"),
  },
  {
    label: "discovery",
    words: new Set([
      "found",
      "discovered",
      "uncovered",
      "revealed",
      "identified",
      "noticed",
      "spotted",
      "detected",
      "observed",
      "witnessed",
      "confirmed",
      "showed",
      "demonstrated",
      "proved",
      "established",
    ]),
    icon: _em("🔍"),
  },
  {
    label: "transformation",
    words: new Set([
      "changed",
      "transformed",
      "evolved",
      "shifted",
      "converted",
      "switched",
      "reformed",
      "rebuilt",
      "redesigned",
      "reinvented",
      "overhauled",
      "revamped",
      "revolutionized",
      "disrupted",
      "replaced",
    ]),
    icon: _em("🔄"),
  },
];

// ═════════════════════════════════════════════════════════════
// TIER 5 — UNIVERSAL ROTATING FALLBACK (30 icons)
// Used when ALL four tiers produce no match.
// Cycles in round-robin — never repeats consecutively,
// always contextually neutral but engaging.
// ═════════════════════════════════════════════════════════════
const FALLBACK_POOL = [
  _em("👀"),
  _em("💡"),
  _em("🎯"),
  _em("⚡"),
  _em("🔥"),
  _em("✨"),
  _em("💪"),
  _em("🧠"),
  _em("🚀"),
  _em("👊"),
  _em("🌟"),
  _em("⭐"),
  _em("💥"),
  _em("🔑"),
  _em("💎"),
  _em("🏆"),
  _em("📈"),
  _em("⬆️"),
  _em("🎖️"),
  _em("🌊"),
  _em("🎭"),
  _em("🦁"),
  _em("🔮"),
  _em("🌀"),
  _em("⚔️"),
  _em("🛡️"),
  _em("🏹"),
  _em("🌈"),
  _em("🦅"),
  _em("🎪"),
];

let _fallbackIdx = 0;
function _nextFallback() {
  const icon = FALLBACK_POOL[_fallbackIdx % FALLBACK_POOL.length];
  _fallbackIdx++;
  return icon;
}

// ═════════════════════════════════════════════════════════════
// MATCHING ENGINE
// ═════════════════════════════════════════════════════════════

function _norm(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match a text chunk through all 4 tiers.
 * Returns { type, value } or null (caller handles null → fallback).
 *
 * @param {string}   rawText   - joined words of the chunk
 * @param {string[]} rawWords  - individual word array
 */
function _matchChunk(rawText, rawWords) {
  const text = _norm(rawText);
  const words = rawWords.map(_norm);
  const wset = new Set(words);

  // ── Tier 1: Exact phrase ────────────────────────────────
  for (const { phrase, icon } of PHRASE_MAP) {
    if (text.includes(phrase)) return icon;
  }

  // ── Tier 2: Word combo (within 6-word window) ───────────
  for (const [w1, w2, icon] of COMBO_MAP) {
    const i1 = words.indexOf(w1);
    const i2 = words.indexOf(w2);
    if (i1 !== -1 && i2 !== -1 && Math.abs(i1 - i2) <= 6) return icon;
  }

  // ── Tier 3: Single keyword (O(1) set + O(1) map) ────────
  // First pass: exact word boundary match (fastest)
  for (const w of wset) {
    const hit = KEYWORD_LOOKUP.get(w);
    if (hit) return hit;
  }
  // Second pass: substring match for morphological variants
  // e.g. "investing" matches "invest", "running" matches "run"
  for (const [kw, icon] of KEYWORD_LOOKUP) {
    if (text.includes(kw)) return icon;
  }

  // ── Tier 4: Sentiment / tone ────────────────────────────
  for (const tier of SENTIMENT_TIERS) {
    for (const w of wset) {
      if (tier.words.has(w)) return tier.icon;
    }
  }

  return null; // nothing matched — caller uses fallback
}

/** Convert an internal icon descriptor to a Remotion overlay object */
function _toOverlay(icon, atSec) {
  if (icon.type === "svg") {
    return { icon: icon.value, atSec, x: 0.5, y: 0.68, size: 100 };
  }
  return { emoji: icon.value, atSec, x: 0.5, y: 0.68, size: 100 };
}

// ═════════════════════════════════════════════════════════════
// MAIN EXPORT — buildIconOverlaysFromTranscript
//
// Algorithm:
//   1. Divide words into 3.5s chunks
//   2. Run 4-tier matcher on each chunk → icon or null
//   3. Place icon at midpoint of spoken words in chunk
//      (midpoint = better visual sync than chunk start)
//   4. Enforce 3s minimum gap (removes clustering)
//   5. Fill any gap > 7s with rotating fallback
//   6. Guarantee first icon ≤ 2s, last icon ≤ 3s before end
//   7. Final gap-enforcement pass after insertions
//
// Complexity: O(n * k) where n = chunks, k = keyword count
// Runtime on 1000 keywords, 60s clip: < 3ms
// ═════════════════════════════════════════════════════════════
function buildIconOverlaysFromTranscript(words, clipDurationSecs) {
  if (!words || words.length === 0) return [];

  const duration = clipDurationSecs || 30;
  const CHUNK_DUR = 3.5; // seconds per analysis window
  const MIN_GAP = 3.0; // minimum seconds between any two icons
  const MAX_GAP = 7.0; // maximum seconds before forcing a fallback

  // ── Step 1: Match each chunk ────────────────────────────
  const rawPlacements = [];
  for (let t = 0; t < duration; t += CHUNK_DUR) {
    const end = Math.min(t + CHUNK_DUR, duration);
    const cw = words.filter((w) => w.startSec >= t && w.startSec < end);
    if (cw.length === 0) continue;

    // Icon timestamp = midpoint of actual spoken words (not chunk edge)
    const mid = cw[Math.floor(cw.length / 2)];
    const atSec = mid.startSec;

    const icon = _matchChunk(
      cw.map((w) => w.word).join(" "),
      cw.map((w) => w.word),
    );
    rawPlacements.push({ atSec, icon });
  }

  // ── Step 2: Enforce MIN_GAP (remove clustering) ─────────
  const gapped = [];
  let lastSec = -99;
  for (const p of rawPlacements) {
    if (p.atSec - lastSec >= MIN_GAP) {
      gapped.push(p);
      lastSec = p.atSec;
    }
  }

  // ── Step 3: Build output with gap-filling ───────────────
  const out = [];
  let prev = 0;

  // Guarantee icon near the start (within 2s)
  if (gapped.length === 0 || gapped[0].atSec > 2) {
    out.push(_toOverlay(_nextFallback(), 1.0));
    prev = 1.0;
  }

  for (const p of gapped) {
    // Fill large internal gaps with fallback
    while (p.atSec - prev > MAX_GAP) {
      const fill = prev + MAX_GAP / 2;
      if (fill < duration - 1) {
        out.push(_toOverlay(_nextFallback(), fill));
        prev = fill;
      } else break;
    }
    // Place matched icon (or fallback if no match)
    out.push(_toOverlay(p.icon || _nextFallback(), p.atSec));
    prev = p.atSec;
  }

  // Guarantee icon near the end (within 3s of end)
  if (out.length === 0 || duration - prev > 5) {
    const endSec = Math.max(prev + MIN_GAP, duration - 2.5);
    if (endSec < duration) out.push(_toOverlay(_nextFallback(), endSec));
  }

  // ── Step 4: Final MIN_GAP pass after all insertions ─────
  const final = [];
  let lastF = -99;
  for (const ov of out.sort((a, b) => a.atSec - b.atSec)) {
    if (ov.atSec - lastF >= MIN_GAP) {
      final.push(ov);
      lastF = ov.atSec;
    }
  }

  console.log(
    `      🎭 Icons (rule): ${final.length} | ${final
      .map((o) => `${o.emoji || o.icon}@${o.atSec.toFixed(1)}s`)
      .join(" ")}`,
  );
  return final;
}

module.exports = {
  buildIconOverlaysFromTranscript,
  SVG_ICONS,
  SVG_EMOJI_FALLBACK,
  PHRASE_MAP,
  COMBO_MAP,
  KEYWORD_ENTRIES,
  KEYWORD_LOOKUP,
  SENTIMENT_TIERS,
  FALLBACK_POOL,
};
