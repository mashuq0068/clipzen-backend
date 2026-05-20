/* eslint-disable no-undef */
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const ZERNIO_BASE_URL = process.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertApiKey() {
  if (!process.env.ZERNIO_API_KEY) {
    const error = new Error("ZERNIO_API_KEY is not configured");
    error.status = 503;
    throw error;
  }
}

function normalizeZernioError(error) {
  const status = error.response?.status || 500;
  const message =
    error.response?.data?.error ||
    error.response?.data?.message ||
    error.message ||
    "Zernio request failed";

  const normalized = new Error(message);
  normalized.status = status;
  normalized.details = error.response?.data?.details || error.response?.data || null;
  return normalized;
}

class ZernioProvider {
  constructor() {
    this.client = axios.create({
      baseURL: ZERNIO_BASE_URL,
      timeout: Number(process.env.ZERNIO_TIMEOUT_MS || 30000),
    });
  }

  async request(config, options = {}) {
    assertApiKey();

    const maxAttempts = options.attempts || 3;
    const requestId = options.requestId || uuidv4();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.client.request({
          ...config,
          headers: {
            Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
            "Content-Type": "application/json",
            "x-request-id": requestId,
            ...(config.headers || {}),
          },
        });
        return response.data;
      } catch (error) {
        const status = error.response?.status;
        const canRetry =
          attempt < maxAttempts &&
          (!status || RETRYABLE_STATUS.has(status));

        if (!canRetry) {
          throw normalizeZernioError(error);
        }

        const retryAfter = Number(error.response?.headers?.["retry-after"]);
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Math.min(2000 * 2 ** (attempt - 1), 10000);
        await sleep(delay);
      }
    }

    throw new Error("Zernio request failed after retries");
  }

  async createProfile({ name, description }) {
    return this.request({
      method: "POST",
      url: "/profiles",
      data: { name, description },
    });
  }

  async getConnectUrl({ platform, profileId, redirectUrl }) {
    const data = await this.request({
      method: "GET",
      url: `/connect/${platform}`,
      params: {
        profileId,
        redirect_url: redirectUrl,
      },
    });

    return data.authUrl || data.url;
  }

  async listAccounts({ profileId, platform }) {
    return this.request({
      method: "GET",
      url: "/accounts",
      params: {
        profileId,
        platform,
      },
    });
  }

  async disconnectAccount(accountId) {
    return this.request({
      method: "DELETE",
      url: `/accounts/${accountId}`,
    });
  }

  async createPost({ body, requestId }) {
    return this.request(
      {
        method: "POST",
        url: "/posts",
        data: body,
      },
      { attempts: 3, requestId },
    );
  }
}

module.exports = {
  ZernioProvider,
  zernioProvider: new ZernioProvider(),
};
