/* eslint-disable no-undef */
/* eslint-disable no-empty */
require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});

const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const { query } = require("../db/pool");
const { downloadVideo } = require("../services/downloader");
const {
  transcribeVideo,
  extractWordTimingsForClip,
} = require("../services/transcriber");
const { selectClips } = require("../services/clipSelector");
const { cutClip, formatTime } = require("../services/clipCutter");
const { generateAllCaptions } = require("../services/captionWriter");
const { burnCaptions } = require("../services/captionBurner");
const { buildBrollSegments } = require("../services/brollEngine");
const {
  extractJobThumbnail,
  extractClipThumbnail,
} = require("../services/thumbnailExtractor");
const fs = require("fs");
const pathModule = require("path");

// CHANGE 1: Updated import to include buildFullVideoLayoutMap
const { analyzeClipTimeline } = require("../services/speakerReframer");

const connection = new IORedis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  maxRetriesPerRequest: null,
});

const THUMBNAIL_COLORS = [
  "bg-gradient-to-br from-violet-500/30 to-purple-400/10",
  "bg-gradient-to-br from-blue-500/30 to-cyan-400/10",
  "bg-gradient-to-br from-rose-500/30 to-pink-400/10",
  "bg-gradient-to-br from-amber-500/30 to-orange-400/10",
  "bg-gradient-to-br from-emerald-500/30 to-teal-400/10",
];

function extractWordTimingsForStitchedClip(transcriptSegments, clipSegments) {
  const allWords = [];
  for (const seg of clipSegments) {
    const segStart = seg.startSec || 0;
    const segEnd = seg.endSec || 0;
    if (segEnd <= segStart) continue;
    for (const tSeg of transcriptSegments) {
      if (!tSeg.words || !Array.isArray(tSeg.words)) continue;
      for (const w of tSeg.words) {
        const wStart = w.start ?? w.startSec ?? 0;
        const wEnd = w.end ?? w.endSec ?? wStart + 0.1;
        if (wStart >= segStart - 0.15 && wStart < segEnd + 0.15) {
          allWords.push({
            word: (w.word || w.text || "").replace(/[^\w\s'''-]/g, "").trim(),
            startSec: wStart,
            endSec: wEnd,
            index: 0,
          });
        }
      }
    }
  }
  const seen = new Set();
  const deduped = allWords.filter((w) => {
    if (!w.word) return false;
    const key = `${w.startSec.toFixed(3)}_${w.word}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => a.startSec - b.startSec);
  return deduped.map((w, i) => ({ ...w, index: i }));
}

// ─── Segment-aware face analysis ─────────────────────────────────────────────
// For stitched clips, analyzeClipTimeline(start, end) would scan the gap
// between segments (unused footage), causing false split detections.
// Instead, scan each real segment separately and stitch the timelines
// with correct clipTimeSec offsets matching the stitched output.
async function analyzeClipTimelineForClip(videoPath, clip) {
  const isStitched = clip.segments && clip.segments.length > 1;

  if (!isStitched) {
    // Simple clip — scan its exact range
    return analyzeClipTimeline(videoPath, clip.startSec, clip.endSec);
  }

  // Stitched clip — scan each segment independently
  let combinedTimeline = [];
  let srcW = 1920, srcH = 1080, isAlreadyVertical = false;
  let clipTimeOffset = 0; // running offset in the stitched output

  for (const seg of clip.segments) {
    const segDur = seg.endSec - seg.startSec;
    if (segDur <= 0) continue;

    const result = await analyzeClipTimeline(videoPath, seg.startSec, seg.endSec);
    srcW = result.srcW;
    srcH = result.srcH;
    isAlreadyVertical = result.isAlreadyVertical;

    if (result.isAlreadyVertical || result.timeline.length === 0) {
      // No usable timeline for this segment — add a passthrough placeholder
      combinedTimeline.push({
        videoTimeSec: seg.startSec,
        clipTimeSec: clipTimeOffset,
        faceCount: 0,
        decision: { mode: "passthrough" },
      });
    } else {
      // Re-base clipTimeSec relative to the stitched output start
      for (const entry of result.timeline) {
        combinedTimeline.push({
          ...entry,
          clipTimeSec: parseFloat((clipTimeOffset + entry.clipTimeSec).toFixed(2)),
        });
      }
    }

    clipTimeOffset += segDur;
  }

  return { timeline: combinedTimeline, srcW, srcH, isAlreadyVertical };
}


// ─── Layout stabilization helpers ────────────────────────────────────────────
/**
 * trimToStableLayoutWindow
 *
 * Given a clip and its computed timeline, find the largest contiguous window
 * where the DOMINANT layout mode holds consistently.
 *
 * Strategy (cheap — no extra YOLO calls):
 *  1. Tally votes from the existing per-second timeline.
 *  2. Find the dominant mode.
 *  3. Walk the timeline to find the longest contiguous run of that mode.
 *  4. If that run covers <60% of the clip AND trimming would drop <40% of duration,
 *     return the trimmed window. Otherwise return original (already stable enough).
 *
 * MIN_STABLE_FRAC: if dominant mode already covers ≥80% of the clip, don't trim —
 * the clip is already stable enough and tiny blips will be smoothed by ffmpeg filter.
 */
const STABLE_TRIM_MIN_FRAC  = 0.80;  // already stable — skip trimming
const STABLE_TRIM_MIN_DUR   = 20;    // never trim below 20s
const STABLE_TRIM_MAX_LOSS  = 0.45;  // never throw away more than 45% of clip

function trimToStableLayoutWindow(clip, timeline) {
  const clipStart = clip.startSec;
  const clipEnd   = clip.endSec;
  const clipDur   = clipEnd - clipStart;

  if (timeline.length < 4 || clipDur < STABLE_TRIM_MIN_DUR * 2) {
    return { wasTrimmed: false, startSec: clipStart, endSec: clipEnd };
  }

  // Count votes
  const votes = {};
  for (const e of timeline) {
    const m = e.decision.mode;
    votes[m] = (votes[m] || 0) + 1;
  }
  const total = timeline.length;
  const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [dominantMode, dominantCount] = sorted[0];
  const dominantFrac = dominantCount / total;

  // Already stable — no trimming needed
  if (dominantFrac >= STABLE_TRIM_MIN_FRAC) {
    return { wasTrimmed: false, startSec: clipStart, endSec: clipEnd, dominantMode, dominantFrac };
  }

  // Find longest contiguous run of the dominant mode
  // timeline entries have clipTimeSec (relative to clip start = 0)
  let bestRunStart = -1, bestRunEnd = -1, bestRunLen = 0;
  let curRunStart = -1, curRunLen = 0;

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    if (entry.decision.mode === dominantMode) {
      if (curRunStart < 0) curRunStart = i;
      curRunLen++;
      if (curRunLen > bestRunLen) {
        bestRunLen = curRunLen;
        bestRunStart = curRunStart;
        bestRunEnd = i;
      }
    } else {
      curRunStart = -1;
      curRunLen = 0;
    }
  }

  if (bestRunStart < 0) {
    return { wasTrimmed: false, startSec: clipStart, endSec: clipEnd, dominantMode, dominantFrac };
  }

  // Convert run indices → video timestamps
  const runStartT = clipStart + (timeline[bestRunStart].clipTimeSec || 0);
  const runEndEntry = timeline[bestRunEnd];
  const nextEntry = bestRunEnd + 1 < timeline.length ? timeline[bestRunEnd + 1] : null;
  const runEndT = clipStart + (nextEntry ? nextEntry.clipTimeSec : (runEndEntry.clipTimeSec + 1));

  const trimmedDur = runEndT - runStartT;
  const lostFrac   = 1 - trimmedDur / clipDur;

  // Don't trim if result is too short or we'd lose too much
  if (trimmedDur < STABLE_TRIM_MIN_DUR || lostFrac > STABLE_TRIM_MAX_LOSS) {
    return { wasTrimmed: false, startSec: clipStart, endSec: clipEnd, dominantMode, dominantFrac };
  }

  const trimmedFrac = bestRunLen / total;
  return {
    wasTrimmed:    true,
    startSec:      parseFloat(runStartT.toFixed(2)),
    endSec:        parseFloat(runEndT.toFixed(2)),
    dominantMode,
    dominantFrac:  trimmedFrac,
  };
}

/**
 * After trimming clip boundaries, slice the timeline to only entries that fall
 * within [newStart, newEnd] and rebase clipTimeSec to 0.
 */
function trimToTimelineWindow(timeline, newVideoStart, newVideoEnd, originalVideoStart) {
  const relStart = newVideoStart - originalVideoStart;
  const relEnd   = newVideoEnd   - originalVideoStart;
  const sliced = timeline.filter(
    (e) => e.clipTimeSec >= relStart - 0.1 && e.clipTimeSec <= relEnd + 0.1
  );
  return sliced.map((e) => ({
    ...e,
    clipTimeSec: parseFloat(Math.max(0, e.clipTimeSec - relStart).toFixed(2)),
  }));
}

const worker = new Worker(
  "video-processing",
  async (job) => {
    const { jobId, userId } = job.data;
    console.log(`\n${"=".repeat(55)}\n JOB: ${jobId}\n${"=".repeat(55)}`);

    let videoPath = null;
    let downloadedLocally = false;
    let brollFolder = null;

    try {
      await updateJobStatus(jobId, "processing");

      const { rows } = await query("SELECT * FROM jobs WHERE id = $1", [jobId]);
      if (rows.length === 0) throw new Error("Job not found");

      const dbJob = rows[0];
      const brollEnabled = dbJob.broll_enabled || false;
      const brollStyle = dbJob.broll_style || "fullscreen";

      const platforms =
        Array.isArray(dbJob.platforms) && dbJob.platforms.length > 0
          ? dbJob.platforms
          : ["tiktok", "instagram", "youtube"];

      console.log(
        `Platforms: ${platforms.join(", ")} | Clips: ${dbJob.clip_count || 5} | B-roll: ${brollEnabled}`,
      );

      let videoTitle = dbJob.video_title || "Untitled Video";
      let originalDuration = dbJob.original_duration || "0:00";

      if (dbJob.source_type === "url") {
        console.log(`\nDownloading...`);
        const result = await downloadVideo(dbJob.source_url);

        const originalVideoPath = result.filePath;
        videoPath = originalVideoPath;

        videoTitle = result.title;
        originalDuration = result.duration;
        downloadedLocally = true;

        console.log(`\nExtracting job thumbnail...`);
        const jobThumbnailUrl = await extractJobThumbnail(originalVideoPath, jobId);
        if (jobThumbnailUrl) {
          await query("UPDATE jobs SET thumbnail_url = $1 WHERE id = $2", [
            jobThumbnailUrl,
            jobId,
          ]);
        }

        console.log(`Downloaded: "${videoTitle}" (${originalDuration})`);
      } else {
        videoPath = dbJob.source_file_path;
        if (!videoPath || !fs.existsSync(videoPath))
          throw new Error(`File not found: ${videoPath}`);
        const jobThumbnailUrl = await extractJobThumbnail(videoPath, jobId);
        if (jobThumbnailUrl) {
          await query("UPDATE jobs SET thumbnail_url = $1 WHERE id = $2", [
            jobThumbnailUrl,
            jobId,
          ]);
        }
      }

      await query(
        "UPDATE jobs SET video_title = $1, original_duration = $2 WHERE id = $3",
        [videoTitle, originalDuration, jobId],
      );

      console.log(`\nTranscribing...`);
      const segments = await transcribeVideo(videoPath);
      console.log(`${segments.length} segments`);


      console.log(`\nSelecting story clips...`);
    const selectedClips = await selectClips(
    segments,
    dbJob.clip_count || 5,
    dbJob.clip_duration || "auto",
    platforms,
    videoPath,
    [],   // empty — layout scoring disabled, clips selected by transcript only
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

      console.log(`\nProcessing clips...`);

      for (let i = 0; i < selectedClips.length; i++) {
        const clip = selectedClips[i];
        const clipContentType = clip.contentType || "general";
        const clipTopic = clip.topic || "general";
        const directives = clip.directives || {};
        const isStitched = clip.segments && clip.segments.length > 1;

        console.log(`\n[${i + 1}/${selectedClips.length}] "${clip.title}"`);
        console.log(
          `  ${clip.narrativeRole || "body"} | ${clip.emotion || "neutral"} | ${clipContentType} | topic: ${clipTopic}`,
        );

        // ── Per-clip face detection (segment-aware) ──────────────────────────
        // For stitched clips, each real segment is scanned independently so we
        // never analyze the gap footage between segments.
        let clipTimeline = { timeline: [], srcW: 1920, srcH: 1080, isAlreadyVertical: false };
        try {
          if (isStitched) {
            console.log(`  Analyzing faces for stitched clip (${clip.segments.length} segments)...`);
          } else {
            console.log(`  Analyzing faces for clip ${formatTime(clip.startSec)}→${formatTime(clip.endSec)}...`);
          }
          clipTimeline = await analyzeClipTimelineForClip(videoPath, clip);
          // CHANGE 3: mode summary now naturally handles face_left/face_right
          const modeSummary = clipTimeline.timeline.reduce((acc, e) => {
            acc[e.decision.mode] = (acc[e.decision.mode] || 0) + 1;
            return acc;
          }, {});
          console.log(`  Clip face timeline: ${JSON.stringify(modeSummary)}`);

          // ── Layout stabilization: trim clip boundaries to keep only the dominant mode ──
          // After we know what the clip looks like, find the longest contiguous window
          // where the dominant layout holds, and use that as the actual clip boundaries.
          // This is cheap (uses the already-computed timeline) and ensures every output
          // clip has a single stable layout — no jarring mid-clip switches.
          if (!clipTimeline.isAlreadyVertical && clipTimeline.timeline.length >= 4 && !isStitched) {
            const originalClipStart = clip.startSec;
            const trimmed = trimToStableLayoutWindow(clip, clipTimeline.timeline);
            if (trimmed.wasTrimmed) {
              console.log(
                `  ✂️  Layout-stabilized: [${formatTime(clip.startSec)}-${formatTime(clip.endSec)}] → ` +
                `[${formatTime(trimmed.startSec)}-${formatTime(trimmed.endSec)}] ` +
                `dominant="${trimmed.dominantMode}" (${(trimmed.dominantFrac * 100).toFixed(0)}% of trimmed clip)`
              );
              // Re-slice timeline BEFORE reassigning clip (originalClipStart still valid)
              const trimmedTimeline = trimToTimelineWindow(
                clipTimeline.timeline, trimmed.startSec, trimmed.endSec, originalClipStart
              );
              clip = { ...clip, startSec: trimmed.startSec, endSec: trimmed.endSec };
              clipTimeline = { ...clipTimeline, timeline: trimmedTimeline };
            }
          }
        } catch (e) {
          console.warn(`  Face analysis failed for clip, using passthrough: ${e.message}`);
        }

        let fileUrl = null;
        let filePath = null;

        try {
          const cut = await cutClip(
            videoPath,
            clip.startSec,
            clip.endSec,
            jobId,
            clipContentType,
            clip,
            clipTimeline,
          );
          fileUrl = cut.fileUrl;
          filePath = cut.filePath;

          if (filePath && dbJob.auto_captions !== false) {
            let wordTimings;

            if (isStitched) {
              wordTimings = extractWordTimingsForStitchedClip(
                segments,
                clip.segments,
              );
              console.log(
                `  ${wordTimings.length} word timestamps (stitched: ${clip.segments.length} segments)`,
              );
            } else {
              wordTimings = extractWordTimingsForClip(
                segments,
                clip.startSec,
                clip.endSec,
              );
              console.log(`  ${wordTimings.length} word timestamps`);
            }

            const jobOutputDir = pathModule.dirname(filePath);
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
            // CHANGE 4: isSplitClip check remains correct — only checks "split" mode
            // face_left/face_right should NOT trigger split caption positioning
            const isSplitClip =
              clipTimeline.timeline.length > 0 &&
              clipTimeline.timeline.filter((e) => e.decision.mode === "split")
                .length >
                clipTimeline.timeline.length * 0.4;

            // Build per-moment split intervals for per-frame caption centering
            // in CaptionedVideo.tsx. We convert from clip-relative seconds.
            // CHANGE 5: splitTimeline remains correct — only pushes "split" mode
            // face_left/face_right correctly do NOT appear in splitTimeline
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
                  last.endSec = segEnd; // merge adjacent
                } else {
                  splitTimeline.push({ startSec: segStart, endSec: segEnd });
                }
              }
            }
            const captionedPath = await burnCaptions(
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

            if (captionedPath && captionedPath !== filePath) {
              fileUrl = `/outputs/${jobId}/${pathModule.basename(captionedPath)}`;
              filePath = captionedPath;
              console.log(`  Captions burned`);
            }
          }
        } catch (cutErr) {
          console.error(`  Cut/burn failed: ${cutErr.message}`);
        }

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
          const clipThumbUrl = await extractClipThumbnail(
            filePath,
            jobId,
            clipId,
          );
          if (clipThumbUrl) {
            await query("UPDATE clips SET thumbnail_url = $1 WHERE id = $2", [
              clipThumbUrl,
              clipId,
            ]);
          }
        }

        if (dbJob.auto_captions !== false) {
          console.log(`  Writing platform captions...`);
          try {
            const captions = await generateAllCaptions(
              clip.transcript || "",
              clip.title,
              platforms,
            );
            const VALID_PLATFORMS = [
              "tiktok",
              "instagram",
              "linkedin",
              "facebook",
              "youtube",
              "twitter",
            ];
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

      await query(
        "UPDATE jobs SET status = 'done', clip_count = $1 WHERE id = $2",
        [selectedClips.length, jobId],
      );
      console.log(`\nDONE: ${selectedClips.length} clips\n`);
    } catch (err) {
      console.error(`\nFAILED: ${err.message}`);
      await query(
        "UPDATE jobs SET status = 'failed', error_message = $1 WHERE id = $2",
        [err.message.substring(0, 500), jobId],
      ).catch(() => {});
      throw err;
    } finally {
      if (downloadedLocally && videoPath && fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
          console.log("Source cleaned up");
        } catch {}
      }
      if (brollFolder && fs.existsSync(brollFolder)) {
        try {
          fs.rmSync(brollFolder, { recursive: true, force: true });
          console.log("🧹 B‑roll folder cleaned up");
        } catch {}
      }
    }
  },
  { connection, concurrency: 1 },
);

async function updateJobStatus(jobId, status) {
  await query("UPDATE jobs SET status = $1 WHERE id = $2", [status, jobId]);
}

worker.on("completed", (job) => console.log(`Job ${job.id} done`));
worker.on("failed", (job, err) =>
  console.error(`Job ${job?.id} failed: ${err.message}`),
);
console.log("Clipora worker ready\n");