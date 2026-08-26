// Live tests against the REAL, undocumented https://www.mapareve.es/api/public/v1.
// No API key needed — but keep this file's request count small and don't add loops
// that page through the full nationwide dataset (that belongs in manual/experimental
// use, not in a test that anyone can run). Run with: npm run test:live-public

const { test } = require('node:test');
const assert = require('node:assert');
const { createRevePublicClient } = require('../src/reve-public');
const { normalizeRevePublicLocation, mergePublicAvailability } = require('../src/enrich-public');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

const SPAIN_LATITUDE_RANGE = [27, 44];
const SPAIN_LONGITUDE_RANGE = [-18.5, 4.5];

// Captured during the mapareve.es investigation (2026-08-26). May stop existing if the
// site removes/relocates this station — the test skips itself rather than failing if so.
const KNOWN_LOCATION_ID = 'bf98707f-8ba7-4e2a-8934-3aff07c04a70';

const client = createRevePublicClient({ acknowledgeUnsupported: true, logger: silentLogger });

test('live /locations/{id}: returns a real, well-formed location', async (t) => {
  let loc;
  try {
    loc = await client.fetchLocation(KNOWN_LOCATION_ID);
  } catch (error) {
    if (error?.response?.status === 404) {
      t.skip(`known test location ${KNOWN_LOCATION_ID} no longer exists`);
      return;
    }
    throw error;
  }

  assert.equal(loc.id, KNOWN_LOCATION_ID);
  assert.ok(loc.name);
  assert.ok(Array.isArray(loc.evses));

  const normalized = normalizeRevePublicLocation(loc);
  assert.ok(normalized, 'normalizeRevePublicLocation should accept a real response');
  assert.ok(normalized.lat >= SPAIN_LATITUDE_RANGE[0] && normalized.lat <= SPAIN_LATITUDE_RANGE[1]);
  assert.ok(normalized.lon >= SPAIN_LONGITUDE_RANGE[0] && normalized.lon <= SPAIN_LONGITUDE_RANGE[1]);

  if (normalized.evseStatuses.length > 0) {
    const availability = mergePublicAvailability(normalized);
    assert.ok(availability);
    assert.ok(Number.isInteger(availability.evseCount));
  }
});

test('live /connector_types and /facilities: return non-empty catalogs', async () => {
  const [types, facilities] = await Promise.all([client.fetchConnectorTypes(), client.fetchFacilities()]);

  assert.ok(Array.isArray(types) && types.length > 0);
  assert.ok(types.every((t) => typeof t.code === 'string'));

  assert.ok(Array.isArray(facilities) && facilities.length > 0);
  assert.ok(facilities.every((f) => typeof f.code === 'string' && typeof f.name === 'string'));
});

test('live POST /markers: viewport query returns clusters and/or locations', async () => {
  const markers = await client.fetchMarkers({
    latitudeNe: 40.55,
    longitudeNe: -3.55,
    latitudeSw: 40.3,
    longitudeSw: -3.85,
    zoom: 12,
  });

  assert.ok(Array.isArray(markers));
  assert.ok(markers.length > 0, 'expected at least one marker/cluster for the Madrid viewport');
  for (const m of markers) {
    assert.ok(['cluster', 'location', 'locations'].includes(m.type), `unexpected marker type: ${m.type}`);
    assert.ok(Number.isFinite(m.latitude) && Number.isFinite(m.longitude));
  }
});
