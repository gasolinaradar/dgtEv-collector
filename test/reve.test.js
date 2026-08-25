const { test } = require('node:test');
const assert = require('node:assert');
const { createReveClient, ReveRateLimiter, RATE_LIMIT_PER_HOUR } = require('../src/reve');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

function createFakeReveClient(responseData, headers = {}) {
  const calls = [];
  return {
    httpClient: {
      get: async (url, config) => {
        calls.push({ url, config });
        return {
          status: 200,
          data: responseData,
          headers: {
            'total-count': String(responseData.length),
            'total-pages': '1',
            ...headers,
          },
        };
      },
    },
    calls,
  };
}

test('createReveClient throws without API key', () => {
  assert.throws(() => createReveClient(), /Reve API key is required/);
  assert.throws(() => createReveClient({ apiKey: '' }), /Reve API key is required/);
  assert.throws(() => createReveClient({ apiKey: '  ' }), /Reve API key is required/);
});

test('createReveClient returns client with all methods', () => {
  const fake = createFakeReveClient([]);
  const client = createReveClient({
    apiKey: 'test-key',
    httpClient: fake.httpClient,
    logger: silentLogger,
  });

  assert.equal(typeof client.fetchLocations, 'function');
  assert.equal(typeof client.fetchOperationalStatus, 'function');
  assert.equal(typeof client.fetchTariffs, 'function');
  assert.equal(typeof client.fetchEvseStatus, 'function');
  assert.equal(typeof client.streamLocations, 'function');
  assert.equal(typeof client.streamOperationalStatus, 'function');
  assert.equal(typeof client.streamTariffs, 'function');
});

test('fetchLocations paginates through all pages', async () => {
  let pageCount = 0;
  const fakeHttpClient = {
    get: async (url, config) => {
      pageCount += 1;
      const page = config.params.page;
      const data = page <= 2 ? [{ id: `loc-${page}` }] : [];
      return {
        status: 200,
        data,
        headers: { 'total-count': '2', 'total-pages': '2' },
      };
    },
  };

  const client = createReveClient({
    apiKey: 'test-key',
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const locations = await client.fetchLocations();
  assert.equal(locations.length, 2);
  assert.equal(locations[0].id, 'loc-1');
  assert.equal(locations[1].id, 'loc-2');
  assert.equal(pageCount, 2);
});

test('fetchLocations sends x-api-key header', async () => {
  let capturedHeaders;
  const fakeHttpClient = {
    get: async (url, config) => {
      capturedHeaders = config.headers;
      return {
        status: 200,
        data: [],
        headers: { 'total-count': '0', 'total-pages': '1' },
      };
    },
  };

  const client = createReveClient({
    apiKey: 'my-secret-key',
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  await client.fetchLocations();
  assert.equal(capturedHeaders['x-api-key'], 'my-secret-key');
});

test('fetchTariffs returns tariff data', async () => {
  const tariffData = [
    {
      connector_id: 'conn-1',
      tariffs: [
        {
          id: 'tariff-1',
          currency: 'EUR',
          elements: [
            {
              price_components: [
                { type: 'ENERGY', price: '0.35', step_size: 1 },
              ],
            },
          ],
        },
      ],
      last_tariff_updated: '2026-01-01T00:00:00Z',
    },
  ];

  const fake = createFakeReveClient(tariffData);
  const client = createReveClient({
    apiKey: 'test-key',
    httpClient: fake.httpClient,
    logger: silentLogger,
  });

  const tariffs = await client.fetchTariffs();
  assert.equal(tariffs.length, 1);
  assert.equal(tariffs[0].connector_id, 'conn-1');
  assert.equal(tariffs[0].tariffs[0].elements[0].price_components[0].price, '0.35');
});

test('ReveRateLimiter tracks request count', async () => {
  const limiter = new ReveRateLimiter(3);

  await limiter.waitForSlot();
  await limiter.waitForSlot();
  await limiter.waitForSlot();

  assert.equal(limiter.count, 3);

  await assert.rejects(() => limiter.waitForSlot(), /rate limit reached/);
});

test('ReveRateLimiter resets after window', () => {
  const limiter = new ReveRateLimiter(5);
  limiter.windowStart = Date.now() - 60 * 60 * 1000 - 1000;
  limiter.count = 5;

  limiter.reset();
  assert.equal(limiter.count, 0);
});

test('streamLocations yields page by page', async () => {
  let pageCount = 0;
  const fakeHttpClient = {
    get: async (url, config) => {
      pageCount += 1;
      const page = config.params.page;
      const data = page <= 2 ? [{ id: `loc-${page}` }] : [];
      return {
        status: 200,
        data,
        headers: { 'total-count': '2', 'total-pages': '2' },
      };
    },
  };

  const client = createReveClient({
    apiKey: 'test-key',
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  const pages = [];
  for await (const page of client.streamLocations()) {
    pages.push(page);
  }

  assert.equal(pages.length, 2);
  assert.equal(pages[0][0].id, 'loc-1');
  assert.equal(pages[1][0].id, 'loc-2');
});
