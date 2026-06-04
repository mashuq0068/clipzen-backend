/* eslint-disable no-undef */
// ──────────────────────────────────────────────────────────────
// Lemon Squeezy integration — hosted checkout creation + webhook
// handling. Owner only sets LEMONSQUEEZY_* + LS_VARIANT_* in .env.
// ──────────────────────────────────────────────────────────────
const crypto = require("crypto");
const axios = require("axios");
const { query } = require("../db/pool");
const {
  variantForPlan,
  variantForPayg,
  describeVariant,
} = require("../config/plans");
const billing = require("./billing");

const LS_API = "https://api.lemonsqueezy.com/v1";

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function frontendUrl() {
  return process.env.FRONTEND_URL || "http://localhost:8080";
}

async function createCheckoutForVariant({ variantId, userId, email }) {
  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  const storeId = process.env.LEMONSQUEEZY_STORE_ID;
  if (!apiKey || !storeId) {
    throw httpErr(500, "Billing is not configured on this server.");
  }
  if (!variantId) {
    throw httpErr(400, "No Lemon Squeezy variant configured for that option.");
  }

  const body = {
    data: {
      type: "checkouts",
      attributes: {
        checkout_data: {
          // Forwarded into webhook payload at meta.custom_data → maps to our user.
          custom: { user_id: String(userId) },
          ...(email ? { email } : {}),
        },
        product_options: {
          redirect_url: `${frontendUrl()}/billing?checkout=success`,
        },
      },
      relationships: {
        store: { data: { type: "stores", id: String(storeId) } },
        variant: { data: { type: "variants", id: String(variantId) } },
      },
    },
  };

  const { data } = await axios.post(`${LS_API}/checkouts`, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
    },
  });

  const url = data?.data?.attributes?.url;
  if (!url) throw httpErr(502, "Lemon Squeezy did not return a checkout URL.");
  return url;
}

async function createPlanCheckout({ userId, plan, cycle, email }) {
  return createCheckoutForVariant({
    variantId: variantForPlan(plan, cycle),
    userId,
    email,
  });
}

async function createPaygCheckout({ userId, pack, email }) {
  return createCheckoutForVariant({
    variantId: variantForPayg(pack),
    userId,
    email,
  });
}

// HMAC-SHA256 signature check (same approach as the Zernio webhook).
function verifyWebhook(rawBody, signature) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) return true; // not configured → skip (dev)
  if (!signature) return false;
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(digest, "hex");
  const b = Buffer.from(String(signature), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function resolveUserId(payload, attrs, eventName) {
  let userId = payload?.meta?.custom_data?.user_id || null;
  if (!userId) {
    const subId =
      attrs.subscription_id ||
      (eventName.startsWith("subscription_") ? payload?.data?.id : null);
    if (subId) {
      const r = await query(
        "SELECT user_id FROM subscriptions WHERE ls_subscription_id = $1 LIMIT 1",
        [String(subId)],
      );
      userId = r.rows[0]?.user_id || null;
    }
  }
  if (!userId && attrs.customer_id) {
    const r = await query(
      `SELECT user_id FROM subscriptions WHERE ls_customer_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [String(attrs.customer_id)],
    );
    userId = r.rows[0]?.user_id || null;
  }
  return userId;
}

// Process one webhook event. Idempotent via lemon_webhook_events.
async function handleLemonWebhook(payload) {
  const eventName = payload?.meta?.event_name;
  const data = payload?.data;
  const attrs = data?.attributes || {};
  if (!eventName || !data) return { ignored: true };

  const eventId = `${eventName}:${data.id}:${attrs.updated_at || attrs.created_at || ""}`;

  // Dedupe: first writer wins.
  const claim = await query(
    `INSERT INTO lemon_webhook_events (event_id, event_name, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, eventName, JSON.stringify(payload)],
  );
  if (claim.rows.length === 0) return { duplicate: true };

  const userId = await resolveUserId(payload, attrs, eventName);
  if (!userId) {
    console.warn(`LS webhook ${eventName}: could not resolve user`);
    await query(
      "UPDATE lemon_webhook_events SET processed_at = NOW() WHERE event_id = $1",
      [eventId],
    );
    return { ok: true, noUser: true };
  }

  try {
    switch (eventName) {
      case "subscription_created":
      case "subscription_updated": {
        const v = describeVariant(String(attrs.variant_id));
        if (v?.type === "plan") {
          await billing.upsertSubscription(userId, {
            lsSubscriptionId: String(data.id),
            lsCustomerId: attrs.customer_id ? String(attrs.customer_id) : null,
            lsOrderId: attrs.order_id ? String(attrs.order_id) : null,
            lsVariantId: String(attrs.variant_id),
            plan: v.plan,
            cycle: v.cycle,
            status: attrs.status,
            periodStart: attrs.created_at,
            periodEnd: attrs.renews_at,
            renewsAt: attrs.renews_at,
            endsAt: attrs.ends_at,
            customerPortalUrl: attrs.urls?.customer_portal,
            updatePaymentUrl: attrs.urls?.update_payment_method,
          });
          if (["active", "on_trial", "past_due"].includes(attrs.status)) {
            await billing.applySubscription(userId, {
              plan: v.plan,
              periodStart: attrs.created_at,
              periodEnd: attrs.renews_at,
            });
          } else if (attrs.status === "expired") {
            await billing.downgradeToFree(userId);
          }
        }
        break;
      }

      case "subscription_payment_success": {
        // Renewal payment → reset the period's usage. (Initial payment is
        // already handled by subscription_created.)
        if (attrs.billing_reason === "renewal") {
          await billing.renewSubscription(userId, {
            periodStart: attrs.created_at,
            periodEnd: null,
          });
        }
        break;
      }

      case "subscription_cancelled": {
        // Still active until ends_at; subscription_expired does the downgrade.
        await query(
          `UPDATE subscriptions SET status = 'cancelled', ends_at = $2
           WHERE ls_subscription_id = $1`,
          [String(data.id), attrs.ends_at || null],
        );
        break;
      }

      case "subscription_expired": {
        await query(
          "UPDATE subscriptions SET status = 'expired' WHERE ls_subscription_id = $1",
          [String(data.id)],
        );
        await billing.downgradeToFree(userId);
        break;
      }

      case "subscription_paused": {
        await query(
          "UPDATE subscriptions SET status = 'paused' WHERE ls_subscription_id = $1",
          [String(data.id)],
        );
        break;
      }

      case "order_created": {
        // One-time purchases: PAYG credit packs or the automation add-on.
        // (Subscription orders also fire order_created; their variant maps to a
        // plan and is handled by subscription_created, so we ignore those here.)
        const variantId = attrs.first_order_item?.variant_id;
        const v = describeVariant(String(variantId));
        if (v?.type === "payg") {
          await billing.addCreditMinutes(userId, v.minutes, {
            type: "payg_topup",
            eventId,
            amountCents: attrs.total,
            currency: attrs.currency,
            meta: { order_id: data.id, pack: v.pack },
          });
        } else if (v?.type === "addon") {
          await billing.setAutomationAddon(userId, true);
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error(`LS webhook ${eventName} handling error:`, err.message);
    throw err; // leave processed_at null so a redelivery can retry
  }

  await query(
    "UPDATE lemon_webhook_events SET processed_at = NOW() WHERE event_id = $1",
    [eventId],
  );
  return { ok: true };
}

module.exports = {
  createPlanCheckout,
  createPaygCheckout,
  verifyWebhook,
  handleLemonWebhook,
};
