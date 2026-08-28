const { test } = require('node:test');
const assert = require('node:assert');
const {
  enrichStationsPublic,
  normalizeRevePublicLocation,
  normalizeStationName,
  mergePublicPrices,
  mergePublicAvailability,
} = require('../src/enrich-public');

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
  assert.ok(result.raw);
  assert.equal(result.raw.id, 'reve-pub-1');
});

test('normalizeRevePublicLocation returns null for invalid coordinates', () => {
  const loc = samplePublicLocation({ coordinates: { latitude: null, longitude: '-3.7038' } });
  assert.equal(normalizeRevePublicLocation(loc), null);
});

test('mergePublicPrices tags each price with the evseId/connectorId it came from', () => {
  const reveLoc = normalizeRevePublicLocation(samplePublicLocation());
  const prices = mergePublicPrices(reveLoc);
  assert.equal(prices.length, 1);
  assert.equal(prices[0].type, 'ENERGY');
  assert.equal(prices[0].price, 0.48);
  assert.equal(prices[0].evseId, 'ES*ACM*E000001*1');
  assert.equal(prices[0].connectorId, 'conn-1');
});

test('mergePublicPrices does not dedup identical tariffs across different connectors, so each price stays traceable to its own connector', () => {
  const reveLoc = normalizeRevePublicLocation(
    samplePublicLocation({
      evses: [
        {
          evse_id: 'evse-1',
          status: 'AVAILABLE',
          connectors: [
            {
              id: 'conn-a',
              standard: 'IEC_62196_T2',
              tariffs: [
                { tariff: { currency: 'EUR', elements: [{ price_components: [{ type: 'ENERGY', price: 0.35, step_size: 1 }] }] } },
              ],
            },
          ],
        },
        {
          evse_id: 'evse-2',
          status: 'AVAILABLE',
          connectors: [
            {
              id: 'conn-b',
              standard: 'IEC_62196_T2',
              tariffs: [
                { tariff: { currency: 'EUR', elements: [{ price_components: [{ type: 'ENERGY', price: 0.35, step_size: 1 }] }] } },
              ],
            },
          ],
        },
      ],
    }),
  );

  const prices = mergePublicPrices(reveLoc);
  assert.equal(prices.length, 2);
  assert.deepEqual(
    prices.map((p) => p.connectorId).sort(),
    ['conn-a', 'conn-b'],
  );
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

test('mergePublicAvailability includes a per-EVSE breakdown with connector power/type, so slow-vs-fast is distinguishable from the status alone', () => {
  const reveLoc = normalizeRevePublicLocation(
    samplePublicLocation({
      evses: [
        {
          evse_id: 'evse-slow-ok',
          status: 'AVAILABLE',
          connectors: [{ id: 'c1', standard: 'IEC_62196_T2', max_electric_power: 22000 }],
        },
        {
          evse_id: 'evse-fast-broken',
          status: 'OUTOFORDER',
          connectors: [{ id: 'c2', standard: 'IEC_62196_T2_COMBO', max_electric_power: 150000 }],
        },
      ],
    }),
  );

  const availability = mergePublicAvailability(reveLoc);
  // Summary status alone would just say "AVAILABLE" (highest priority) — it can't tell
  // you the fast connector is the one that's actually broken. The per-EVSE array can.
  assert.equal(availability.status, 'AVAILABLE');
  assert.equal(availability.evses.length, 2);

  const slow = availability.evses.find((e) => e.evseId === 'evse-slow-ok');
  assert.equal(slow.status, 'AVAILABLE');
  assert.equal(slow.connectors[0].maxPowerW, 22000);
  assert.equal(slow.connectors[0].connectorId, 'c1');

  const fast = availability.evses.find((e) => e.evseId === 'evse-fast-broken');
  assert.equal(fast.status, 'OUTOFORDER');
  assert.equal(fast.connectors[0].maxPowerW, 150000);
  assert.equal(fast.connectors[0].connectorId, 'c2');
});

test('enrichStationsPublic throws when acknowledgeUnsupported is missing', async () => {
  await assert.rejects(
    () => enrichStationsPublic([], {}),
    /acknowledgeUnsupported/,
  );
});

test('enrichStationsPublic matches DGT stations to Reve public locations by proximity', async () => {
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

  const result = await enrichStationsPublic(stations, {
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

  // The exact raw API object is kept too, not just the flattened fields above.
  assert.ok(result[0].reveData);
  assert.equal(result[0].reveData.id, 'reve-pub-1');
  assert.deepEqual(result[0].reveData, samplePublicLocation());
});

test('enrichStationsPublic leaves stations untouched when nothing matches nearby', async () => {
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

  const result = await enrichStationsPublic(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 50,
  });

  assert.equal(result[0].reveLocationId, undefined);
  assert.equal(result[0].prices, undefined);
});

test('enrichStationsPublic walks every page of the dataset by default (no cap, no cache)', async () => {
  // 3 total pages of 1 location each — with no maxPages passed, all 3 must be fetched.
  const pages = {
    1: samplePublicLocation({ id: 'reve-pub-1', coordinates: { latitude: '40.0', longitude: '-3.0' } }),
    2: samplePublicLocation({ id: 'reve-pub-2', coordinates: { latitude: '41.0', longitude: '-4.0' } }),
    3: samplePublicLocation({ id: 'reve-pub-3', coordinates: { latitude: '42.0', longitude: '-5.0' } }),
  };
  let calls = 0;
  const fakeHttpClient = {
    post: async (url, data, config) => {
      calls += 1;
      const page = config.params.page;
      const loc = pages[page];
      return {
        status: 200,
        data: { data: loc ? [loc] : [], pagination: { page, per_page: 1, total_pages: 3, total_count: 3 } },
      };
    },
  };

  const stations = [
    { sourceStationId: 'dgt-1', location: { type: 'Point', coordinates: [-5.0, 42.0] }, prices: undefined, availability: undefined },
  ];

  const enriched = await enrichStationsPublic(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 5000,
  });

  assert.equal(calls, 3, 'must walk all 3 pages, not stop at a default cap');
  assert.equal(enriched[0].reveLocationId, 'reve-pub-3');
});

test('enrichStationsPublic reports progress per page instead of jumping straight from 0 to 100', async () => {
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
        data: { data: loc ? [loc] : [], pagination: { page, per_page: 1, total_pages: 3, total_count: 3 } },
      };
    },
  };

  const progressCalls = [];
  const stations = [
    { sourceStationId: 'dgt-1', location: { type: 'Point', coordinates: [-5.0, 42.0] }, prices: undefined, availability: undefined },
  ];

  await enrichStationsPublic(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 5000,
    reportProgress: (percent, meta) => progressCalls.push({ percent, meta }),
  });

  // One call per page fetched (33/66/99 for a 3-page sweep) plus the initial 0 and the
  // final 100 once the sweep is done — not just a single jump from 0 straight to 100 that
  // would look "stuck" while 582 real pages are being fetched one by one.
  const sweepCalls = progressCalls.filter((c) => c.meta.stage === 'reve_public_locations_sweep');
  assert.ok(sweepCalls.length >= 4, `expected progress during the sweep, got ${JSON.stringify(sweepCalls)}`);
  assert.equal(sweepCalls[0].percent, 0);
  assert.equal(sweepCalls.at(-1).percent, 100);
  const midCall = sweepCalls.find((c) => c.meta.page === 2);
  assert.ok(midCall, 'expected a progress event tied to page 2');
  assert.equal(midCall.percent, 67);
});

test('enrichStationsPublic always restarts at page 1 (no cache/cursor between calls)', async () => {
  const capturedPages = [];
  const fakeHttpClient = {
    post: async (url, data, config) => {
      capturedPages.push(config.params.page);
      return {
        status: 200,
        data: { data: [samplePublicLocation()], pagination: { page: config.params.page, per_page: 1, total_pages: 1, total_count: 1 } },
      };
    },
  };

  const opts = { acknowledgeUnsupported: true, httpClient: fakeHttpClient, logger: silentLogger };
  await enrichStationsPublic([], opts);
  await enrichStationsPublic([], opts);

  assert.deepEqual(capturedPages, [1, 1], 'every call starts at page 1 — no persisted cursor');
});

test('enrichStationsPublic skips a page that fails after retries instead of losing the whole run', async () => {
  const pages = {
    1: samplePublicLocation({ id: 'reve-pub-1', coordinates: { latitude: '40.0', longitude: '-3.0' } }),
    // page 2 always fails (simulates a transient server error that outlasts request-level retries)
    3: samplePublicLocation({ id: 'reve-pub-3', coordinates: { latitude: '42.0', longitude: '-5.0' } }),
  };
  const fakeHttpClient = {
    post: async (url, data, config) => {
      const page = config.params.page;
      if (page === 2) {
        const err = new Error('Internal Server Error');
        err.response = { status: 500 };
        throw err;
      }
      const loc = pages[page];
      return {
        status: 200,
        data: { data: loc ? [loc] : [], pagination: { page, per_page: 1, total_pages: 3, total_count: 3 } },
      };
    },
  };

  const stations = [
    { sourceStationId: 'dgt-1', location: { type: 'Point', coordinates: [-5.0, 42.0] }, prices: undefined, availability: undefined },
    { sourceStationId: 'dgt-2', location: { type: 'Point', coordinates: [-3.0, 40.0] }, prices: undefined, availability: undefined },
  ];

  const enriched = await enrichStationsPublic(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 5000,
    retries: 0, // fail page 2 immediately instead of waiting through real retry backoff in the test
  });

  // Pages 1 and 3 still made it in despite page 2 failing every attempt.
  assert.equal(enriched.find((s) => s.sourceStationId === 'dgt-1').reveLocationId, 'reve-pub-3');
  assert.equal(enriched.find((s) => s.sourceStationId === 'dgt-2').reveLocationId, 'reve-pub-1');
});

test('normalizeStationName is accent/case insensitive', () => {
  assert.equal(normalizeStationName('Repsol, Elorrio, Vía Pública'), normalizeStationName('REPSOL, ELORRIO, VIA PUBLICA'));
  assert.equal(normalizeStationName(null), null);
  assert.equal(normalizeStationName('   '), null);
});

test('enrichStationsPublic matches by exact name even when far outside thresholdMeters', async () => {
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

  const result = await enrichStationsPublic(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 50, // would reject this on distance alone
  });

  assert.equal(result[0].reveLocationId, 'reve-far');
});

test('enrichStationsPublic disambiguates same-named Reve locations by nearest', async () => {
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

  const result = await enrichStationsPublic(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  assert.equal(result[0].reveLocationId, 'reve-near', 'ambiguous name match should resolve to the nearest candidate');
});

test('enrichStationsPublic falls back to proximity when there is no name match', async () => {
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

  const result = await enrichStationsPublic(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 100,
  });

  assert.equal(result[0].reveLocationId, 'reve-prox-only');
});

test('enrichStationsPublic discards Reve locations that are neither a name nor a proximity candidate (memory: never normalized/retained)', async () => {
  // Only one DGT station, near (0, 0) with no name. Reve sends back 200 far-away,
  // irrelevant locations plus 1 real candidate near (0, 0).
  const farLocations = Array.from({ length: 200 }, (_, i) =>
    samplePublicLocation({
      id: `reve-far-${i}`,
      name: `Irrelevant ${i}`,
      coordinates: { latitude: String(10 + i), longitude: String(10 + i) },
    }),
  );
  const nearLocation = samplePublicLocation({
    id: 'reve-real-match',
    name: 'Not Matched By Name',
    coordinates: { latitude: '0.0001', longitude: '0.0001' },
  });

  const fakeHttpClient = {
    post: async () => ({
      status: 200,
      data: { data: [...farLocations, nearLocation], pagination: { page: 1, per_page: 201, total_pages: 1, total_count: 201 } },
    }),
  };

  const infoLogs = [];
  const logger = { ...silentLogger, info: (msg, meta) => infoLogs.push({ msg, meta }) };

  const stations = [
    { sourceStationId: 'dgt-1', location: { type: 'Point', coordinates: [0, 0] }, prices: undefined, availability: undefined },
  ];

  const result = await enrichStationsPublic(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger,
    thresholdMeters: 100,
  });

  assert.equal(result[0].reveLocationId, 'reve-real-match');

  const sweepLog = infoLogs.find((l) => l.msg === 'Reve public locations sweep complete');
  assert.ok(sweepLog, 'expected the sweep-complete log line');
  assert.equal(sweepLog.meta.fetched, 201);
  assert.equal(sweepLog.meta.kept, 1, 'only the one geographically/nominally relevant location should be kept');
});

test('enrichStationsPublic keeps only the best candidate per station even when many pass the proximity filter (bounded memory under a high keep ratio)', async () => {
  // A loose threshold plus dense-ish coverage means MOST incoming locations pass the
  // proximity filter (this is the real production shape: national DGT density means a
  // high fraction of Reve locations are "kept" candidates). Regardless of how many are
  // kept, only the single best (closest) one per station may remain resident at a time —
  // worse candidates must be evicted immediately, not accumulated.
  // The SpatialIndex only scans the 3x3 grid neighborhood around a point (cellSize
  // ~111m), so candidates must stay within that reach for the proximity filter to see
  // them at all — spread these ~0.56m apart, topping out at ~56m, well inside both the
  // grid's search radius and the thresholdMeters below.
  const candidates = Array.from({ length: 100 }, (_, i) =>
    samplePublicLocation({
      id: `reve-cand-${i}`,
      name: `Candidate ${i}`,
      coordinates: { latitude: String(0.000005 * (i + 1)), longitude: '0' },
    }),
  );
  // The true nearest candidate is placed last in arrival order, and a worse one first —
  // proves the final match isn't just "whatever arrived first/last" but the actual best.
  const ordered = [...candidates.slice(1), candidates[0]];

  const fakeHttpClient = {
    post: async () => ({
      status: 200,
      data: { data: ordered, pagination: { page: 1, per_page: ordered.length, total_pages: 1, total_count: ordered.length } },
    }),
  };

  const infoLogs = [];
  const logger = { ...silentLogger, info: (msg, meta) => infoLogs.push({ msg, meta }) };

  const stations = [
    { sourceStationId: 'dgt-1', location: { type: 'Point', coordinates: [0, 0] }, prices: undefined, availability: undefined },
  ];

  const result = await enrichStationsPublic(stations, {
    acknowledgeUnsupported: true,
    httpClient: fakeHttpClient,
    logger,
    thresholdMeters: 100,
  });

  assert.equal(result[0].reveLocationId, 'reve-cand-0', 'the closest candidate must win regardless of arrival order');

  const sweepLog = infoLogs.find((l) => l.msg === 'Reve public locations sweep complete');
  assert.equal(sweepLog.meta.fetched, 100);
  // Normalizing (parsing the full nested evses/connectors/tariffs payload) is deferred
  // until a candidate is actually about to become a station's new best match — a
  // candidate that is already worse than what's held is skipped before ever being
  // normalized. With 99 candidates arriving worse-first and the true best arriving last,
  // only 2 ever get normalized (the initial best, then the true best that replaces it) —
  // nowhere near the 100 that merely passed the coarse coordinate-only proximity check.
  assert.equal(sweepLog.meta.kept, 2);
});
