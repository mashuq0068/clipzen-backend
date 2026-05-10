const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../db/pool");

// ── TOKEN GENERATION FUNCTIONS ─────────────────────────────────
function generateAccessToken(userId) {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m" } // Short-lived (15 min)
  );
}

function generateRefreshToken(userId) {
  return jwt.sign(
    { userId, type: "refresh" },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d" } // Long-lived (7 days)
  );
}

// ── COOKIE CONFIGURATION ───────────────────────────────────────
const getCookieOptions = () => {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,           // Prevents XSS attacks
    secure: isProduction,     // false for localhost (HTTP), true for HTTPS
    sameSite: "lax",          // CSRF protection
    path: "/",                // Available across all routes
  };
};

const getAccessCookieOptions = () => ({
  ...getCookieOptions(),
  maxAge: 15 * 60 * 1000, // 15 minutes
});

const getRefreshCookieOptions = () => ({
  ...getCookieOptions(),
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
});

// ── POST /api/auth/signup ─────────────────────────────────────
router.post(
  "/signup",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
    body("name").trim().notEmpty().withMessage("Name is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name } = req.body;

    try {
      // Check existing
      const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: "Email already in use" });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const result = await withTransaction(async (client) => {
        // Create user
        const { rows } = await client.query(
          `INSERT INTO users (email, password_hash, name)
           VALUES ($1, $2, $3)
           RETURNING id, email, name, plan, avatar_url`,
          [email, passwordHash, name]
        );
        const user = rows[0];

        // Create default preferences
        await client.query(
          `INSERT INTO user_preferences (user_id) VALUES ($1)`,
          [user.id]
        );

        return user;
      });

      // Generate both tokens
      const accessToken = generateAccessToken(result.id);
      const refreshToken = generateRefreshToken(result.id);

      // Store refresh token in database
      await query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
        [result.id, refreshToken]
      );

      // Set cookies (NOT in JSON response)
      res.cookie("clipzen_token", accessToken, getAccessCookieOptions());
      res.cookie("clipzen_refresh_token", refreshToken, getRefreshCookieOptions());

      // Return ONLY user data - NO TOKEN in JSON
      res.status(201).json({
        user: {
          id: result.id,
          email: result.email,
          name: result.name,
          plan: result.plan,
          avatarUrl: result.avatar_url,
        },
      });
    } catch (err) {
      console.error("Signup error:", err);
      res.status(500).json({ error: "Registration failed" });
    }
  }
);

// ── POST /api/auth/login ──────────────────────────────────────
router.post(
  "/login",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      const { rows } = await query(
        "SELECT id, email, name, plan, avatar_url, password_hash FROM users WHERE email = $1",
        [email]
      );

      if (rows.length === 0) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const user = rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);

      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // Generate both tokens
      const accessToken = generateAccessToken(user.id);
      const refreshToken = generateRefreshToken(user.id);

      // Store refresh token in database (delete old ones first)
      await query("DELETE FROM refresh_tokens WHERE user_id = $1", [user.id]);
      await query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
        [user.id, refreshToken]
      );

      // Set cookies (NOT in JSON response)
      res.cookie("clipzen_token", accessToken, getAccessCookieOptions());
      res.cookie("clipzen_refresh_token", refreshToken, getRefreshCookieOptions());

      // Return ONLY user data - NO TOKEN in JSON
      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          avatarUrl: user.avatar_url,
        },
      });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ error: "Login failed" });
    }
  }
);

// ── POST /api/auth/refresh ──────────────────────────────────────
router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = req.cookies.clipzen_refresh_token;
    
    if (!refreshToken) {
      return res.status(401).json({ error: "No refresh token provided" });
    }

    // Verify refresh token
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Refresh token expired" });
      }
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    // Check if refresh token exists in database
    const { rows } = await query(
      "SELECT user_id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()",
      [refreshToken]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Refresh token not found" });
    }

    // Generate new access token
    const newAccessToken = generateAccessToken(decoded.userId);
    
    // Set new access token cookie
    res.cookie("clipzen_token", newAccessToken, getAccessCookieOptions());

    // Return success (no tokens in body)
    res.json({ message: "Token refreshed successfully" });
  } catch (err) {
    console.error("Refresh error:", err);
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

// ── POST /api/auth/logout ──────────────────────────────────────
router.post("/logout", async (req, res) => {
  try {
    const refreshToken = req.cookies.clipzen_refresh_token;
    
    if (refreshToken) {
      // Remove refresh token from database
      await query("DELETE FROM refresh_tokens WHERE token = $1", [refreshToken]);
    }

    // Clear cookies
    res.clearCookie("clipzen_token", { path: "/" });
    res.clearCookie("clipzen_refresh_token", { path: "/" });
    
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ error: "Logout failed" });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
router.get("/me", async (req, res) => {
  try {
    const token = req.cookies.clipzen_token;
    
    if (!token) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const { rows } = await query(
      "SELECT id, email, name, plan, avatar_url FROM users WHERE id = $1",
      [decoded.userId]
    );
    
    if (rows.length === 0) {
      return res.status(401).json({ error: "User not found" });
    }
    
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
});

module.exports = router;