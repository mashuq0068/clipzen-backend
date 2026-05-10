const express = require("express");
const router = express.Router();
const { query } = require("../db/pool");
const authMiddleware = require("../middleware/auth");

router.use(authMiddleware);

// ── GET /api/clips/:jobId — get all clips for a job ───────────
router.get("/:jobId", async (req, res) => {
  try {
    // Verify job belongs to user
    const { rows: jobRows } = await query(
      `SELECT id, video_title, original_duration, platforms, status, thumbnail_url
       FROM jobs WHERE id = $1 AND user_id = $2`,
      [req.params.jobId, req.user.id],
    );

    if (jobRows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const job = jobRows[0];

    // Fetch clips — thumbnail_url included
    const { rows: clips } = await query(
      `SELECT c.id, c.title, c.file_url, c.duration, c.start_time, c.end_time,
              c.hook_score, c.platforms, c.thumbnail_color, c.thumbnail_url,
              c.transcript, c.created_at
       FROM clips c
       WHERE c.job_id = $1
       ORDER BY c.hook_score DESC`,
      [req.params.jobId],
    );

    // Fetch captions for all clips in one query
    const clipIds = clips.map((c) => c.id);
    let captionsMap = {};

    if (clipIds.length > 0) {
      const { rows: captions } = await query(
        `SELECT clip_id, platform, body FROM captions WHERE clip_id = ANY($1)`,
        [clipIds],
      );

      captions.forEach((cap) => {
        if (!captionsMap[cap.clip_id]) captionsMap[cap.clip_id] = {};
        captionsMap[cap.clip_id][cap.platform] = cap.body;
      });
    }

    // Merge captions into clips
    const clipsWithCaptions = clips.map((clip) => ({
      ...clip,
      captions: captionsMap[clip.id] || {},
    }));

    res.json({
      job: {
        id: job.id,
        videoTitle: job.video_title,
        originalDuration: job.original_duration,
        platforms: job.platforms,
        status: job.status,
        thumbnailUrl: job.thumbnail_url || null,
      },
      clips: clipsWithCaptions,
    });
  } catch (err) {
    console.error("Get clips error:", err);
    res.status(500).json({ error: "Failed to fetch clips" });
  }
});

// ── GET /api/clips/library/all — all clips across all jobs ────
router.get("/library/all", async (req, res) => {
  const { search = "", platform, page = 1, limit = 12 } = req.query;
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  try {
    let whereClause = "WHERE c.user_id = $1";
    const params = [req.user.id];
    let paramIndex = 2;

    if (search) {
      whereClause += ` AND c.title ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (platform) {
      whereClause += ` AND $${paramIndex} = ANY(c.platforms)`;
      params.push(platform);
      paramIndex++;
    }

    // Get clips with pagination — thumbnail_url included
    const { rows: clips } = await query(
      `SELECT c.id, c.job_id, c.title, c.file_url, c.duration,
              c.hook_score, c.platforms, c.thumbnail_color, c.thumbnail_url,
              c.transcript, c.created_at
       FROM clips c
       ${whereClause}
       ORDER BY c.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit, 10), offset],
    );

    // Get total count
    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM clips c ${whereClause}`,
      params.slice(0, paramIndex - 1),
    );

    // Fetch captions for all clips in one query
    const clipIds = clips.map((c) => c.id);
    let captionsMap = {};

    if (clipIds.length > 0) {
      const { rows: captions } = await query(
        `SELECT clip_id, platform, body FROM captions WHERE clip_id = ANY($1)`,
        [clipIds],
      );

      captions.forEach((cap) => {
        if (!captionsMap[cap.clip_id]) captionsMap[cap.clip_id] = {};
        captionsMap[cap.clip_id][cap.platform] = cap.body;
      });
    }

    // Merge captions into clips
    const clipsWithCaptions = clips.map((clip) => ({
      ...clip,
      captions: captionsMap[clip.id] || {
        tiktok: "",
        instagram: "",
        facebook: "",
        linkedin: "",
        youtube: "",
      },
      file_url: clip.file_url,
      hook_score: clip.hook_score,
      thumbnail_color: clip.thumbnail_color,
      thumbnail_url: clip.thumbnail_url || null,
    }));

    res.json({
      clips: clipsWithCaptions,
      total: parseInt(countRows[0].count, 10),
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
  } catch (err) {
    console.error("Library error:", err);
    res.status(500).json({ error: "Failed to fetch library" });
  }
});

// ── POST /api/clips/:clipId/regenerate-caption ────────────────
router.post("/:clipId/regenerate-caption", async (req, res) => {
  const { platform } = req.body;

  if (!platform) {
    return res.status(400).json({ error: "platform is required" });
  }

  try {
    // Verify ownership
    const { rows } = await query(
      `SELECT c.id, c.transcript, c.title FROM clips c
       JOIN jobs j ON j.id = c.job_id
       WHERE c.id = $1 AND j.user_id = $2`,
      [req.params.clipId, req.user.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Clip not found" });
    }

    const clip = rows[0];
    const { generateCaption } = require("../services/captionWriter");
    const newCaption = await generateCaption(
      clip.transcript,
      clip.title,
      platform,
    );

    // Upsert caption
    await query(
      `INSERT INTO captions (clip_id, platform, body)
       VALUES ($1, $2, $3)
       ON CONFLICT (clip_id, platform) DO UPDATE SET body = EXCLUDED.body`,
      [clip.id, platform, newCaption],
    );

    res.json({ platform, caption: newCaption });
  } catch (err) {
    console.error("Regenerate caption error:", err);
    res.status(500).json({ error: "Failed to regenerate caption" });
  }
});

module.exports = router;