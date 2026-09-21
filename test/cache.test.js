const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createReveCache, createSweepCache } = require('../src/cache');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reve-cache-test-'));
}

test('createReveCache creates directory and files', () => {
  const dir = tempDir();
  const cache = createReveCache(dir);

  assert.ok(fs.existsSync(dir));
  assert.ok(cache);

  fs.rmSync(dir, { recursive: true });
});

test('loadAllStatus returns empty object when no cache exists', () => {
  const dir = tempDir();
  const cache = createReveCache(dir);
  assert.deepEqual(cache.loadAllStatus(), {});

  fs.rmSync(dir, { recursive: true });
});

test('bulkUpdateStatus persists and loads data', () => {
  const dir = tempDir();
  const cache = createReveCache(dir);

  cache.bulkUpdateStatus({
    'evse-1': { status: 'AVAILABLE', lastUpdated: '2026-01-01T00:00:00Z' },
    'evse-2': { status: 'CHARGING', lastUpdated: '2026-01-02T00:00:00Z' },
  });

  const all = cache.loadAllStatus();
  assert.equal(Object.keys(all).length, 2);
  assert.equal(all['evse-1'].status, 'AVAILABLE');
  assert.equal(all['evse-2'].status, 'CHARGING');

  const single = cache.getStatusByEvseId('evse-1');
  assert.equal(single.status, 'AVAILABLE');

  const missing = cache.getStatusByEvseId('evse-999');
  assert.equal(missing, null);

  fs.rmSync(dir, { recursive: true });
});

test('bulkUpdateTariffs persists and loads data', () => {
  const dir = tempDir();
  const cache = createReveCache(dir);

  cache.bulkUpdateTariffs({
    'conn-1': [{ type: 'ENERGY', price: 0.35, currency: 'EUR' }],
    'conn-2': [{ type: 'FLAT', price: 5.0, currency: 'EUR' }],
  });

  const all = cache.loadAllTariffs();
  assert.equal(Object.keys(all).length, 2);
  assert.equal(all['conn-1'][0].price, 0.35);

  const single = cache.getTariffsByConnectorId('conn-2');
  assert.equal(single[0].type, 'FLAT');

  fs.rmSync(dir, { recursive: true });
});

test('updateStatus updates timestamp in meta', () => {
  const dir = tempDir();
  const cache = createReveCache(dir);

  assert.equal(cache.getLastStatusFetchDate(), null);

  cache.updateStatus('evse-1', { status: 'AVAILABLE', lastUpdated: '2026-01-01T00:00:00Z' });

  const ts = cache.getLastStatusFetchDate();
  assert.ok(ts);
  assert.ok(new Date(ts) instanceof Date);

  fs.rmSync(dir, { recursive: true });
});

test('updateTariff updates timestamp in meta', () => {
  const dir = tempDir();
  const cache = createReveCache(dir);

  assert.equal(cache.getLastTariffsFetchDate(), null);

  cache.updateTariff('conn-1', [{ type: 'ENERGY', price: 0.35, currency: 'EUR' }]);

  const ts = cache.getLastTariffsFetchDate();
  assert.ok(ts);

  fs.rmSync(dir, { recursive: true });
});

test('loadAllLocations returns empty object when no cache exists', () => {
  const dir = tempDir();
  const cache = createReveCache(dir);
  assert.deepEqual(cache.loadAllLocations(), {});
  assert.equal(cache.getLastLocationsFetchDate(), null);

  fs.rmSync(dir, { recursive: true });
});

test('bulkUpdateLocations persists, merges, and bumps lastLocationsFetch', () => {
  const dir = tempDir();
  const cache = createReveCache(dir);

  cache.bulkUpdateLocations({
    'reve-1': { reveLocationId: 'reve-1', lat: 40.4, lon: -3.7 },
  });

  let all = cache.loadAllLocations();
  assert.equal(Object.keys(all).length, 1);
  assert.equal(all['reve-1'].lat, 40.4);

  const firstFetch = cache.getLastLocationsFetchDate();
  assert.ok(firstFetch);

  // Un segundo bulkUpdateLocations con una ubicación distinta debe MERGEAR, no reemplazar la
  // colección entera — así es como se acumula cobertura entre ciclos limitados por rate limit.
  cache.bulkUpdateLocations({
    'reve-2': { reveLocationId: 'reve-2', lat: 41.0, lon: -4.0 },
  });

  all = cache.loadAllLocations();
  assert.equal(Object.keys(all).length, 2, 'la ubicación del primer ciclo debe seguir presente');
  assert.ok(all['reve-1']);
  assert.ok(all['reve-2']);

  fs.rmSync(dir, { recursive: true });
});

test('cache is atomic (uses tmp + rename)', () => {
  const dir = tempDir();
  const cache = createReveCache(dir);

  cache.bulkUpdateStatus({ 'evse-1': { status: 'AVAILABLE', lastUpdated: '2026-01-01T00:00:00Z' } });

  const files = fs.readdirSync(dir);
  assert.ok(!files.some((f) => f.endsWith('.tmp')));

  fs.rmSync(dir, { recursive: true });
});

test('createSweepCache persists pages and the nextPage cursor', () => {
  const dir = tempDir();
  const cache = createSweepCache(dir, { body: { latitude_ne: 44 }, perPage: 25 });

  const pageResult = { data: [{ id: 'loc-1' }], page: 1, totalPages: 7 };
  cache.setPage(1, pageResult);

  assert.deepEqual(cache.getPage(1), pageResult);
  assert.equal(cache.getPage(2), null);
  assert.deepEqual(cache.loadMeta(), { nextPage: 2, totalPages: 7, updatedAt: cache.loadMeta().updatedAt });

  fs.rmSync(dir, { recursive: true });
});

test('createSweepCache page expires once cacheTtlMs has passed (re-fetchable)', () => {
  const dir = tempDir();
  const cache = createSweepCache(dir, { body: { latitude_ne: 44 }, perPage: 25 });
  const pageResult = { data: [{ id: 'loc-1' }], page: 1, totalPages: 1 };
  cache.setPage(1, pageResult);

  const old = new Date(2000, 0, 1);
  fs.utimesSync(cache.pageFile(1), old, old);

  assert.equal(cache.getPage(1, 0), null, 'expired page must be treated as absent so it gets re-fetched');
  assert.deepEqual(cache.getPage(1), pageResult, 'without a TTL the page still serves from disk');

  fs.rmSync(dir, { recursive: true });
});

test('createSweepCache keeps different queries in separate caches', () => {
  const dir = tempDir();
  const withFilter = createSweepCache(dir, { body: { latitude_ne: 44, power_min: 43 }, perPage: 25 });
  const withoutFilter = createSweepCache(dir, { body: { latitude_ne: 44 }, perPage: 25 });
  const otherPageSize = createSweepCache(dir, { body: { latitude_ne: 44 }, perPage: 1 });

  withFilter.setPage(1, { data: [{ id: 'loc-1' }], page: 1, totalPages: 1 });

  assert.deepEqual(withFilter.getPage(1), { data: [{ id: 'loc-1' }], page: 1, totalPages: 1 });
  assert.equal(withoutFilter.getPage(1), null, 'a different body must not reuse pages');
  assert.equal(otherPageSize.getPage(1), null, 'a different per_page must not reuse pages');

  fs.rmSync(dir, { recursive: true });
});
