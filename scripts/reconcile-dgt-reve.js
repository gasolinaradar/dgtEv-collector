#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { experimental } = require('../src');

function parseArgs(argv) {
  const args = {
    dgt: './dgt-dump.ndjson',
    reve: './reve-dump.ndjson',
    out: './reconciled.ndjson',
    thresholdMeters: 50,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--dgt') { args.dgt = value; i++; }
    else if (flag === '--reve') { args.reve = value; i++; }
    else if (flag === '--out') { args.out = value; i++; }
    else if (flag === '--threshold-meters') { args.thresholdMeters = Number(value); i++; }
  }
  return args;
}

function readNdjson(filePath) {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function createLocalReveHttpClient(reveLocations) {
  return {
    async post(url, data, config) {
      return {
        status: 200,
        data: {
          data: reveLocations,
          pagination: {
            page: 1,
            per_page: config.params.per_page,
            total_count: reveLocations.length,
            total_pages: 1,
          },
        },
      };
    },
  };
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dgtPath = path.resolve(process.cwd(), args.dgt);
  const revePath = path.resolve(process.cwd(), args.reve);
  const outPath = path.resolve(process.cwd(), args.out);

  log('Reading local dumps', { dgtPath, revePath });
  const stations = readNdjson(dgtPath);
  const reveLocations = readNdjson(revePath);
  log('Loaded', { stations: stations.length, reveLocations: reveLocations.length });

  const httpClient = createLocalReveHttpClient(reveLocations);

  const enriched = await experimental.enrichStationsExperimental(stations, {
    acknowledgeUnsupported: true,
    httpClient,
    logger: console,
    thresholdMeters: args.thresholdMeters,
  });

  fs.writeFileSync(outPath, enriched.map((s) => JSON.stringify(s)).join('\n') + '\n');

  log('Done.', {
    outPath,
    totalStations: enriched.length,
    matched: enriched.filter((s) => s.reveLocationId).length,
    withPrices: enriched.filter((s) => s.prices).length,
    withAvailability: enriched.filter((s) => s.availability).length,
  });
}

main();
