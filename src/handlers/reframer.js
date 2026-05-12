const { query } = require("../db/pool");
const { cutClip, formatTime } = require("../services/clipCutter");
const { extractClipThumbnail } = require("../services/thumbnailExtractor");
const fs = require("fs");

async function handleReframer(dbJob, videoPath, jobId, userId, helpers) {
  const { analyzeClipTimelineForClip } = helpers;
  
  const platforms = dbJob.platforms || ["tiktok"];
  
  // We treat the whole video as one clip for reframing
  const clip = {
    title: dbJob.video_title || "Reframed Video",
    startSec: 0,
    endSec: 999999 // analyzeClipTimeline handles bounds
  };

  console.log(`\nAnalyzing Speaker Layout (YOLO v8)...`);
  const clipTimeline = await analyzeClipTimelineForClip(videoPath, clip);
  
  // Update endSec to actual duration if it was unknown
  if (clipTimeline.duration) clip.endSec = clipTimeline.duration;

  console.log(`\nReframing Video...`);
  const cut = await cutClip(videoPath, 0, clip.endSec, jobId, "general", clip, clipTimeline);
  
  const { rows: clipRows } = await query(
    `INSERT INTO clips (job_id, user_id, title, file_path, file_url, duration, start_time, end_time, hook_score, platforms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [jobId, userId, clip.title, cut.filePath, cut.fileUrl, formatTime(cut.duration), "0:00", formatTime(cut.duration), 100, platforms]
  );

  const clipId = clipRows[0].id;
  if (cut.filePath && fs.existsSync(cut.filePath)) {
    await extractClipThumbnail(cut.filePath, jobId, clipId);
  }
}

module.exports = handleReframer;
