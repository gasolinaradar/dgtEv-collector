// EXPERIMENTAL / UNSUPPORTED.
//
// This client talks to `https://www.mapareve.es/api/public/v1`, the internal API the
// mapareve.es map itself uses in the browser — NOT the documented `/api/external/v1`
// (see src/reve.js). It was reverse-engineered from the site's public JS bundle and a
// handful of manual requests; it requires no API key and no documented rate limit was
// observed, but:
//
//   - It is not published or supported by Red Eléctrica in any way.
//   - It can change or disappear without notice.
//   - Automated use outside a browser may fall outside the site's terms of use.
//
// Prefer `src/reve.js` (`/api/external/v1`) for anything that needs to keep working.
// This module exists so the library can be evaluated against it in tests, not as a
// recommended integration path — hence the explicit `acknowledgeUnsupported` gate below.

const axios = require('axios');

const REVE_PUBLIC_BASE_URL = 'https://www.mapareve.es/api/public/v1';
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRIES = 2;
const DEFAULT_PAGE_SIZE = 50;
// No documented rate limit exists for this endpoint. This delay between paginated
// requests is a self-imposed courtesy throttle, not a requirement from Reve.
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
      // Only 429 is retried. A 403 here most likely means the Incapsula WAF challenged
      // the request — retrying/evading that automatically is out of scope for this client.
      if (status === 429 && attempt < retries) {
        attempt += 1;
        logger.warn(`Reve public API 429 on attempt ${attempt}, waiting ${delay / 1000}s`);
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

async function* streamLocations(httpClient, opts = {}) {
  const {
    perPage = DEFAULT_PAGE_SIZE,
    filters = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
    ...rest
  } = opts;

  let page = 1;
  let totalPages = 1;

  for (;;) {
    if (page > totalPages) break;
    if (page > 1) await sleep(requestDelayMs);

    const body = await request(
      httpClient,
      'post',
      '/locations',
      { data: filters, params: { page, per_page: perPage } },
      rest,
    );
    const { data, pagination } = unwrapPaginated(body);

    if (pagination?.total_pages) {
      totalPages = pagination.total_pages;
    } else if (data.length < perPage) {
      totalPages = page;
    }

    if (data.length === 0) break;
    yield data;
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
        { data: filters, params: { page, per_page: perPage } },
        buildOpts(opts),
      );
      return unwrapPaginated(body);
    },

    async *streamLocations(opts = {}) {
      yield* streamLocations(httpClient, buildOpts(opts));
    },

    async fetchAllLocations(opts = {}) {
      const results = [];
      for await (const page of streamLocations(httpClient, buildOpts(opts))) {
        results.push(...page);
      }
      return results;
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
};
