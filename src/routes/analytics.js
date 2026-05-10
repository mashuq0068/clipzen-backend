const express = require("express");
const router = express.Router();
const { query } = require("../db/pool");
const authMiddleware = require("../middleware/auth");

router.use(authMiddleware);

// ── GET /api/analytics/overview ──────────────────────────────
router.get("/overview", async (req, res) => {
  try {
    // Get overall stats from database directly
    const { rows: statsRows } = await query(
      `SELECT
         COUNT(j.id) FILTER (WHERE j.status = 'done') AS videos_processed,
         COALESCE(SUM(j.clip_count) FILTER (WHERE j.status = 'done'), 0) AS clips_generated,
         COALESCE(SUM(j.clip_count) FILTER (WHERE j.status = 'done') * 0.5, 0) AS hours_saved,
         (
           SELECT COUNT(DISTINCT platform)
           FROM jobs j2, UNNEST(j2.platforms) AS platform
           WHERE j2.user_id = $1 AND j2.status = 'done'
         ) AS platforms_reached
       FROM jobs j
       WHERE j.user_id = $1`,
      [req.user.id]
    );

    // Get platform distribution from clips table
    const { rows: platformRows } = await query(
      `SELECT 
         UNNEST(platforms) as platform,
         COUNT(*) as clip_count
       FROM clips
       WHERE user_id = $1
       GROUP BY platform
       ORDER BY clip_count DESC`,
      [req.user.id]
    );

    // Get hook score distribution
    const { rows: hookRows } = await query(
      `SELECT 
         hook_score,
         COUNT(*) as count
       FROM clips
       WHERE user_id = $1 AND hook_score > 0
       GROUP BY hook_score
       ORDER BY hook_score`,
      [req.user.id]
    );

    // Calculate hook score ranges
    const hookDistribution = {
      "90-100": 0,
      "80-89": 0,
      "70-79": 0,
      "60-69": 0,
      "<60": 0,
    };

    hookRows.forEach(row => {
      const score = row.hook_score;
      if (score >= 90) hookDistribution["90-100"] += parseInt(row.count);
      else if (score >= 80) hookDistribution["80-89"] += parseInt(row.count);
      else if (score >= 70) hookDistribution["70-79"] += parseInt(row.count);
      else if (score >= 60) hookDistribution["60-69"] += parseInt(row.count);
      else hookDistribution["<60"] += parseInt(row.count);
    });

    // Get best performing clip
    const { rows: bestClipRows } = await query(
      `SELECT 
         c.id, c.title, c.duration, c.hook_score, c.platforms, c.thumbnail_color,
         j.id as job_id
       FROM clips c
       JOIN jobs j ON j.id = c.job_id
       WHERE c.user_id = $1 AND c.hook_score > 0
       ORDER BY c.hook_score DESC
       LIMIT 1`,
      [req.user.id]
    );

    // Get monthly trend (last 6 months)
    const { rows: trendRows } = await query(
      `SELECT 
         DATE_TRUNC('month', j.created_at) as month,
         COUNT(DISTINCT j.id) as videos,
         SUM(j.clip_count) as clips
       FROM jobs j
       WHERE j.user_id = $1 AND j.status = 'done'
         AND j.created_at > NOW() - INTERVAL '6 months'
       GROUP BY DATE_TRUNC('month', j.created_at)
       ORDER BY month DESC`,
      [req.user.id]
    );

    // Format platform data for chart
    const platformData = platformRows.map(row => ({
      name: row.platform === "twitter" ? "X" : row.platform.charAt(0).toUpperCase() + row.platform.slice(1),
      clips: parseInt(row.clip_count),
      platform: row.platform,
    }));

    // Format hook data for chart
    const hookData = Object.entries(hookDistribution).map(([range, count]) => ({
      range,
      count,
    }));

    // Format trend data
    const trendData = trendRows.map(row => ({
      month: new Date(row.month).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      videos: parseInt(row.videos),
      clips: parseInt(row.clips),
    }));

    res.json({
      stats: statsRows[0],
      platformData,
      hookData,
      bestClip: bestClipRows[0] || null,
      trendData,
    });
  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// ── GET /api/analytics/platforms ──────────────────────────────
router.get("/platforms", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT 
         UNNEST(platforms) as platform,
         COUNT(*) as count
       FROM clips
       WHERE user_id = $1
       GROUP BY platform
       ORDER BY count DESC`,
      [req.user.id]
    );
    res.json({ platforms: rows });
  } catch (err) {
    console.error("Platform analytics error:", err);
    res.status(500).json({ error: "Failed to fetch platform analytics" });
  }
});

// ── GET /api/analytics/hookscores ────────────────────────────
router.get("/hookscores", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT 
         hook_score,
         COUNT(*) as count,
         AVG(hook_score) as avg_score
       FROM clips
       WHERE user_id = $1 AND hook_score > 0
       GROUP BY hook_score
       ORDER BY hook_score DESC`,
      [req.user.id]
    );
    res.json({ hookScores: rows });
  } catch (err) {
    console.error("Hook score analytics error:", err);
    res.status(500).json({ error: "Failed to fetch hook score analytics" });
  }
});

module.exports = router;