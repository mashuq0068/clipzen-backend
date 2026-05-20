/* eslint-disable no-undef */
require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});

const { Worker } = require("bullmq");
const { connection } = require("../queue/videoQueue");
const { processPublishJob } = require("../services/socialAccounts");

const publishingWorker = new Worker(
  "social-publishing",
  async (job) => {
    const { publishJobId } = job.data;
    console.log(`Publishing job ${publishJobId}`);
    await processPublishJob(publishJobId);
  },
  { connection, concurrency: Number(process.env.SOCIAL_PUBLISH_CONCURRENCY || 2) },
);

publishingWorker.on("completed", (job) => {
  console.log(`Publishing job ${job.data.publishJobId} done`);
});

publishingWorker.on("failed", (job, err) => {
  console.error(`Publishing job ${job?.data?.publishJobId} failed: ${err.message}`);
});

module.exports = publishingWorker;
