// middleware/auth.js
const jwt = require("jsonwebtoken");
const { query } = require("../db/pool");

async function authMiddleware(req, res, next) {
  try {
    // Get token from cookie instead of header
    const token = req.cookies.clipzen_token;
    
    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Verify user still exists in DB
    const { rows } = await query(
      "SELECT id, email, name, plan, avatar_url FROM users WHERE id = $1",
      [decoded.userId]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "User no longer exists" });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = authMiddleware;