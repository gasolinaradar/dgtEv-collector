const axios = require('axios');

const REVE_PUBLIC_BASE_URL = 'https://www.mapareve.es/api/public/v1';
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRIES = 3;
const DEFAULT_PAGE_SIZE = 25;
const SPAIN_BBOX = { latitude_ne: 44, longitude_ne: 4.5, latitude_sw: 27, longitude_sw: -18.5 };
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_REQUEST_DELAY_MS = 150;

function resolveHttpClient(httpClientOption) {
  const looksLikeHttpClient =
    httpClientOption &&
    (typeof httpClientOption.get === 'function' || typeof httpClientOption.post === 'function');
  return looksLikeHttpClient ? httpClientOption : axios;
}

function resolveLogger(loggerOption) {
  return loggerOption && typeof loggerOption.info === 'function' ? loggerOption : console;
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BASE_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

async function request(httpClient, method, endpoint, { params, data } = {}, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, retries = DEFAULT_RETRIES, logger = console } = opts;
  const url = `${REVE_PUBLIC_BASE_URL}${endpoint}`;
  let attempt = 0;
  let delay = 1000;

  for (;;) {
    try {
      const config = { params, headers: BASE_HEADERS, timeout };
      const response =
        method === 'post' ? await httpClient.post(url, data, config) : await httpClient.get(url, config);
      return response.data;
    } catch (error) {
      const status = error?.response?.status;
      const isRetryable = !error.response || status === 429 || (status >= 500 && status < 600);
      if (isRetryable && attempt < retries) {
        attempt += 1;
        const reason = status ? `HTTP ${status}` : error.code || 'network error';
        logger.warn(`Reve public API request failed (${reason}), retry ${attempt}/${retries} in ${delay / 1000}s`, {
          endpoint,
          status,
          message: error.message,
        });
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw error;
    }
  }
}

function unwrapPaginated(body) {
  if (Array.isArray(body)) {
    return { data: body, pagination: null };
  }
  return { data: Array.isArray(body?.data) ? body.data : [], pagination: body?.pagination || null };
}

async function* streamLocationPages(httpClient, opts = {}) {
  const {
    perPage = DEFAULT_PAGE_SIZE,
    filters = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
    maxPages = DEFAULT_MAX_PAGES,
    startPage = 1,
    logger = console,
    maxConsecutivePageFailures = 3,
    ...rest
  } = opts;

  let page = startPage;
  let totalPages = null;
  let pagesFetched = 0;
  let consecutiveFailures = 0;

  for (;;) {
    if (totalPages !== null && page > totalPages) break;
    if (pagesFetched >= maxPages) {
      logger.warn(
        `Reve public API: stopped at maxPages (${maxPages}) — dataset is partial. ` +
          `Raise options.maxPages if you deliberately want more (each extra page is one request).`,
      );
      break;
    }
    if (pagesFetched > 0) await sleep(requestDelayMs);

    logger.info(`Requesting Reve public locations page ${page}`, { page, perPage });
    const requestStart = Date.now();

    let body;
    try {
      body = await request(
        httpClient,
        'post',
        '/locations',
        { data: { ...SPAIN_BBOX, ...filters }, params: { page, per_page: perPage } },
        { logger, ...rest },
      );
    } catch (error) {
      consecutiveFailures += 1;
      logger.warn(`Failed to fetch Reve public locations page ${page} after retries — skipping it`, {
        page,
        consecutiveFailures,
        error: error.message,
        status: error.response?.status,
        responseBody: error.response?.data,
      });
      if (consecutiveFailures >= maxConsecutivePageFailures) {
        logger.warn(
          `Reve public API: ${consecutiveFailures} consecutive page failures — stopping sweep early`,
          { lastAttemptedPage: page },
        );
        break;
      }
      page += 1;
      continue;
    }
    consecutiveFailures = 0;

    const { data, pagination } = unwrapPaginated(body);
    pagesFetched += 1;

    if (pagination?.total_pages) {
      totalPages = pagination.total_pages;
    } else if (data.length < perPage) {
      totalPages = page;
    }

    logger.info(`Received Reve public locations page ${page}`, {
      page,
      count: data.length,
      ms: Date.now() - requestStart,
      totalPages,
      totalCount: pagination?.total_count,
    });

    if (data.length === 0) break;
    yield { data, page, totalPages };
    page += 1;
  }
}

function createRevePublicClient(options = {}) {
  if (options.acknowledgeUnsupported !== true) {
    throw new Error(
      'createRevePublicClient talks to an undocumented, unsupported Reve endpoint ' +
        '(/api/public/v1). Pass { acknowledgeUnsupported: true } to confirm you understand ' +
        'it can change or break without notice. Prefer createReveClient (/api/external/v1) ' +
        'for anything that needs to keep working.',
    );
  }

  const httpClient = resolveHttpClient(options.httpClient);
  const logger = resolveLogger(options.logger);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const retries = options.retries ?? DEFAULT_RETRIES;

  function buildOpts(overrides = {}) {
    return { timeout, retries, logger, ...overrides };
  }

  return {
    async fetchLocation(id, opts = {}) {
      return request(httpClient, 'get', `/locations/${encodeURIComponent(id)}`, {}, buildOpts(opts));
    },

    async fetchLocationsPage({ page = 1, perPage = DEFAULT_PAGE_SIZE, filters = {} } = {}, opts = {}) {
      const body = await request(
        httpClient,
        'post',
        '/locations',
        { data: { ...SPAIN_BBOX, ...filters }, params: { page, per_page: perPage } },
        buildOpts(opts),
      );
      return unwrapPaginated(body);
    },

    async *streamLocations(opts = {}) {
      for await (const { data } of streamLocationPages(httpClient, buildOpts(opts))) {
        yield data;
      }
    },

    async fetchAllLocations(opts = {}) {
      const results = [];
      for await (const { data } of streamLocationPages(httpClient, buildOpts(opts))) {
        results.push(...data);
      }
      return results;
    },

    async fetchLocationsSweep(opts = {}) {
      const built = buildOpts(opts);
      const startPage = built.startPage ?? 1;
      const locations = [];
      let lastPage = null;
      let totalPages = null;

      for await (const pageResult of streamLocationPages(httpClient, built)) {
        locations.push(...pageResult.data);
        lastPage = pageResult.page;
        totalPages = pageResult.totalPages;
      }

      if (lastPage === null) {
        return { locations, totalPages, nextPage: startPage, completedSweep: false };
      }

      const reachedEnd = totalPages !== null && lastPage >= totalPages;
      return {
        locations,
        totalPages,
        nextPage: reachedEnd ? 1 : lastPage + 1,
        completedSweep: reachedEnd,
      };
    },

    async fetchMarkers(
      { latitudeNe, longitudeNe, latitudeSw, longitudeSw, zoom, filters = {} } = {},
      opts = {},
    ) {
      const data = {
        latitude_ne: latitudeNe,
        longitude_ne: longitudeNe,
        latitude_sw: latitudeSw,
        longitude_sw: longitudeSw,
        zoom,
        ...filters,
      };
      return request(httpClient, 'post', '/markers', { data }, buildOpts(opts));
    },

    async fetchCpos({ page = 1, perPage = 500 } = {}, opts = {}) {
      const body = await request(
        httpClient,
        'get',
        '/cpos',
        { params: { page, per_page: perPage } },
        buildOpts(opts),
      );
      return unwrapPaginated(body);
    },

    async fetchConnectorTypes(opts = {}) {
      return request(httpClient, 'get', '/connector_types', {}, buildOpts(opts));
    },

    async fetchFacilities(opts = {}) {
      return request(httpClient, 'get', '/facilities', {}, buildOpts(opts));
    },

    async fetchPaymentMethods(opts = {}) {
      return request(httpClient, 'get', '/payment_methods', {}, buildOpts(opts));
    },
  };
}

module.exports = {
  createRevePublicClient,
  REVE_PUBLIC_BASE_URL,
  SPAIN_BBOX,
  DEFAULT_MAX_PAGES,
};
