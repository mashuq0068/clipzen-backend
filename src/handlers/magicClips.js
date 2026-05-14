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

const VALID_PLATFORMS = [
  "tiktok",
  "instagram",
  "linkedin",
  "facebook",
  "youtube",
  "twitter",
];

/**
 * Returns { brollFolder } so the worker can clean it up in `finally`.
 */
async function handleMagicClips(dbJob, videoPath, jobId, userId, helpers) {
  const {
    analyzeClipTimelineForClip,
    trimToStableLayoutWindow,
    trimToTimelineWindow,
    extractWordTimingsForStitchedClip,
  } = helpers;

  const brollEnabled = dbJob.broll_enabled || false;
  const brollStyle = dbJob.broll_style || "fullscreen";
  const platforms =
    Array.isArray(dbJob.platforms) && dbJob.platforms.length > 0
      ? dbJob.platforms
      : ["tiktok", "instagram", "youtube"];

  let brollFolder = null;

  console.log(`\nTranscribing...`);
  const segments = await transcribeVideo(videoPath);
  console.log(`\nSelecting story clips...`);
  const selectedClips = await selectClips(
    segments,
    dbJob.clip_count || 5,
    dbJob.clip_duration || 'auto',
    platforms,
    videoPath,
    [],
  );

  if (!selectedClips || selectedClips.length === 0)
    throw new Error("No clips selected");

  console.log(`\n${selectedClips.length} clips selected:`);
  selectedClips.forEach((c, i) => {
    const dur = (c.endSec - c.startSec).toFixed(0);
    const multi =
      c.segments?.length > 1
        ? ` [STITCHED: ${c.segments.map((s) => s.role).join("+")}]`
        : "";
    console.log(
      `  ${i + 1}. "${c.title}" ${dur}s | ${c.emotion}/${c.contentType}${multi}`,
    );
  });

  for (let i = 0; i < selectedClips.length; i++) {
    let clip = selectedClips[i];
    const clipContentType = clip.contentType || "general";
    const clipTopic = clip.topic || "general";
    const directives = clip.directives || {};
    const isStitched = clip.segments && clip.segments.length > 1;

    console.log(`\n[${i + 1}/${selectedClips.length}] "${clip.title}"`);

    // ── Face analysis ──────────────────────────────────────────────────────
    let clipTimeline = {
      timeline: [],
      srcW: 1920,
      srcH: 1080,
      isAlreadyVertical: false,
    };
    try {
      clipTimeline = await analyzeClipTimelineForClip(videoPath, clip);
      const modeSummary = clipTimeline.timeline.reduce((acc, e) => {
        acc[e.decision.mode] = (acc[e.decision.mode] || 0) + 1;
        return acc;
      }, {});
      console.log(`  Clip face timeline: ${JSON.stringify(modeSummary)}`);

      // ── Layout stabilization ─────────────────────────────────────────────
      if (
        !clipTimeline.isAlreadyVertical &&
        clipTimeline.timeline.length >= 4 &&
        !isStitched
      ) {
        const originalClipStart = clip.startSec;
        const trimmed = trimToStableLayoutWindow(clip, clipTimeline.timeline);
        if (trimmed.wasTrimmed) {
          console.log(
            `  ✂️  Layout-stabilized: [${formatTime(clip.startSec)}-${formatTime(clip.endSec)}] → ` +
              `[${formatTime(trimmed.startSec)}-${formatTime(trimmed.endSec)}] ` +
              `dominant="${trimmed.dominantMode}" (${(trimmed.dominantFrac * 100).toFixed(0)}%)`,
          );
          const trimmedTimeline = trimToTimelineWindow(
            clipTimeline.timeline,
            trimmed.startSec,
            trimmed.endSec,
            originalClipStart,
          );
          clip = { ...clip, startSec: trimmed.startSec, endSec: trimmed.endSec };
          clipTimeline = { ...clipTimeline, timeline: trimmedTimeline };
        }
      }
    } catch (e) {
      console.warn(`  Face analysis failed, using passthrough: ${e.message}`);
    }

    // ── Cut ────────────────────────────────────────────────────────────────
    const cut = await cutClip(
      videoPath,
      clip.startSec,
      clip.endSec,
      jobId,
      clipContentType,
      clip,
      clipTimeline,
    );
    let fileUrl = cut.fileUrl;
    let filePath = cut.filePath;

    // ── Captions + B-roll ──────────────────────────────────────────────────
    if (filePath && dbJob.auto_captions !== false) {
      const wordTimings = isStitched
        ? extractWordTimingsForStitchedClip(segments, clip.segments)
        : extractWordTimingsForClip(segments, clip.startSec, clip.endSec);

      const jobOutputDir = pathModule.dirname(filePath);
      // Track brollFolder for cleanup (use last seen value — all clips share same jobOutputDir)
      brollFolder = pathModule.join(jobOutputDir, "broll");

      const brollSegments = await buildBrollSegments(
        clip,
        wordTimings,
        clipTopic,
        clipContentType,
        brollEnabled,
        brollStyle,
        jobOutputDir,
      );

      const isSplitClip =
        clipTimeline.timeline.length > 0 &&
        clipTimeline.timeline.filter((e) => e.decision.mode === "split")
          .length >
          clipTimeline.timeline.length * 0.4;

      const splitTimeline = [];
      if (clipTimeline.timeline.length > 0) {
        const tl = clipTimeline.timeline;
        for (let ti = 0; ti < tl.length; ti++) {
          if (tl[ti].decision.mode !== "split") continue;
          const segStart = tl[ti].clipTimeSec;
          const segEnd =
            ti + 1 < tl.length
              ? tl[ti + 1].clipTimeSec
              : clip.endSec - clip.startSec;
          const last = splitTimeline[splitTimeline.length - 1];
          if (last && Math.abs(last.endSec - segStart) < 0.05) {
            last.endSec = segEnd;
          } else {
            splitTimeline.push({ startSec: segStart, endSec: segEnd });
          }
        }
      }

      let captionedPath = null;
      try {
        captionedPath = await burnCaptions(
          {
            ...clip,
            filePath,
            fileUrl,
            wordTimings,
            jobId,
            startSec: 0,
            endSec: clip.endSec - clip.startSec,
            segments: null,
            originalSegments: isStitched ? clip.segments : null,
            captionPosition: isSplitClip
              ? "center"
              : directives.captionPosition || "bottom",
            captionColorOverride: directives.captionColor || null,
            visualCue: directives.visualCue || null,
            brollSegments,
            splitTimeline,
          },
          clipContentType,
          platforms,
        );
      } catch (burnErr) {
        console.error(
          `  ❌ Caption burn FAILED for clip ${i + 1}: ${burnErr.message}`,
        );
        captionedPath = null;
      }

      // Only update paths if burn produced a valid new file
      if (
        captionedPath &&
        captionedPath !== filePath &&
        fs.existsSync(captionedPath) &&
        fs.statSync(captionedPath).size > 100_000
      ) {
        fileUrl = `/outputs/${jobId}/${pathModule.basename(captionedPath)}`;
        filePath = captionedPath;
        console.log(`  Captions burned`);
      } else if (captionedPath && captionedPath !== filePath) {
        console.warn(
          `  ⚠️  Burn output invalid for clip ${i + 1} — keeping original cut`,
        );
      }
    }

    // ── Save to DB ─────────────────────────────────────────────────────────
    const duration = formatTime(clip.endSec - clip.startSec);
    const thumbnailColor = THUMBNAIL_COLORS[i % THUMBNAIL_COLORS.length];

    const { rows: clipRows } = await query(
      `INSERT INTO clips (job_id, user_id, title, file_path, file_url, duration, start_time, end_time, hook_score, platforms, thumbnail_color, transcript)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        jobId,
        userId,
        clip.title,
        filePath,
        fileUrl,
        duration,
        formatTime(clip.startSec),
        formatTime(clip.endSec),
        clip.hookScore,
        platforms,
        thumbnailColor,
        clip.transcript || "",
      ],
    );

    const clipId = clipRows[0].id;

    if (filePath && fs.existsSync(filePath)) {
      const clipThumbUrl = await extractClipThumbnail(filePath, jobId, clipId);
      if (clipThumbUrl)
        await query("UPDATE clips SET thumbnail_url = $1 WHERE id = $2", [
          clipThumbUrl,
          clipId,
        ]);
    }

    // ── Platform captions ──────────────────────────────────────────────────
    if (dbJob.auto_captions !== false) {
      console.log(`  Writing platform captions...`);
      try {
        const captions = await generateAllCaptions(
          clip.transcript || "",
          clip.title,
          platforms,
        );
        for (const [platform, body] of Object.entries(captions)) {
          if (!body) continue;
          const normalizedPlatform = platform.toLowerCase().trim();
          if (!VALID_PLATFORMS.includes(normalizedPlatform)) {
            console.warn(`  ⚠️ Skipping invalid platform: "${platform}"`);
            continue;
          }
          await query(
            `INSERT INTO captions (clip_id, platform, body) VALUES ($1,$2,$3)
             ON CONFLICT (clip_id, platform) DO UPDATE SET body = EXCLUDED.body`,
            [clipId, normalizedPlatform, body],
          );
          console.log(`  ✅ ${normalizedPlatform} caption saved`);
        }
        console.log(
          `  Captions saved for ${Object.keys(captions).length} platforms`,
        );
      } catch (capErr) {
        console.warn(`  Captions failed: ${capErr.message}`);
      }
    }
  }

  await query("UPDATE jobs SET clip_count = $1 WHERE id = $2", [
    selectedClips.length,
    jobId,
  ]);

  // Return brollFolder so worker can clean it up
  return { brollFolder };
}

module.exports = handleMagicClips;