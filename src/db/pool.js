/* eslint-disable no-undef */
const { Pool } = require("pg");

// DB_SSL=true enables TLS (required by managed Postgres like Neon). Neon's
// serverless DB can also take a few seconds to wake from idle, so the connect
// timeout is configurable and defaults higher than the old 2s.
const useSsl = String(process.env.DB_SSL || "").toLowerCase() === "true";

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 20,                  // max pool connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: parseInt(
    process.env.DB_CONNECT_TIMEOUT_MS || "10000",
    10,
  ),
});

pool.on("connect", () => {
  console.log("✅ PostgreSQL pool connected");
});

pool.on("error", (err) => {
  console.error("❌ PostgreSQL pool error:", err);
});

// Helper for single queries
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === "development") {
    console.log("DB query", { text: text.substring(0, 60), duration, rows: res.rowCount });
  }
  return res;
}

// Helper for transactions
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };