const { test } = require('node:test');
const assert = require('node:assert');
const {
  haversineMeters,
  SpatialIndex,
  normalizeReveLocation,
  buildTariffMap,
  buildStatusMap,
  mergePrices,
  mergeAvailability,
  enrichStations,
} = require('../src/enrich');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

test('haversineMeters calculates distance between two points', () => {
  const dist = haversineMeters(40.4168, -3.7038, 40.417, -3.704);
  assert.ok(dist > 0);
  assert.ok(dist < 100);

  const dist2 = haversineMeters(40.4168, -3.7038, 43.263, -2.935);
  assert.ok(dist2 > 300000);
});

test('SpatialIndex finds nearest item within threshold', () => {
  const index = new SpatialIndex();
  index.insert('A', 40.4168, -3.7038);
  index.insert('B', 43.263, -2.935);

  const hit = index.findNearest(40.417, -3.704, 100);
  assert.ok(hit);
  assert.equal(hit.item, 'A');
  assert.ok(hit.distance < 100);

  const miss = index.findNearest(41.0, -4.0, 1000);
  assert.equal(miss, null);
});

test('SpatialIndex finds nearest among multiple candidates', () => {
  const index = new SpatialIndex();
  index.insert('close', 40.4168, -3.7038);
  index.insert('far', 40.5, -3.8);

  const hit = index.findNearest(40.417, -3.704, 5000);
  assert.ok(hit);
  assert.equal(hit.item, 'close');
});

test('normalizeReveLocation parses Reve location object', () => {
  const loc = {
    id: 'reve-123',
    coordinates: { latitude: '40.4168', longitude: '-3.7038' },
    party_id: 'ES*WEN',
    cpo_name: 'Wenea Services Spain, S.L.',
    owner: 'Wenea - www.wenea.es',
    name: null,
    address: 'Calle Mayor 1',
    city: 'Madrid',
    postal_code: '28013',
    evses: [
      {
        id: 'evse-1',
        connectors: [
          {
            id: 'conn-1',
            standard: 'IEC_62196_T2',
            format: 'SOCKET',
            power_type: 'AC_3_PHASE',
            max_electric_power: 22000,
            max_voltage: 400,
            max_amperage: 32,
          },
        ],
      },
    ],
  };

  const result = normalizeReveLocation(loc);
  assert.ok(result);
  assert.equal(result.reveLocationId, 'reve-123');
  assert.equal(result.lat, 40.4168);
  assert.equal(result.lon, -3.7038);
  assert.equal(result.operator.name, 'Wenea');
  assert.equal(result.operator.website, 'www.wenea.es');
  assert.equal(result.allConnectors.length, 1);
  assert.equal(result.allConnectors[0].standard, 'IEC_62196_T2');
});

test('normalizeReveLocation returns null for invalid coordinates', () => {
  const loc = {
    id: 'reve-bad',
    coordinates: { latitude: null, longitude: '-3.7038' },
  };
  assert.equal(normalizeReveLocation(loc), null);
});

test('normalizeReveLocation parses owner with URL in the middle', () => {
  const loc = {
    id: 'reve-456',
    coordinates: { latitude: '40.4168', longitude: '-3.7038' },
    party_id: 'ES*END',
    cpo_name: 'Endesa',
    owner: 'Energía Plus - Solar - https://energiaplus.es',
    evses: [],
  };

  const result = normalizeReveLocation(loc);
  assert.ok(result);
  assert.equal(result.operator.name, 'Energía Plus - Solar');
  assert.equal(result.operator.website, 'https://energiaplus.es');
});

test('normalizeReveLocation parses owner with no URL', () => {
  const loc = {
    id: 'reve-789',
    coordinates: { latitude: '40.4168', longitude: '-3.7038' },
    party_id: 'ES*IBE',
    cpo_name: 'Iberdrola',
    owner: 'Iberdrola',
    evses: [],
  };

  const result = normalizeReveLocation(loc);
  assert.ok(result);
  assert.equal(result.operator.name, 'Iberdrola');
  assert.equal(result.operator.website, null);
});

test('buildTariffMap creates connector-to-tariffs mapping', () => {
  const data = [
    {
      connector_id: 'conn-1',
      tariffs: [
        {
          id: 't1',
          currency: 'EUR',
          elements: [
            {
              price_components: [
                { type: 'ENERGY', price: '0.35', step_size: 1 },
                { type: 'TIME', price: '0.05', step_size: 60 },
              ],
            },
          ],
        },
      ],
    },
  ];

  const map = buildTariffMap(data);
  assert.equal(map['conn-1'].length, 2);
  assert.equal(map['conn-1'][0].type, 'ENERGY');
  assert.equal(map['conn-1'][0].price, 0.35);
  assert.equal(map['conn-1'][1].type, 'TIME');
  assert.equal(map['conn-1'][1].price, 0.05);
});

test('buildStatusMap creates evse-to-status mapping from boolean format', () => {
  const data = [
    { evse_id: 'evse-1', operational_status: true, last_operational_status_updated: '2026-01-01T00:00:00Z' },
    { evse_id: 'evse-2', operational_status: false, last_operational_status_updated: '2026-01-02T00:00:00Z' },
  ];

  const map = buildStatusMap(data);
  assert.equal(map['evse-1'].status, 'AVAILABLE');
  assert.equal(map['evse-2'].status, 'INOPERATIVE');
});

test('buildStatusMap uses status field from EvseStatus when available', () => {
  const data = [
    { evse_id: 'evse-1', status: 'CHARGING', last_status_updated: '2026-01-01T00:00:00Z' },
    { evse_id: 'evse-2', status: 'BLOCKED', last_status_updated: '2026-01-02T00:00:00Z' },
    { evse_id: 'evse-3', operational_status: true, last_operational_status_updated: '2026-01-03T00:00:00Z' },
  ];

  const map = buildStatusMap(data);
  assert.equal(map['evse-1'].status, 'CHARGING');
  assert.equal(map['evse-2'].status, 'BLOCKED');
  assert.equal(map['evse-3'].status, 'AVAILABLE');
});

test('mergePrices returns tariffs from Reve connectors', () => {
  const dgtConnectors = [{ type: 'IEC_62196_T2' }];
  const reveConnectors = [
    { connectorId: 'conn-1', evseId: 'evse-1', standard: 'IEC_62196_T2' },
  ];
  const tariffMap = {
    'conn-1': [{ type: 'ENERGY', price: 0.35, currency: 'EUR', stepSize: 1 }],
  };

  const prices = mergePrices(dgtConnectors, reveConnectors, tariffMap);
  assert.ok(prices);
  assert.equal(prices.length, 1);
  assert.equal(prices[0].price, 0.35);
});

test('mergePrices returns undefined when no tariffs', () => {
  const prices = mergePrices([], [], {});
  assert.equal(prices, undefined);
});

test('mergeAvailability returns most severe status', () => {
  const evses = [{ id: 'evse-1' }, { id: 'evse-2' }];
  const statusMap = {
    'evse-1': { status: 'AVAILABLE' },
    'evse-2': { status: 'CHARGING' },
  };

  const result = mergeAvailability(evses, statusMap);
  assert.ok(result);
  assert.equal(result.status, 'CHARGING');
  assert.equal(result.evseCount, 2);
});

test('mergeAvailability returns undefined for empty evses', () => {
  assert.equal(mergeAvailability([], {}), undefined);
  assert.equal(mergeAvailability(undefined, {}), undefined);
});

test('enrichStations returns original when no API key', async () => {
  const stations = [
    {
      sourceStationId: '1',
      location: { type: 'Point', coordinates: [-3.7038, 40.4168] },
      prices: undefined,
      availability: undefined,
    },
  ];

  const result = await enrichStations(stations, {});
  assert.deepEqual(result, stations);
});

test('enrichStations matches DGT stations to Reve by proximity', async () => {
  const stations = [
    {
      sourceStationId: 'dgt-1',
      name: 'Test Station',
      location: { type: 'Point', coordinates: [-3.7038, 40.4168] },
      connectors: [{ type: 'IEC_62196_T2' }],
      prices: undefined,
      availability: undefined,
    },
  ];

  let locationsFetched = false;
  const fakeHttpClient = {
    get: async (url, config) => {
      if (url.includes('/evses/operational_status')) {
        return {
          status: 200,
          data: [{ evse_id: 'evse-1', operational_status: true, last_operational_status_updated: '2026-01-01T00:00:00Z' }],
          headers: { 'total-count': '1', 'total-pages': '1' },
        };
      }
      if (url.includes('/connectors/tariffs')) {
        return {
          status: 200,
          data: [
            {
              connector_id: 'conn-1',
              tariffs: [
                {
                  id: 't1',
                  currency: 'EUR',
                  elements: [{ price_components: [{ type: 'ENERGY', price: '0.35', step_size: 1 }] }],
                },
              ],
              last_tariff_updated: '2026-01-01T00:00:00Z',
            },
          ],
          headers: { 'total-count': '1', 'total-pages': '1' },
        };
      }
      if (url.includes('/locations')) {
        locationsFetched = true;
        return {
          status: 200,
          data: [
            {
              id: 'reve-1',
              coordinates: { latitude: '40.4168', longitude: '-3.7038' },
              party_id: 'ES*WEN',
              cpo_name: 'Wenea',
              owner: 'Wenea - www.wenea.es',
              address: 'Calle Mayor 1',
              city: 'Madrid',
              postal_code: '28013',
              country: 'ESP',
              version: 'V221',
              time_zone: 'Europe/Madrid',
              last_updated: '2026-01-01T00:00:00Z',
              evses: [
                {
                  id: 'evse-1',
                  accessibility: 'SI',
                  coordinates: { latitude: '40.4168', longitude: '-3.7038' },
                  last_static_updated: '2026-01-01T00:00:00Z',
                  connectors: [
                    {
                      id: 'conn-1',
                      standard: 'IEC_62196_T2',
                      format: 'SOCKET',
                      power_type: 'AC_3_PHASE',
                      max_electric_power: 22000,
                      max_voltage: 400,
                      max_amperage: 32,
                      last_static_updated: '2026-01-01T00:00:00Z',
                    },
                  ],
                },
              ],
            },
          ],
          headers: { 'total-count': '1', 'total-pages': '1' },
        };
      }
      return { status: 200, data: [], headers: { 'total-count': '0', 'total-pages': '1' } };
    },
  };

  const result = await enrichStations(stations, {
    reveApiKey: 'test-key',
    httpClient: fakeHttpClient,
    logger: silentLogger,
    thresholdMeters: 100,
  });

  assert.equal(result.length, 1);
  assert.equal(locationsFetched, true);
  assert.equal(result[0].reveLocationId, 'reve-1');
  assert.ok(result[0].prices);
  assert.equal(result[0].prices[0].price, 0.35);
  assert.ok(result[0].availability);
  assert.equal(result[0].availability.status, 'AVAILABLE');
  assert.equal(result[0].operator.name, 'Wenea');
});
