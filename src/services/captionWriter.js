/**
 * captionWriter.js
 *
 * Platform caption generation.
 * Uses llmProvider — supports Ollama AND OpenRouter via .env:
 *
 *   MODEL_PROVIDER=ollama              → local Ollama
 *   MODEL_PROVIDER=openrouter          → any cloud model via OpenRouter
 *   MODEL_NAME=nousresearch/hermes-3-llama-3.1-405b:free
 *   OPENROUTER_API_KEY=sk-or-...
 *
 * FIX: was Promise.all (6 concurrent Ollama requests → all empty)
 * Now: sequential for-loop + preflight + explicit empty check + retry via llmProvider
 */

const { llmWithRetry, isLLMAvailable } = require("./llmProvider");
const { deriveHashtags } = require("../utils/textLang");

const PLATFORM_INSTRUCTIONS = {
  tiktok:
    "TikTok: 1-2 line hook creating curiosity or FOMO. 3-5 trending hashtags. 1-2 emojis. Max 150 chars.",
  instagram:
    "Instagram Reels: 2-3 engaging lines + CTA + 5-8 hashtags. 1-2 emojis. Max 200 chars.",
  linkedin:
    "LinkedIn: 2-3 professional insight-driven sentences. NO hashtags. Minimal emojis. Thought-leader tone. Max 250 chars.",
  facebook:
    "Facebook: 2-3 conversational lines. End with a question. 1-2 emojis. No hashtags.",
  youtube:
    "YouTube Shorts: Clickbait title (max 60 chars) + 1-line description with 2-3 SEO keywords.",
  twitter:
    "Twitter/X: One punchy line under 280 chars. Bold or provocative. Max 2 hashtags.",
};

/**
 * Algorithmic caption fallback — used when the LLM is unavailable.
 *
 * MULTILINGUAL: builds the caption from the clip's own title (already in the
 * content's language) plus language-neutral elements (emoji, and hashtags
 * derived from the title's OWN words). No English boilerplate is injected, so
 * a Hindi/Arabic/Japanese clip gets a Hindi/Arabic/Japanese caption — not a
 * mix. `#Shorts` is kept only for YouTube as a platform convention, not text.
 */
function getFallbackCaption(title, platform) {
  const base =
    (title || "")
      .replace(/[.…]+$/u, "")
      .replace(/["']/g, "")
      .trim() || "▶";

  // Hashtags from the title's own words → same language as the content.
  const tagCount = platform === "instagram" ? 6 : platform === "tiktok" ? 4 : 2;
  const tags = deriveHashtags(base, tagCount).join(" ");

  switch (platform) {
    case "tiktok":
      return `${base} 🔥 ${tags}`.trim().slice(0, 150);
    case "instagram":
      return `${base} ✨\n\n${tags}`.trim().slice(0, 200);
    case "linkedin":
      return base.slice(0, 250); // professional: no emoji, no hashtags
    case "facebook":
      return `${base} 👇`.trim().slice(0, 200);
    case "youtube":
      return `${base} #Shorts`.trim().slice(0, 90);
    case "twitter":
      return `${base} ${deriveHashtags(base, 2).join(" ")}`.trim().slice(0, 280);
    default:
      return base.slice(0, 200);
  }
}

async function generateCaption(transcript, clipTitle, platform) {
  const instruction =
    PLATFORM_INSTRUCTIONS[platform] || PLATFORM_INSTRUCTIONS.tiktok;

  let plainText = transcript || "";
  try {
    const parsed = JSON.parse(transcript);
    if (Array.isArray(parsed)) {
      plainText = parsed.map(s => s.text).join(" ");
    }
  } catch (e) {
    // Not JSON, use as is
  }

  const excerpt = plainText.substring(0, 500).trim();

  return llmWithRetry({
    prompt: `Write a social media caption for a short-form video.

Platform rules: ${instruction}

Video title: "${clipTitle}"
Transcript: "${excerpt}"

Match the language of the transcript exactly.
Return ONLY the caption text. No explanation, no quotes, no markdown.`,
    maxTokens: 150,
    temperature: 0.7,
  });
}

// Sequential — NOT Promise.all (Ollama is single-threaded, OpenRouter has rate limits)
async function generateAllCaptions(transcript, clipTitle, platforms) {
  const captions = {};

  const up = await isLLMAvailable();
  if (!up) {
    console.warn(
      `      ⚠️  LLM not reachable — using fallback captions for all platforms`,
    );
    for (const p of platforms) captions[p] = getFallbackCaption(clipTitle, p);
    return captions;
  }

  console.log(
    `      Generating captions for ${platforms.length} platforms (sequential)...`,
  );

  for (const platform of platforms) {
    try {
      captions[platform] = await generateCaption(
        transcript,
        clipTitle,
        platform,
      );
      console.log(
        `      ✅ ${platform}: ${captions[platform].substring(0, 50)}...`,
      );
    } catch (err) {
      const detail = err?.message?.split("\n")[0] || err?.code || "unknown";
      console.warn(`      ⚠️  ${platform} failed (${detail}) — fallback`);
      captions[platform] = getFallbackCaption(clipTitle, platform);
    }
  }

  return captions;
}

module.exports = { generateAllCaptions, generateCaption };
