/* eslint-disable no-undef */
const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const billing = require("../services/billing");
const ls = require("../services/lemonsqueezy");
const { VALID_PLANS, VALID_CYCLES, PAYG_PACKS } = require("../config/plans");
const { query } = require("../db/pool");

router.use(authMiddleware);

// ── GET /api/billing/summary — minutes balance + subscription ──
router.get("/summary", async (req, res) => {
  try {
    const summary = await billing.getSummary(req.user.id);
    const usage = await query(
      `SELECT minutes, kind, created_at, job_id
       FROM usage_ledger WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [req.user.id],
    );
    res.json({ billing: summary, usage: usage.rows });
  } catch (err) {
    console.error("Billing summary error:", err);
    res.status(500).json({ error: "Failed to load billing summary" });
  }
});

// ── POST /api/billing/checkout — start a Lemon Squeezy checkout ──
// body: { plan, cycle }  (subscription)  |  { type:'payg', pack }
router.post("/checkout", async (req, res) => {
  try {
    const { type, plan, cycle, pack } = req.body || {};

    if (type === "payg") {
      if (!PAYG_PACKS[pack]) {
        return res.status(400).json({ error: "Invalid credit pack" });
      }
      const url = await ls.createPaygCheckout({
        userId: req.user.id,
        pack,
        email: req.user.email,
      });
      return res.json({ url });
    }

    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: "Invalid plan" });
    }
    if (!VALID_CYCLES.includes(cycle)) {
      return res.status(400).json({ error: "Invalid billing cycle" });
    }
    const url = await ls.createPlanCheckout({
      userId: req.user.id,
      plan,
      cycle,
      email: req.user.email,
    });
    return res.json({ url });
  } catch (err) {
    console.error("Checkout error:", err.response?.data || err.message);
    res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to start checkout" });
  }
});

// ── POST /api/billing/portal — manage/renew subscription ──
router.post("/portal", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT customer_portal_url FROM subscriptions
       WHERE user_id = $1 AND customer_portal_url IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "No subscription to manage" });
    }
    res.json({ url: rows[0].customer_portal_url });
  } catch (err) {
    console.error("Portal error:", err);
    res.status(500).json({ error: "Failed to open billing portal" });
  }
});

module.exports = router;
