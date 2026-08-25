const axios = require('axios');

const REVE_BASE_URL = 'https://www.mapareve.es/api/external/v1';
const RATE_LIMIT_PER_HOUR = 5;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRIES = 2;
const MIN_DELAY_MS = 60 * 60 * 1000; // 1 hour between rate limit resets

function resolveHttpClient(httpClientOption) {
  return httpClientOption && typeof httpClientOption.get === 'function' ? httpClientOption : axios;
}

function resolveLogger(loggerOption) {
  return loggerOption && typeof loggerOption.info === 'function' ? loggerOption : console;
}

class ReveRateLimiter {
  constructor(maxRequests = RATE_LIMIT_PER_HOUR) {
    this.maxRequests = maxRequests;
    this.windowStart = Date.now();
    this.count = 0;
  }

  async waitForSlot() {
    const now = Date.now();
    if (now - this.windowStart >= MIN_DELAY_MS) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.maxRequests) {
      const waitMs = MIN_DELAY_MS - (now - this.windowStart) + 1000;
      throw new Error(
        `Reve rate limit reached (${this.maxRequests} req/h). Retry after ${Math.ceil(waitMs / 60000)} min.`,
      );
    }
    this.count += 1;
  }

  reset() {
    this.windowStart = Date.now();
    this.count = 0;
  }
}

function buildHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
    Accept: 'application/json',
  };
}

async function fetchPage(httpClient, url, params, headers, timeout, retries, logger) {
  let attempt = 0;
  let delay = 1000;

  for (;;) {
    try {
      const response = await httpClient.get(url, {
        params,
        headers,
        timeout,
      });
      return {
        data: response.data,
        totalCount: Number(response.headers?.['total-count']) || undefined,
        totalPages: Number(response.headers?.['total-pages']) || undefined,
      };
    } catch (error) {
      const status = error?.response?.status;
      if (status === 429) {
        if (attempt === retries) {
          throw new Error('Reve API rate limit exceeded (HTTP 429) after retries');
        }
        attempt += 1;
        logger.warn(`Reve API 429 on attempt ${attempt}, waiting ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      throw error;
    }
  }
}

async function* paginate(httpClient, endpoint, apiKey, options = {}) {
  const {
    pageSize = DEFAULT_PAGE_SIZE,
    timeout = DEFAULT_TIMEOUT,
    retries = DEFAULT_RETRIES,
    logger = console,
    dateFrom,
    rateLimiter,
    extraParams = {},
  } = options;

  const url = `${REVE_BASE_URL}${endpoint}`;
  const headers = buildHeaders(apiKey);
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    if (rateLimiter) {
      await rateLimiter.waitForSlot();
    }

    const params = { page, limit: pageSize, ...extraParams };
    if (dateFrom) {
      params.date_from = dateFrom;
    }

    const result = await fetchPage(httpClient, url, params, headers, timeout, retries, logger);

    if (result.totalPages) {
      totalPages = result.totalPages;
    }

    if (!result.data || (Array.isArray(result.data) && result.data.length === 0)) {
      break;
    }

    yield result.data;

    page += 1;
  }
}

async function fetchAllLocations(httpClient, apiKey, options = {}) {
  const results = [];
  for await (const pageData of paginate(httpClient, '/locations', apiKey, options)) {
    results.push(...pageData);
  }
  return results;
}

async function fetchAllOperationalStatus(httpClient, apiKey, options = {}) {
  const results = [];
  for await (const pageData of paginate(httpClient, '/evses/operational_status', apiKey, options)) {
    results.push(...pageData);
  }
  return results;
}

async function fetchAllTariffs(httpClient, apiKey, options = {}) {
  const results = [];
  for await (const pageData of paginate(httpClient, '/connectors/tariffs', apiKey, options)) {
    results.push(...pageData);
  }
  return results;
}

async function fetchEvseStatus(httpClient, apiKey, evseId, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, retries = DEFAULT_RETRIES, logger = console } = options;
  const url = `${REVE_BASE_URL}/evses/${encodeURIComponent(evseId)}/status`;
  const headers = buildHeaders(apiKey);
  const result = await fetchPage(httpClient, url, {}, headers, timeout, retries, logger);
  return result.data;
}

function createReveClient(options = {}) {
  const apiKey = options.apiKey;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Reve API key is required. Get one at https://www.mapareve.es/api-contacto');
  }

  const httpClient = resolveHttpClient(options.httpClient);
  const logger = resolveLogger(options.logger);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const rateLimiter = new ReveRateLimiter(options.rateLimit ?? RATE_LIMIT_PER_HOUR);

  function buildOpts(overrides = {}) {
    return {
      httpClient,
      apiKey: apiKey.trim(),
      timeout,
      retries,
      logger,
      rateLimiter,
      ...overrides,
    };
  }

  return {
    async fetchLocations(opts = {}) {
      return fetchAllLocations(httpClient, apiKey.trim(), buildOpts(opts));
    },

    async fetchOperationalStatus(opts = {}) {
      return fetchAllOperationalStatus(httpClient, apiKey.trim(), buildOpts(opts));
    },

    async fetchTariffs(opts = {}) {
      return fetchAllTariffs(httpClient, apiKey.trim(), buildOpts(opts));
    },

    async fetchEvseStatus(evseId, opts = {}) {
      return fetchEvseStatus(httpClient, apiKey.trim(), evseId, buildOpts(opts));
    },

    async *streamLocations(opts = {}) {
      yield* paginate(httpClient, '/locations', apiKey.trim(), buildOpts(opts));
    },

    async *streamOperationalStatus(opts = {}) {
      yield* paginate(httpClient, '/evses/operational_status', apiKey.trim(), buildOpts(opts));
    },

    async *streamTariffs(opts = {}) {
      yield* paginate(httpClient, '/connectors/tariffs', apiKey.trim(), buildOpts(opts));
    },
  };
}

module.exports = {
  createReveClient,
  ReveRateLimiter,
  REVE_BASE_URL,
  RATE_LIMIT_PER_HOUR,
};
