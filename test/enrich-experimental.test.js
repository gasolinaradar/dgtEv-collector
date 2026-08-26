const { test } = require('node:test');
const assert = require('node:assert');
const {
  enrichStationsExperimental,
  normalizeRevePublicLocation,
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
