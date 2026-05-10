require("dotenv").config();
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cookieParser = require("cookie-parser");


const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration for credentials
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    // List of allowed origins (your frontend URLs)
    const allowedOrigins = [
      'http://localhost:8080',           // React dev server
      'http://localhost:8081',           // Alternative port
      'http://localhost:5173',           // Vite dev server
      'https://yourdomain.com',          // Production domain
      'https://api.yourdomain.com',      // API domain if separate
    ];
    
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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ── Routes ────────────────────────────────────────────────
const authRoutes = require("./routes/auth");
const jobRoutes = require("./routes/jobs");
const clipRoutes = require("./routes/clips");
const userRoutes = require("./routes/user");
const analyticsRoutes = require("./routes/analytics");

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