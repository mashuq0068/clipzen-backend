const express = require("express");
const router = express.Router();
const { query } = require("../db/pool");
const authMiddleware = require("../middleware/auth");

router.use(authMiddleware);

// Max custom styles a user can save, per kind.
const MAX_PER_KIND = 20;
const KINDS = ["caption", "title"];

function assertKind(res, kind) {
  if (!KINDS.includes(kind)) {
    res.status(400).json({ error: "Invalid style kind" });
    return false;
  }
  return true;
}

// ── GET /api/styles/:kind — list this user's custom styles ────
router.get("/:kind", async (req, res) => {
  const { kind } = req.params;
  if (!assertKind(res, kind)) return;
  try {
    const { rows } = await query(
      `SELECT config FROM custom_styles
       WHERE user_id = $1 AND kind = $2
       ORDER BY created_at ASC`,
      [req.user.id, kind],
    );
    // Each config is the full style object (it carries its own "name")
    res.json({ styles: rows.map((r) => r.config) });
  } catch (err) {
    console.error("List custom styles error:", err);
    res.status(500).json({ error: "Failed to load custom styles" });
  }
});

// ── POST /api/styles/:kind — save (upsert by name) a custom style ──
// Body = the full style config object (must include a "name").
// Enforces a 20-per-kind limit on NEW names; saving over an existing name
// (an edit) does not count against the limit.
router.post("/:kind", async (req, res) => {
  const { kind } = req.params;
  if (!assertKind(res, kind)) return;

  const config = req.body && req.body.config ? req.body.config : req.body;
  const name = config && typeof config.name === "string" ? config.name.trim() : "";

  if (!name) {
    return res.status(400).json({ error: "Style must have a name" });
  }

  try {
    // Is this an update of an existing style (same name) or a brand-new one?
    const existing = await query(
      `SELECT id FROM custom_styles WHERE user_id = $1 AND kind = $2 AND name = $3`,
      [req.user.id, kind, name],
    );

    if (existing.rows.length === 0) {
      const { rows: countRows } = await query(
        `SELECT COUNT(*)::int AS count FROM custom_styles WHERE user_id = $1 AND kind = $2`,
        [req.user.id, kind],
      );
      if (countRows[0].count >= MAX_PER_KIND) {
        return res.status(409).json({
          error: `You've reached the limit of ${MAX_PER_KIND} custom ${kind} styles. Delete one before saving a new style.`,
          code: "STYLE_LIMIT_REACHED",
          limit: MAX_PER_KIND,
        });
      }
    }

    const { rows } = await query(
      `INSERT INTO custom_styles (user_id, kind, name, config)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, kind, name)
       DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
       RETURNING config`,
      [req.user.id, kind, name, config],
    );

    res.status(201).json({ style: rows[0].config });
  } catch (err) {
    console.error("Save custom style error:", err);
    res.status(500).json({ error: "Failed to save custom style" });
  }
});

// ── DELETE /api/styles/:kind/:name — remove a custom style ────
router.delete("/:kind/:name", async (req, res) => {
  const { kind, name } = req.params;
  if (!assertKind(res, kind)) return;
  try {
    await query(
      `DELETE FROM custom_styles WHERE user_id = $1 AND kind = $2 AND name = $3`,
      [req.user.id, kind, decodeURIComponent(name)],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete custom style error:", err);
    res.status(500).json({ error: "Failed to delete custom style" });
  }
});

module.exports = router;
