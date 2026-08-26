const path = require('node:path');
const { createReveClient } = require('./reve');
const { createReveCache } = require('./cache');

const DEFAULT_THRESHOLD_METERS = 50;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class SpatialIndex {
  constructor(cellSize = 0.001) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.items = [];
  }

  _key(lat, lon) {
    const row = Math.floor(lat / this.cellSize);
    const col = Math.floor(lon / this.cellSize);
    return `${row}:${col}`;
  }

  _cellNeighbors(lat, lon) {
    const row = Math.floor(lat / this.cellSize);
    const col = Math.floor(lon / this.cellSize);
    const neighbors = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        neighbors.push(`${row + dr}:${col + dc}`);
      }
    }
    return neighbors;
  }

  insert(item, lat, lon) {
    const idx = this.items.length;
    this.items.push({ item, lat, lon });
    const key = this._key(lat, lon);
    if (!this.cells.has(key)) {
      this.cells.set(key, []);
    }
    this.cells.get(key).push(idx);
  }

  findNearest(lat, lon, maxMeters) {
    const neighbors = this._cellNeighbors(lat, lon);
    let bestDist = Infinity;
    let bestItem = null;

    for (const key of neighbors) {
      const indices = this.cells.get(key);
      if (!indices) continue;
      for (const idx of indices) {
        const { item, lat: ilat, lon: ilon } = this.items[idx];
        const dist = haversineMeters(lat, lon, ilat, ilon);
        if (dist < bestDist) {
          bestDist = dist;
          bestItem = item;
        }
      }
    }

    return bestDist <= maxMeters ? { item: bestItem, distance: bestDist } : null;
  }
}

function normalizeReveLocation(loc) {
  const lat = parseFloat(loc.coordinates?.latitude);
  const lon = parseFloat(loc.coordinates?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const evses = Array.isArray(loc.evses) ? loc.evses : [];

  const allConnectors = [];
  for (const evse of evses) {
    const connectors = Array.isArray(evse.connectors) ? evse.connectors : [];
    for (const conn of connectors) {
      allConnectors.push({
        connectorId: conn.id,
        evseId: evse.id,
        standard: conn.standard,
        format: conn.format,
        powerType: conn.power_type,
        maxPowerW: conn.max_electric_power,
        maxVoltage: conn.max_voltage,
        maxAmperage: conn.max_amperage,
      });
    }
  }

  const ownerParts = loc.owner ? loc.owner.split(' - ') : [];
  const operatorName = ownerParts[0]?.trim() || loc.cpo_name || null;
  const operatorWebsite = ownerParts.length > 1 ? ownerParts.slice(1).join(' - ').trim() : null;

  return {
    reveLocationId: loc.id,
    lat,
    lon,
    partyId: loc.party_id,
    cpoName: loc.cpo_name,
    operator: operatorName ? { name: operatorName, website: operatorWebsite } : null,
    evses,
    allConnectors,
    name: loc.name || null,
    address: loc.address || null,
    city: loc.city || null,
    postalCode: loc.postal_code || null,
  };
}

function buildTariffMap(tariffsData) {
  const map = {};
  for (const entry of tariffsData) {
    const connectorId = entry.connector_id;
    if (!connectorId) continue;
    const tariffs = Array.isArray(entry.tariffs) ? entry.tariffs : [];
    const simplified = [];
    for (const tariff of tariffs) {
      const elements = Array.isArray(tariff.elements) ? tariff.elements : [];
      for (const element of elements) {
        const components = Array.isArray(element.price_components) ? element.price_components : [];
        for (const comp of components) {
          simplified.push({
            type: comp.type,
            price: parseFloat(comp.price) || 0,
            currency: tariff.currency || 'EUR',
            vat: comp.vat ? parseFloat(comp.vat) : undefined,
            stepSize: comp.step_size,
          });
        }
      }
    }
    map[connectorId] = simplified;
  }
  return map;
}

function buildStatusMap(statusData) {
  const map = {};
  for (const entry of statusData) {
    const evseId = entry.evse_id;
    if (!evseId) continue;
    map[evseId] = {
      status: entry.operational_status ? 'AVAILABLE' : 'INOPERATIVE',
      lastUpdated: entry.last_operational_status_updated,
    };
  }
  return map;
}

function mergePrices(dgtConnectors, reveConnectors, tariffMap) {
  if (!Array.isArray(reveConnectors) || reveConnectors.length === 0) return undefined;

  const prices = [];
  const seen = new Set();

  for (const conn of reveConnectors) {
    const connectorId = conn.connectorId;
    const tariffs = tariffMap[connectorId];
    if (!tariffs || tariffs.length === 0) continue;

    for (const tariff of tariffs) {
      const key = `${tariff.type}:${tariff.price}:${tariff.currency}`;
      if (seen.has(key)) continue;
      seen.add(key);
      prices.push({
        type: tariff.type,
        price: tariff.price,
        currency: tariff.currency,
        vat: tariff.vat,
        stepSize: tariff.stepSize,
      });
    }
  }

  return prices.length > 0 ? prices : undefined;
}

function mergeAvailability(evses, statusMap) {
  if (!Array.isArray(evses) || evses.length === 0) return undefined;

  const statuses = [];
  for (const evse of evses) {
    const st = statusMap[evse.id];
    if (st) {
      statuses.push(st.status);
    }
  }

  if (statuses.length === 0) return undefined;

  const priority = ['CHARGING', 'AVAILABLE', 'RESERVED', 'BLOCKED', 'INOPERATIVE', 'OUTOFORDER', 'UNKNOWN', 'PLANNED', 'REMOVED'];
  for (const p of priority) {
    if (statuses.includes(p)) {
      return {
        status: p,
        evseCount: statuses.length,
        lastUpdated: new Date().toISOString(),
      };
    }
  }

  return {
    status: 'UNKNOWN',
    evseCount: statuses.length,
    lastUpdated: new Date().toISOString(),
  };
}

async function enrichStations(stations, options = {}) {
  const {
    reveApiKey,
    cacheDir,
    thresholdMeters = DEFAULT_THRESHOLD_METERS,
    httpClient,
    logger = console,
    dateFrom: dateFromOverride,
  } = options;

  if (!reveApiKey) {
    return stations;
  }

  const reveClient = createReveClient({
    apiKey: reveApiKey,
    httpClient,
    logger,
    rateLimitPersistPath: cacheDir ? path.join(cacheDir, 'rate_limit.json') : null,
  });
  const cache = cacheDir ? createReveCache(cacheDir) : null;

  let statusData = [];
  let tariffsData = [];

  const lastStatusFetch = cache?.getLastStatusFetchDate() || null;
  const lastTariffsFetch = cache?.getLastTariffsFetchDate() || null;

  const statusDateFrom = dateFromOverride || lastStatusFetch || undefined;
  const tariffsDateFrom = dateFromOverride || lastTariffsFetch || undefined;

  logger.info('Fetching Reve operational status', { dateFrom: statusDateFrom || 'full' });
  try {
    statusData = await reveClient.fetchOperationalStatus({ dateFrom: statusDateFrom });
  } catch (error) {
    if (error.message.includes('rate limit')) {
      reveClient.markLimited();
    }
    logger.warn('Failed to fetch Reve operational status', { error: error.message });
    if (cache) {
      const cached = cache.loadAllStatus();
      statusData = Object.entries(cached).map(([evseId, entry]) => ({
        evse_id: evseId,
        operational_status: entry.status === 'AVAILABLE',
        last_operational_status_updated: entry.lastUpdated,
      }));
    }
  }

  logger.info('Fetching Reve tariffs', { dateFrom: tariffsDateFrom || 'full' });
  try {
    tariffsData = await reveClient.fetchTariffs({ dateFrom: tariffsDateFrom });
  } catch (error) {
    if (error.message.includes('rate limit')) {
      reveClient.markLimited();
    }
    logger.warn('Failed to fetch Reve tariffs', { error: error.message });
    if (cache) {
      const cached = cache.loadAllTariffs();
      tariffsData = Object.entries(cached).map(([connectorId, tariffs]) => ({
        connector_id: connectorId,
        tariffs: tariffs.map((t) => ({
          id: `${connectorId}:${t.type}`,
          currency: t.currency,
          elements: [{ price_components: [{ type: t.type, price: String(t.price), step_size: t.stepSize }] }],
        })),
      }));
    }
  }

  if (cache) {
    const statusEntries = {};
    for (const entry of statusData) {
      if (entry.evse_id) {
        statusEntries[entry.evse_id] = {
          status: entry.operational_status ? 'AVAILABLE' : 'INOPERATIVE',
          lastUpdated: entry.last_operational_status_updated,
        };
      }
    }
    cache.bulkUpdateStatus(statusEntries);

    const tariffEntries = {};
    for (const entry of tariffsData) {
      if (entry.connector_id) {
        const tariffs = Array.isArray(entry.tariffs) ? entry.tariffs : [];
        const simplified = [];
        for (const tariff of tariffs) {
          const elements = Array.isArray(tariff.elements) ? tariff.elements : [];
          for (const element of elements) {
            const components = Array.isArray(element.price_components) ? element.price_components : [];
            for (const comp of components) {
              simplified.push({
                type: comp.type,
                price: parseFloat(comp.price) || 0,
                currency: tariff.currency || 'EUR',
                vat: comp.vat ? parseFloat(comp.vat) : undefined,
                stepSize: comp.step_size,
              });
            }
          }
        }
        tariffEntries[entry.connector_id] = simplified;
      }
    }
    cache.bulkUpdateTariffs(tariffEntries);
  }

  const tariffMap = buildTariffMap(tariffsData);
  const statusMap = buildStatusMap(statusData);

  let reveLocations = [];
  try {
    reveLocations = await reveClient.fetchLocations({ dateFrom: statusDateFrom });
  } catch (error) {
    if (error.message.includes('rate limit')) {
      reveClient.markLimited();
    }
    logger.warn('Failed to fetch Reve locations for matching', { error: error.message });
  }

  const normalizedReve = [];
  for (const loc of reveLocations) {
    const n = normalizeReveLocation(loc);
    if (n) normalizedReve.push(n);
  }

  logger.info('Building spatial index for Reve locations', { count: normalizedReve.length });
  const index = new SpatialIndex();
  for (const loc of normalizedReve) {
    index.insert(loc, loc.lat, loc.lon);
  }

  const enriched = [];
  let matched = 0;

  for (const station of stations) {
    const coords = station.location?.coordinates;
    if (!coords || !Array.isArray(coords) || coords.length !== 2) {
      enriched.push(station);
      continue;
    }

    const [lon, lat] = coords;
    const hit = index.findNearest(lat, lon, thresholdMeters);

    if (!hit) {
      enriched.push(station);
      continue;
    }

    matched += 1;
    const reve = hit.item;

    const prices = mergePrices(station.connectors, reve.allConnectors, tariffMap);
    const availability = mergeAvailability(reve.evses, statusMap);

    enriched.push({
      ...station,
      reveLocationId: reve.reveLocationId,
      operator: reve.operator || station.operator,
      prices: prices || station.prices,
      availability: availability || station.availability,
    });
  }

  logger.info('Enrichment complete', {
    totalStations: stations.length,
    matched,
    withPrices: enriched.filter((s) => s.prices).length,
    withAvailability: enriched.filter((s) => s.availability).length,
  });

  return enriched;
}

module.exports = {
  enrichStations,
  haversineMeters,
  SpatialIndex,
  normalizeReveLocation,
  buildTariffMap,
  buildStatusMap,
  mergePrices,
  mergeAvailability,
  DEFAULT_THRESHOLD_METERS,
};
