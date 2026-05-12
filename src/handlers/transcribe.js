const { query } = require("../db/pool");
const { transcribeVideo } = require("../services/transcriber");

async function handleTranscribe(dbJob, videoPath, jobId, userId) {
  const segments = await transcribeVideo(videoPath);
  const transcript = segments.map(s => s.text).join(" ");
  
  // Create a record so it shows up in the UI
  await query(
    `INSERT INTO clips (job_id, user_id, title, file_url, duration, start_time, end_time, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [jobId, userId, "Transcript Result", "", "0:00", "0:00", "0:00", transcript]
  );
}

module.exports = handleTranscribe;
