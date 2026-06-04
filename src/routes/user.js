const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const { query } = require("../db/pool");
const authMiddleware = require("../middleware/auth");
const billing = require("../services/billing");

router.use(authMiddleware);

// ── GET /api/user/me ──────────────────────────────────────────
router.get("/me", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.name, u.plan, u.avatar_url, u.created_at,
              u.provider, u.email_verified,
              p.default_clip_count, p.default_platforms, p.default_language
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Monthly usage
    const { rows: usageRows } = await query(
      `SELECT COUNT(*) FROM jobs WHERE user_id = $1 AND created_at > date_trunc('month', NOW())`,
      [req.user.id]
    );

    const u = rows[0];

    // Minutes-based billing snapshot (plan allowance + credits).
    const billingSummary = await billing.getSummary(req.user.id);

    res.json({
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        plan: u.plan,
        avatarUrl: u.avatar_url,
        provider: u.provider,
        emailVerified: u.email_verified,
        createdAt: u.created_at,
        preferences: {
          defaultClipCount: u.default_clip_count,
          defaultPlatforms: u.default_platforms,
          defaultLanguage: u.default_language,
        },
        // Minutes usage for the dashboard/billing UI.
        usage: {
          minutesUsed: billingSummary.planMinutesUsed,
          minutesIncluded: billingSummary.planMinutesIncluded,
          availableMinutes: billingSummary.availableMinutes,
          videosUsedThisMonth: parseInt(usageRows[0].count, 10),
        },
        billing: billingSummary,
      },
    });
  } catch (err) {
    console.error("Get user error:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ── PATCH /api/user/me — update profile ───────────────────────
router.patch(
  "/me",
  [
    body("name").optional().trim().notEmpty(),
    body("email").optional().isEmail().normalizeEmail(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email } = req.body;
    const updates = [];
    const params = [];
    let idx = 1;

    if (name) { updates.push(`name = $${idx++}`); params.push(name); }
    if (email) { updates.push(`email = $${idx++}`); params.push(email); }

    if (updates.length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    params.push(req.user.id);

    try {
      const { rows } = await query(
        `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx} RETURNING id, email, name, plan`,
        params
      );
      res.json({ user: rows[0] });
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({ error: "Email already in use" });
      }
      res.status(500).json({ error: "Update failed" });
    }
  }
);

// ── PATCH /api/user/preferences ───────────────────────────────
router.patch("/preferences", async (req, res) => {
  const { defaultClipCount, defaultPlatforms, defaultLanguage } = req.body;

  try {
    await query(
      `INSERT INTO user_preferences (user_id, default_clip_count, default_platforms, default_language)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET default_clip_count = COALESCE($2, user_preferences.default_clip_count),
             default_platforms  = COALESCE($3, user_preferences.default_platforms),
             default_language   = COALESCE($4, user_preferences.default_language),
             updated_at = NOW()`,
      [req.user.id, defaultClipCount || null, defaultPlatforms || null, defaultLanguage || null]
    );
    res.json({ message: "Preferences updated" });
  } catch (err) {
    console.error("Preferences error:", err);
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

// ── DELETE /api/user/me — delete account ──────────────────────
router.delete("/me", async (req, res) => {
  try {
    await query("DELETE FROM users WHERE id = $1", [req.user.id]);
    res.json({ message: "Account deleted" });
  } catch (err) {
    console.error("Delete account error:", err);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

module.exports = router;