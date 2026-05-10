/* eslint-disable no-undef */
const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  maxRetriesPerRequest: null, // required by BullMQ
});

connection.on("error", (err) => {
  console.error("❌ Redis connection error:", err.message);
});

connection.on("connect", () => {
  console.log("✅ Redis connected");
});

const videoQueue = new Queue("video-processing", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
  },
});

module.exports = { videoQueue, connection };