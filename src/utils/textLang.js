/**
 * textLang.js
 *
 * Language-agnostic text helpers for the ALGORITHMIC (non-LLM) fallbacks.
 * Everything here is multilingual on purpose so clip-cutting, social captions
 * and on-screen titles degrade gracefully in ANY language when the LLM is
 * unavailable / rate-limited.
 *
 * Scripts covered by the sentence detector:
 *   Latin        . ! ?
 *   CJK          。 ！ ？
 *   Arabic/Urdu  ؟ ۔
 *   Indic danda  । ॥        (Hindi, Bengali, Marathi, Nepali, …)
 *   Ellipsis     …
 *
 * For Latin text these helpers behave identically to the old Latin-only
 * checks, so existing English behaviour is unchanged — they only ADD
 * correct handling for other scripts.
 */

// Sentence-ending punctuation across scripts.
const SENT_END_CHARS = ".!?。！？؟۔।॥…";

// A string/token ENDS a sentence (optionally followed by a closing quote/bracket).
const SENT_END_RE = new RegExp(`[${SENT_END_CHARS}]["'”’»)\\]]?\\s*$`);

// Question marks across scripts (Latin, fullwidth CJK, Arabic).
const QUESTION_RE = /[?？؟]/;

function endsSentence(str) {
  return SENT_END_RE.test((str || "").trim());
}

function isQuestion(str) {
  return QUESTION_RE.test(str || "");
}

/**
 * Split text into sentences using multilingual terminators.
 * The terminator stays attached to its sentence.
 */
function splitSentences(text) {
  const t = (text || "").trim();
  if (!t) return [];
  // Match a run ending in a terminator (works for CJK with no spaces too),
  // plus any trailing run that has no terminator at all.
  const re = new RegExp(
    `[^${SENT_END_CHARS}]*[${SENT_END_CHARS}]["'”’»)\\]]?|[^${SENT_END_CHARS}]+$`,
    "gu",
  );
  return (t.match(re) || [t]).map((s) => s.trim()).filter(Boolean);
}

/**
 * Script-agnostic word count. Space-separated scripts use word boundaries;
 * scripts without spaces (CJK) are approximated from character count.
 */
function wordCount(str) {
  const t = (str || "").trim();
  if (!t) return 0;
  const spaced = t.split(/\s+/).filter(Boolean).length;
  if (spaced > 1) return spaced;
  const chars = [...t].filter((c) => /\S/.test(c)).length;
  return chars > 0 ? Math.max(1, Math.round(chars / 2)) : spaced;
}

/**
 * First COMPLETE sentence from text, trimmed to ~maxWords with a clean ending.
 * A grammatical, meaningful summary in any language — far better than a raw
 * N-word cut for a title / summary fallback.
 */
function firstSentenceSummary(text, maxWords = 9) {
  const sentences = splitSentences(text);
  let candidate =
    sentences.find((s) => wordCount(s) >= 3) ||
    sentences[0] ||
    (text || "").trim();

  const words = candidate.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    candidate = words.slice(0, maxWords).join(" ") + "…";
  }
  // Strip trailing sentence punctuation / commas for a clean on-screen title.
  return candidate
    .replace(new RegExp(`[${SENT_END_CHARS},،]+\\s*$`, "u"), "")
    .trim();
}

// Common English stop-words — only used to AVOID dull hashtags. Non-English
// words are never in this set, so they pass through unaffected.
const STOP = new Set(
  (
    "a an the and or but of to in on for with at by from is are was were be " +
    "this that it as he she they we you i so not just like get got how why what"
  ).split(" "),
);

/**
 * Derive up to n hashtags from the most significant words of the text.
 * Language-agnostic: keeps tokens >= 3 chars in ANY script (Latin, Indic,
 * Arabic, CJK), skips pure numbers and English stop-words, de-dupes.
 * Hashtags therefore come out in the SAME language as the content.
 */
function deriveHashtags(text, n = 4) {
  const seen = new Set();
  const tags = [];
  for (const raw of (text || "").split(/\s+/)) {
    // Keep letters, numbers AND combining marks (\p{M}) so Indic/Arabic vowel
    // signs (ा ी े …) are not stripped out of the word.
    const w = raw.replace(/[^\p{L}\p{N}\p{M}]/gu, "");
    const len = [...w].length;
    // Too short, or an unsegmented run (e.g. a whole CJK clause with no spaces).
    if (len < 3 || len > 30) continue;
    if (/^\p{N}+$/u.test(w)) continue;
    const key = w.toLowerCase();
    if (STOP.has(key) || seen.has(key)) continue;
    seen.add(key);
    tags.push("#" + w.charAt(0).toUpperCase() + w.slice(1));
    if (tags.length >= n) break;
  }
  return tags;
}

module.exports = {
  SENT_END_RE,
  QUESTION_RE,
  endsSentence,
  isQuestion,
  splitSentences,
  wordCount,
  firstSentenceSummary,
  deriveHashtags,
};
