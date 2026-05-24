/* eslint-disable no-undef */
require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});
const { pool } = require("./pool");

const SQL = `

-- ── Extensions ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS ─────────────────────────────────────────────────────
-- Stores all registered accounts.
-- plan: free | pro | agency
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  plan          TEXT NOT NULL DEFAULT 'free'
                  CHECK (plan IN ('free', 'pro', 'agency')),
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── JOBS ──────────────────────────────────────────────────────
-- One row per video processing request.
-- source_type: url | upload
-- status:      pending | processing | done | failed
CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','processing','done','failed')),
  source_type      TEXT NOT NULL CHECK (source_type IN ('url','upload')),
  source_url       TEXT,                      -- youtube URL if source_type=url
  source_file_path TEXT,                      -- local path if source_type=upload
  video_title      TEXT,
  original_duration TEXT,                     -- e.g. "12:34"
  clip_count       INT DEFAULT 0,
  platforms        TEXT[] NOT NULL DEFAULT '{}',
  caption_style    TEXT NOT NULL DEFAULT 'flip_board_yellow',
  clip_duration    TEXT NOT NULL DEFAULT 'auto',
  language         TEXT NOT NULL DEFAULT 'en',
  auto_captions    BOOLEAN DEFAULT TRUE,
  hook_detection   BOOLEAN DEFAULT TRUE,
  error_message    TEXT,
  bull_job_id      TEXT,                      -- BullMQ job id for status polling
  thumbnail_url    TEXT,                      -- auto-extracted at 10% of video duration
  broll_enabled    BOOLEAN DEFAULT FALSE,
  broll_style      TEXT NOT NULL DEFAULT 'fullscreen'
                   CHECK (broll_style IN ('fullscreen', 'pip')),
  job_type         TEXT NOT NULL DEFAULT 'magic-clips',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);

-- ── CLIPS ─────────────────────────────────────────────────────
-- One row per generated clip from a job.
CREATE TABLE IF NOT EXISTS clips (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id           UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL DEFAULT '',
  file_path        TEXT,                      -- local path to the .mp4 file
  file_url         TEXT,                      -- served URL (e.g. /outputs/...)
  cloud_url        TEXT,                      -- Cloudinary hosted URL
  duration         TEXT,                      -- e.g. "0:32"
  start_time       TEXT,                      -- e.g. "2:14"
  end_time         TEXT,                      -- e.g. "2:46"
  hook_score       INT DEFAULT 0,             -- 0-100
  platforms        TEXT[] NOT NULL DEFAULT '{}',
  thumbnail_color  TEXT DEFAULT 'bg-gradient-to-br from-violet-500/30 to-purple-400/10',
  thumbnail_url    TEXT,                      -- auto-extracted at 20% of clip duration
  transcript       TEXT,
  broll_segments   JSONB DEFAULT '[]',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clips_job_id  ON clips(job_id);
CREATE INDEX IF NOT EXISTS idx_clips_user_id ON clips(user_id);

-- ── CAPTIONS ──────────────────────────────────────────────────
-- One row per platform per clip (normalised to avoid wide columns).
-- platform: tiktok | instagram | linkedin | facebook | youtube | twitter
CREATE TABLE IF NOT EXISTS captions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clip_id    UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  platform   TEXT NOT NULL
               CHECK (platform IN ('tiktok','instagram','linkedin','facebook','youtube','twitter')),
  body       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(clip_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_captions_clip_id ON captions(clip_id);

-- ── USER PREFERENCES ──────────────────────────────────────────
-- Stores default settings the user has saved in /settings.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_clip_count INT DEFAULT 5,
  default_platforms  TEXT[] DEFAULT ARRAY['tiktok','instagram','youtube','linkedin','facebook','twitter'],
  default_language   TEXT DEFAULT 'en',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── TRIGGER: auto-update updated_at ───────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  -- users
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_updated_at') THEN
    CREATE TRIGGER trg_users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  -- jobs
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_jobs_updated_at') THEN
    CREATE TRIGGER trg_jobs_updated_at
      BEFORE UPDATE ON jobs
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ── REFRESH TOKENS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);

-- Connected social identities. Tokens are encrypted by the API before storage.
CREATE TABLE IF NOT EXISTS connected_social_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('youtube','tiktok','instagram','facebook','linkedin','twitter')),
  platform_account_id TEXT NOT NULL,
  account_name TEXT,
  account_username TEXT,
  account_avatar_url TEXT,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  token_type TEXT DEFAULT 'Bearer',
  scope TEXT[] NOT NULL DEFAULT '{}',
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  publish_permissions TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','disconnected','expired','revoked','error')),
  last_refreshed_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, platform, platform_account_id)
);

CREATE INDEX IF NOT EXISTS idx_connected_social_accounts_user_id ON connected_social_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_connected_social_accounts_platform ON connected_social_accounts(platform);
CREATE INDEX IF NOT EXISTS idx_connected_social_accounts_status ON connected_social_accounts(status);

CREATE TABLE IF NOT EXISTS zernio_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  zernio_profile_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS social_publish_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','published','scheduled','partial','failed','cancelled')),
  scheduled_for TIMESTAMPTZ,
  selected_account_ids UUID[] NOT NULL DEFAULT '{}',
  selected_clip_ids UUID[] NOT NULL DEFAULT '{}',
  caption_overrides JSONB NOT NULL DEFAULT '{}',
  bull_job_id TEXT,
  zernio_response JSONB,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_publish_jobs_user_id ON social_publish_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_social_publish_jobs_status ON social_publish_jobs(status);

CREATE TABLE IF NOT EXISTS social_publish_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  publish_job_id UUID NOT NULL REFERENCES social_publish_jobs(id) ON DELETE CASCADE,
  clip_id UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','published','scheduled','partial','failed','cancelled')),
  caption TEXT,
  zernio_post_id TEXT,
  zernio_response JSONB,
  error_message TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_publish_items_job_id ON social_publish_items(publish_job_id);
CREATE INDEX IF NOT EXISTS idx_social_publish_items_clip_id ON social_publish_items(clip_id);
CREATE INDEX IF NOT EXISTS idx_social_publish_items_zernio_post_id ON social_publish_items(zernio_post_id);

CREATE TABLE IF NOT EXISTS zernio_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── SAFE MIGRATIONS (idempotent ALTER TABLE) ──────────────────
-- thumbnail_url for jobs: extracted at 10% of source video duration
ALTER TABLE jobs  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
-- thumbnail_url for clips: extracted at 20% of rendered clip duration
ALTER TABLE clips ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS cloud_url TEXT;


ALTER TABLE jobs ADD COLUMN IF NOT EXISTS broll_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS broll_style TEXT NOT NULL DEFAULT 'fullscreen' CHECK (broll_style IN ('fullscreen', 'pip'));

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'magic-clips';

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS title_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS title_text TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS title_style TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS title_position TEXT DEFAULT 'center';

ALTER TABLE connected_social_accounts ADD COLUMN IF NOT EXISTS zernio_account_id TEXT;
ALTER TABLE connected_social_accounts ALTER COLUMN access_token_encrypted DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_connected_social_accounts_zernio_account_id ON connected_social_accounts(zernio_account_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_connected_social_accounts_updated_at') THEN
    CREATE TRIGGER trg_connected_social_accounts_updated_at
      BEFORE UPDATE ON connected_social_accounts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_zernio_profiles_updated_at') THEN
    CREATE TRIGGER trg_zernio_profiles_updated_at
      BEFORE UPDATE ON zernio_profiles
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_social_publish_jobs_updated_at') THEN
    CREATE TRIGGER trg_social_publish_jobs_updated_at
      BEFORE UPDATE ON social_publish_jobs
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_social_publish_items_updated_at') THEN
    CREATE TRIGGER trg_social_publish_items_updated_at
      BEFORE UPDATE ON social_publish_items
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;
`;

async function migrate() {
  console.log("🔄 Running Clipora migrations...");
  try {
    await pool.query(SQL);
    console.log("✅ All tables created successfully.");
    console.log(
      "💡 Thumbnail files are stored under: outputs/<jobId>/thumbnails/",
    );
    console.log(
      "   Make sure your static file server exposes the /outputs directory.",
    );
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
