/* eslint-disable no-undef */
/* eslint-disable no-empty */
require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});

const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const { query } = require("../db/pool");
const { downloadVideo } = require("../services/downloader");
const { extractJobThumbnail } = require("../services/thumbnailExtractor");
const fs = require("fs");

// Import Helpers
const workerHelpers = require("../utils/workerHelpers");

// Import Handlers
const handleMagicClips = require("../handlers/magicClips");
const handleAddCaptions = require("../handlers/addCaptions");
const handleReframer = require("../handlers/reframer");
const handleTranscribe = require("../handlers/transcribe");
const handleEditVideo = require("../handlers/editVideo");
const handleBrollOnly = require("../handlers/brollOnly");

const connection = new IORedis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  maxRetriesPerRequest: null,
});

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

        const jobThumbnailUrl = await extractJobThumbnail(videoPath, jobId);
        if (jobThumbnailUrl) {
          await query("UPDATE jobs SET thumbnail_url = $1 WHERE id = $2", [jobThumbnailUrl, jobId]);
        }
      } else {
        videoPath = dbJob.source_file_path;
        if (!videoPath || !fs.existsSync(videoPath)) throw new Error(`File not found: ${videoPath}`);
        const jobThumbnailUrl = await extractJobThumbnail(videoPath, jobId);
        if (jobThumbnailUrl) {
          await query("UPDATE jobs SET thumbnail_url = $1 WHERE id = $2", [jobThumbnailUrl, jobId]);
        }
      }

      await query("UPDATE jobs SET video_title = $1, original_duration = $2 WHERE id = $3", [videoTitle, originalDuration, jobId]);

      // Duration check for specific services (Max 5 mins = 300s)
      if (jobType === "edit-video" || jobType === "b-roll") {
        const durMatch = originalDuration.match(/(\d+):(\d+)/);
        if (durMatch) {
          const mins = parseInt(durMatch[1]);
          if (mins >= 5) throw new Error("Video too long. Max duration for this service is 5 minutes.");
        }
      }

      console.log(`\nJob Type: ${jobType}`);

      switch (jobType) {
        case "magic-clips":
          await handleMagicClips(dbJob, videoPath, jobId, userId, workerHelpers);
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
          await handleEditVideo(dbJob, videoPath, jobId, userId, workerHelpers);
          break;
        case "b-roll":
          await handleBrollOnly(dbJob, videoPath, jobId, userId, workerHelpers);
          break;
        default:
          await handleMagicClips(dbJob, videoPath, jobId, userId, workerHelpers);
      }

      await query("UPDATE jobs SET status = 'done' WHERE id = $1", [jobId]);
      console.log(`\nDONE: Job ${jobId}\n`);
    } catch (err) {
      console.error(`\nFAILED: ${err.message}`);
      await query("UPDATE jobs SET status = 'failed', error_message = $1 WHERE id = $2", [err.message.substring(0, 500), jobId]).catch(() => {});
      throw err;
    } finally {
      if (downloadedLocally && videoPath && fs.existsSync(videoPath)) {
        try { fs.unlinkSync(videoPath); console.log("Source cleaned up"); } catch {}
      }
      if (brollFolder && fs.existsSync(brollFolder)) {
        try { fs.rmSync(brollFolder, { recursive: true, force: true }); console.log("🧹 B‑roll folder cleaned up"); } catch {}
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