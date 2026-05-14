const { query } = require("../db/pool");
const { transcribeVideo } = require("../services/transcriber");
const { cutClip, formatTime } = require("../services/clipCutter");
const { extractClipThumbnail } = require("../services/thumbnailExtractor");
const { promisify } = require("util");
const { exec } = require("child_process");
const fs = require("fs");

const execAsync = promisify(exec);

async function handleReframer(dbJob, videoPath, jobId, userId, helpers) {
  const { analyzeClipTimelineForClip } = helpers;

  const platforms = dbJob.platforms || ["tiktok"];

  // Probe actual video duration
  let videoDuration = 60;
  try {
    const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
    const { stdout } = await execAsync(
      `"${ffprobe}" -v quiet -print_format json -show_format "${videoPath}"`,
      { timeout: 15000 },
    );
    const info = JSON.parse(stdout);
    const dur = parseFloat(info?.format?.duration || "0");
    if (dur > 0) videoDuration = dur;
  } catch (e) {
    console.warn(`  ⚠️  Could not probe duration: ${e.message.split("\n")[0]}`);
  }

  const clip = {
    title: dbJob.video_title || "Reframed Video",
    startSec: 0,
    endSec: videoDuration,
    transcript: "",
  };

  console.log(`\nTranscribing...`);
  const segments = await transcribeVideo(videoPath);
  clip.transcript = segments.map((s) => s.text).join(" ");
  const transcriptJson = JSON.stringify(segments);

  console.log(`\nAnalyzing clip timeline (YOLOv8)...`);
  const clipTimeline = await analyzeClipTimelineForClip(videoPath, clip);

  console.log(`\nCutting reframed video...`);
  const cut = await cutClip(
    videoPath,
    clip.startSec,
    clip.endSec,
    jobId,
    "general",
    clip,
    clipTimeline,
  );

  if (!cut || !cut.filePath) throw new Error("Reframe cut failed — no output file");

  const { rows: clipRows } = await query(
    `INSERT INTO clips (job_id, user_id, title, file_path, file_url, duration, start_time, end_time, hook_score, platforms, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      jobId,
      userId,
      clip.title,
      cut.filePath,
      cut.fileUrl,
      formatTime(videoDuration),
      "0:00",
      formatTime(videoDuration),
      100,
      platforms,
      transcriptJson,
    ],
  );

  const clipId = clipRows[0].id;
  if (cut.filePath && fs.existsSync(cut.filePath)) {
    await extractClipThumbnail(cut.filePath, jobId, clipId);
  }
}

module.exports = handleReframer;