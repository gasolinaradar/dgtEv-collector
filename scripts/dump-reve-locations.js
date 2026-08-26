#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const BASE_URL = 'https://www.mapareve.es/api/public/v1';
const SPAIN_BBOX = { latitude_ne: 44, longitude_ne: 4.5, latitude_sw: 27, longitude_sw: -18.5 };

function parseArgs(argv) {
  const args = { startPage: 1, maxPages: 50, perPage: 25, delayMs: 200, out: './reve-dump.ndjson' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--start-page') { args.startPage = Number(value); i++; }
    else if (flag === '--max-pages') { args.maxPages = Number(value); i++; }
    else if (flag === '--per-page') { args.perPage = Number(value); i++; }
    else if (flag === '--delay-ms') { args.delayMs = Number(value); i++; }
    else if (flag === '--out') { args.out = value; i++; }
    else if (flag === '--bbox') { args.bbox = JSON.parse(value); i++; }
    else if (flag === '--filters') { args.filters = JSON.parse(value); i++; }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.perPage > 25) {
    log(`WARNING: --per-page ${args.perPage} is above the confirmed max of 25 — the API will likely 400.`);
  }

  const body = { ...SPAIN_BBOX, ...(args.bbox || {}), ...(args.filters || {}) };
  const outPath = path.resolve(process.cwd(), args.out);
  const metaPath = `${outPath}.meta.json`;

  log('Starting dump', {
    outPath,
    startPage: args.startPage,
    maxPages: args.maxPages,
    perPage: args.perPage,
    delayMs: args.delayMs,
    body,
  });

  fs.writeFileSync(outPath, '');

  let page = args.startPage;
  let totalPages = null;
  let totalCount = null;
  let pagesFetched = 0;
  let locationsWritten = 0;

  while (pagesFetched < args.maxPages) {
    const start = Date.now();
    try {
      const response = await axios.post(`${BASE_URL}/locations`, body, {
        params: { page, per_page: args.perPage },
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 30000,
      });

      const ms = Date.now() - start;
      const data = Array.isArray(response.data?.data) ? response.data.data : [];
      const pagination = response.data?.pagination;

      if (pagination) {
        totalPages = pagination.total_pages;
        totalCount = pagination.total_count;
      }

      log(`OK  page=${page} status=${response.status} count=${data.length} ms=${ms}` +
        (totalPages ? ` totalPages=${totalPages} totalCount=${totalCount}` : ''));

      if (data.length === 0) {
        log('Empty page — stopping (either past the end, or nothing at this bbox/filter).');
        break;
      }

      const lines = data.map((loc) => JSON.stringify(loc)).join('\n') + '\n';
      fs.appendFileSync(outPath, lines);
      locationsWritten += data.length;

      fs.writeFileSync(metaPath, JSON.stringify({
        lastPageFetched: page,
        nextPage: page + 1,
        totalPages,
        totalCount,
        locationsWritten,
        updatedAt: new Date().toISOString(),
      }, null, 2));

      pagesFetched += 1;

      if (totalPages && page >= totalPages) {
        log('Reached the last page.');
        break;
      }

      page += 1;
      if (pagesFetched < args.maxPages) await sleep(args.delayMs);
    } catch (error) {
      const ms = Date.now() - start;
      log(`FAIL page=${page} ms=${ms}`, {
        message: error.message,
        status: error.response?.status,
        responseBody: error.response?.data,
      });
      log(`Stopping. To resume from this exact page: --start-page ${page}`);
      process.exitCode = 1;
      return;
    }
  }

  log('Done.', { pagesFetched, locationsWritten, outPath, metaPath, resumeFrom: page });
}

main();
