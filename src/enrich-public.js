const { createRevePublicClient, DEFAULT_MAX_PAGES } = require('./reve-public');
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
    raw: loc,
  };
}

function mergePublicPrices(reveLoc) {
  const evses = Array.isArray(reveLoc.raw?.evses) ? reveLoc.raw.evses : [];
  const seen = new Set();
  const prices = [];

  for (const evse of evses) {
    const connectors = Array.isArray(evse.connectors) ? evse.connectors : [];
    for (const conn of connectors) {
      for (const t of Array.isArray(conn.tariffs) ? conn.tariffs : []) {
        const tariff = t.tariff;
        if (!tariff) continue;
        for (const element of Array.isArray(tariff.elements) ? tariff.elements : []) {
          for (const comp of Array.isArray(element.price_components) ? element.price_components : []) {
            const price = parseFloat(comp.price) || 0;
            const currency = tariff.currency || 'EUR';
            const key = `${comp.type}:${price}:${currency}`;
            if (seen.has(key)) continue;
            seen.add(key);
            prices.push({
              type: comp.type,
              price,
              currency,
              vat: comp.vat !== undefined && comp.vat !== null ? parseFloat(comp.vat) : undefined,
              stepSize: comp.step_size,
            });
          }
        }
      }
    }
  }

  return prices.length > 0 ? prices : undefined;
}

function mergePublicAvailability(reveLoc) {
  const evses = Array.isArray(reveLoc.raw?.evses) ? reveLoc.raw.evses : [];
  const statuses = evses.filter((evse) => typeof evse.status === 'string').map((evse) => evse.status);
  if (statuses.length === 0) return undefined;

  for (const p of STATUS_PRIORITY) {
    if (statuses.includes(p)) {
      return { status: p, evseCount: statuses.length, lastUpdated: new Date().toISOString() };
    }
  }
  return { status: 'UNKNOWN', evseCount: statuses.length, lastUpdated: new Date().toISOString() };
}

function buildDgtIndices(stations) {
  const spatialIndex = new SpatialIndex();
  const names = new Set();

  for (const station of stations) {
    const coords = station.location?.coordinates;
    if (!coords || !Array.isArray(coords) || coords.length !== 2) continue;

    const [lon, lat] = coords;
    spatialIndex.insert(true, lat, lon);

    const key = normalizeStationName(station.name);
    if (key) names.add(key);
  }

  return { spatialIndex, names };
}

async function enrichStationsPublic(stations, options = {}) {
  const {
    thresholdMeters = DEFAULT_THRESHOLD_METERS,
    httpClient,
    logger = console,
    acknowledgeUnsupported,
    filters = {},
    perPage = 25,
    maxPages = DEFAULT_MAX_PAGES,
  } = options;

  const reveClient = createRevePublicClient({ httpClient, logger, acknowledgeUnsupported });
  const dgt = buildDgtIndices(stations);

  logger.info('Requesting Reve public locations sweep', { maxPages, perPage });

  const candidateSpatialIndex = new SpatialIndex();
  const candidateNameIndex = new Map();
  let fetched = 0;
  let kept = 0;

  try {
    for await (const page of reveClient.streamLocations({ filters, perPage, maxPages })) {
      for (const loc of page) {
        fetched += 1;

        const lat = parseFloat(loc.coordinates?.latitude);
        const lon = parseFloat(loc.coordinates?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const nameKey = normalizeStationName(loc.name);
        const isNameCandidate = nameKey !== null && dgt.names.has(nameKey);
        const isProximityCandidate = dgt.spatialIndex.findNearest(lat, lon, thresholdMeters) !== null;
        if (!isNameCandidate && !isProximityCandidate) continue;

        const normalized = normalizeRevePublicLocation(loc);
        if (!normalized) continue;

        kept += 1;
        candidateSpatialIndex.insert(normalized, normalized.lat, normalized.lon);
        if (nameKey) {
          if (!candidateNameIndex.has(nameKey)) candidateNameIndex.set(nameKey, []);
          candidateNameIndex.get(nameKey).push(normalized);
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to fetch Reve public locations for matching', {
      error: error.message,
      status: error.response?.status,
      responseBody: error.response?.data,
    });
    return stations;
  }

  logger.info('Reve public locations sweep complete', { fetched, kept });

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
    const nameCandidates = nameKey ? candidateNameIndex.get(nameKey) : undefined;
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
      const hit = candidateSpatialIndex.findNearest(lat, lon, thresholdMeters);
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

  logger.info('Reve public-API enrichment complete', {
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
  enrichStationsPublic,
  normalizeRevePublicLocation,
  normalizeStationName,
  mergePublicPrices,
  mergePublicAvailability,
};
