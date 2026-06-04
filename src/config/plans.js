/* eslint-disable no-undef */
// ──────────────────────────────────────────────────────────────
// Billing configuration — single source of truth for plans, the
// free grant, pay-as-you-go packs, and the Lemon Squeezy variant map.
// Only env values change between environments; the numbers below
// match the marketing pricing in clipzen-website-new / clipzen-portal.
// ──────────────────────────────────────────────────────────────

// Monthly minute allowance per plan (resets each billing period).
const PLAN_MINUTES = {
  free: 0,
  starter: 140,
  pro: 400,
  advanced: 1000,
};

// One-time free minutes granted to every new account.
const FREE_SIGNUP_MINUTES = Number.parseInt(
  process.env.FREE_SIGNUP_MINUTES || "20",
  10,
);

// Pay-as-you-go credit packs → minutes added (non-expiring).
const PAYG_PACKS = {
  small: Number.parseInt(process.env.PAYG_MINUTES_SMALL || "100", 10),
  medium: Number.parseInt(process.env.PAYG_MINUTES_MEDIUM || "300", 10),
  large: Number.parseInt(process.env.PAYG_MINUTES_LARGE || "600", 10),
};

const VALID_PLANS = ["starter", "pro", "advanced"];
const VALID_CYCLES = ["monthly", "yearly"];

// Resolve the configured Lemon Squeezy variant id for a plan + cycle.
function variantForPlan(plan, cycle) {
  const key = `LS_VARIANT_${String(plan).toUpperCase()}_${String(cycle).toUpperCase()}`;
  return process.env[key] || null;
}

function variantForPayg(pack) {
  const key = `LS_VARIANT_PAYG_${String(pack).toUpperCase()}`;
  return process.env[key] || null;
}

function automationVariant() {
  return process.env.LS_VARIANT_AUTOMATION_ADDON || null;
}

// Reverse lookup used by the webhook: variant id → what it represents.
// Returns one of:
//   { type: 'plan', plan, cycle }
//   { type: 'payg', pack, minutes }
//   { type: 'addon' }
//   null (unknown variant)
function describeVariant(variantId) {
  if (!variantId) return null;
  const id = String(variantId);

  for (const plan of VALID_PLANS) {
    for (const cycle of VALID_CYCLES) {
      if (variantForPlan(plan, cycle) === id) {
        return { type: "plan", plan, cycle };
      }
    }
  }
  for (const pack of Object.keys(PAYG_PACKS)) {
    if (variantForPayg(pack) === id) {
      return { type: "payg", pack, minutes: PAYG_PACKS[pack] };
    }
  }
  if (automationVariant() === id) {
    return { type: "addon" };
  }
  return null;
}

module.exports = {
  PLAN_MINUTES,
  FREE_SIGNUP_MINUTES,
  PAYG_PACKS,
  VALID_PLANS,
  VALID_CYCLES,
  variantForPlan,
  variantForPayg,
  automationVariant,
  describeVariant,
};
