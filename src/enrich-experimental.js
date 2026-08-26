const { createRevePublicClient } = require('./reve-public');
const { SpatialIndex, STATUS_PRIORITY, DEFAULT_THRESHOLD_METERS, haversineMeters } = require('./enrich');

function normalizeStationName(name) {
  if (typeof name !== 'string') return null;
  const normalized = name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  return normalized || null;
}

function normalizeRevePublicLocation(loc) {
  const lat = parseFloat(loc.coordinates?.latitude);
  const lon = parseFloat(loc.coordinates?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const evses = Array.isArray(loc.evses) ? loc.evses : [];
  const allConnectors = [];
  const evseStatuses = [];

  for (const evse of evses) {
    if (typeof evse.status === 'string') {
      evseStatuses.push(evse.status);
    }

    const connectors = Array.isArray(evse.connectors) ? evse.connectors : [];
    for (const conn of connectors) {
      const prices = [];
      for (const t of Array.isArray(conn.tariffs) ? conn.tariffs : []) {
        const tariff = t.tariff;
        if (!tariff) continue;
        for (const element of Array.isArray(tariff.elements) ? tariff.elements : []) {
          for (const comp of Array.isArray(element.price_components) ? element.price_components : []) {
            prices.push({
              type: comp.type,
              price: parseFloat(comp.price) || 0,
              currency: tariff.currency || 'EUR',
              vat: comp.vat !== undefined && comp.vat !== null ? parseFloat(comp.vat) : undefined,
              stepSize: comp.step_size,
            });
          }
        }
      }

      allConnectors.push({
        connectorId: conn.id,
        evseId: evse.evse_id,
        standard: conn.standard,
        format: conn.format,
        maxPowerW: conn.max_electric_power,
        prices,
      });
    }
  }

  const owner = loc.owner || null;

  return {
    reveLocationId: loc.id,
    lat,
    lon,
    operator: owner && owner.name ? { name: owner.name, website: owner.website || null } : null,
    name: loc.name || null,
    address: loc.address || null,
    city: loc.city || null,
    postalCode: loc.postal_code || null,
    allConnectors,
    evseStatuses,
    raw: loc,
  };
}

function mergePublicPrices(reveLoc) {
  const seen = new Set();
  const prices = [];
  for (const conn of reveLoc.allConnectors) {
    for (const p of conn.prices) {
      const key = `${p.type}:${p.price}:${p.currency}`;
      if (seen.has(key)) continue;
      seen.add(key);
      prices.push(p);
    }
  }
  return prices.length > 0 ? prices : undefined;
}

function mergePublicAvailability(reveLoc) {
  const statuses = reveLoc.evseStatuses;
  if (!statuses || statuses.length === 0) return undefined;

  for (const p of STATUS_PRIORITY) {
    if (statuses.includes(p)) {
      return { status: p, evseCount: statuses.length, lastUpdated: new Date().toISOString() };
    }
  }
  return { status: 'UNKNOWN', evseCount: statuses.length, lastUpdated: new Date().toISOString() };
}

const FULL_SWEEP_MAX_PAGES = 100000;

async function enrichStationsExperimental(stations, options = {}) {
  const {
    thresholdMeters = DEFAULT_THRESHOLD_METERS,
    httpClient,
    logger = console,
    acknowledgeUnsupported,
    filters = {},
    perPage = 25,
    maxPages = FULL_SWEEP_MAX_PAGES,
  } = options;

  const reveClient = createRevePublicClient({ httpClient, logger, acknowledgeUnsupported });

  logger.info('Requesting Reve public locations sweep', { maxPages, perPage });

  let locations;
  try {
    locations = await reveClient.fetchAllLocations({ filters, perPage, maxPages });
  } catch (error) {
    logger.warn('Failed to fetch Reve public locations for matching', {
      error: error.message,
      status: error.response?.status,
      responseBody: error.response?.data,
    });
    return stations;
  }

  const normalizedReve = [];
  for (const loc of locations) {
    const n = normalizeRevePublicLocation(loc);
    if (n) normalizedReve.push(n);
  }

  logger.info('Reve public locations sweep complete', { fetched: locations.length, normalized: normalizedReve.length });

  logger.info('Building spatial index for Reve public locations', { count: normalizedReve.length });
  const index = new SpatialIndex();
  const nameIndex = new Map();
  for (const loc of normalizedReve) {
    index.insert(loc, loc.lat, loc.lon);
    const key = normalizeStationName(loc.name);
    if (key) {
      if (!nameIndex.has(key)) nameIndex.set(key, []);
      nameIndex.get(key).push(loc);
    }
  }

  const enriched = [];
  let matched = 0;
  let matchedByName = 0;
  let matchedByProximity = 0;

  for (const station of stations) {
    const coords = station.location?.coordinates;
    if (!coords || !Array.isArray(coords) || coords.length !== 2) {
      enriched.push(station);
      continue;
    }

    const [lon, lat] = coords;

    let reve = null;
    let matchedBy = null;
    const nameKey = normalizeStationName(station.name);
    const nameCandidates = nameKey ? nameIndex.get(nameKey) : undefined;
    if (nameCandidates?.length === 1) {
      reve = nameCandidates[0];
      matchedBy = 'name';
    } else if (nameCandidates?.length > 1) {
      let best = null;
      let bestDist = Infinity;
      for (const candidate of nameCandidates) {
        const dist = haversineMeters(lat, lon, candidate.lat, candidate.lon);
        if (dist < bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }
      reve = best;
      matchedBy = 'name';
    }

    if (!reve) {
      const hit = index.findNearest(lat, lon, thresholdMeters);
      if (hit) {
        reve = hit.item;
        matchedBy = 'proximity';
      }
    }

    if (!reve) {
      enriched.push(station);
      continue;
    }

    matched += 1;
    if (matchedBy === 'name') matchedByName += 1;
    else matchedByProximity += 1;

    enriched.push({
      ...station,
      reveLocationId: reve.reveLocationId,
      operator: reve.operator || station.operator,
      prices: mergePublicPrices(reve) || station.prices,
      availability: mergePublicAvailability(reve) || station.availability,
      reveData: reve.raw,
    });
  }

  logger.info('Experimental public-API enrichment complete', {
    totalStations: stations.length,
    matched,
    matchedByName,
    matchedByProximity,
    withPrices: enriched.filter((s) => s.prices).length,
    withAvailability: enriched.filter((s) => s.availability).length,
  });

  return enriched;
}

module.exports = {
  enrichStationsExperimental,
  normalizeRevePublicLocation,
  normalizeStationName,
  mergePublicPrices,
  mergePublicAvailability,
};
