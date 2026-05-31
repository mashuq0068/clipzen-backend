/* eslint-disable no-undef */
/* eslint-disable no-empty */
require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});

const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const { query } = require("../db/pool");
const { downloadVideo } = require("../services/downloader");
const { extractJobThumbnail, getVideoDurationSec } = require("../services/thumbnailExtractor");
const fs = require("fs");

function parseDurationToSeconds(durationStr) {
  if (!durationStr || typeof durationStr !== "string") return 0;
  const parts = durationStr.split(":").map(Number);
  let secs = 0;
  if (parts.length === 3) {
    secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    secs = parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    secs = parts[0];
  }
  return isNaN(secs) ? 0 : secs;
}

// Import Helpers
const workerHelpers = require("../utils/workerHelpers");

// Import Handlers
const handleMagicClips = require("../handlers/magicClips");
const handleAddCaptions = require("../handlers/addCaptions");
const handleReframer = require("../handlers/reframer");
const handleTranscribe = require("../handlers/transcribe");
const handleEditVideo = require("../handlers/editVideo");
const handleBrollOnly = require("../handlers/brollOnly");

// ── PERF: Warm the Remotion bundle immediately at worker startup.
// By the time the first job arrives the bundle is already compiled
// and cached — clips skip the 15-30s cold start entirely.
const { warmBundle } = require("../services/remotionBundle");
warmBundle(); // fire-and-forget, errors are non-fatal
require("./publishingWorker");

const connection = new IORedis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  maxRetriesPerRequest: null,
});

const workerConcurrency = Math.max(
  1,
  Number.isFinite(Number.parseInt(process.env.WORKER_CONCURRENCY || "2", 10))
    ? Number.parseInt(process.env.WORKER_CONCURRENCY || "2", 10)
    : 2,
);

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
      const jobType = dbJob.job_type || "magic-clips";

      let videoTitle = dbJob.video_title || "Untitled Video";
      let originalDuration = dbJob.original_duration || "0:00";

      if (dbJob.source_type === "url") {
        console.log(`\nDownloading...`);
        const result = await downloadVideo(dbJob.source_url);
        videoPath = result.filePath;
        videoTitle = result.title;
        originalDuration = result.duration;
        downloadedLocally = true;

        const jobThumbnailUrl = await extractJobThumbnail(videoPath, jobId, dbJob.source_url);
        if (jobThumbnailUrl) {
          await query("UPDATE jobs SET thumbnail_url = $1 WHERE id = $2", [
            jobThumbnailUrl,
            jobId,
          ]);
        }
      } else {
        videoPath = dbJob.source_file_path;
        if (!videoPath || !fs.existsSync(videoPath))
          throw new Error(`File not found: ${videoPath}`);
        
        // Extract and format uploaded video's duration
        const durationSecs = await getVideoDurationSec(videoPath);
        const formatDuration = (secs) => {
          const m = Math.floor(secs / 60);
          const s = Math.floor(secs % 60);
          return `${m}:${s.toString().padStart(2, "0")}`;
        };
        originalDuration = formatDuration(durationSecs);

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

      // Strict duration validation:
      // - magic-clips: max 2.5 hours (9000 seconds)
      // - all other cases: max 5 minutes (300 seconds)
      const durationSeconds = parseDurationToSeconds(originalDuration);
      if (jobType === "magic-clips") {
        if (durationSeconds > 9000) {
          throw new Error(
            "Video too long. Max duration for Magic Clips is 2 hours and 30 minutes."
          );
        }
      } else {
        if (durationSeconds > 300) {
          const serviceTitle = {
            "add-captions": "Add Captions",
            "reframer": "Auto Reframe",
            "transcribe": "Transcribe",
            "edit-video": "Edit Video",
            "b-roll": "Add B-Roll"
          }[jobType] || jobType;
          throw new Error(
            `Video too long. Max duration for ${serviceTitle} is 5 minutes.`
          );
        }
      }

      console.log(`\nJob Type: ${jobType}`);

      // Handlers that return { brollFolder } will populate it for cleanup below
      let handlerResult = null;

      switch (jobType) {
        case "magic-clips":
          handlerResult = await handleMagicClips(
            dbJob,
            videoPath,
            jobId,
            userId,
            workerHelpers,
          );
          break;
        case "add-captions":
          await handleAddCaptions(dbJob, videoPath, jobId, userId);
          break;
        case "reframer":
          await handleReframer(dbJob, videoPath, jobId, userId, workerHelpers);
          break;
        case "transcribe":
          await handleTranscribe(dbJob, videoPath, jobId, userId);
          break;
        case "edit-video":
          handlerResult = await handleEditVideo(
            dbJob,
            videoPath,
            jobId,
            userId,
            workerHelpers,
          );
          break;
        case "b-roll":
          await handleBrollOnly(dbJob, videoPath, jobId, userId, workerHelpers);
          break;
        default:
          handlerResult = await handleMagicClips(
            dbJob,
            videoPath,
            jobId,
            userId,
            workerHelpers,
          );
      }

      // Pick up brollFolder from handler if it returned one
      if (handlerResult?.brollFolder) {
        brollFolder = handlerResult.brollFolder;
      }

      // Push clips + thumbnails to Cloudinary, save URLs, then delete the
      // local outputs/<jobId> folder (clips, thumbnails, b-roll — everything).
      try {
        const { finalizeJobAssets } = require("../services/jobFinalizer");
        await finalizeJobAssets(jobId);
        brollFolder = null; // folder already removed by finalize
      } catch (finErr) {
        console.warn(`Finalize/cleanup warning: ${finErr.message}`);
      }

      await query("UPDATE jobs SET status = 'done' WHERE id = $1", [jobId]);
      console.log(`\nDONE: Job ${jobId}\n`);
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
          console.log("🧹 B-roll folder cleaned up");
        } catch {}
      }
    }
  },
  { connection, concurrency: workerConcurrency },
);

async function updateJobStatus(jobId, status) {
  await query("UPDATE jobs SET status = $1 WHERE id = $2", [status, jobId]);
}

worker.on("completed", (job) => console.log(`Job ${job.id} done`));
worker.on("failed", (job, err) =>
  console.error(`Job ${job?.id} failed: ${err.message}`),
);
console.log("Clipora worker ready\n");