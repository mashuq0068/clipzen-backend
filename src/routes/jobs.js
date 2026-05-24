const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const { query } = require("../db/pool");
const authMiddleware = require("../middleware/auth");
const upload = require("../middleware/upload");
const { videoQueue } = require("../queue/videoQueue");

// All job routes require auth
router.use(authMiddleware);

// ── POST /api/jobs — create a new processing job ──────────────
// Accepts either JSON (youtube URL) or multipart/form-data (file upload)
router.post(
  "/",

  // ✅ ALWAYS run multer
  upload.single("video"),

  [
    body("sourceType").isIn(["url", "upload"]),

    body("sourceUrl")
      .if(body("sourceType").equals("url"))
      .isURL()
      .withMessage("Valid YouTube URL required"),

    body("platforms")
      .isArray({ min: 1 })
      .withMessage("Select at least one platform"),

    body("clipCount").optional().isInt({ min: 1, max: 10 }),

    body("clipDuration").optional().isIn(["15s", "30s", "60s", "auto"]),

    body("language").optional().isString(),

    body("captionStyle").optional().custom(value => {
      if (typeof value !== 'string' && typeof value !== 'object') {
        throw new Error('captionStyle must be a string or an object');
      }
      return true;
    }),
    body("brollEnabled").optional().isBoolean(),
    body("brollStyle").optional().isIn(["fullscreen", "pip"]),
    body("titleEnabled").optional().isBoolean(),
    body("titleText").optional().isString(),
    body("titleStyle").optional().custom(value => {
      if (value !== undefined && typeof value !== 'string' && typeof value !== 'object') {
        throw new Error('titleStyle must be a string or an object');
      }
      return true;
    }),
    body("titlePosition").optional().isString(),
  ],

  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    console.log("📦 BODY:", req.body);
    console.log("📁 FILE:", req.file);

    const {
      sourceType,
      sourceUrl,
      platforms,
      clipCount = 5,
      clipDuration = "auto",
      language = "en",
      autoCaptions = false,
      hookDetection = true,
      captionStyle,
      brollEnabled = false,
      brollStyle = "fullscreen",
      jobType = "magic-clips",
      titleEnabled = false,
      titleText = "",
      titleStyle,
      titlePosition = "center",
    } = req.body;

    try {
      // normalize platforms (IMPORTANT for multipart form-data)
      const platformsArray =
        typeof platforms === "string" ? JSON.parse(platforms) : platforms;

      // plan limits
      const PLAN_LIMITS = {
        free: 5,
        pro: 30,
        agency: Infinity,
      };

      const limit = PLAN_LIMITS[req.user.plan] || 5;

      const { rows: usageRows } = await query(
        `SELECT COUNT(*) FROM jobs
         WHERE user_id = $1
         AND created_at > date_trunc('month', NOW())`,
        [req.user.id],
      );

      const usedThisMonth = parseInt(usageRows[0].count, 10);

      let initialThumbnailUrl = null;
      if (sourceType === "url" && sourceUrl) {
        const regExp = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = sourceUrl.match(regExp);
        if (match && match[1]) {
          initialThumbnailUrl = `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`;
        }
      }

      const videoTitleVal = sourceType === "upload" && req.file ? req.file.originalname : "Untitled Video";

      // INSERT JOB
      const { rows } = await query(
        `INSERT INTO jobs
        (
          user_id,
          status,
          source_type,
          source_url,
          source_file_path,
          platforms,
          clip_count,
          clip_duration,
          language,
          auto_captions,
          hook_detection,
          caption_style,
          broll_enabled,
          broll_style,
          job_type,
          thumbnail_url,
          video_title,
          title_enabled,
          title_text,
          title_style,
          title_position
        )
        VALUES
        ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        RETURNING *`,
        [
          req.user.id,
          sourceType,
          sourceUrl || null,
          req.file?.path || null,
          platformsArray,
          parseInt(clipCount, 10),
          clipDuration,
          language,
          autoCaptions === true || autoCaptions === "true",
          hookDetection === true || hookDetection === "true",
          captionStyle && typeof captionStyle === "object" ? JSON.stringify(captionStyle) : (captionStyle || "wordpop"),
          brollEnabled === true || brollEnabled === "true",
          brollStyle || "fullscreen",
          jobType || "magic-clips",
          initialThumbnailUrl,
          videoTitleVal,
          titleEnabled === true || titleEnabled === "true",
          titleText,
          titleStyle && typeof titleStyle === "object" ? JSON.stringify(titleStyle) : (titleStyle || ""),
          titlePosition || "center",
        ],
      );

      const job = rows[0];

      // enqueue job
      const bullJob = await videoQueue.add(
        "process-video",
        {
          jobId: job.id,
          userId: req.user.id,
        },
        {
          attempts: 2,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      // store bull id
      await query("UPDATE jobs SET bull_job_id = $1 WHERE id = $2", [
        bullJob.id,
        job.id,
      ]);

      return res.status(201).json({
        jobId: job.id,
        status: "pending",
        message: "Job queued successfully",
      });
    } catch (err) {
      console.error("Create job error:", err);
      return res.status(500).json({
        error: "Failed to create job",
      });
    }
  },
);

// ── GET /api/jobs — list all jobs for user ────────────────────
router.get("/", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 5;
    const offset = (page - 1) * limit;

    const { rows } = await query(
      `SELECT id, status, source_type, source_url, video_title,
              original_duration, clip_count, platforms, thumbnail_url, job_type,
              error_message, created_at, updated_at
       FROM jobs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset],
    );

    const countRes = await query(
      `SELECT COUNT(*) FROM jobs WHERE user_id = $1`,
      [req.user.id],
    );

    const total = Number(countRes.rows[0].count);

    res.json({
      jobs: rows,
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error("List jobs error:", err);
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

// ── GET /api/jobs/:id — get single job status ─────────────────
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, status, source_type, source_url, video_title,
              original_duration, clip_count, platforms, thumbnail_url,
              error_message, job_type, created_at, updated_at
       FROM jobs
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json({ job: rows[0] });
  } catch (err) {
    console.error("Get job error:", err);
    res.status(500).json({ error: "Failed to fetch job" });
  }
});

// ── GET /api/jobs/stats/overview — dashboard stats ────────────
router.get("/stats/overview", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(j.id) FILTER (WHERE j.status = 'done')          AS videos_processed,
         COALESCE(SUM(j.clip_count) FILTER (WHERE j.status = 'done'), 0) AS clips_generated,
         COALESCE(SUM(j.clip_count) FILTER (WHERE j.status = 'done') * 0.8, 0) AS hours_saved,
         (
           SELECT COUNT(DISTINCT platform)
           FROM jobs j2, UNNEST(j2.platforms) AS platform
           WHERE j2.user_id = $1 AND j2.status = 'done'
         ) AS platforms_reached
       FROM jobs j
       WHERE j.user_id = $1`,
      [req.user.id],
    );
    res.json({ stats: rows[0] });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

module.exports = router;
