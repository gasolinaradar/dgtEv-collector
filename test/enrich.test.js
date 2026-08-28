const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  haversineMeters,
  SpatialIndex,
  normalizeReveLocation,
  buildTariffMap,
  buildStatusMap,
  mergePrices,
  mergeAvailability,
  mergeConnectorStatus,
  enrichStations,
} = require('../src/enrich');
const { createReveCache } = require('../src/cache');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reve-enrich-test-'));
}

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

test('buildTariffMap carries restrictions through, so two components of the same type with different prices are distinguishable as separate bands, not duplicates', () => {
  const data = [
    {
      connector_id: 'conn-1',
      tariffs: [
        {
          id: 't1',
          currency: 'EUR',
          elements: [
            { price_components: [{ type: 'PARKING_TIME', price: '0', step_size: 60 }], restrictions: { max_duration: 3600 } },
            { price_components: [{ type: 'PARKING_TIME', price: '3', step_size: 60 }] },
          ],
        },
      ],
    },
  ];

  const map = buildTariffMap(data);
  assert.equal(map['conn-1'].length, 2);
  assert.deepEqual(map['conn-1'][0].restrictions, { max_duration: 3600 });
  assert.equal(map['conn-1'][1].restrictions, undefined);
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

test('mergePrices returns tariffs from Reve connectors, tagged with evseId/connectorId', () => {
  const reveConnectors = [
    { connectorId: 'conn-1', evseId: 'evse-1', standard: 'IEC_62196_T2' },
  ];
  const tariffMap = {
    'conn-1': [{ type: 'ENERGY', price: 0.35, currency: 'EUR', stepSize: 1 }],
  };

  const prices = mergePrices(reveConnectors, tariffMap);
  assert.ok(prices);
  assert.equal(prices.length, 1);
  assert.equal(prices[0].price, 0.35);
  assert.equal(prices[0].evseId, 'evse-1');
  assert.equal(prices[0].connectorId, 'conn-1');
});

test('mergePrices carries restrictions through to the final price entries', () => {
  const reveConnectors = [{ connectorId: 'conn-1', evseId: 'evse-1', standard: 'IEC_62196_T2' }];
  const tariffMap = {
    'conn-1': [
      { type: 'PARKING_TIME', price: 0, currency: 'EUR', restrictions: { max_duration: 3600 } },
      { type: 'PARKING_TIME', price: 3, currency: 'EUR' },
    ],
  };

  const prices = mergePrices(reveConnectors, tariffMap);
  assert.equal(prices.length, 2);
  assert.deepEqual(prices[0].restrictions, { max_duration: 3600 });
  assert.equal(prices[1].restrictions, undefined);
});

test('mergePrices returns undefined when no tariffs', () => {
  const prices = mergePrices([], {});
  assert.equal(prices, undefined);
});

test('mergePrices does not dedup identical tariffs across different connectors, so each price stays traceable to its own connector', () => {
  const reveConnectors = [
    { connectorId: 'conn-1', evseId: 'evse-1', standard: 'IEC_62196_T2' },
    { connectorId: 'conn-2', evseId: 'evse-2', standard: 'IEC_62196_T2' },
  ];
  const tariffMap = {
    'conn-1': [{ type: 'ENERGY', price: 0.35, currency: 'EUR', stepSize: 1 }],
    'conn-2': [{ type: 'ENERGY', price: 0.35, currency: 'EUR', stepSize: 1 }],
  };

  const prices = mergePrices(reveConnectors, tariffMap);
  assert.equal(prices.length, 2);
  assert.deepEqual(
    prices.map((p) => p.connectorId).sort(),
    ['conn-1', 'conn-2'],
  );
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

test('mergeAvailability includes a per-EVSE breakdown with connector power/type/id', () => {
  const evses = [
    {
      id: 'evse-slow',
      connectors: [{ id: 'conn-slow', standard: 'IEC_62196_T2', power_type: 'AC_3_PHASE', max_electric_power: 22000 }],
    },
    {
      id: 'evse-fast',
      connectors: [{ id: 'conn-fast', standard: 'IEC_62196_T2_COMBO', power_type: 'DC', max_electric_power: 150000 }],
    },
  ];
  const statusMap = {
    'evse-slow': { status: 'AVAILABLE' },
    'evse-fast': { status: 'OUTOFORDER' },
  };

  const result = mergeAvailability(evses, statusMap);
  assert.equal(result.evses.length, 2);

  const slow = result.evses.find((e) => e.evseId === 'evse-slow');
  assert.equal(slow.status, 'AVAILABLE');
  assert.equal(slow.connectors[0].maxPowerW, 22000);
  // Same connectorId a price entry for this connector would carry (mergePrices) — this is
  // the join key that relates availability and prices back to one physical connector.
  assert.equal(slow.connectors[0].connectorId, 'conn-slow');

  const fast = result.evses.find((e) => e.evseId === 'evse-fast');
  assert.equal(fast.status, 'OUTOFORDER');
  assert.equal(fast.connectors[0].maxPowerW, 150000);
  assert.equal(fast.connectors[0].connectorId, 'conn-fast');
});

test('mergeConnectorStatus matches DGT connectors to their Reve EVSE status by type + power, duplicates included', () => {
  // Reproduces a real station: 3 connector types duplicated x2 in `connectors[]` (DGT), but a
  // single EVSE in Reve reporting only one of each — every duplicate should still resolve to
  // that EVSE's status, and the kW-vs-W rounding (43.7kW vs 43470W) should not block the match.
  const dgtConnectors = [
    { type: 'iec62196T2', maxPowerKw: 43.7 },
    { type: 'iec62196T2COMBO', maxPowerKw: 50 },
    { type: 'chademo', maxPowerKw: 50 },
    { type: 'iec62196T2', maxPowerKw: 43.7 },
    { type: 'iec62196T2COMBO', maxPowerKw: 50 },
    { type: 'chademo', maxPowerKw: 50 },
  ];
  const evseDetails = [
    {
      evseId: 'ES*REP*E10477*1',
      status: 'OUTOFORDER',
      connectors: [
        { standard: 'CHADEMO', maxPowerW: 50000 },
        { standard: 'IEC_62196_T2', maxPowerW: 43470 },
        { standard: 'IEC_62196_T2_COMBO', maxPowerW: 50000 },
      ],
    },
  ];

  const result = mergeConnectorStatus(dgtConnectors, evseDetails);
  assert.equal(result.length, 6);
  for (const conn of result) {
    assert.equal(conn.status, 'OUTOFORDER');
    assert.equal(conn.evseId, 'ES*REP*E10477*1');
  }
});

test('mergeConnectorStatus leaves a connector untouched when it matches EVSEs that disagree on status', () => {
  const dgtConnectors = [{ type: 'iec62196T2', maxPowerKw: 22 }];
  const evseDetails = [
    { evseId: 'evse-a', status: 'AVAILABLE', connectors: [{ standard: 'IEC_62196_T2', maxPowerW: 22000 }] },
    { evseId: 'evse-b', status: 'OUTOFORDER', connectors: [{ standard: 'IEC_62196_T2', maxPowerW: 22000 }] },
  ];

  const result = mergeConnectorStatus(dgtConnectors, evseDetails);
  assert.equal(result[0].status, undefined);
  assert.equal(result[0].evseId, undefined);
});

test('mergeConnectorStatus leaves a connector untouched when its DGT type has no known OCPI equivalent', () => {
  const dgtConnectors = [{ type: 'someUnmappedType', maxPowerKw: 22 }];
  const evseDetails = [{ evseId: 'evse-a', status: 'AVAILABLE', connectors: [{ standard: 'IEC_62196_T2', maxPowerW: 22000 }] }];

  const result = mergeConnectorStatus(dgtConnectors, evseDetails);
  assert.deepEqual(result[0], { type: 'someUnmappedType', maxPowerKw: 22 });
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

test('enrichStations annotates connectors[] with the matched EVSE status end-to-end', async () => {
  const stations = [
    {
      sourceStationId: 'dgt-1',
      name: 'Test Station',
      location: { type: 'Point', coordinates: [-3.7038, 40.4168] },
      connectors: [{ type: 'iec62196T2', maxPowerKw: 22 }],
      prices: undefined,
      availability: undefined,
    },
  ];

  const fakeHttpClient = {
    get: async (url) => {
      if (url.includes('/evses/operational_status')) {
        return { status: 200, data: [{ evse_id: 'evse-1', status: 'CHARGING' }], headers: { 'total-count': '1', 'total-pages': '1' } };
      }
      if (url.includes('/connectors/tariffs')) {
        return { status: 200, data: [], headers: { 'total-count': '0', 'total-pages': '1' } };
      }
      if (url.includes('/locations')) {
        return {
          status: 200,
          data: [
            {
              id: 'reve-1',
              coordinates: { latitude: '40.4168', longitude: '-3.7038' },
              evses: [
                {
                  id: 'evse-1',
                  connectors: [{ id: 'conn-1', standard: 'IEC_62196_T2', max_electric_power: 22000 }],
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

  assert.equal(result[0].connectors[0].status, 'CHARGING');
  assert.equal(result[0].connectors[0].evseId, 'evse-1');
});

test('enrichStations fetches locations before status/tariffs (locations get priority for the shared rate limit)', async () => {
  const callOrder = [];
  const fakeHttpClient = {
    get: async (url) => {
      if (url.includes('/locations')) callOrder.push('locations');
      else if (url.includes('/evses/operational_status')) callOrder.push('status');
      else if (url.includes('/connectors/tariffs')) callOrder.push('tariffs');
      return { status: 200, data: [], headers: { 'total-count': '0', 'total-pages': '1' } };
    },
  };

  await enrichStations([], {
    reveApiKey: 'test-key',
    httpClient: fakeHttpClient,
    logger: silentLogger,
  });

  assert.deepEqual(
    callOrder,
    ['locations', 'status', 'tariffs'],
    'sin locations no puede haber match pase lo que pase con status/tariffs, así que van primero',
  );
});

test('enrichStations reports coarse progress across its locations/status/tariffs stages', async () => {
  const fakeHttpClient = {
    get: async () => ({ status: 200, data: [], headers: { 'total-count': '0', 'total-pages': '1' } }),
  };

  const progressCalls = [];
  await enrichStations([], {
    reveApiKey: 'test-key',
    httpClient: fakeHttpClient,
    logger: silentLogger,
    reportProgress: (percent, meta) => progressCalls.push({ percent, meta }),
  });

  assert.deepEqual(
    progressCalls.map((c) => c.percent),
    [0, 40, 70, 90, 100],
  );
  assert.deepEqual(
    progressCalls.map((c) => c.meta.stage),
    ['reve_locations', 'reve_locations', 'reve_status', 'reve_tariffs', 'reve_enrichment_complete'],
  );
});

test('enrichStations accumulates locations in cache across calls instead of losing coverage each cycle', async () => {
  const dir = tempDir();

  const stationNearLoc1 = {
    sourceStationId: 'dgt-1',
    location: { type: 'Point', coordinates: [-3.7038, 40.4168] },
    connectors: [],
  };

  function buildHttpClient(locationsPage) {
    return {
      get: async (url) => {
        if (url.includes('/locations')) {
          return {
            status: 200,
            data: locationsPage,
            headers: { 'total-count': String(locationsPage.length), 'total-pages': '1' },
          };
        }
        return { status: 200, data: [], headers: { 'total-count': '0', 'total-pages': '1' } };
      },
    };
  }

  const loc1 = { id: 'reve-1', coordinates: { latitude: '40.4168', longitude: '-3.7038' }, evses: [] };
  const loc2 = { id: 'reve-2', coordinates: { latitude: '41.0', longitude: '-4.0' }, evses: [] };

  // Ciclo 1: el fetch de este ciclo solo trae loc1 (simula cupo limitado a una página).
  await enrichStations([stationNearLoc1], {
    reveApiKey: 'test-key',
    cacheDir: dir,
    httpClient: buildHttpClient([loc1]),
    logger: silentLogger,
    thresholdMeters: 100,
  });

  // Ciclo 2: el fetch de este ciclo solo trae loc2 (loc1 no matcheó ya el date_from incremental,
  // p. ej. porque no cambió). loc1 debe seguir matcheando desde el cache acumulado, no perderse.
  const result2 = await enrichStations([stationNearLoc1], {
    reveApiKey: 'test-key',
    cacheDir: dir,
    httpClient: buildHttpClient([loc2]),
    logger: silentLogger,
    thresholdMeters: 100,
  });

  assert.equal(
    result2[0].reveLocationId,
    'reve-1',
    'debe seguir matcheando loc1 aunque el ciclo 2 no la haya vuelto a traer',
  );

  fs.rmSync(dir, { recursive: true });
});

test('a failed locations fetch does not poison lastLocationsFetch (unlike the known status/tariffs bug)', async () => {
  const dir = tempDir();

  const failingHttpClient = {
    get: async (url) => {
      if (url.includes('/locations')) {
        throw new Error('network down');
      }
      return { status: 200, data: [], headers: { 'total-count': '0', 'total-pages': '1' } };
    },
  };

  await enrichStations([], {
    reveApiKey: 'test-key',
    cacheDir: dir,
    httpClient: failingHttpClient,
    logger: silentLogger,
  });

  const cache = createReveCache(dir);
  assert.equal(cache.getLastLocationsFetchDate(), null, 'un fallo no debe dejar timestamp');

  fs.rmSync(dir, { recursive: true });
});

test('availability lookup uses accumulated status cache across cycles, not just the current incremental fetch', async () => {
  const dir = tempDir();

  const station = {
    sourceStationId: 'dgt-1',
    location: { type: 'Point', coordinates: [-3.7038, 40.4168] },
    connectors: [],
  };

  const loc = {
    id: 'reve-1',
    coordinates: { latitude: '40.4168', longitude: '-3.7038' },
    evses: [{ id: 'evse-1', connectors: [] }],
  };

  function buildHttpClient({ locations, status }) {
    return {
      get: async (url) => {
        if (url.includes('/locations')) {
          return {
            status: 200,
            data: locations,
            headers: { 'total-count': String(locations.length), 'total-pages': '1' },
          };
        }
        if (url.includes('/evses/operational_status')) {
          return {
            status: 200,
            data: status,
            headers: { 'total-count': String(status.length), 'total-pages': '1' },
          };
        }
        return { status: 200, data: [], headers: { 'total-count': '0', 'total-pages': '1' } };
      },
    };
  }

  // Ciclo 1: status trae evse-1 = AVAILABLE.
  await enrichStations([station], {
    reveApiKey: 'test-key',
    cacheDir: dir,
    httpClient: buildHttpClient({
      locations: [loc],
      status: [
        { evse_id: 'evse-1', operational_status: true, last_operational_status_updated: '2026-01-01T00:00:00Z' },
      ],
    }),
    logger: silentLogger,
    thresholdMeters: 100,
  });

  // Ciclo 2: el refresh incremental de status no devuelve nada nuevo (evse-1 no cambió) — la
  // disponibilidad debe seguir saliendo del cache acumulado, no desaparecer.
  const result2 = await enrichStations([station], {
    reveApiKey: 'test-key',
    cacheDir: dir,
    httpClient: buildHttpClient({ locations: [loc], status: [] }),
    logger: silentLogger,
    thresholdMeters: 100,
  });

  assert.ok(result2[0].availability, 'la disponibilidad de evse-1 debe seguir viniendo del cache acumulado');
  assert.equal(result2[0].availability.status, 'AVAILABLE');

  fs.rmSync(dir, { recursive: true });
});
