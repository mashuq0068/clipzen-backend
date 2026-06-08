/* eslint-disable no-undef, no-unused-vars */
require("dotenv").config();
// Outbound HTTPS to dual-stack hosts (e.g. Google's OAuth token endpoint) can
// stall ~21s on this machine: Node 17+ resolves DNS "verbatim" (IPv6 first) and
// Node 20+ Happy Eyeballs (autoSelectFamily) fails to fall back from the broken
// IPv6 route to IPv4, so the request hangs until the TCP timeout and then throws
// with an empty error message. Prefer IPv4 and disable Happy Eyeballs so the
// working IPv4 address is used directly.
require("dns").setDefaultResultOrder("ipv4first");
require("net").setDefaultAutoSelectFamily(false);
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cookieParser = require("cookie-parser");
const authMiddleware = require("./middleware/auth");
const crypto = require("crypto");
const { handleWebhookEvent, queuePublish } = require("./services/socialAccounts");
const { verifyWebhook: verifyLemonWebhook, handleLemonWebhook } = require("./services/lemonsqueezy");


const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration for credentials
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    // List of allowed origins (your frontend URLs)
    const allowedOrigins = [
      process.env.FRONTEND_URL,
      'http://localhost:8080',           // React dev server
      'http://localhost:8081',           // Alternative port
       "https://portal.clipzen.pro",          // Production portal
                                        // API domain if separate
    ].filter(Boolean);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,  // Allow cookies to be sent
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Cookie',
    'Set-Cookie'
  ],
  exposedHeaders: ['Set-Cookie'],  // Allow frontend to access Set-Cookie header
};

// ── Middleware ────────────────────────────────────────────────
// Apply CORS middleware first
app.use(cors(corsOptions));

// Handle preflight requests for all routes
app.options('*', cors(corsOptions));

// Configure helmet to work with CORS
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allows cross-origin requests
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  contentSecurityPolicy: false, // Disable if you're having CSP issues
}));

app.use(morgan("dev"));

app.post(
  "/api/social/webhooks/zernio",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature =
        req.get("X-Zernio-Signature") ||
        req.get("X-Late-Signature");
      const secret = process.env.ZERNIO_WEBHOOK_SECRET;

      if (secret) {
        if (!signature) {
          return res.status(401).json({ error: "Missing Zernio webhook signature" });
        }

        const computed = crypto
          .createHmac("sha256", secret)
          .update(req.body)
          .digest("hex");

        const expected = Buffer.from(signature, "hex");
        const actual = Buffer.from(computed, "hex");
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
          return res.status(400).json({ error: "Invalid Zernio webhook signature" });
        }
      }

      const payload = JSON.parse(req.body.toString("utf8"));
      await handleWebhookEvent(payload);
      res.json({ received: true });
    } catch (err) {
      console.error("Zernio webhook error:", err);
      res.status(400).json({ error: "Invalid webhook payload" });
    }
  },
);

// Lemon Squeezy billing webhook — must read the RAW body to verify the
// HMAC signature, so it is registered before express.json() (same as Zernio).
app.post(
  "/api/billing/webhooks/lemonsqueezy",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.get("X-Signature");
      if (!verifyLemonWebhook(req.body, signature)) {
        return res.status(400).json({ error: "Invalid Lemon Squeezy signature" });
      }
      const payload = JSON.parse(req.body.toString("utf8"));
      await handleLemonWebhook(payload);
      res.json({ received: true });
    } catch (err) {
      console.error("Lemon Squeezy webhook error:", err);
      res.status(400).json({ error: "Invalid webhook payload" });
    }
  },
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ── Routes ────────────────────────────────────────────────
const authRoutes = require("./routes/auth");
const jobRoutes = require("./routes/jobs");
const clipRoutes = require("./routes/clips");
const userRoutes = require("./routes/user");
const analyticsRoutes = require("./routes/analytics");
const socialRoutes = require("./routes/social");
const styleRoutes = require("./routes/styles");
const billingRoutes = require("./routes/billing");

// ── Ensure upload/output dirs exist ──────────────────────────
[process.env.UPLOAD_DIR, process.env.OUTPUT_DIR].forEach((dir) => {
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
});

// Rate limiting configuration
// const generalLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 min
//   max: 100,
//   message: { error: "Too many requests, please try again later." },
// });

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10, // Stricter limit for auth endpoints
  message: { error: "Too many login attempts, please try again later." },
});

// Apply rate limiters to specific routes
// app.use("/api/jobs");
// app.use("/api/clips");
// app.use("/api/analytics");
// app.use("/api/user");
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);

// Serve generated clips as static files
app.use("/outputs", express.static(path.resolve(process.env.OUTPUT_DIR || "./outputs")));

// ── Routes ────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/clips", clipRoutes);
app.use("/api/user", userRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/social", socialRoutes);
app.use("/api/styles", styleRoutes);
app.use("/api/billing", billingRoutes);

// Compatibility route for older frontend calls; the main contract is /api/social/publish.
app.post("/api/publish", authMiddleware, async (req, res) => {
  try {
    const result = await queuePublish({
      userId: req.user.id,
      clipIds: req.body.clipIds || (req.body.clipId ? [req.body.clipId] : []),
      accountIds: req.body.accountIds || [],
      captionByClip: req.body.captionByClip || {},
      scheduledFor: req.body.scheduledFor || null,
    });
    res.status(202).json(result);
  } catch (err) {
    console.error("Publish queue error:", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to queue publish job" });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development"
  });
});

// Test endpoint to check CORS and cookies
app.get("/api/test-cors", (req, res) => {
  res.json({ 
    message: "CORS is working correctly!",
    cookies: req.cookies,
    hasCredentials: !!req.headers.cookie
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Error:", err.stack);
  
  // Handle specific error types
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: "CORS origin not allowed" });
  }
  
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`\n🚀 Clipora API running on http://localhost:${PORT}`);
  console.log(`   ENV: ${process.env.NODE_ENV || "development"}`);
  console.log(`   DB:  ${process.env.DB_NAME}@${process.env.DB_HOST}`);
  console.log(`   Redis: ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);
  console.log(`   CORS enabled for credentials with configured origins\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

module.exports = app;
