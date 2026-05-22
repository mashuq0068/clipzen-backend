/* eslint-disable no-console */
const { execFile, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");

const execFileAsync = util.promisify(execFile);
const execAsync = util.promisify(exec);
const PYTHON = process.env.PYTHON_PATH || "python3";

function getFFmpeg() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

async function run(videoPath) {
  if (!videoPath) {
    console.error("❌ Please provide a video file");
    console.log("Usage: node detect.js <video.mp4>");
    process.exit(1);
  }

  const ffmpeg = getFFmpeg();
  const audioPath = videoPath.replace(/\.[^.]+$/, ".mp3");
  const outputDir = path.dirname(audioPath);

  try {
    console.log("🔊 Extracting audio...");

    await execFileAsync(ffmpeg, [
      "-i",
      videoPath,
      "-q:a",
      "0",
      "-map",
      "a",
      "-y",
      audioPath,
    ]);

    console.log("🧠 Detecting language...");

    // Language detection run (fast + small model)
    const cmd = `${PYTHON} -m whisper "${audioPath}" --model small --task transcribe --output_format json --output_dir "${outputDir}" --verbose False`;

    await execAsync(cmd, {
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const jsonPath = path.join(
      outputDir,
      path.basename(audioPath, ".mp3") + ".json"
    );

    if (!fs.existsSync(jsonPath)) {
      throw new Error("Whisper JSON not found");
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

    const lang = data.language || "unknown";
    const segments = data.segments || [];

    const preview = segments
      .slice(0, 3)
      .map((s) => s.text)
      .join(" ")
      .slice(0, 200);

    const isBengali = lang === "bn";

    console.log("\n=======================");
    console.log("🌍 Detected Language:", lang);
    console.log("🇧🇩 Bengali:", isBengali ? "YES" : "NO");
    console.log("📝 Preview:", preview);
    console.log("=======================\n");

    if (isBengali) {
      console.log("💡 Recommendation: Use --language bn + medium model");
    } else {
      console.log("💡 Recommendation: Use auto or detected language");
    }

    // cleanup
    try {
      fs.unlinkSync(audioPath);
      fs.unlinkSync(jsonPath);
    } catch {}
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

run(process.argv[2]);