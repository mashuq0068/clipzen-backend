/* eslint-disable no-undef */
const crypto = require("crypto");
const { query, withTransaction } = require("../db/pool");
const { socialQueue } = require("../queue/socialQueue");
const { zernioProvider } = require("../social/providers/zernio.provider");

const SUPPORTED_PLATFORMS = ["youtube", "tiktok", "instagram", "facebook", "twitter"];

const PLATFORM_LABELS = {
  youtube: "YouTube Shorts",
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
  twitter: "X/Twitter",
};

function backendPublicUrl() {
  return process.env.BACKEND_PUBLIC_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
}

function frontendUrl() {
  return process.env.FRONTEND_URL || "http://localhost:8080";
}

function frontendRedirect(path, params = {}) {
  const safePath = path && path.startsWith("/") ? path : "/projects";
  const url = new URL(safePath, frontendUrl());
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });
  return url.toString();
}

function publicClipUrl(fileUrl) {
  if (!fileUrl) return null;
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  return new URL(fileUrl, backendPublicUrl()).toString();
}

function normalizeAccount(account) {
  return {
    zernioAccountId: account._id || account.accountId || account.id,
    platform: account.platform,
    accountName: account.displayName || account.name || account.username || PLATFORM_LABELS[account.platform],
    accountUsername: account.username || null,
    accountAvatarUrl: account.avatarUrl || account.profileImageUrl || null,
    platformAccountId: account.platformAccountId || account.externalId || account.username || account._id,
    profileUrl: account.profileUrl || null,
    connected: account.isActive !== false,
    metadata: account,
  };
}

function publicAccount(row) {
  return {
    id: row.id,
    platform: row.platform,
    connected: row.status === "connected",
    status: row.status,
    accountName: row.account_name,
    accountUsername: row.account_username,
    accountAvatarUrl: row.account_avatar_url,
    platformAccountId: row.platform_account_id,
    zernioAccountId: row.zernio_account_id || row.platform_account_id,
    profileUrl: row.metadata?.profileUrl || row.metadata?.profile_url || null,
    publishPermissions: row.publish_permissions || ["post.create"],
    connectedAt: row.connected_at,
    lastRefreshedAt: row.last_refreshed_at,
  };
}

async function ensureZernioProfile(userId) {
  const existing = await query(
    `SELECT zp.zernio_profile_id
     FROM zernio_profiles zp
     WHERE zp.user_id = $1`,
    [userId],
  );

  if (existing.rows[0]?.zernio_profile_id) {
    return existing.rows[0].zernio_profile_id;
  }

  const user = await query("SELECT email, name FROM users WHERE id = $1", [userId]);
  const label = user.rows[0]?.name || user.rows[0]?.email || "Clipzen creator";

  const data = await zernioProvider.createProfile({
    name: `Clipzen - ${label}`,
    description: `Clipzen social publishing profile for user ${userId}`,
  });
  const profileId = data.profile?._id || data.profile?.id || data._id || data.id;

  if (!profileId) {
    const error = new Error("Zernio did not return a profile ID");
    error.status = 502;
    throw error;
  }

  await query(
    `INSERT INTO zernio_profiles (user_id, zernio_profile_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id)
     DO UPDATE SET zernio_profile_id = EXCLUDED.zernio_profile_id, updated_at = NOW()`,
    [userId, profileId],
  );

  return profileId;
}

async function syncConnections(userId) {
  const profileId = await ensureZernioProfile(userId);
  const data = await zernioProvider.listAccounts({ profileId });
  const accounts = (data.accounts || [])
    .map(normalizeAccount)
    .filter((account) => SUPPORTED_PLATFORMS.includes(account.platform));

  await withTransaction(async (client) => {
    const seenIds = [];

    for (const account of accounts) {
      if (!account.zernioAccountId) continue;
      seenIds.push(account.zernioAccountId);

      await client.query(
        `INSERT INTO connected_social_accounts (
          user_id, platform, platform_account_id, zernio_account_id,
          account_name, account_username, account_avatar_url,
          access_token_encrypted, refresh_token_encrypted, token_type, scope,
          publish_permissions, metadata, status, last_refreshed_at, connected_at,
          disconnected_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,'Zernio','{}',$8,$9,$10,NOW(),NOW(),NULL)
        ON CONFLICT (user_id, platform, platform_account_id)
        DO UPDATE SET
          zernio_account_id = EXCLUDED.zernio_account_id,
          account_name = EXCLUDED.account_name,
          account_username = EXCLUDED.account_username,
          account_avatar_url = EXCLUDED.account_avatar_url,
          publish_permissions = EXCLUDED.publish_permissions,
          metadata = EXCLUDED.metadata,
          status = EXCLUDED.status,
          last_refreshed_at = NOW(),
          disconnected_at = CASE WHEN EXCLUDED.status = 'connected' THEN NULL ELSE connected_social_accounts.disconnected_at END
        RETURNING id`,
        [
          userId,
          account.platform,
          account.platformAccountId || account.zernioAccountId,
          account.zernioAccountId,
          account.accountName,
          account.accountUsername,
          account.accountAvatarUrl,
          ["post.create"],
          { ...account.metadata, profileUrl: account.profileUrl },
          account.connected ? "connected" : "disconnected",
        ],
      );
    }

    await client.query(
      `UPDATE connected_social_accounts
       SET status = 'disconnected', disconnected_at = COALESCE(disconnected_at, NOW())
       WHERE user_id = $1
         AND zernio_account_id IS NOT NULL
         AND ($2::text[] = '{}'::text[] OR NOT (zernio_account_id = ANY($2)))`,
      [userId, seenIds],
    );
  });
}

async function getConnections(userId) {
  await syncConnections(userId);

  const { rows } = await query(
    `SELECT *
     FROM connected_social_accounts
     WHERE user_id = $1
       AND platform = ANY($2)
       AND zernio_account_id IS NOT NULL
     ORDER BY connected_at DESC`,
    [userId, SUPPORTED_PLATFORMS],
  );

  return SUPPORTED_PLATFORMS.map((platform) => {
    const accounts = rows
      .filter((row) => row.platform === platform)
      .map(publicAccount);
    const connectedAccounts = accounts.filter((account) => account.connected);

    return {
      platform,
      label: PLATFORM_LABELS[platform],
      connected: connectedAccounts.length > 0,
      account: connectedAccounts[0] || accounts[0] || null,
      accounts,
    };
  });
}

async function createConnectUrl({ userId, platform, redirectPath }) {
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    const error = new Error("Unsupported social platform");
    error.status = 404;
    throw error;
  }

  const profileId = await ensureZernioProfile(userId);
  const redirectUrl = frontendRedirect(redirectPath, {
    socialAuth: "success",
    platform,
  });
  const authUrl = await zernioProvider.getConnectUrl({ platform, profileId, redirectUrl });

  if (!authUrl) {
    const error = new Error("Zernio did not return an OAuth URL");
    error.status = 502;
    throw error;
  }

  return authUrl;
}

async function disconnect(userId, accountIdOrPlatform) {
  const { rows } = await query(
    `SELECT id, platform, zernio_account_id
     FROM connected_social_accounts
     WHERE user_id = $1
       AND (id::text = $2 OR platform = $2)
       AND status = 'connected'
     ORDER BY connected_at DESC
     LIMIT 1`,
    [userId, accountIdOrPlatform],
  );

  if (rows.length === 0) return false;

  const account = rows[0];
  if (account.zernio_account_id) {
    await zernioProvider.disconnectAccount(account.zernio_account_id);
  }

  await query(
    `UPDATE connected_social_accounts
     SET status = 'disconnected', disconnected_at = NOW()
     WHERE id = $1`,
    [account.id],
  );

  return true;
}

async function getPublishAccounts(userId, accountIds) {
  const { rows } = await query(
    `SELECT *
     FROM connected_social_accounts
     WHERE user_id = $1
       AND id = ANY($2)
       AND status = 'connected'
       AND zernio_account_id IS NOT NULL`,
    [userId, accountIds],
  );

  if (rows.length !== accountIds.length) {
    const error = new Error("One or more selected accounts are not connected");
    error.status = 400;
    throw error;
  }

  return rows.map(publicAccount);
}

async function getPublishClips(userId, clipIds) {
  const { rows } = await query(
    `SELECT c.id, c.job_id, c.title, c.file_url, c.file_path, c.transcript,
            COALESCE(jsonb_object_agg(cap.platform, cap.body) FILTER (WHERE cap.platform IS NOT NULL), '{}'::jsonb) AS captions
     FROM clips c
     LEFT JOIN captions cap ON cap.clip_id = c.id
     WHERE c.user_id = $1
       AND c.id = ANY($2)
     GROUP BY c.id`,
    [userId, clipIds],
  );

  if (rows.length !== clipIds.length) {
    const error = new Error("One or more selected clips were not found");
    error.status = 404;
    throw error;
  }

  rows.forEach((clip) => {
    if (!publicClipUrl(clip.file_url)) {
      const error = new Error(`Clip "${clip.title || clip.id}" does not have a publishable media URL`);
      error.status = 400;
      throw error;
    }
  });

  return rows;
}

function defaultCaptionForClip(clip, accounts) {
  const platform = accounts[0]?.platform;
  return (
    clip.captions?.[platform] ||
    clip.captions?.instagram ||
    clip.captions?.tiktok ||
    clip.title ||
    "New Clipzen clip"
  );
}

async function queuePublish({ userId, clipIds, accountIds, captionByClip = {}, scheduledFor = null }) {
  if (!Array.isArray(clipIds) || clipIds.length === 0) {
    const error = new Error("Select at least one clip to publish");
    error.status = 400;
    throw error;
  }

  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    const error = new Error("Select at least one connected account");
    error.status = 400;
    throw error;
  }

  const accounts = await getPublishAccounts(userId, accountIds);
  const clips = await getPublishClips(userId, clipIds);

  const result = await withTransaction(async (client) => {
    const publish = await client.query(
      `INSERT INTO social_publish_jobs (
        user_id, status, scheduled_for, selected_account_ids, selected_clip_ids, caption_overrides
      )
      VALUES ($1, 'queued', $2, $3, $4, $5)
      RETURNING *`,
      [userId, scheduledFor || null, accountIds, clipIds, captionByClip],
    );

    for (const clip of clips) {
      await client.query(
        `INSERT INTO social_publish_items (
          publish_job_id, clip_id, status, caption
        )
        VALUES ($1, $2, 'queued', $3)`,
        [
          publish.rows[0].id,
          clip.id,
          captionByClip[clip.id] || defaultCaptionForClip(clip, accounts),
        ],
      );
    }

    return publish.rows[0];
  });

  const bullJob = await socialQueue.add(
    "publish-clips",
    { publishJobId: result.id, userId },
    scheduledFor ? { delay: Math.max(0, new Date(scheduledFor).getTime() - Date.now()) } : undefined,
  );

  await query("UPDATE social_publish_jobs SET bull_job_id = $1 WHERE id = $2", [
    String(bullJob.id),
    result.id,
  ]);

  return {
    queued: true,
    publishJobId: result.id,
    bullJobId: bullJob.id,
    scheduledFor: result.scheduled_for,
  };
}

async function processPublishJob(publishJobId) {
  const publishResult = await query(
    `SELECT *
     FROM social_publish_jobs
     WHERE id = $1`,
    [publishJobId],
  );

  if (publishResult.rows.length === 0) {
    throw new Error("Publish job not found");
  }

  const publishJob = publishResult.rows[0];
  await query(
    "UPDATE social_publish_jobs SET status = 'processing', started_at = NOW(), error_message = NULL WHERE id = $1",
    [publishJobId],
  );

  const accounts = await getPublishAccounts(publishJob.user_id, publishJob.selected_account_ids);
  const clips = await getPublishClips(publishJob.user_id, publishJob.selected_clip_ids);

  let failed = false;
  const zernioPosts = [];

  for (const clip of clips) {
    const item = await query(
      `SELECT id, caption
       FROM social_publish_items
       WHERE publish_job_id = $1 AND clip_id = $2`,
      [publishJobId, clip.id],
    );
    const itemId = item.rows[0].id;
    const caption = item.rows[0].caption || defaultCaptionForClip(clip, accounts);

    try {
      await query(
        "UPDATE social_publish_items SET status = 'processing', error_message = NULL WHERE id = $1",
        [itemId],
      );

      const requestId = crypto
        .createHash("sha256")
        .update(`${publishJobId}:${clip.id}`)
        .digest("hex")
        .slice(0, 32)
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");

      const data = await zernioProvider.createPost({
        requestId,
        body: {
          title: clip.title || "Clipzen clip",
          content: caption,
          mediaItems: [
            {
              type: "video",
              url: publicClipUrl(clip.file_url),
            },
          ],
          platforms: accounts.map((account) => ({
            platform: account.platform,
            accountId: account.zernioAccountId,
          })),
          publishNow: !publishJob.scheduled_for,
          scheduledFor: publishJob.scheduled_for || undefined,
          timezone: "UTC",
          metadata: {
            clipzenPublishJobId: publishJobId,
            clipzenClipId: clip.id,
          },
        },
      });

      const post = data.post || data.existingPost || data;
      zernioPosts.push(post);

      await query(
        `UPDATE social_publish_items
         SET status = $1,
             zernio_post_id = $2,
             zernio_response = $3,
             completed_at = CASE WHEN $1 = 'published' THEN NOW() ELSE completed_at END
         WHERE id = $4`,
        [
          publishJob.scheduled_for ? "scheduled" : "published",
          post?._id || post?.id || null,
          post,
          itemId,
        ],
      );
    } catch (error) {
      failed = true;
      await query(
        `UPDATE social_publish_items
         SET status = 'failed', error_message = $1, zernio_response = $2
         WHERE id = $3`,
        [error.message.substring(0, 500), error.details || null, itemId],
      );
    }
  }

  await query(
    `UPDATE social_publish_jobs
     SET status = $1,
         zernio_response = $2,
         completed_at = CASE WHEN $1 IN ('published','scheduled','failed') THEN NOW() ELSE completed_at END,
         error_message = CASE WHEN $1 = 'failed' THEN 'One or more clips failed to publish' ELSE NULL END
     WHERE id = $3`,
    [
      failed ? "failed" : publishJob.scheduled_for ? "scheduled" : "published",
      { posts: zernioPosts },
      publishJobId,
    ],
  );

  if (failed) {
    const error = new Error("One or more clips failed to publish");
    error.status = 502;
    throw error;
  }
}

async function listPublishJobs(userId) {
  const { rows } = await query(
    `SELECT spj.*,
            COALESCE(jsonb_agg(
              jsonb_build_object(
                'id', spi.id,
                'clipId', spi.clip_id,
                'status', spi.status,
                'caption', spi.caption,
                'zernioPostId', spi.zernio_post_id,
                'errorMessage', spi.error_message
              )
            ) FILTER (WHERE spi.id IS NOT NULL), '[]'::jsonb) AS items
     FROM social_publish_jobs spj
     LEFT JOIN social_publish_items spi ON spi.publish_job_id = spj.id
     WHERE spj.user_id = $1
     GROUP BY spj.id
     ORDER BY spj.created_at DESC
     LIMIT 50`,
    [userId],
  );
  return rows;
}

async function handleWebhookEvent(payload) {
  await query(
    `INSERT INTO zernio_webhook_events (event_id, event_type, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING`,
    [payload.id, payload.event, payload],
  );

  const postId = payload.post?._id || payload.post?.id;
  if (!postId) return;

  const statusByEvent = {
    "post.published": "published",
    "post.failed": "failed",
    "post.partial": "partial",
    "post.cancelled": "cancelled",
    "post.scheduled": "scheduled",
  };
  const status = statusByEvent[payload.event];
  if (!status) return;

  await query(
    `UPDATE social_publish_items
     SET status = $1,
         zernio_response = COALESCE(zernio_response, '{}'::jsonb) || $2::jsonb,
         completed_at = CASE WHEN $1 IN ('published','failed','partial','cancelled') THEN NOW() ELSE completed_at END
     WHERE zernio_post_id = $3`,
    [status, JSON.stringify({ webhook: payload }), postId],
  );
}

module.exports = {
  SUPPORTED_PLATFORMS,
  PLATFORM_LABELS,
  createConnectUrl,
  disconnect,
  getConnections,
  queuePublish,
  processPublishJob,
  listPublishJobs,
  handleWebhookEvent,
};
