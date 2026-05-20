const express = require("express");
const { body, param, validationResult } = require("express-validator");
const authMiddleware = require("../middleware/auth");
const {
  SUPPORTED_PLATFORMS,
  createConnectUrl,
  disconnect,
  getConnections,
  listPublishJobs,
  queuePublish,
} = require("../services/socialAccounts");

const router = express.Router();

router.use(authMiddleware);

function sendValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

router.get("/connections", async (req, res) => {
  try {
    const connections = await getConnections(req.user.id);
    res.json({ connections });
  } catch (err) {
    console.error("Fetch Zernio social connections error:", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to fetch social connections" });
  }
});

router.get(
  "/connect/:platform",
  [param("platform").isIn(SUPPORTED_PLATFORMS)],
  async (req, res) => {
    if (sendValidationErrors(req, res)) return;

    try {
      const redirectPath =
        typeof req.query.redirect === "string" && req.query.redirect.startsWith("/")
          ? req.query.redirect
          : "/projects";

      const authUrl = await createConnectUrl({
        userId: req.user.id,
        platform: req.params.platform,
        redirectPath,
      });

      res.redirect(authUrl);
    } catch (err) {
      console.error("Zernio connect start error:", err);
      res.status(err.status || 500).json({ error: err.message || "Failed to start account connection" });
    }
  },
);

router.post(
  "/disconnect",
  [body("accountId").optional().isUUID(), body("platform").optional().isIn(SUPPORTED_PLATFORMS)],
  async (req, res) => {
    if (sendValidationErrors(req, res)) return;

    const target = req.body.accountId || req.body.platform;
    if (!target) {
      return res.status(400).json({ error: "accountId or platform is required" });
    }

    try {
      const disconnected = await disconnect(req.user.id, target);
      res.json({ disconnected });
    } catch (err) {
      console.error("Disconnect Zernio social account error:", err);
      res.status(err.status || 500).json({ error: err.message || "Failed to disconnect social account" });
    }
  },
);

router.post(
  "/publish",
  [
    body("clipIds").isArray({ min: 1 }),
    body("clipIds.*").isUUID(),
    body("accountIds").isArray({ min: 1 }),
    body("accountIds.*").isUUID(),
    body("captionByClip").optional().isObject(),
    body("scheduledFor").optional({ nullable: true }).isISO8601(),
  ],
  async (req, res) => {
    if (sendValidationErrors(req, res)) return;

    try {
      const result = await queuePublish({
        userId: req.user.id,
        clipIds: req.body.clipIds,
        accountIds: req.body.accountIds,
        captionByClip: req.body.captionByClip || {},
        scheduledFor: req.body.scheduledFor || null,
      });
      res.status(202).json(result);
    } catch (err) {
      console.error("Zernio publish queue error:", err);
      res.status(err.status || 500).json({ error: err.message || "Failed to queue publish job" });
    }
  },
);

router.get("/publishes", async (req, res) => {
  try {
    const publishes = await listPublishJobs(req.user.id);
    res.json({ publishes });
  } catch (err) {
    console.error("List social publishes error:", err);
    res.status(500).json({ error: "Failed to fetch publish history" });
  }
});

module.exports = router;
