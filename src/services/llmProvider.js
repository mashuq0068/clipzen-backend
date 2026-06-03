/**
 * llmProvider.js
 *
 * Unified LLM abstraction layer.
 * Switch providers entirely via .env — zero code changes needed.
 *
 * .env examples:
 *
 *   # Local Ollama:
 *   MODEL_PROVIDER=ollama
 *   MODEL_NAME=llama3.2:3b
 *   OLLAMA_BASE_URL=http://localhost:11434
 *
 *   # OpenRouter (any cloud model):
 *   MODEL_PROVIDER=openrouter
 *   MODEL_NAME=nousresearch/hermes-3-llama-3.1-405b:free
 *   OPENROUTER_API_KEY=sk-or-...
 *
 *   # Groq (fast, free tier — OpenAI-compatible):
 *   MODEL_PROVIDER=groq
 *   MODEL_NAME=llama-3.3-70b-versatile
 *   GROQ_API_KEY=gsk_...
 *
 * Usage:
 *   const { llm, isLLMAvailable } = require("./llmProvider");
 *   const text = await llm({ prompt: "...", maxTokens: 100 });
 */

const axios = require("axios");

// ─────────────────────────────────────────────────────────────
// CONFIG — read from .env once at startup
// ─────────────────────────────────────────────────────────────
const PROVIDER   = (process.env.MODEL_PROVIDER || "ollama").toLowerCase().trim();

// Per-provider model override → falls back to the shared MODEL_NAME.
// This lets you switch providers by changing ONLY MODEL_PROVIDER, without
// having to also edit MODEL_NAME every time.
const MODEL_BY_PROVIDER = {
  ollama:     process.env.OLLAMA_MODEL,
  openrouter: process.env.OPENROUTER_MODEL,
  groq:       process.env.GROQ_MODEL,
};
const MODEL_NAME =
  MODEL_BY_PROVIDER[PROVIDER] ||
  process.env.MODEL_NAME ||
  process.env.OLLAMA_MODEL ||
  "llama3.2:3b";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OR_KEY     = process.env.OPENROUTER_API_KEY || "";
const OR_URL     = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

// Groq — OpenAI-compatible API. Free tier is fast and generous (Llama 3.3 70B etc).
const GROQ_KEY   = process.env.GROQ_API_KEY || "";
const GROQ_URL   = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";

console.log(`[llmProvider] provider=${PROVIDER} model=${MODEL_NAME}`);

// ─────────────────────────────────────────────────────────────
// AVAILABILITY CACHE — preflight, refreshes every 60s
// ─────────────────────────────────────────────────────────────
let _avail = null;
let _lastCheck = 0;

async function isLLMAvailable() {
  const now = Date.now();
  if (_avail !== null && now - _lastCheck < 60_000) return _avail;
  try {
    if (PROVIDER === "groq") {
      if (!GROQ_KEY) { _avail = false; _lastCheck = now; return false; }
      await axios.get(`${GROQ_URL}/models`, {
        headers: { Authorization: `Bearer ${GROQ_KEY}` }, timeout: 5000,
      });
    } else if (PROVIDER === "openrouter") {
      if (!OR_KEY) { _avail = false; _lastCheck = now; return false; }
      await axios.get(`${OR_URL}/models`, {
        headers: { Authorization: `Bearer ${OR_KEY}` }, timeout: 5000,
      });
    } else {
      await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 4000 });
    }
    _avail = true;
  } catch {
    _avail = false;
  }
  _lastCheck = now;
  if (!_avail) console.warn(`[llmProvider] ${PROVIDER} not reachable`);
  return _avail;
}

// ─────────────────────────────────────────────────────────────
// OLLAMA PROVIDER
// ─────────────────────────────────────────────────────────────
async function callOllama({ prompt, maxTokens = 300, temperature = 0.2 }) {
  const res = await axios.post(
    `${OLLAMA_URL}/api/generate`,
    {
      model: MODEL_NAME,
      prompt,
      stream: false,
      options: { temperature, num_predict: maxTokens },
    },
    { timeout: 90_000 },
  );
  const text = res.data?.response?.trim();
  if (!text || text.length < 2) throw new Error("Ollama empty response");
  return text;
}

// ─────────────────────────────────────────────────────────────
// OPENROUTER PROVIDER
// OpenAI-compatible /chat/completions — works with any model on OpenRouter
// ─────────────────────────────────────────────────────────────
async function callOpenRouter({ prompt, maxTokens = 300, temperature = 0.2 }) {
  if (!OR_KEY) throw new Error("OPENROUTER_API_KEY not set in .env");
  const res = await axios.post(
    `${OR_URL}/chat/completions`,
    {
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
    },
    {
      headers: {
        Authorization: `Bearer ${OR_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://clipzen-hazel.vercel.app",
        "X-Title": "Clipzen",
      },
      timeout: 60_000,
    },
  );
  const text = res.data?.choices?.[0]?.message?.content?.trim();
  if (!text || text.length < 2) throw new Error("OpenRouter empty response");
  return text;
}

// ─────────────────────────────────────────────────────────────
// GROQ PROVIDER
// OpenAI-compatible /chat/completions. Free tier is fast and generous.
// MODEL_NAME e.g. "llama-3.3-70b-versatile".
// ─────────────────────────────────────────────────────────────
async function callGroq({ prompt, maxTokens = 300, temperature = 0.2 }) {
  if (!GROQ_KEY) throw new Error("GROQ_API_KEY not set in .env");
  const res = await axios.post(
    `${GROQ_URL}/chat/completions`,
    {
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 60_000,
    },
  );
  const text = res.data?.choices?.[0]?.message?.content?.trim();
  if (!text || text.length < 2) throw new Error("Groq empty response");
  return text;
}

// ─────────────────────────────────────────────────────────────
// MAIN INTERFACE
// ─────────────────────────────────────────────────────────────
async function llm(options) {
  if (PROVIDER === "groq")       return callGroq(options);
  if (PROVIDER === "openrouter") return callOpenRouter(options);
  return callOllama(options);
}

// ─────────────────────────────────────────────────────────────
// RETRY WRAPPER
// ─────────────────────────────────────────────────────────────
async function llmWithRetry(options, retries = 2, delayMs = 2500) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await llm(options); }
    catch (err) {
      lastErr = err;
      if (i < retries) {
        console.warn(`[llmProvider] retry ${i + 1}/${retries}: ${err?.message?.split("\n")[0]}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

module.exports = { llm, llmWithRetry, isLLMAvailable, PROVIDER, MODEL_NAME };