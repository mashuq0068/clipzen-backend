const { query } = require("../db/pool");
const { transcribeVideo, extractWordTimingsForClip } = require("../services/transcriber");
const { cutClip, formatTime } = require("../services/clipCutter");
const { burnCaptions } = require("../services/captionBurner");
const { buildBrollSegments } = require("../services/brollEngine");
const { extractClipThumbnail } = require("../services/thumbnailExtractor");
const pathModule = require("path");
const fs = require("fs");

async function handleBrollOnly(dbJob, videoPath, jobId, userId, helpers) {
  const brollStyle = dbJob.broll_style || "fullscreen";
  
  console.log(`\nTranscribing for B-roll placement...`);
  const segments = await transcribeVideo(videoPath);
  const transcript = segments.map(s => s.text).join(" ");

  const clip = {
    title: dbJob.video_title || "B-roll Video",
    startSec: 0,
    endSec: segments[segments.length-1]?.endSec || 60,
    transcript: transcript
  };

  // We skip complex reframing if it's just b-roll only, or we can do a simple vertical cut
  const cut = await cutClip(videoPath, 0, clip.endSec, jobId, "general", clip, { timeline: [], srcW: 1920, srcH: 1080 });
  let filePath = cut.filePath;
  let fileUrl = cut.fileUrl;

  if (filePath) {
    const wordTimings = extractWordTimingsForClip(segments, 0, clip.endSec);
    const jobOutputDir = pathModule.dirname(filePath);
    
    // brollEnabled is true for this service
    const brollSegments = await buildBrollSegments(clip, wordTimings, "general", "general", true, brollStyle, jobOutputDir);

    // Burn B-roll (burnCaptions handles b-roll even if autoCaptions is off)
    const processedPath = await burnCaptions({
      ...clip, filePath, fileUrl, wordTimings, jobId, startSec: 0, endSec: clip.endSec,
      captionPosition: "bottom", brollSegments, splitTimeline: []
    }, "general", ["vertical"], false); // false = no captions

    if (processedPath && processedPath !== filePath) {
      fileUrl = `/outputs/${jobId}/${pathModule.basename(processedPath)}`;
      filePath = processedPath;
    }
  }

  const { rows: clipRows } = await query(
    `INSERT INTO clips (job_id, user_id, title, file_path, file_url, duration, start_time, end_time, hook_score, platforms, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [jobId, userId, clip.title, filePath, fileUrl, formatTime(clip.endSec), "0:00", formatTime(clip.endSec), 100, ["b-roll"], transcript]
  );

  const clipId = clipRows[0].id;
  if (filePath && fs.existsSync(filePath)) {
    await extractClipThumbnail(filePath, jobId, clipId);
  }
}

module.exports = handleBrollOnly;
