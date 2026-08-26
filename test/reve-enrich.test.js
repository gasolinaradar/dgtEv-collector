const { test } = require('node:test');
const assert = require('node:assert');
const { enrichStations } = require('../src/reve-enrich');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

const station = {
  sourceStationId: 'dgt-1',
  name: 'Repsol',
  location: { type: 'Point', coordinates: [-3.7038, 40.4168] },
  prices: undefined,
  availability: undefined,
};

const externalLocation = {
  id: 'reve-external-1',
  coordinates: { latitude: '40.4168', longitude: '-3.7038' },
  party_id: 'ES*WEN',
  cpo_name: 'Wenea',
  owner: 'Wenea - www.wenea.es',
  evses: [],
};

function fakeExternalHttpClient() {
  return {
    get: async (url) => {
      if (url.includes('/locations')) {
        return { status: 200, data: [externalLocation], headers: { 'total-count': '1', 'total-pages': '1' } };
      }
      return { status: 200, data: [], headers: { 'total-count': '0', 'total-pages': '1' } };
    },
  };
}

const publicLocation = {
  id: 'reve-public-1',
  name: 'Repsol',
  coordinates: { latitude: '40.4168', longitude: '-3.7038' },
  owner: { name: 'Repsol S.A.', website: 'repsol.com' },
  evses: [],
};

function fakePublicHttpClient() {
  return {
    post: async (url, data, config) => ({
      status: 200,
      data: { data: [publicLocation], pagination: { page: config.params.page, per_page: 25, total_pages: 1, total_count: 1 } },
    }),
  };
}

test('enrichStations defaults to external when reveApiKey is present', async () => {
  const result = await enrichStations([station], {
    reveApiKey: 'test-key',
    httpClient: fakeExternalHttpClient(),
    logger: silentLogger,
    thresholdMeters: 100,
  });

  assert.equal(result[0].reveLocationId, 'reve-external-1');
});

test('enrichStations defaults to public when reveApiKey is absent', async () => {
  const result = await enrichStations([station], {
    acknowledgeUnsupported: true,
    httpClient: fakePublicHttpClient(),
    logger: silentLogger,
    thresholdMeters: 100,
  });

  assert.equal(result[0].reveLocationId, 'reve-public-1');
});

test('enrichStations with no reveApiKey and no source defaults to public, so it still requires acknowledgeUnsupported', async () => {
  await assert.rejects(
    () => enrichStations([station], {}),
    /acknowledgeUnsupported/,
  );
});

test('enrichStations({ source: "external" }) with no reveApiKey is a no-op, not public', async () => {
  const result = await enrichStations([station], { source: 'external' });
  assert.deepEqual(result, [station]);
});

test('enrichStations({ source: "public" }) forces public even when reveApiKey is present', async () => {
  const result = await enrichStations([station], {
    reveApiKey: 'test-key',
    source: 'public',
    acknowledgeUnsupported: true,
    httpClient: fakePublicHttpClient(),
    logger: silentLogger,
    thresholdMeters: 100,
  });

  assert.equal(result[0].reveLocationId, 'reve-public-1');
});

test('enrichStations({ source: "public" }) still requires acknowledgeUnsupported', async () => {
  await assert.rejects(
    () => enrichStations([station], { source: 'public' }),
    /acknowledgeUnsupported/,
  );
});
