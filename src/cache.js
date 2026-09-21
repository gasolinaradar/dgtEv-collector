const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function createReveCache(dirPath) {
  ensureDir(dirPath);

  const statusFile = path.join(dirPath, 'operational_status.json');
  const tariffsFile = path.join(dirPath, 'tariffs.json');
  const locationsFile = path.join(dirPath, 'locations.json');
  const metaFile = path.join(dirPath, 'meta.json');

  function loadMeta() {
    return (
      readJson(metaFile) || { lastStatusFetch: null, lastTariffsFetch: null, lastLocationsFetch: null }
    );
  }

  function saveMeta(meta) {
    writeJson(metaFile, meta);
  }

  function loadStatus() {
    return readJson(statusFile) || {};
  }

  function saveStatus(data) {
    writeJson(statusFile, data);
  }

  function loadTariffs() {
    return readJson(tariffsFile) || {};
  }

  function saveTariffs(data) {
    writeJson(tariffsFile, data);
  }

  function loadLocations() {
    return readJson(locationsFile) || {};
  }

  function saveLocations(data) {
    writeJson(locationsFile, data);
  }

  return {
    getStatusByEvseId(evseId) {
      const cache = loadStatus();
      return cache[evseId] || null;
    },

    getTariffsByConnectorId(connectorId) {
      const cache = loadTariffs();
      return cache[connectorId] || null;
    },

    getLastStatusFetchDate() {
      return loadMeta().lastStatusFetch;
    },

    getLastTariffsFetchDate() {
      return loadMeta().lastTariffsFetch;
    },

    getLastLocationsFetchDate() {
      return loadMeta().lastLocationsFetch;
    },

    updateStatus(evseId, statusEntry) {
      const cache = loadStatus();
      cache[evseId] = statusEntry;
      saveStatus(cache);
      const meta = loadMeta();
      meta.lastStatusFetch = new Date().toISOString();
      saveMeta(meta);
    },

    bulkUpdateStatus(entries) {
      const cache = loadStatus();
      for (const [evseId, entry] of Object.entries(entries)) {
        cache[evseId] = entry;
      }
      saveStatus(cache);
      const meta = loadMeta();
      meta.lastStatusFetch = new Date().toISOString();
      saveMeta(meta);
    },

    updateTariff(connectorId, tariffEntry) {
      const cache = loadTariffs();
      cache[connectorId] = tariffEntry;
      saveTariffs(cache);
      const meta = loadMeta();
      meta.lastTariffsFetch = new Date().toISOString();
      saveMeta(meta);
    },

    bulkUpdateTariffs(entries) {
      const cache = loadTariffs();
      for (const [connectorId, entry] of Object.entries(entries)) {
        cache[connectorId] = entry;
      }
      saveTariffs(cache);
      const meta = loadMeta();
      meta.lastTariffsFetch = new Date().toISOString();
      saveMeta(meta);
    },

    // A diferencia de bulkUpdateStatus/bulkUpdateTariffs (llamadas incondicionalmente incluso
    // cuando el fetch falló y se recompuso desde cache), esta se llama solo dentro del try de un
    // fetch de locations que tuvo éxito de verdad — así lastLocationsFetch nunca se envenena con
    // la fecha de un intento fallido.
    bulkUpdateLocations(entries) {
      const cache = loadLocations();
      for (const [locationId, entry] of Object.entries(entries)) {
        cache[locationId] = entry;
      }
      saveLocations(cache);
      const meta = loadMeta();
      meta.lastLocationsFetch = new Date().toISOString();
      saveMeta(meta);
    },

    loadAllStatus() {
      return loadStatus();
    },

    loadAllTariffs() {
      return loadTariffs();
    },

    loadAllLocations() {
      return loadLocations();
    },
  };
}

// Page cache for flat sweeps (p. ej. el barrido completo del source público /api/public/v1):
// un fichero JSON por página (con su totalPages) + un meta-curso con la siguiente página. La
// clave incluye body y per_page para que filtros distintos no compartan páginas. getPage acepta
// un TTL: sin él (undefined) la página se sirve siempre desde disco; con él, se re-fetchea cuando
// caduca. El propio cache ES el cursor: basta con saber qué páginas hay escritas en disco para
// saber qué saltarse.
function createSweepCache(dirPath, { body, perPage } = {}) {
  const key = createHash('sha1').update(JSON.stringify({ body, perPage })).digest('hex').slice(0, 12);
  const cacheDir = path.join(dirPath, `sweep-locations-${key}`);
  const pagesDir = path.join(cacheDir, 'pages');
  ensureDir(pagesDir);

  const metaFile = path.join(cacheDir, 'meta.json');
  const loadMeta = () => readJson(metaFile) || {};
  const saveMeta = (meta) => writeJson(metaFile, meta);

  return {
    pageFile(page) {
      return path.join(pagesDir, `${page}.json`);
    },

    getPage(page, ttlMs) {
      const file = this.pageFile(page);
      if (typeof ttlMs === 'number') {
        try {
          if (Date.now() - fs.statSync(file).mtimeMs > ttlMs) return null;
        } catch {
          return null;
        }
      }
      return readJson(file);
    },

    setPage(page, pageResult) {
      writeJson(path.join(pagesDir, `${page}.json`), pageResult);
      saveMeta({ nextPage: page + 1, totalPages: pageResult.totalPages, updatedAt: new Date().toISOString() });
    },

    loadMeta,
  };
}

module.exports = {
  createReveCache,
  createSweepCache,
  readJson,
  writeJson,
};
