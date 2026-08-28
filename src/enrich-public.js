const { createRevePublicClient, DEFAULT_MAX_PAGES } = require('./reve-public');
const {
  SpatialIndex,
  STATUS_PRIORITY,
  DEFAULT_THRESHOLD_METERS,
  haversineMeters,
  summarizeConnectors,
  mergeConnectorStatus,
} = require('./enrich');

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

// Same evseId/connectorId tagging as mergePrices in enrich.js, and same reasoning: dedup stays
// scoped to each connector's own tariff list, not across connectors, so the IDs stay meaningful.
function mergePublicPrices(reveLoc) {
  const evses = Array.isArray(reveLoc.raw?.evses) ? reveLoc.raw.evses : [];
  const prices = [];

  for (const evse of evses) {
    const connectors = Array.isArray(evse.connectors) ? evse.connectors : [];
    for (const conn of connectors) {
      const seen = new Set();
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
              restrictions:
                element.restrictions && typeof element.restrictions === 'object' && Object.keys(element.restrictions).length > 0
                  ? element.restrictions
                  : undefined,
              evseId: evse.evse_id,
              connectorId: conn.id,
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
  const withStatus = evses.filter((evse) => typeof evse.status === 'string');
  if (withStatus.length === 0) return undefined;

  const statuses = withStatus.map((evse) => evse.status);
  const evseDetails = withStatus.map((evse) => ({
    evseId: evse.evse_id,
    status: evse.status,
    connectors: summarizeConnectors(evse.connectors),
  }));

  for (const p of STATUS_PRIORITY) {
    if (statuses.includes(p)) {
      return { status: p, evseCount: statuses.length, lastUpdated: new Date().toISOString(), evses: evseDetails };
    }
  }
  return { status: 'UNKNOWN', evseCount: statuses.length, lastUpdated: new Date().toISOString(), evses: evseDetails };
}

function buildDgtIndices(stations) {
  const spatialIndex = new SpatialIndex();
  const nameIndex = new Map();
  const stationCoords = [];

  stations.forEach((station, idx) => {
    const coords = station.location?.coordinates;
    if (!coords || !Array.isArray(coords) || coords.length !== 2) return;

    const [lon, lat] = coords;
    spatialIndex.insert(idx, lat, lon);
    stationCoords[idx] = { lat, lon };

    const key = normalizeStationName(station.name);
    if (key) {
      if (!nameIndex.has(key)) nameIndex.set(key, []);
      nameIndex.get(key).push(idx);
    }
  });

  return { spatialIndex, nameIndex, stationCoords };
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
    reportProgress,
  } = options;
  const emitProgress = typeof reportProgress === 'function' ? reportProgress : () => {};

  const reveClient = createRevePublicClient({ httpClient, logger, acknowledgeUnsupported });
  const dgt = buildDgtIndices(stations);

  logger.info('Requesting Reve public locations sweep', { maxPages, perPage });
  emitProgress(0, { stage: 'reve_public_locations_sweep' });

  const bestMatches = new Map();
  let fetched = 0;
  let kept = 0;

  try {
    for await (const page of reveClient.streamLocations({ filters, perPage, maxPages, reportProgress })) {
      for (const loc of page) {
        fetched += 1;

        const lat = parseFloat(loc.coordinates?.latitude);
        const lon = parseFloat(loc.coordinates?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const nameKey = normalizeStationName(loc.name);
        const nameStationIndices = nameKey ? dgt.nameIndex.get(nameKey) : undefined;
        const nearbyStations = dgt.spatialIndex.findAllWithin(lat, lon, thresholdMeters);
        if (!nameStationIndices && nearbyStations.length === 0) continue;

        let normalized = null;
        const ensureNormalized = () => {
          if (normalized === null) normalized = normalizeRevePublicLocation(loc) || false;
          return normalized || null;
        };

        if (nameStationIndices) {
          for (const idx of nameStationIndices) {
            const stationCoord = dgt.stationCoords[idx];
            const distance = haversineMeters(stationCoord.lat, stationCoord.lon, lat, lon);
            const current = bestMatches.get(idx);
            const better = !current || current.matchedBy !== 'name' || distance < current.distance;
            if (!better) continue;
            const n = ensureNormalized();
            if (n) bestMatches.set(idx, { reve: n, matchedBy: 'name', distance });
          }
        }

        for (const { item: idx, distance } of nearbyStations) {
          const current = bestMatches.get(idx);
          if (current && current.matchedBy === 'name') continue;
          if (current && distance >= current.distance) continue;
          const n = ensureNormalized();
          if (n) bestMatches.set(idx, { reve: n, matchedBy: 'proximity', distance });
        }

        if (normalized) kept += 1;
      }
    }
  } catch (error) {
    logger.warn('Failed to fetch Reve public locations for matching', {
      error: error.message,
      status: error.response?.status,
      responseBody: error.response?.data,
    });
    emitProgress(100, { stage: 'reve_public_locations_sweep', failed: true });
    return stations;
  }

  logger.info('Reve public locations sweep complete', { fetched, kept });
  emitProgress(100, { stage: 'reve_public_locations_sweep', fetched, kept });

  const enriched = [];
  let matched = 0;
  let matchedByName = 0;
  let matchedByProximity = 0;

  stations.forEach((station, idx) => {
    const best = bestMatches.get(idx);
    if (!best) {
      enriched.push(station);
      return;
    }

    matched += 1;
    if (best.matchedBy === 'name') matchedByName += 1;
    else matchedByProximity += 1;

    const reve = best.reve;
    const availability = mergePublicAvailability(reve) || station.availability;
    enriched.push({
      ...station,
      reveLocationId: reve.reveLocationId,
      operator: reve.operator || station.operator,
      prices: mergePublicPrices(reve) || station.prices,
      availability,
      connectors: availability?.evses ? mergeConnectorStatus(station.connectors, availability.evses) : station.connectors,
      reveData: reve.raw,
    });
  });

  logger.info('Reve public-API enrichment complete', {
    totalStations: stations.length,
    matched,
    matchedByName,
    matchedByProximity,
    withPrices: enriched.filter((s) => s.prices).length,
    withAvailability: enriched.filter((s) => s.availability).length,
  });
  emitProgress(100, { stage: 'reve_public_enrichment_complete', matched });

  return enriched;
}

module.exports = {
  enrichStationsPublic,
  normalizeRevePublicLocation,
  normalizeStationName,
  mergePublicPrices,
  mergePublicAvailability,
};
