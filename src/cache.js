const fs = require('node:fs');
const path = require('node:path');

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

module.exports = {
  createReveCache,
  readJson,
  writeJson,
};
