const { query } = require("../db/pool");
const { transcribeVideo, extractWordTimingsForClip } = require("../services/transcriber");
const { burnCaptions } = require("../services/captionBurner");
const { formatTime } = require("../services/clipCutter");
const pathModule = require("path");

async function handleAddCaptions(dbJob, videoPath, jobId, userId) {
  const platforms = dbJob.platforms || ["tiktok"];
  const segments = await transcribeVideo(videoPath);
  const wordTimings = extractWordTimingsForClip(segments, 0, 999999);
  
  const clip = {
    title: dbJob.video_title || "Captioned Video",
    startSec: 0,
    endSec: wordTimings[wordTimings.length-1]?.endSec || 0,
    transcript: segments.map(s => s.text).join(" ")
  };

  const captionedPath = await burnCaptions({
    ...clip, filePath: videoPath, fileUrl: "", wordTimings, jobId, startSec: 0, endSec: clip.endSec,
    captionPosition: "bottom", brollSegments: [], splitTimeline: []
  }, "general", platforms);

  let fileUrl = `/outputs/${jobId}/${pathModule.basename(captionedPath)}`;
  
  await query(
    `INSERT INTO clips (job_id, user_id, title, file_path, file_url, duration, start_time, end_time, hook_score, platforms, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [jobId, userId, clip.title, captionedPath, fileUrl, formatTime(clip.endSec), "0:00", formatTime(clip.endSec), 100, platforms, clip.transcript]
  );
}

module.exports = handleAddCaptions;
