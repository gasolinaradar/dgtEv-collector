#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { streamStations } = require('../src');

function parseArgs(argv) {
  const args = { out: './dgt-dump.ndjson', progressEvery: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--out') { args.out = value; i++; }
    else if (flag === '--progress-every') { args.progressEvery = Number(value); i++; }
  }
  return args;
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = path.resolve(process.cwd(), args.out);

  log('Starting DGT dump', { outPath });
  fs.writeFileSync(outPath, '');

  let count = 0;
  const start = Date.now();

  for await (const station of streamStations({ logger: console })) {
    fs.appendFileSync(outPath, JSON.stringify(station) + '\n');
    count += 1;
    if (count % args.progressEvery === 0) {
      log(`Progress: ${count} stations written`, { ms: Date.now() - start });
    }
  }

  log('Done.', { count, outPath, ms: Date.now() - start });
}

main();
