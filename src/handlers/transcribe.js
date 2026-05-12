const { query } = require("../db/pool");
const { transcribeVideo } = require("../services/transcriber");

async function handleTranscribe(dbJob, videoPath, jobId, userId) {
  const segments = await transcribeVideo(videoPath);
  // Store segments as JSON so frontend can show timeline
  const transcriptJson = JSON.stringify(segments);
  
  // Create a record so it shows up in the UI
  await query(
    `INSERT INTO clips (job_id, user_id, title, file_url, duration, start_time, end_time, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [jobId, userId, "Transcript Result", "", "0:00", "0:00", "0:00", transcriptJson]
  );
}

module.exports = handleTranscribe;
