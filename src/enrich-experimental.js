// EXPERIMENTAL / UNSUPPORTED — see src/reve-public.js for why.
//
// Mirrors enrichStations() from src/enrich.js field-for-field (same Station output shape:
// reveLocationId, operator, prices, availability), but sources data from the undocumented
// /api/public/v1 instead of the documented /api/external/v1. Kept as a separate module so
// the supported path in enrich.js never depends on it.
//
// Functional difference worth noting: /api/public/v1 embeds status and tariffs directly
// inside each location's evses/connectors, so this needs only one paginated call
// (POST /locations) instead of three separate feeds (locations + operational_status +
// tariffs) — at the cost of relying on an endpoint nobody guarantees will keep working.

const { createRevePublicClient } = require('./reve-public');
const { SpatialIndex, STATUS_PRIORITY, DEFAULT_THRESHOLD_METERS } = require('./enrich');

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

async function enrichStationsExperimental(stations, options = {}) {
  const {
    thresholdMeters = DEFAULT_THRESHOLD_METERS,
    httpClient,
    logger = console,
    acknowledgeUnsupported,
    filters = {},
    perPage = 50,
  } = options;

  const reveClient = createRevePublicClient({ httpClient, logger, acknowledgeUnsupported });

  let reveLocations = [];
  try {
    reveLocations = await reveClient.fetchAllLocations({ filters, perPage });
  } catch (error) {
    logger.warn('Failed to fetch Reve public locations for matching', {
      error: error.message,
      status: error.response?.status,
      responseBody: error.response?.data,
    });
    return stations;
  }

  const normalizedReve = [];
  for (const loc of reveLocations) {
    const n = normalizeRevePublicLocation(loc);
    if (n) normalizedReve.push(n);
  }

  logger.info('Building spatial index for Reve public locations', { count: normalizedReve.length });
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

    enriched.push({
      ...station,
      reveLocationId: reve.reveLocationId,
      operator: reve.operator || station.operator,
      prices: mergePublicPrices(reve) || station.prices,
      availability: mergePublicAvailability(reve) || station.availability,
    });
  }

  logger.info('Experimental public-API enrichment complete', {
    totalStations: stations.length,
    matched,
    withPrices: enriched.filter((s) => s.prices).length,
    withAvailability: enriched.filter((s) => s.availability).length,
  });

  return enriched;
}

module.exports = {
  enrichStationsExperimental,
  normalizeRevePublicLocation,
  mergePublicPrices,
  mergePublicAvailability,
};
