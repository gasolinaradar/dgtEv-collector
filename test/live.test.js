const { test, before } = require('node:test');
const assert = require('node:assert');
const { createDgtEvCollector, fetchStations } = require('../src');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

const SPAIN_LATITUDE_RANGE = [27, 44];
const SPAIN_LONGITUDE_RANGE = [-18.5, 4.5];

let stations;

before(async () => {
  stations = await fetchStations({ logger: silentLogger });
});

test('real DGT API: full fetch returns normalized EV charging sites', () => {
  assert.ok(stations.length > 1000, `expected a large dataset, got ${stations.length}`);

  const sample = stations[0];
  assert.equal(sample.source, 'dgt-ev');
  assert.equal(sample.country, 'ES');
  assert.ok(sample.sourceStationId, 'station should have a source id');
  assert.ok(sample.name, 'station should have a name');
  assert.ok(Number.isFinite(sample.location?.coordinates?.[0]));
  assert.ok(Number.isFinite(sample.location?.coordinates?.[1]));
  assert.ok(sample.lastUpdated instanceof Date);

  const withConnectors = stations.filter(
    (station) => Array.isArray(station.connectors) && station.connectors.length > 0,
  );
  assert.ok(withConnectors.length > 0, 'expected at least one station with connector details');
});

test('real DGT API: every site has the required shape', () => {
  for (const station of stations) {
    assert.equal(station.source, 'dgt-ev', `wrong source for ${station.sourceStationId}`);
    assert.equal(station.country, 'ES', `wrong country for ${station.sourceStationId}`);
    assert.ok(station.sourceStationId, `missing source id for ${station.sourceStationId}`);
    assert.ok(station.name, `missing name for ${station.sourceStationId}`);
    assert.ok(Number.isFinite(station.location?.coordinates?.[0]));
    assert.ok(Number.isFinite(station.location?.coordinates?.[1]));
    assert.ok(station.lastUpdated instanceof Date);
  }
});

test('real DGT API: coordinates fall within Spain', () => {
  for (const station of stations) {
    const [lon, lat] = station.location.coordinates;
    assert.ok(
      lat >= SPAIN_LATITUDE_RANGE[0] && lat <= SPAIN_LATITUDE_RANGE[1],
      `latitude out of Spain range for ${station.sourceStationId}: ${lat}`,
    );
    assert.ok(
      lon >= SPAIN_LONGITUDE_RANGE[0] && lon <= SPAIN_LONGITUDE_RANGE[1],
      `longitude out of Spain range for ${station.sourceStationId}: ${lon}`,
    );
  }
});

test('real DGT API: no duplicate source site ids', () => {
  const ids = stations.map((station) => station.sourceStationId);
  assert.equal(new Set(ids).size, ids.length, 'sourceStationId must be unique');
});

test('real DGT API: connectors are well-formed when present', () => {
  const withConnectors = stations.filter(
    (station) => Array.isArray(station.connectors) && station.connectors.length > 0,
  );
  assert.ok(withConnectors.length > 0, 'expected at least one station with connectors');

  for (const station of withConnectors) {
    for (const connector of station.connectors) {
      assert.ok(connector.type, `missing connector type for ${station.sourceStationId}`);
      assert.ok(
        connector.maxPowerKw === undefined || connector.maxPowerKw > 0,
        `invalid connector power for ${station.sourceStationId}`,
      );
    }
  }
});

test('real DGT API: collector contract reports progress end to end', async () => {
  const collector = createDgtEvCollector({ logger: silentLogger });
  const steps = [];

  const result = await collector.fetch({
    reportProgress(percent, metadata = {}) {
      steps.push({ percent, metadata });
    },
  });

  assert.ok(result.length > 0);
  assert.equal(steps[0].percent, 5);
  assert.equal(steps[0].metadata.stage, 'requesting_dataset');
  assert.ok(steps.some((step) => step.percent === 35 && step.metadata.stage === 'parsing_dataset'));
  assert.ok(
    steps.some((step) => step.percent === 70 && step.metadata.stage === 'normalizing_dataset'),
  );
  assert.equal(steps[steps.length - 1].percent, 100);
  assert.equal(steps[steps.length - 1].metadata.stage, 'completed');
});
