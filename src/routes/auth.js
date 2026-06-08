/* eslint-disable no-undef, no-unused-vars */
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { body, validationResult } = require("express-validator");
const { query, withTransaction } = require("../db/pool");
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
} = require("../services/email");
const billing = require("../services/billing");

// Grant the one-time free minutes to a (now verified) account. Idempotent.
async function grantFreeMinutes(userId) {
  try {
    await billing.ensureUserBilling(userId);
    await billing.grantSignupMinutes(userId);
  } catch (e) {
    console.error("Free minutes grant failed:", e.message);
  }
}

// ── TOKEN GENERATION ──────────────────────────────────────────
function generateAccessToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  });
}

function generateRefreshToken(userId) {
  return jwt.sign(
    { userId, type: "refresh" },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d" },
  );
}

// ── COOKIE CONFIG ─────────────────────────────────────────────
const getCookieOptions = () => {
  // In production the frontend (e.g. clipzenapp.vercel.app) and the API live on
  // DIFFERENT domains, so auth cookies are cross-site. The browser only sends
  // cross-site cookies on XHR when sameSite="none" AND secure=true. With "lax"
  // the cookie is dropped on every API call → instant logout. Locally we stay
  // on "lax"+insecure since it's same-site over http.
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
  };
};
const getAccessCookieOptions = () => ({
  ...getCookieOptions(),
  maxAge: 15 * 60 * 1000,
});
const getRefreshCookieOptions = () => ({
  ...getCookieOptions(),
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

// ── HELPERS ───────────────────────────────────────────────────
async function issueSession(res, userId) {
  const accessToken = generateAccessToken(userId);
  const refreshToken = generateRefreshToken(userId);
  await query("DELETE FROM refresh_tokens WHERE user_id = $1", [userId]);
  await query(
    `INSERT INTO refresh_tokens (user_id, token, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
    [userId, refreshToken],
  );
  res.cookie("clipzen_token", accessToken, getAccessCookieOptions());
  res.cookie(
    "clipzen_refresh_token",
    refreshToken,
    getRefreshCookieOptions(),
  );
}

function userResponse(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    plan: u.plan,
    avatarUrl: u.avatar_url,
    emailVerified: u.email_verified,
    provider: u.provider,
  };
}

function generateOtp() {
  // 6 digits, zero-padded
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function generateResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ── POST /api/auth/signup ─────────────────────────────────────
router.post(
  "/signup",
  [
    body("email").isEmail().normalizeEmail(),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("name").trim().notEmpty().withMessage("Name is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { email, password, name } = req.body;

    try {
      const existing = await query(
        "SELECT id, email_verified FROM users WHERE email = $1",
        [email],
      );
      if (existing.rows.length > 0) {
        // If the existing account is unverified, re-send OTP instead of erroring.
        const row = existing.rows[0];
        if (!row.email_verified) {
          const code = generateOtp();
          await query(
            `INSERT INTO email_verification_codes (user_id, code, type, expires_at)
             VALUES ($1, $2, 'verify_email', NOW() + INTERVAL '15 minutes')`,
            [row.id, code],
          );
          try {
            await sendVerificationEmail({ to: email, name, code });
          } catch (e) {
            console.error("Signup re-send email failed:", e);
          }
          return res.status(200).json({
            pendingVerification: true,
            email,
            message: "Verification email re-sent",
          });
        }
        return res.status(409).json({ error: "Email already in use" });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const user = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO users (email, password_hash, name, provider, email_verified)
           VALUES ($1, $2, $3, 'email', FALSE)
           RETURNING id, email, name, plan, avatar_url, email_verified, provider`,
          [email, passwordHash, name],
        );
        const u = rows[0];
        await client.query(
          `INSERT INTO user_preferences (user_id) VALUES ($1)`,
          [u.id],
        );
        return u;
      });

      const code = generateOtp();
      await query(
        `INSERT INTO email_verification_codes (user_id, code, type, expires_at)
         VALUES ($1, $2, 'verify_email', NOW() + INTERVAL '15 minutes')`,
        [user.id, code],
      );

      try {
        await sendVerificationEmail({ to: email, name, code });
      } catch (e) {
        console.error("Signup send email failed:", e);
        // Continue — user can request a resend.
      }

      // Note: we do NOT issue a session here. User must verify first.
      return res.status(201).json({
        pendingVerification: true,
        email,
        message:
          "Account created. Check your email for the 6-digit verification code.",
      });
    } catch (err) {
      console.error("Signup error:", err);
      res.status(500).json({ error: "Registration failed" });
    }
  },
);

// ── POST /api/auth/verify-email ───────────────────────────────
router.post(
  "/verify-email",
  [
    body("email").isEmail().normalizeEmail(),
    body("code")
      .isLength({ min: 6, max: 6 })
      .isNumeric()
      .withMessage("Code must be 6 digits"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { email, code } = req.body;

    try {
      const { rows: userRows } = await query(
        "SELECT id, email, name, plan, avatar_url, email_verified, provider FROM users WHERE email = $1",
        [email],
      );
      if (userRows.length === 0) {
        return res.status(404).json({ error: "Account not found" });
      }
      const user = userRows[0];
      if (user.email_verified) {
        await issueSession(res, user.id);
        return res.json({ user: userResponse(user) });
      }

      const { rows: codeRows } = await query(
        `SELECT id FROM email_verification_codes
         WHERE user_id = $1 AND code = $2 AND type = 'verify_email'
           AND used_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [user.id, code],
      );
      if (codeRows.length === 0) {
        return res
          .status(400)
          .json({ error: "Invalid or expired verification code" });
      }

      await withTransaction(async (client) => {
        await client.query(
          "UPDATE users SET email_verified = TRUE WHERE id = $1",
          [user.id],
        );
        await client.query(
          "UPDATE email_verification_codes SET used_at = NOW() WHERE id = $1",
          [codeRows[0].id],
        );
      });

      await grantFreeMinutes(user.id);
      await issueSession(res, user.id);
      return res.json({
        user: { ...userResponse(user), emailVerified: true },
      });
    } catch (err) {
      console.error("Verify email error:", err);
      res.status(500).json({ error: "Verification failed" });
    }
  },
);

// ── POST /api/auth/resend-verification ────────────────────────
router.post(
  "/resend-verification",
  [body("email").isEmail().normalizeEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { email } = req.body;

    try {
      const { rows } = await query(
        "SELECT id, name, email_verified FROM users WHERE email = $1",
        [email],
      );
      // Always respond 200 to prevent email enumeration.
      if (rows.length === 0 || rows[0].email_verified) {
        return res.json({ ok: true });
      }
      const user = rows[0];
      const code = generateOtp();
      await query(
        `INSERT INTO email_verification_codes (user_id, code, type, expires_at)
         VALUES ($1, $2, 'verify_email', NOW() + INTERVAL '15 minutes')`,
        [user.id, code],
      );
      try {
        await sendVerificationEmail({ to: email, name: user.name, code });
      } catch (e) {
        console.error("Resend verification failed:", e);
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error("Resend verification error:", err);
      res.status(500).json({ error: "Could not resend verification" });
    }
  },
);

// ── POST /api/auth/login ──────────────────────────────────────
router.post(
  "/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { email, password } = req.body;

    try {
      const { rows } = await query(
        `SELECT id, email, name, plan, avatar_url, password_hash,
                email_verified, provider
         FROM users WHERE email = $1`,
        [email],
      );
      if (rows.length === 0) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const user = rows[0];
      if (user.provider === "google" || !user.password_hash) {
        return res.status(401).json({
          error:
            "This account uses Google sign-in. Continue with Google instead.",
        });
      }
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      if (!user.email_verified) {
        // Re-issue OTP so the user can finish verification.
        const code = generateOtp();
        await query(
          `INSERT INTO email_verification_codes (user_id, code, type, expires_at)
           VALUES ($1, $2, 'verify_email', NOW() + INTERVAL '15 minutes')`,
          [user.id, code],
        );
        try {
          await sendVerificationEmail({ to: email, name: user.name, code });
        } catch (e) {
          console.error("Login OTP send failed:", e);
        }
        return res.status(403).json({
          error: "Please verify your email to continue.",
          pendingVerification: true,
          email,
        });
      }

      await issueSession(res, user.id);
      res.json({ user: userResponse(user) });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ error: "Login failed" });
    }
  },
);

// ── POST /api/auth/forgot-password ────────────────────────────
router.post(
  "/forgot-password",
  [body("email").isEmail().normalizeEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { email } = req.body;

    try {
      const { rows } = await query(
        "SELECT id, name, provider FROM users WHERE email = $1",
        [email],
      );
      // Always 200 to prevent enumeration.
      if (rows.length === 0 || rows[0].provider === "google") {
        return res.json({ ok: true });
      }
      const user = rows[0];
      const token = generateResetToken();
      await query(
        `INSERT INTO email_verification_codes (user_id, code, type, expires_at)
         VALUES ($1, $2, 'reset_password', NOW() + INTERVAL '30 minutes')`,
        [user.id, token],
      );
      try {
        await sendPasswordResetEmail({ to: email, name: user.name, token });
      } catch (e) {
        console.error("Reset email send failed:", e);
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error("Forgot password error:", err);
      res.status(500).json({ error: "Could not process request" });
    }
  },
);

// ── POST /api/auth/reset-password ─────────────────────────────
router.post(
  "/reset-password",
  [
    body("token").isLength({ min: 32 }),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { token, password } = req.body;

    try {
      const { rows } = await query(
        `SELECT c.id AS code_id, u.id AS user_id, u.email, u.name, u.plan,
                u.avatar_url, u.email_verified, u.provider
         FROM email_verification_codes c
         JOIN users u ON u.id = c.user_id
         WHERE c.code = $1 AND c.type = 'reset_password'
           AND c.used_at IS NULL AND c.expires_at > NOW()
         ORDER BY c.created_at DESC LIMIT 1`,
        [token],
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: "Invalid or expired token" });
      }
      const row = rows[0];
      const passwordHash = await bcrypt.hash(password, 12);
      await withTransaction(async (client) => {
        await client.query(
          "UPDATE users SET password_hash = $1, email_verified = TRUE WHERE id = $2",
          [passwordHash, row.user_id],
        );
        await client.query(
          "UPDATE email_verification_codes SET used_at = NOW() WHERE id = $1",
          [row.code_id],
        );
        // Invalidate any other live reset tokens for this user.
        await client.query(
          `UPDATE email_verification_codes SET used_at = NOW()
           WHERE user_id = $1 AND type = 'reset_password' AND used_at IS NULL`,
          [row.user_id],
        );
      });

      await issueSession(res, row.user_id);
      res.json({
        user: userResponse({
          id: row.user_id,
          email: row.email,
          name: row.name,
          plan: row.plan,
          avatar_url: row.avatar_url,
          email_verified: true,
          provider: row.provider,
        }),
      });
    } catch (err) {
      console.error("Reset password error:", err);
      res.status(500).json({ error: "Could not reset password" });
    }
  },
);

// ── Google OAuth ──────────────────────────────────────────────
// GET /api/auth/google/start  →  redirect to Google consent
// GET /api/auth/google/callback?code=...&state=...  →  exchange + redirect

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

function googleRedirectUri() {
  return (
    process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.BACKEND_URL || "http://localhost:3001"}/api/auth/google/callback`
  );
}

router.get("/google/start", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res
      .status(500)
      .json({ error: "Google OAuth is not configured on this server." });
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("clipzen_oauth_state", state, {
    ...getCookieOptions(),
    maxAge: 10 * 60 * 1000,
  });
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

router.get("/google/callback", async (req, res) => {
  const { code, state } = req.query;
  const cookieState = req.cookies.clipzen_oauth_state;
  const frontend = process.env.FRONTEND_URL || "http://localhost:8080";

  res.clearCookie("clipzen_oauth_state", { path: "/" });

  if (!code || !state || state !== cookieState) {
    return res.redirect(`${frontend}/login?error=oauth_state`);
  }
  try {
    const tokenResp = await axios.post(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        code: String(code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(),
        grant_type: "authorization_code",
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      },
    );

    const { access_token } = tokenResp.data;
    const userInfo = await axios.get(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 15000,
    });

    const { sub, email, name, picture, email_verified } = userInfo.data;
    if (!email) {
      return res.redirect(`${frontend}/login?error=google_no_email`);
    }

    // Find by google provider_id first, then by email.
    let user;
    const byProvider = await query(
      `SELECT id, email, name, plan, avatar_url, email_verified, provider
       FROM users WHERE provider = 'google' AND provider_id = $1`,
      [sub],
    );
    if (byProvider.rows.length > 0) {
      user = byProvider.rows[0];
    } else {
      const byEmail = await query(
        `SELECT id, email, name, plan, avatar_url, email_verified, provider
         FROM users WHERE email = $1`,
        [email],
      );
      if (byEmail.rows.length > 0) {
        // Upgrade existing email account to also link Google.
        user = byEmail.rows[0];
        await query(
          `UPDATE users SET provider = 'google', provider_id = $1,
                            email_verified = TRUE,
                            avatar_url = COALESCE(avatar_url, $2)
           WHERE id = $3`,
          [sub, picture || null, user.id],
        );
        user.email_verified = true;
      } else {
        const inserted = await withTransaction(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO users (email, name, provider, provider_id,
                                avatar_url, email_verified)
             VALUES ($1, $2, 'google', $3, $4, $5)
             RETURNING id, email, name, plan, avatar_url, email_verified, provider`,
            [email, name || "", sub, picture || null, !!email_verified],
          );
          const u = rows[0];
          await client.query(
            `INSERT INTO user_preferences (user_id) VALUES ($1)`,
            [u.id],
          );
          return u;
        });
        user = inserted;
      }
    }

    await grantFreeMinutes(user.id);
    await issueSession(res, user.id);
    return res.redirect(`${frontend}/upload`);
  } catch (err) {
    console.error(
      "Google OAuth callback error:",
      err.response?.data || err.message || err.code || err,
    );
    return res.redirect(`${frontend}/login?error=oauth_exchange`);
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────
router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = req.cookies.clipzen_refresh_token;
    if (!refreshToken) {
      return res.status(401).json({ error: "No refresh token provided" });
    }
    let decoded;
    try {
      decoded = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      );
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Refresh token expired" });
      }
      return res.status(401).json({ error: "Invalid refresh token" });
    }
    const { rows } = await query(
      "SELECT user_id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()",
      [refreshToken],
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Refresh token not found" });
    }
    const newAccessToken = generateAccessToken(decoded.userId);
    res.cookie("clipzen_token", newAccessToken, getAccessCookieOptions());
    res.json({ message: "Token refreshed successfully" });
  } catch (err) {
    console.error("Refresh error:", err);
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post("/logout", async (req, res) => {
  try {
    const refreshToken = req.cookies.clipzen_refresh_token;
    if (refreshToken) {
      await query("DELETE FROM refresh_tokens WHERE token = $1", [
        refreshToken,
      ]);
    }
    res.clearCookie("clipzen_token", { path: "/" });
    res.clearCookie("clipzen_refresh_token", { path: "/" });
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ error: "Logout failed" });
  }
});

// ── POST /api/auth/change-password ────────────────────────────
// Authenticated password change for email-signup users.
// Google-only users (provider='google' AND no password_hash) are rejected —
// the frontend shows a "managed by Google" notice for them instead.
router.post(
  "/change-password",
  [
    body("currentPassword").isString().notEmpty(),
    body("newPassword")
      .isLength({ min: 6 })
      .withMessage("New password must be at least 6 characters"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    try {
      const token = req.cookies.clipzen_token;
      if (!token) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { currentPassword, newPassword } = req.body;

      const { rows } = await query(
        `SELECT id, password_hash, provider FROM users WHERE id = $1`,
        [decoded.userId],
      );
      if (rows.length === 0) {
        return res.status(401).json({ error: "User not found" });
      }
      const user = rows[0];

      if (!user.password_hash) {
        return res.status(400).json({
          error:
            "This account uses Google sign-in. Manage your password in your Google account.",
        });
      }

      const ok = await bcrypt.compare(currentPassword, user.password_hash);
      if (!ok) {
        return res
          .status(400)
          .json({ error: "Current password is incorrect" });
      }

      if (currentPassword === newPassword) {
        return res
          .status(400)
          .json({ error: "New password must differ from current password" });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
        newHash,
        user.id,
      ]);

      // Revoke all other refresh tokens for security; re-issue this session.
      await query("DELETE FROM refresh_tokens WHERE user_id = $1", [user.id]);
      await issueSession(res, user.id);

      res.json({ message: "Password updated successfully" });
    } catch (err) {
      if (err.name === "TokenExpiredError" || err.name === "JsonWebTokenError") {
        return res.status(401).json({ error: "Invalid or expired session" });
      }
      console.error("Change password error:", err);
      res.status(500).json({ error: "Could not change password" });
    }
  },
);

// ── GET /api/auth/me ──────────────────────────────────────────
router.get("/me", async (req, res) => {
  try {
    const token = req.cookies.clipzen_token;
    if (!token) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      `SELECT id, email, name, plan, avatar_url, email_verified, provider
       FROM users WHERE id = $1`,
      [decoded.userId],
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "User not found" });
    }
    res.json({ user: userResponse(rows[0]) });
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
});

module.exports = router;
