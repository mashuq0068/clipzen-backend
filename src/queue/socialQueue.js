/* eslint-disable no-undef */
const { Queue } = require("bullmq");
const { connection } = require("./videoQueue");

const socialQueue = new Queue("social-publishing", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

module.exports = { socialQueue };
