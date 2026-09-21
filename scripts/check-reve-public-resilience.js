#!/usr/bin/env node
// Full live sweep of the undocumented Reve /api/public/v1 source (no SLA):
// walks every page of POST /locations (default ~586 pages / ~14.6k locations),
// re-normalizes each location through normalizeRevePublicLocation +
// mergePublicAvailability, and reports WAF (403) / rate-limit (429) / 5xx /
// page-failure counts and any schema drift.
//
// Exit code 0 = full sweep completed, no failures, no schema drift.
//
// Usage:
//   node scripts/check-reve-public-resilience.js
//   node scripts/check-reve-public-resilience.js --max-pages 50     # short smoke run
//   node scripts/check-reve-public-resilience.js --delay-ms 0       # no pacing between pages

const { createRevePublicClient } = require('../src/reve-public');
const {
  normalizeRevePublicLocation,
  mergePublicAvailability,
} = require('../src/enrich-public');

function parseArgs(argv) {
  const args = { maxPages: Number.MAX_SAFE_INTEGER, delayMs: 150 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--max-pages') { args.maxPages = Number(value); i++; }
    else if (flag === '--delay-ms') { args.delayMs = Number(value); i++; }
    else if (flag === '--per-page') { args.perPage = Number(value); i++; }
  }
  return args;
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const warnStats = { 403: 0, 429: 0, '5xx': 0, other: 0, pageFailures: 0 };

  const logger = {
    info: () => {},
    warn: (msg, meta = {}) => {
      const status = meta.status;
      if (status === 403) warnStats['403'] += 1;
      else if (status === 429) warnStats['429'] += 1;
      else if (status >= 500 && status < 600) warnStats['5xx'] += 1;
      else if (status) warnStats.other += 1;
      if (meta.consecutiveFailures !== undefined) warnStats.pageFailures += 1;
      log('WARN', msg, { page: meta.page, status, consecutiveFailures: meta.consecutiveFailures });
    },
    debug: () => {},
  };

  const client = createRevePublicClient({ acknowledgeUnsupported: true, logger });

  const schemaFailures = [];
  let locations = 0;
  let normalized = 0;
  let withAvailability = 0;

  const sweepStart = Date.now();
  const result = await client.fetchLocationsSweep({
    maxPages: args.maxPages,
    requestDelayMs: args.delayMs,
    ...(args.perPage ? { perPage: args.perPage } : {}),
  });

  for (const loc of result.locations) {
    locations += 1;
    const norm = normalizeRevePublicLocation(loc);
    if (!norm) {
      schemaFailures.push({ id: loc.id, name: loc.name, coordinates: loc.coordinates });
      continue;
    }
    normalized += 1;
    if (loc.evses && loc.evses.some((e) => typeof e.status === 'string')) {
      if (mergePublicAvailability(norm)) withAvailability += 1;
    }
  }

  const elapsedSeconds = ((Date.now() - sweepStart) / 1000).toFixed(1);

  const summary = {
    completedSweep: result.completedSweep,
    totalPages: result.totalPages,
    nextPage: result.nextPage,
    locationsSeen: result.locations.length,
    normalizedOk: normalized,
    withAvailability,
    schemaFailures: schemaFailures.length,
    warnStats,
    elapsedSeconds,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (schemaFailures.length > 0) {
    console.log(JSON.stringify(schemaFailures.slice(0, 20), null, 2));
  }

  const ok =
    result.completedSweep &&
    summary.schemaFailures === 0 &&
    warnStats.pageFailures === 0 &&
    warnStats['403'] === 0 &&
    warnStats['429'] === 0 &&
    warnStats['5xx'] === 0;

  log(`RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  log('FATAL', err?.message, { status: err?.response?.status });
  process.exitCode = 1;
});