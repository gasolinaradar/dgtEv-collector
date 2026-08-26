// Side-by-side smoke test: does the experimental /api/public/v1 path produce data that
// feeds the SAME Station enrichment fields (operator, prices via allConnectors, lat/lon)
// as the documented, supported /api/external/v1 client?
//
// Opt-in only: requires REVE_API_KEY, and fetches exactly ONE page (limit=1) from
// /api/external/v1, which spends 1 of that key's 5 requests/hour. It is intentionally
// excluded from `npm test` and `npm run test:live`. Run explicitly with:
//   REVE_API_KEY=xxx npm run test:live-compare

const { test } = require('node:test');
const assert = require('node:assert');
const { createReveClient } = require('../src/reve');
const { createRevePublicClient } = require('../src/reve-public');
const { normalizeReveLocation } = require('../src/enrich');
const { normalizeRevePublicLocation } = require('../src/enrich-public');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };
const hasKey = Boolean(process.env.REVE_API_KEY);
const KNOWN_LOCATION_ID = 'bf98707f-8ba7-4e2a-8934-3aff07c04a70';

test(
  'external v1 and public v1 both normalize into the same Station-enrichment shape',
  { skip: !hasKey && 'set REVE_API_KEY to run this (spends 1 of its 5 req/h)' },
  async () => {
    const externalClient = createReveClient({ apiKey: process.env.REVE_API_KEY, logger: silentLogger });
    const publicClient = createRevePublicClient({ acknowledgeUnsupported: true, logger: silentLogger });

    // 1 request against /api/external/v1 (counts toward the 5/h budget).
    let externalPage = [];
    for await (const page of externalClient.streamLocations({ pageSize: 1 })) {
      externalPage = page;
      break;
    }
    assert.ok(externalPage.length > 0, 'expected at least one location from /api/external/v1');

    // 1 request against /api/public/v1 (no documented rate limit).
    const publicLocation = await publicClient.fetchLocation(KNOWN_LOCATION_ID);

    const normalizedExternal = normalizeReveLocation(externalPage[0]);
    const normalizedPublic = normalizeRevePublicLocation(publicLocation);

    assert.ok(normalizedExternal, 'external v1 location should normalize');
    assert.ok(normalizedPublic, 'public v1 location should normalize');

    // Same output contract: both give a matchable point plus operator/connector data
    // that enrichStations() / enrichStationsExperimental() rely on.
    for (const n of [normalizedExternal, normalizedPublic]) {
      assert.ok(Number.isFinite(n.lat));
      assert.ok(Number.isFinite(n.lon));
      assert.ok('operator' in n);
    }

    assert.ok(Array.isArray(normalizedExternal.allConnectors));
    assert.ok(Array.isArray(normalizedPublic.allConnectors));
  },
);
