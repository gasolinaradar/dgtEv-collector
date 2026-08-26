const { test } = require('node:test');
const assert = require('node:assert');
const { createRevePublicClient, REVE_PUBLIC_BASE_URL, DEFAULT_MAX_PAGES } = require('../src/reve-public');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

test('createRevePublicClient throws without acknowledgeUnsupported', () => {
  assert.throws(() => createRevePublicClient(), /acknowledgeUnsupported/);
  assert.throws(() => createRevePublicClient({ acknowledgeUnsupported: false }), /acknowledgeUnsupported/);
});

test('createRevePublicClient returns client with all methods', () => {
  const client = createRevePublicClient({ acknowledgeUnsupported: true, logger: silentLogger });

  assert.equal(typeof client.fetchLocation, 'function');
  assert.equal(typeof client.fetchLocationsPage, 'function');
  assert.equal(typeof client.fetchAllLocations, 'function');
  assert.equal(typeof client.streamLocations, 'function');
  assert.equal(typeof client.fetchMarkers, 'function');
  assert.equal(typeof client.fetchCpos, 'function');
  assert.equal(typeof client.fetchConnectorTypes, 'function');
  assert.equal(typeof client.fetchFacilities, 'function');
  assert.equal(typeof client.fetchPaymentMethods, 'function');
});

test('fetchLocation calls GET /locations/{id} with no auth header', async () => {
  let capturedUrl;
  let capturedHeaders;
  const fakeHttpClient = {
    get: async (url, config) => {
      capturedUrl = url;
      capturedHeaders = config.headers;
      return { status: 200, data: { id: 'loc-1' } };
    },
    post: async () => {
      throw new Error('should not POST');
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const loc = await client.fetchLocation('loc-1');
  assert.equal(loc.id, 'loc-1');
  assert.equal(capturedUrl, `${REVE_PUBLIC_BASE_URL}/locations/loc-1`);
  assert.equal(capturedHeaders['x-api-key'], undefined);
});

test('fetchLocationsPage POSTs filters as body and page/per_page as params', async () => {
  let capturedData;
  let capturedParams;
  const fakeHttpClient = {
    post: async (url, data, config) => {
      capturedData = data;
      capturedParams = config.params;
      return { status: 200, data: { data: [{ id: 'loc-1' }], pagination: { page: 1, per_page: 10, total_pages: 1, total_count: 1 } } };
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const result = await client.fetchLocationsPage({ page: 2, perPage: 10, filters: { power_min: 43 } });
  assert.equal(capturedParams.page, 2);
  assert.equal(capturedParams.per_page, 10);
  assert.equal(capturedData.power_min, 43);
  assert.equal(result.data.length, 1);
  assert.equal(result.pagination.total_pages, 1);
});

test('fetchLocationsPage defaults to a full-Spain bbox — POST /locations 400s without one', async () => {
  let capturedData;
  const fakeHttpClient = {
    post: async (url, data) => {
      capturedData = data;
      return { status: 200, data: { data: [], pagination: { page: 1, per_page: 10, total_pages: 1, total_count: 0 } } };
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  await client.fetchLocationsPage();
  assert.equal(capturedData.latitude_ne, 44);
  assert.equal(capturedData.longitude_ne, 4.5);
  assert.equal(capturedData.latitude_sw, 27);
  assert.equal(capturedData.longitude_sw, -18.5);
});

test('fetchLocationsPage lets filters override the default bbox', async () => {
  let capturedData;
  const fakeHttpClient = {
    post: async (url, data) => {
      capturedData = data;
      return { status: 200, data: { data: [], pagination: { page: 1, per_page: 10, total_pages: 1, total_count: 0 } } };
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  await client.fetchLocationsPage({ filters: { latitude_ne: 40.6, latitude_sw: 40.3 } });
  assert.equal(capturedData.latitude_ne, 40.6);
  assert.equal(capturedData.latitude_sw, 40.3);
  assert.equal(capturedData.longitude_ne, 4.5); // untouched default
});

test('fetchAllLocations paginates using body pagination.total_pages', async () => {
  let calls = 0;
  const fakeHttpClient = {
    post: async (url, data, config) => {
      calls += 1;
      const page = config.params.page;
      const data_ = page <= 2 ? [{ id: `loc-${page}` }] : [];
      return { status: 200, data: { data: data_, pagination: { page, per_page: 1, total_pages: 2, total_count: 2 } } };
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const locations = await client.fetchAllLocations({ perPage: 1, requestDelayMs: 0 });
  assert.equal(locations.length, 2);
  assert.equal(locations[0].id, 'loc-1');
  assert.equal(locations[1].id, 'loc-2');
  assert.equal(calls, 2);
});

test('fetchAllLocations stops when a short page has no total_pages hint', async () => {
  const fakeHttpClient = {
    post: async (url, data, config) => {
      const page = config.params.page;
      const data_ = page === 1 ? [{ id: 'loc-1' }, { id: 'loc-2' }] : [];
      return { status: 200, data: { data: data_, pagination: null } };
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const locations = await client.fetchAllLocations({ perPage: 5, requestDelayMs: 0 });
  assert.equal(locations.length, 2);
});

test('fetchAllLocations stops at maxPages even if the server claims more pages exist', async () => {
  let calls = 0;
  const fakeHttpClient = {
    post: async (url, data, config) => {
      calls += 1;
      const page = config.params.page;
      // Server claims 2000 total pages (~20,000 locations) — a full-Spain-sized sweep.
      return {
        status: 200,
        data: { data: [{ id: `loc-${page}` }], pagination: { page, per_page: 10, total_pages: 2000, total_count: 20000 } },
      };
    },
  };

  const warnings = [];
  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: { ...silentLogger, warn: (msg) => warnings.push(msg) },
  });

  const locations = await client.fetchAllLocations({ maxPages: 3, requestDelayMs: 0 });
  assert.equal(calls, 3, 'must not fetch more than maxPages pages');
  assert.equal(locations.length, 3);
  assert.ok(warnings.some((w) => w.includes('maxPages')), 'should warn that the dataset is partial');
});

test('fetchAllLocations defaults to DEFAULT_MAX_PAGES without an explicit maxPages', async () => {
  let calls = 0;
  const fakeHttpClient = {
    post: async (url, data, config) => {
      calls += 1;
      const page = config.params.page;
      return {
        status: 200,
        data: { data: [{ id: `loc-${page}` }], pagination: { page, per_page: 10, total_pages: 99999, total_count: 999990 } },
      };
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const locations = await client.fetchAllLocations({ requestDelayMs: 0 });
  assert.equal(calls, DEFAULT_MAX_PAGES, 'default cap must kick in without an explicit maxPages');
  assert.equal(locations.length, DEFAULT_MAX_PAGES);
});

test('fetchLocationsSweep resumes from startPage and reports nextPage when capped', async () => {
  const fakeHttpClient = {
    post: async (url, data, config) => {
      const page = config.params.page;
      return {
        status: 200,
        data: { data: [{ id: `loc-${page}` }], pagination: { page, per_page: 10, total_pages: 1000, total_count: 10000 } },
      };
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const result = await client.fetchLocationsSweep({ startPage: 51, maxPages: 3, requestDelayMs: 0 });
  assert.equal(result.locations.length, 3);
  assert.deepEqual(result.locations.map((l) => l.id), ['loc-51', 'loc-52', 'loc-53']);
  assert.equal(result.nextPage, 54, 'should resume right after the last page fetched');
  assert.equal(result.totalPages, 1000);
  assert.equal(result.completedSweep, false);
});

test('fetchLocationsSweep wraps nextPage back to 1 when it reaches the last page', async () => {
  const fakeHttpClient = {
    post: async (url, data, config) => {
      const page = config.params.page;
      const data_ = page <= 3 ? [{ id: `loc-${page}` }] : [];
      return {
        status: 200,
        data: { data: data_, pagination: { page, per_page: 10, total_pages: 3, total_count: 3 } },
      };
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const result = await client.fetchLocationsSweep({ startPage: 1, maxPages: 50, requestDelayMs: 0 });
  assert.equal(result.locations.length, 3);
  assert.equal(result.nextPage, 1, 'a completed sweep should restart from page 1 next time');
  assert.equal(result.completedSweep, true);
});

test('fetchMarkers sends bbox and zoom as the POST body', async () => {
  let capturedData;
  const fakeHttpClient = {
    post: async (url, data) => {
      capturedData = data;
      return { status: 200, data: [{ latitude: 40.4, longitude: -3.7, type: 'cluster', total_evse: 5 }] };
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const markers = await client.fetchMarkers({
    latitudeNe: 40.55,
    longitudeNe: -3.55,
    latitudeSw: 40.3,
    longitudeSw: -3.85,
    zoom: 12,
    filters: { available: true },
  });

  assert.equal(capturedData.latitude_ne, 40.55);
  assert.equal(capturedData.longitude_sw, -3.85);
  assert.equal(capturedData.zoom, 12);
  assert.equal(capturedData.available, true);
  assert.equal(markers[0].type, 'cluster');
});

test('fetchConnectorTypes and fetchFacilities return plain arrays', async () => {
  const fakeHttpClient = {
    get: async (url) => {
      if (url.endsWith('/connector_types')) {
        return { status: 200, data: [{ code: 'IEC_62196_T2', icon: null }] };
      }
      if (url.endsWith('/facilities')) {
        return { status: 200, data: [{ code: 'PARKING_LOT', name: 'Aparcamiento' }] };
      }
      throw new Error(`unexpected url ${url}`);
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const types = await client.fetchConnectorTypes();
  const facilities = await client.fetchFacilities();
  assert.equal(types[0].code, 'IEC_62196_T2');
  assert.equal(facilities[0].code, 'PARKING_LOT');
});

test('fetchCpos unwraps the paginated {data, pagination} envelope', async () => {
  const fakeHttpClient = {
    get: async () => ({
      status: 200,
      data: { data: [{ id: 'cpo-1', name: 'ACCIONA Recarga', source_type: 'OCPI' }], pagination: { page: 1, per_page: 500, total_count: 1, total_pages: 1 } },
    }),
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const { data, pagination } = await client.fetchCpos();
  assert.equal(data[0].name, 'ACCIONA Recarga');
  assert.equal(pagination.total_count, 1);
});

test('retries once on HTTP 429 then succeeds', async () => {
  let attempts = 0;
  const fakeHttpClient = {
    get: async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('rate limited');
        err.response = { status: 429 };
        throw err;
      }
      return { status: 200, data: { id: 'loc-1' } };
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const loc = await client.fetchLocation('loc-1');
  assert.equal(loc.id, 'loc-1');
  assert.equal(attempts, 2);
});

test('does not retry on HTTP 403 (WAF block)', async () => {
  let attempts = 0;
  const fakeHttpClient = {
    get: async () => {
      attempts += 1;
      const err = new Error('Forbidden');
      err.response = { status: 403 };
      throw err;
    },
  };

  const client = createRevePublicClient({
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  await assert.rejects(() => client.fetchLocation('loc-1'));
  assert.equal(attempts, 1);
});
