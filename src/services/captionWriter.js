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

function getFallbackCaption(title, platform) {
  const clean = (title || "Watch this")
    .replace(/\.\.\.\$/, "")
    .replace(/["']/g, "")
    .trim()
    .substring(0, 60);
  return (
    {
      tiktok: `${clean} 🔥 #Viral #MustWatch #Shorts`,
      instagram: `${clean} ✨\n\nSave this for later!\n\n#Reels #ContentCreator #Viral`,
      linkedin: `${clean} — worth thinking about today.`,
      facebook: `Have you thought about this?\n\n"${clean}" — drop your thoughts below 👇`,
      youtube: `${clean} | Watch till the end #Shorts`,
      twitter: `"${clean}" — this one's different.`,
    }[platform] || clean
  );
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
