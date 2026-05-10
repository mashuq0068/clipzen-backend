const { execFile } = require("child_process");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const util = require("util");
const execFileAsync = util.promisify(execFile);

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function withRetry(fn, retries = 3, delayMs = 10000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 =
        err.message?.includes("429") ||
        err.message?.includes("Too Many Requests");
      const isBot = err.message?.includes("Sign in to confirm");

      if (attempt === retries || (!is429 && !isBot)) {
        throw err;
      }

      const wait = delayMs * attempt; // 10s, 20s, 30s
      console.warn(
        `⚠️ Attempt ${attempt} failed (429/bot check). Retrying in ${
          wait / 1000
        }s...`
      );
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}

async function _downloadVideo(url) {
  const outputDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  const filename = `${uuidv4()}.mp4`;
  const outputPath = path.join(outputDir, filename);
  const cookiesPath = path.resolve(
    process.env.YT_COOKIES_PATH || "./cookies.txt"
  );

  console.log(`⬇️  Downloading: ${url}`);

  const baseArgs = [
    "--cookies", cookiesPath,
    "--no-playlist",
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "--add-header", "Accept-Language:en-US,en;q=0.9",
    "--sleep-interval", "3",
    "--max-sleep-interval", "6",
  ];

  // Add proxy if configured
  if (process.env.YT_PROXY) {
    baseArgs.push("--proxy", process.env.YT_PROXY);
  }

  // Get metadata
  const { stdout: metaJson } = await execFileAsync("yt-dlp", [
    ...baseArgs,
    "--dump-json",
    url,
  ]);

  const meta = JSON.parse(metaJson);
  const title = meta.title || "Untitled Video";
  const duration = formatDuration(meta.duration || 0);

  // Download the video
  await execFileAsync("yt-dlp", [
    ...baseArgs,
    "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4",
    "--merge-output-format", "mp4",
    "-o", outputPath,
    url,
  ]);

  console.log(`✅ Downloaded: ${title} → ${outputPath}`);
  return { filePath: outputPath, title, duration };
}

async function downloadVideo(url) {
  try {
    return await withRetry(() => _downloadVideo(url), 3, 10000);
  } catch (err) {
    console.error("Download error:", err.stderr || err.message);
    throw new Error(`Failed to download video: ${err.message}`);
  }
}

module.exports = { downloadVideo };