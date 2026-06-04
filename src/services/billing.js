/* eslint-disable no-undef */
// ──────────────────────────────────────────────────────────────
// Billing service — minute metering + balance management.
//
// Balance = two buckets, consumed plan-first then credits:
//   plan allowance  : plan_minutes_included - plan_minutes_used  (resets on renewal)
//   credit balance  : credit_minutes                              (free grant + PAYG, never expires)
//
// All balance mutations run in a transaction with a FOR UPDATE row
// lock on user_billing to stay correct under concurrent workers.
// Job reserve/refund is idempotent via jobs.minutes_charged so
// BullMQ retries never double-charge.
// ──────────────────────────────────────────────────────────────
const { query, withTransaction } = require("../db/pool");
const { PLAN_MINUTES, FREE_SIGNUP_MINUTES } = require("../config/plans");

// Create the user_billing row if missing, seeded from users.plan.
async function ensureUserBilling(userId) {
  const existing = await query(
    "SELECT 1 FROM user_billing WHERE user_id = $1",
    [userId],
  );
  if (existing.rows.length) return;
  const u = await query("SELECT plan FROM users WHERE id = $1", [userId]);
  const plan = u.rows[0]?.plan || "free";
  const included = PLAN_MINUTES[plan] ?? 0;
  await query(
    `INSERT INTO user_billing (user_id, plan, plan_minutes_included)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, plan, included],
  );
}

async function getAvailableMinutes(userId) {
  await ensureUserBilling(userId);
  const { rows } = await query(
    `SELECT GREATEST(0, plan_minutes_included - plan_minutes_used) + credit_minutes
       AS available
     FROM user_billing WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ? Number(rows[0].available) : 0;
}

async function getSummary(userId) {
  await ensureUserBilling(userId);
  const { rows } = await query(
    `SELECT plan, plan_minutes_included, plan_minutes_used, credit_minutes,
            period_start, period_end, automation_addon
     FROM user_billing WHERE user_id = $1`,
    [userId],
  );
  const b = rows[0];
  const planRemaining = Math.max(
    0,
    b.plan_minutes_included - b.plan_minutes_used,
  );
  const available = planRemaining + b.credit_minutes;

  const sub = await query(
    `SELECT ls_subscription_id, plan, billing_cycle, status,
            current_period_end, renews_at, ends_at,
            customer_portal_url, update_payment_url
     FROM subscriptions WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );

  const completed = await query(
    `SELECT COALESCE(SUM(minutes), 0) AS total
     FROM usage_ledger WHERE user_id = $1 AND minutes > 0`,
    [userId],
  );

  return {
    plan: b.plan,
    planMinutesIncluded: b.plan_minutes_included,
    planMinutesUsed: b.plan_minutes_used,
    planMinutesRemaining: planRemaining,
    creditMinutes: b.credit_minutes,
    availableMinutes: available,
    minutesCompleted: Number(completed.rows[0].total),
    periodStart: b.period_start,
    periodEnd: b.period_end,
    automationAddon: b.automation_addon,
    subscription: sub.rows[0] || null,
  };
}

// One-time free minutes for a new account. Idempotent: the partial
// unique index on billing_transactions(type='signup_grant') blocks a 2nd grant.
async function grantSignupMinutes(userId) {
  if (FREE_SIGNUP_MINUTES <= 0) return;
  await ensureUserBilling(userId);
  await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO billing_transactions (user_id, type, minutes_delta, meta)
       VALUES ($1, 'signup_grant', $2, '{}'::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [userId, FREE_SIGNUP_MINUTES],
    );
    if (ins.rows.length === 0) return; // already granted
    await client.query(
      `UPDATE user_billing SET credit_minutes = credit_minutes + $2
       WHERE user_id = $1`,
      [userId, FREE_SIGNUP_MINUTES],
    );
  });
}

// Reserve (charge) minutes for a job. Idempotent per job via jobs.minutes_charged.
// Returns { ok, available, already? }. ok=false → insufficient minutes.
async function reserveMinutesForJob(jobId, userId, minutes) {
  await ensureUserBilling(userId);
  return withTransaction(async (client) => {
    const jobRes = await client.query(
      "SELECT minutes_charged FROM jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    if (jobRes.rows.length === 0) {
      return { ok: false, available: 0, reason: "job_not_found" };
    }
    if (jobRes.rows[0].minutes_charged > 0) {
      return { ok: true, already: true }; // retry — already charged
    }

    const bRes = await client.query(
      `SELECT plan_minutes_included, plan_minutes_used, credit_minutes
       FROM user_billing WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const b = bRes.rows[0];
    const planRemaining = Math.max(
      0,
      b.plan_minutes_included - b.plan_minutes_used,
    );
    const available = planRemaining + b.credit_minutes;
    if (available < minutes) {
      return { ok: false, available };
    }

    const fromPlan = Math.min(planRemaining, minutes);
    const fromCredit = minutes - fromPlan;
    await client.query(
      `UPDATE user_billing
       SET plan_minutes_used = plan_minutes_used + $2,
           credit_minutes = credit_minutes - $3
       WHERE user_id = $1`,
      [userId, fromPlan, fromCredit],
    );
    await client.query("UPDATE jobs SET minutes_charged = $2 WHERE id = $1", [
      jobId,
      minutes,
    ]);
    await client.query(
      `INSERT INTO usage_ledger (user_id, job_id, minutes, kind)
       VALUES ($1, $2, $3, 'job')`,
      [userId, jobId, minutes],
    );
    return { ok: true, available: available - minutes };
  });
}

// Refund a job's reserved minutes (on failure). Idempotent.
async function refundJobMinutes(jobId) {
  return withTransaction(async (client) => {
    const jobRes = await client.query(
      "SELECT user_id, minutes_charged FROM jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    if (jobRes.rows.length === 0) return;
    const { user_id, minutes_charged } = jobRes.rows[0];
    if (!minutes_charged || minutes_charged <= 0) return;

    const bRes = await client.query(
      "SELECT plan_minutes_used FROM user_billing WHERE user_id = $1 FOR UPDATE",
      [user_id],
    );
    const used = bRes.rows[0]?.plan_minutes_used ?? 0;
    const backToPlan = Math.min(used, minutes_charged);
    const backToCredit = minutes_charged - backToPlan;
    await client.query(
      `UPDATE user_billing
       SET plan_minutes_used = plan_minutes_used - $2,
           credit_minutes = credit_minutes + $3
       WHERE user_id = $1`,
      [user_id, backToPlan, backToCredit],
    );
    await client.query("UPDATE jobs SET minutes_charged = 0 WHERE id = $1", [
      jobId,
    ]);
    await client.query(
      `INSERT INTO usage_ledger (user_id, job_id, minutes, kind)
       VALUES ($1, $2, $3, 'refund')`,
      [user_id, jobId, -minutes_charged],
    );
  });
}

// Set/refresh the user's plan allowance (new subscription). Resets usage.
async function applySubscription(userId, { plan, periodStart, periodEnd }) {
  await ensureUserBilling(userId);
  const included = PLAN_MINUTES[plan] ?? 0;
  await withTransaction(async (client) => {
    await client.query(
      "SELECT 1 FROM user_billing WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    await client.query(
      `UPDATE user_billing
       SET plan = $2, plan_minutes_included = $3, plan_minutes_used = 0,
           period_start = $4, period_end = $5
       WHERE user_id = $1`,
      [userId, plan, included, periodStart || null, periodEnd || null],
    );
    await client.query("UPDATE users SET plan = $2 WHERE id = $1", [
      userId,
      plan,
    ]);
  });
}

// Renewal — reset this period's usage and roll the window forward.
async function renewSubscription(userId, { periodStart, periodEnd }) {
  await ensureUserBilling(userId);
  await query(
    `UPDATE user_billing
     SET plan_minutes_used = 0, period_start = $2, period_end = $3
     WHERE user_id = $1`,
    [userId, periodStart || null, periodEnd || null],
  );
}

// Add non-expiring credit minutes (PAYG top-up). Records a transaction.
async function addCreditMinutes(userId, minutes, txn = {}) {
  if (!minutes || minutes <= 0) return;
  await ensureUserBilling(userId);
  await withTransaction(async (client) => {
    await client.query(
      "SELECT 1 FROM user_billing WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    await client.query(
      "UPDATE user_billing SET credit_minutes = credit_minutes + $2 WHERE user_id = $1",
      [userId, minutes],
    );
    await client.query(
      `INSERT INTO billing_transactions
         (user_id, type, ls_event_id, minutes_delta, amount_cents, currency, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        userId,
        txn.type || "payg_topup",
        txn.eventId || null,
        minutes,
        txn.amountCents || null,
        txn.currency || null,
        JSON.stringify(txn.meta || {}),
      ],
    );
  });
}

// Subscription ended/expired → back to free. Keeps credit_minutes.
async function downgradeToFree(userId) {
  await ensureUserBilling(userId);
  await withTransaction(async (client) => {
    await client.query(
      "SELECT 1 FROM user_billing WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    await client.query(
      `UPDATE user_billing
       SET plan = 'free', plan_minutes_included = 0, plan_minutes_used = 0
       WHERE user_id = $1`,
      [userId],
    );
    await client.query("UPDATE users SET plan = 'free' WHERE id = $1", [userId]);
  });
}

async function setAutomationAddon(userId, enabled) {
  await ensureUserBilling(userId);
  await query(
    "UPDATE user_billing SET automation_addon = $2 WHERE user_id = $1",
    [userId, !!enabled],
  );
}

// Insert/update the Lemon Squeezy subscription record.
async function upsertSubscription(userId, sub) {
  await query(
    `INSERT INTO subscriptions (
       user_id, ls_subscription_id, ls_customer_id, ls_order_id, ls_variant_id,
       plan, billing_cycle, status, current_period_start, current_period_end,
       renews_at, ends_at, customer_portal_url, update_payment_url
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (ls_subscription_id) DO UPDATE SET
       ls_customer_id = EXCLUDED.ls_customer_id,
       ls_order_id = EXCLUDED.ls_order_id,
       ls_variant_id = EXCLUDED.ls_variant_id,
       plan = EXCLUDED.plan,
       billing_cycle = EXCLUDED.billing_cycle,
       status = EXCLUDED.status,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       renews_at = EXCLUDED.renews_at,
       ends_at = EXCLUDED.ends_at,
       customer_portal_url = EXCLUDED.customer_portal_url,
       update_payment_url = EXCLUDED.update_payment_url`,
    [
      userId,
      sub.lsSubscriptionId,
      sub.lsCustomerId || null,
      sub.lsOrderId || null,
      sub.lsVariantId || null,
      sub.plan || null,
      sub.cycle || null,
      sub.status || null,
      sub.periodStart || null,
      sub.periodEnd || null,
      sub.renewsAt || null,
      sub.endsAt || null,
      sub.customerPortalUrl || null,
      sub.updatePaymentUrl || null,
    ],
  );
}

module.exports = {
  ensureUserBilling,
  getAvailableMinutes,
  getSummary,
  grantSignupMinutes,
  reserveMinutesForJob,
  refundJobMinutes,
  applySubscription,
  renewSubscription,
  addCreditMinutes,
  downgradeToFree,
  setAutomationAddon,
  upsertSubscription,
};
