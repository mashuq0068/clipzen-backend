const { query } = require("../db/pool");
const { transcribeVideo, extractWordTimingsForClip } = require("../services/transcriber");
const { cutClip, formatTime } = require("../services/clipCutter");
const { burnCaptions } = require("../services/captionBurner");
const { buildBrollSegments } = require("../services/brollEngine");
const { extractClipThumbnail } = require("../services/thumbnailExtractor");
const pathModule = require("path");
const fs = require("fs");

async function handleEditVideo(dbJob, videoPath, jobId, userId, helpers) {
  const { analyzeClipTimelineForClip } = helpers;

  // 1. Duration check
  // For now we assume videoPath exists and we can get duration from it or dbJob.original_duration
  // If we want a strict check, we could use ffprobe, but for now we'll trust the process.

  const brollEnabled = dbJob.broll_enabled || false;
  const brollStyle = dbJob.broll_style || "fullscreen";
  
  console.log(`\nTranscribing...`);
  const segments = await transcribeVideo(videoPath);
  const transcript = segments.map(s => s.text).join(" ");

  const clip = {
    title: dbJob.video_title || "Edited Video",
    startSec: 0,
    endSec: segments[segments.length-1]?.endSec || 60, // Default to 60 if empty
    transcript: transcript
  };

  console.log(`\nAnalyzing Layout...`);
  const clipTimeline = await analyzeClipTimelineForClip(videoPath, clip);

  console.log(`\nCutting & Processing...`);
  const cut = await cutClip(videoPath, 0, clip.endSec, jobId, "general", clip, clipTimeline);
  let filePath = cut.filePath;
  let fileUrl = cut.fileUrl;

  if (filePath) {
    const wordTimings = extractWordTimingsForClip(segments, 0, clip.endSec);
    const jobOutputDir = pathModule.dirname(filePath);
    
    console.log(`\nBuilding B-roll...`);
    const brollSegments = await buildBrollSegments(clip, wordTimings, "general", "general", brollEnabled, brollStyle, jobOutputDir);

    console.log(`\nBurning Captions...`);
    const captionedPath = await burnCaptions({
      ...clip, filePath, fileUrl, wordTimings, jobId, startSec: 0, endSec: clip.endSec,
      captionPosition: "bottom", brollSegments, splitTimeline: []
    }, "general", ["tiktok"]); // Default to tiktok format for edit video vertical

    if (captionedPath && captionedPath !== filePath) {
      fileUrl = `/outputs/${jobId}/${pathModule.basename(captionedPath)}`;
      filePath = captionedPath;
    }
  }

  const { rows: clipRows } = await query(
    `INSERT INTO clips (job_id, user_id, title, file_path, file_url, duration, start_time, end_time, hook_score, platforms, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [jobId, userId, clip.title, filePath, fileUrl, formatTime(clip.endSec), "0:00", formatTime(clip.endSec), 100, ["vertical"], transcript]
  );

  const clipId = clipRows[0].id;
  if (filePath && fs.existsSync(filePath)) {
    await extractClipThumbnail(filePath, jobId, clipId);
  }
}

module.exports = handleEditVideo;
