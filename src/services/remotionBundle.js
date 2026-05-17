// ─────────────────────────────────────────────────────────────
// remotionBundle.js
// Place this file at: clipzen-backend/src/services/remotionBundle.js
//
// Bundles the Remotion project ONCE when the worker starts.
// All clips share the same bundle — eliminates 15-30s cold
// start per clip. In production set REMOTION_SERVE_URL env
// var to point to a pre-deployed Lambda serve URL — zero
// other changes needed.
// ─────────────────────────────────────────────────────────────

const path = require("path");

const REMOTION_PROJECT = path.resolve(__dirname, "../../remotion-captions");

let bundlePromise = null;
let cachedBundleUrl = null;

async function getBundle() {
  // ── Production: use pre-deployed Lambda serve URL ──────────
  if (process.env.REMOTION_SERVE_URL) {
    return process.env.REMOTION_SERVE_URL;
  }

  // ── Local: return cached bundle if already built ───────────
  if (cachedBundleUrl) return cachedBundleUrl;

  // ── Local: if bundling is in progress, wait on same promise ─
  if (bundlePromise) return bundlePromise;

  // ── Local: bundle for the first time ──────────────────────
  const { bundle } = require("@remotion/bundler");

  console.log("   📦 Bundling Remotion project (first clip only)...");

  bundlePromise = bundle({
    entryPoint: path.join(REMOTION_PROJECT, "src", "Root.jsx"),
    // Pass through webpack config unchanged — keeps your
    // existing setup (fonts, SVGs, etc.) working perfectly
    webpackOverride: (config) => config,
  })
    .then((url) => {
      cachedBundleUrl = url;
      bundlePromise = null;
      console.log("   ✅ Remotion bundle ready — reusing for all clips");
      return url;
    })
    .catch((err) => {
      // Reset so next call can retry
      bundlePromise = null;
      throw err;
    });

  return bundlePromise;
}

/**
 * Call this at worker startup to warm the bundle before
 * the first job arrives. Errors are non-fatal — it will
 * re-attempt on first actual clip.
 */
async function warmBundle() {
  try {
    await getBundle();
  } catch (e) {
    console.warn("   ⚠️  Remotion bundle warm failed:", e.message);
  }
}

module.exports = { getBundle, warmBundle };