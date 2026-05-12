const { query } = require("../db/pool");
const {
  transcribeVideo,
  extractWordTimingsForClip,
} = require("../services/transcriber");
const { selectClips } = require("../services/clipSelector");
const { cutClip, formatTime } = require("../services/clipCutter");
const { generateAllCaptions } = require("../services/captionWriter");
const { burnCaptions } = require("../services/captionBurner");
const { buildBrollSegments } = require("../services/brollEngine");
const { extractClipThumbnail } = require("../services/thumbnailExtractor");
const fs = require("fs");
const pathModule = require("path");

const THUMBNAIL_COLORS = [
  "bg-gradient-to-br from-violet-500/30 to-purple-400/10",
  "bg-gradient-to-br from-blue-500/30 to-cyan-400/10",
  "bg-gradient-to-br from-rose-500/30 to-pink-400/10",
  "bg-gradient-to-br from-amber-500/30 to-orange-400/10",
  "bg-gradient-to-br from-emerald-500/30 to-teal-400/10",
];

// Re-using helper functions that were in videoWorker.js
// Ideally these should be in a utils file, but for now I'll include them here or import them if I move them to utils.
// To keep it simple, I'll pass them in as dependencies or just redefine them if they are small.

async function handleMagicClips(dbJob, videoPath, jobId, userId, helpers) {
  const { 
    analyzeClipTimelineForClip, 
    trimToStableLayoutWindow, 
    trimToTimelineWindow,
    extractWordTimingsForStitchedClip 
  } = helpers;

  const brollEnabled = dbJob.broll_enabled || false;
  const brollStyle = dbJob.broll_style || "fullscreen";
  const platforms = Array.isArray(dbJob.platforms) && dbJob.platforms.length > 0 ? dbJob.platforms : ["tiktok", "instagram", "youtube"];

  console.log(`\nTranscribing...`);
  const segments = await transcribeVideo(videoPath);

  console.log(`\nSelecting story clips...`);
  const selectedClips = await selectClips(segments, dbJob.clip_count || 5, dbJob.clip_duration || "auto", platforms, videoPath, []);

  if (!selectedClips || selectedClips.length === 0) throw new Error("No clips selected");

  for (let i = 0; i < selectedClips.length; i++) {
    let clip = selectedClips[i];
    const clipContentType = clip.contentType || "general";
    const clipTopic = clip.topic || "general";
    const directives = clip.directives || {};
    const isStitched = clip.segments && clip.segments.length > 1;

    let clipTimeline = await analyzeClipTimelineForClip(videoPath, clip);

    // Layout stabilization
    if (!clipTimeline.isAlreadyVertical && clipTimeline.timeline.length >= 4 && !isStitched) {
      const originalClipStart = clip.startSec;
      const trimmed = trimToStableLayoutWindow(clip, clipTimeline.timeline);
      if (trimmed.wasTrimmed) {
        const trimmedTimeline = trimToTimelineWindow(clipTimeline.timeline, trimmed.startSec, trimmed.endSec, originalClipStart);
        clip = { ...clip, startSec: trimmed.startSec, endSec: trimmed.endSec };
        clipTimeline = { ...clipTimeline, timeline: trimmedTimeline };
      }
    }

    const cut = await cutClip(videoPath, clip.startSec, clip.endSec, jobId, clipContentType, clip, clipTimeline);
    let fileUrl = cut.fileUrl;
    let filePath = cut.filePath;

    if (filePath && dbJob.auto_captions !== false) {
      const wordTimings = isStitched ? extractWordTimingsForStitchedClip(segments, clip.segments) : extractWordTimingsForClip(segments, clip.startSec, clip.endSec);
      const jobOutputDir = pathModule.dirname(filePath);
      const brollSegments = await buildBrollSegments(clip, wordTimings, clipTopic, clipContentType, brollEnabled, brollStyle, jobOutputDir);
      
      const isSplitClip = clipTimeline.timeline.length > 0 && clipTimeline.timeline.filter((e) => e.decision.mode === "split").length > clipTimeline.timeline.length * 0.4;
      const splitTimeline = [];
      if (clipTimeline.timeline.length > 0) {
        const tl = clipTimeline.timeline;
        for (let ti = 0; ti < tl.length; ti++) {
          if (tl[ti].decision.mode !== "split") continue;
          const segStart = tl[ti].clipTimeSec;
          const segEnd = ti + 1 < tl.length ? tl[ti + 1].clipTimeSec : clip.endSec - clip.startSec;
          const last = splitTimeline[splitTimeline.length - 1];
          if (last && Math.abs(last.endSec - segStart) < 0.05) { last.endSec = segEnd; } else { splitTimeline.push({ startSec: segStart, endSec: segEnd }); }
        }
      }

      const captionedPath = await burnCaptions({
        ...clip, filePath, fileUrl, wordTimings, jobId, startSec: 0, endSec: clip.endSec - clip.startSec,
        captionPosition: isSplitClip ? "center" : directives.captionPosition || "bottom",
        captionColorOverride: directives.captionColor || null,
        visualCue: directives.visualCue || null,
        brollSegments, splitTimeline
      }, clipContentType, platforms);

      if (captionedPath && captionedPath !== filePath) {
        fileUrl = `/outputs/${jobId}/${pathModule.basename(captionedPath)}`;
        filePath = captionedPath;
      }
    }

    const duration = formatTime(clip.endSec - clip.startSec);
    const thumbnailColor = THUMBNAIL_COLORS[i % THUMBNAIL_COLORS.length];

    const { rows: clipRows } = await query(
      `INSERT INTO clips (job_id, user_id, title, file_path, file_url, duration, start_time, end_time, hook_score, platforms, thumbnail_color, transcript)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [jobId, userId, clip.title, filePath, fileUrl, duration, formatTime(clip.startSec), formatTime(clip.endSec), clip.hookScore, platforms, thumbnailColor, clip.transcript || ""]
    );

    const clipId = clipRows[0].id;
    if (filePath && fs.existsSync(filePath)) {
      const clipThumbUrl = await extractClipThumbnail(filePath, jobId, clipId);
      if (clipThumbUrl) await query("UPDATE clips SET thumbnail_url = $1 WHERE id = $2", [clipThumbUrl, clipId]);
    }

    if (dbJob.auto_captions !== false) {
      const captions = await generateAllCaptions(clip.transcript || "", clip.title, platforms);
      for (const [platform, body] of Object.entries(captions)) {
        if (!body) continue;
        await query(`INSERT INTO captions (clip_id, platform, body) VALUES ($1,$2,$3) ON CONFLICT (clip_id, platform) DO UPDATE SET body = EXCLUDED.body`, [clipId, platform.toLowerCase().trim(), body]);
      }
    }
  }

  await query("UPDATE jobs SET clip_count = $1 WHERE id = $2", [selectedClips.length, jobId]);
}

module.exports = handleMagicClips;
