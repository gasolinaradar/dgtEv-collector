const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  enrichStationsExperimental,
  normalizeRevePublicLocation,
  normalizeStationName,
  mergePublicPrices,
  mergePublicAvailability,
} = require('../src/enrich-experimental');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

// Shape based on the real GET /api/public/v1/locations/{id} response captured against
// mapareve.es (id bf98707f-8ba7-4e2a-8934-3aff07c04a70), trimmed to one EVSE/connector.
function samplePublicLocation(overrides = {}) {
  return {
    id: 'reve-pub-1',
    name: 'Estación de Prueba',
    address: 'Calle Falsa 123',
    postal_code: '28013',
    country: 'ESP',
    owner: { name: 'ACME Recarga S.L.', website: 'acme-recarga.example', logo: null, phone: '900000000' },
    coordinates: { latitude: '40.4168', longitude: '-3.7038' },
    facilities: [{ code: 'PARKING_LOT', name: 'Aparcamiento' }],
    opening_times: { regular_hours: [], twentyfourseven: true, exceptional_openings: [], exceptional_closings: [] },
    evses: [
      {
        evse_id: 'ES*ACM*E000001*1',
        physical_reference: null,
        status: 'AVAILABLE',
        status_updated_at: '2026-08-26T02:50:12.241Z',
        connectors: [
          {
            id: 'conn-1',
            standard: 'IEC_62196_T2_COMBO',
            format: 'CABLE',
            max_electric_power: 65000,
            tariffs: [
              {
                human: ['0.48 EUR/kWh'],
                tariff: {
                  id: 'tariff-1',
                  currency: 'EUR',
                  elements: [{ price_components: [{ type: 'ENERGY', price: 0.48, vat: 21.0, step_size: 1 }] }],
                },
              },
            ],
          },
        ],
        payment_methods: ['Lector RFID'],
      },
    ],
    ...overrides,
  };
}

test('normalizeRevePublicLocation parses the real /locations/{id} shape', () => {
  const result = normalizeRevePublicLocation(samplePublicLocation());
  assert.ok(result);
  assert.equal(result.reveLocationId, 'reve-pub-1');
  assert.equal(result.lat, 40.4168);
  assert.equal(result.lon, -3.7038);
  assert.equal(result.operator.name, 'ACME Recarga S.L.');
  assert.equal(result.operator.website, 'acme-recarga.example');
  assert.equal(result.allConnectors.length, 1);
  assert.equal(result.allConnectors[0].standard, 'IEC_62196_T2_COMBO');
  assert.equal(result.allConnectors[0].maxPowerW, 65000);
  assert.equal(result.allConnectors[0].prices[0].price, 0.48);
  assert.deepEqual(result.evseStatuses, ['AVAILABLE']);
});

test('normalizeRevePublicLocation returns null for invalid coordinates', () => {
  const loc = samplePublicLocation({ coordinates: { latitude: null, longitude: '-3.7038' } });
  assert.equal(normalizeRevePublicLocation(loc), null);
});

test('mergePublicPrices dedupes identical price components across connectors', () => {
  const reveLoc = normalizeRevePublicLocation(samplePublicLocation());
  const prices = mergePublicPrices(reveLoc);
  assert.equal(prices.length, 1);
  assert.equal(prices[0].type, 'ENERGY');
  assert.equal(prices[0].price, 0.48);
});

test('mergePublicAvailability picks the highest-priority status', () => {
  const reveLoc = normalizeRevePublicLocation(samplePublicLocation());
  const availability = mergePublicAvailability(reveLoc);
  assert.equal(availability.status, 'AVAILABLE');
  assert.equal(availability.evseCount, 1);
});

test('mergePublicAvailability returns undefined when there are no EVSE statuses', () => {
  const reveLoc = normalizeRevePublicLocation(samplePublicLocation({ evses: [] }));
  assert.equal(mergePublicAvailability(reveLoc), undefined);
});

test('enrichStationsExperimental throws when acknowledgeUnsupported is missing', async () => {
  await assert.rejects(
    () => enrichStationsExperimental([], {}),
    /acknowledgeUnsupported/,
  );
});

test('enrichStationsExperimental matches DGT stations to Reve public locations by proximity', async () => {
  const stations = [
    {
      sourceStationId: 'dgt-1',
      name: 'Test Station',
      location: { type: 'Point', coordinates: [-3.7038, 40.4168] },
      connectors: [{ type: 'IEC_62196_T2_COMBO' }],
      prices: undefined,
      availability: undefined,
    },
  ];

  const fakeHttpClient = {
    post: async (url, data, config) => {
      const page = config.params.page;
      const pageData = page === 1 ? [samplePublicLocation()] : [];
      return {
        status: 200,
        data: { data: pageData, pagination: { page, per_page: 50, total_pages: 1, total_count: 1 } },
      };
    },
  };

  const result = await enrichStationsExperimental(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 100,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].reveLocationId, 'reve-pub-1');
  assert.equal(result[0].operator.name, 'ACME Recarga S.L.');
  assert.ok(result[0].prices);
  assert.equal(result[0].prices[0].price, 0.48);
  assert.ok(result[0].availability);
  assert.equal(result[0].availability.status, 'AVAILABLE');
});

test('enrichStationsExperimental leaves stations untouched when nothing matches nearby', async () => {
  const stations = [
    {
      sourceStationId: 'dgt-far',
      location: { type: 'Point', coordinates: [-4.0, 41.0] },
      prices: undefined,
      availability: undefined,
    },
  ];

  const fakeHttpClient = {
    post: async (url, data, config) => {
      const page = config.params.page;
      const pageData = page === 1 ? [samplePublicLocation()] : [];
      return {
        status: 200,
        data: { data: pageData, pagination: { page, per_page: 50, total_pages: 1, total_count: 1 } },
      };
    },
  };

  const result = await enrichStationsExperimental(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 50,
  });

  assert.equal(result[0].reveLocationId, undefined);
  assert.equal(result[0].prices, undefined);
});

test('enrichStationsExperimental with cacheDir resumes pagination and accumulates locations across calls', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reve-public-sweep-'));
  try {
    // 3 total pages of 1 location each, distinct ids/coords so each call's match is unique.
    const pages = {
      1: samplePublicLocation({ id: 'reve-pub-1', coordinates: { latitude: '40.0', longitude: '-3.0' } }),
      2: samplePublicLocation({ id: 'reve-pub-2', coordinates: { latitude: '41.0', longitude: '-4.0' } }),
      3: samplePublicLocation({ id: 'reve-pub-3', coordinates: { latitude: '42.0', longitude: '-5.0' } }),
    };
    const fakeHttpClient = {
      post: async (url, data, config) => {
        const page = config.params.page;
        const loc = pages[page];
        return {
          status: 200,
          data: {
            data: loc ? [loc] : [],
            pagination: { page, per_page: 1, total_pages: 3, total_count: 3 },
          },
        };
      },
    };

    const baseOpts = {
      acknowledgeUnsupported: true,
      httpClient: fakeHttpClient,
      logger: silentLogger,
      cacheDir,
      maxPages: 1,
      thresholdMeters: 5000,
    };

    // Call 1: fetches page 1 only (maxPages: 1), stores reve-pub-1 in the cache.
    await enrichStationsExperimental([], baseOpts);
    let state = JSON.parse(fs.readFileSync(path.join(cacheDir, 'reve_public_sweep.json'), 'utf-8'));
    assert.equal(state.nextPage, 2);
    assert.deepEqual(Object.keys(state.locations), ['reve-pub-1']);

    // Call 2: resumes at page 2, accumulates reve-pub-2 alongside reve-pub-1.
    await enrichStationsExperimental([], baseOpts);
    state = JSON.parse(fs.readFileSync(path.join(cacheDir, 'reve_public_sweep.json'), 'utf-8'));
    assert.equal(state.nextPage, 3);
    assert.deepEqual(Object.keys(state.locations).sort(), ['reve-pub-1', 'reve-pub-2']);

    // Call 3: resumes at page 3 (the last one), wraps nextPage back to 1.
    const stations = [
      { sourceStationId: 'dgt-1', location: { type: 'Point', coordinates: [-5.0, 42.0] }, prices: undefined, availability: undefined },
    ];
    const enriched = await enrichStationsExperimental(stations, baseOpts);
    state = JSON.parse(fs.readFileSync(path.join(cacheDir, 'reve_public_sweep.json'), 'utf-8'));
    assert.equal(state.nextPage, 1, 'a completed sweep should wrap back to page 1');
    assert.deepEqual(Object.keys(state.locations).sort(), ['reve-pub-1', 'reve-pub-2', 'reve-pub-3']);
    // By call 3 all three accumulated locations are in the index, so the station near
    // reve-pub-3 matches even though this call only fetched page 3.
    assert.equal(enriched[0].reveLocationId, 'reve-pub-3');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('enrichStationsExperimental without cacheDir always restarts at page 1 (no accumulation)', async () => {
  let capturedPages = [];
  const fakeHttpClient = {
    post: async (url, data, config) => {
      capturedPages.push(config.params.page);
      return {
        status: 200,
        data: { data: [samplePublicLocation()], pagination: { page: config.params.page, per_page: 1, total_pages: 1, total_count: 1 } },
      };
    },
  };

  const opts = { acknowledgeUnsupported: true, httpClient: fakeHttpClient, logger: silentLogger, maxPages: 1 };
  await enrichStationsExperimental([], opts);
  await enrichStationsExperimental([], opts);

  assert.deepEqual(capturedPages, [1, 1], 'every call starts at page 1 without cacheDir');
});

test('normalizeStationName is accent/case insensitive', () => {
  assert.equal(normalizeStationName('Repsol, Elorrio, Vía Pública'), normalizeStationName('REPSOL, ELORRIO, VIA PUBLICA'));
  assert.equal(normalizeStationName(null), null);
  assert.equal(normalizeStationName('   '), null);
});

test('enrichStationsExperimental matches by exact name even when far outside thresholdMeters', async () => {
  // Reve location is 400km from the DGT station's coordinates — proximity alone would
  // never match, but the names are identical (after normalization).
  const reveLoc = samplePublicLocation({ id: 'reve-far', name: 'Repsol, Elorrio, Vía Pública' });
  const fakeHttpClient = {
    post: async (url, data, config) => ({
      status: 200,
      data: { data: [reveLoc], pagination: { page: config.params.page, per_page: 25, total_pages: 1, total_count: 1 } },
    }),
  };

  const stations = [
    {
      sourceStationId: 'dgt-name-match',
      name: 'REPSOL, ELORRIO, VIA PUBLICA', // same name, different case/accents
      location: { type: 'Point', coordinates: [-8.0, 39.0] }, // far from reveLoc's 40.4168,-3.7038
      prices: undefined,
      availability: undefined,
    },
  ];

  const result = await enrichStationsExperimental(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 50, // would reject this on distance alone
  });

  assert.equal(result[0].reveLocationId, 'reve-far');
});

test('enrichStationsExperimental disambiguates same-named Reve locations by nearest', async () => {
  const near = samplePublicLocation({
    id: 'reve-near',
    name: 'Repsol',
    coordinates: { latitude: '40.42', longitude: '-3.70' },
  });
  const far = samplePublicLocation({
    id: 'reve-far-dup',
    name: 'Repsol',
    coordinates: { latitude: '41.5', longitude: '-4.5' },
  });

  const fakeHttpClient = {
    post: async (url, data, config) => ({
      status: 200,
      data: { data: [near, far], pagination: { page: config.params.page, per_page: 25, total_pages: 1, total_count: 2 } },
    }),
  };

  const stations = [
    {
      sourceStationId: 'dgt-dup-name',
      name: 'Repsol',
      location: { type: 'Point', coordinates: [-3.7038, 40.4168] }, // close to "near"
      prices: undefined,
      availability: undefined,
    },
  ];

  const result = await enrichStationsExperimental(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  assert.equal(result[0].reveLocationId, 'reve-near', 'ambiguous name match should resolve to the nearest candidate');
});

test('enrichStationsExperimental falls back to proximity when there is no name match', async () => {
  const reveLoc = samplePublicLocation({ id: 'reve-prox-only', name: 'Totally Different Name' });
  const fakeHttpClient = {
    post: async (url, data, config) => ({
      status: 200,
      data: { data: [reveLoc], pagination: { page: config.params.page, per_page: 25, total_pages: 1, total_count: 1 } },
    }),
  };

  const stations = [
    {
      sourceStationId: 'dgt-no-name-match',
      name: 'DGT Station Name',
      location: { type: 'Point', coordinates: [-3.7038, 40.4168] }, // matches reveLoc's coords
      prices: undefined,
      availability: undefined,
    },
  ];

  const result = await enrichStationsExperimental(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 100,
  });

  assert.equal(result[0].reveLocationId, 'reve-prox-only');
});
