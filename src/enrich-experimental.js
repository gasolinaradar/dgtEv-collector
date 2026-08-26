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
//
// No persistence: every call walks every page of the dataset from page 1 through the last
// one, fresh, every time — no on-disk cache/cursor across calls. That's ~582 requests per
// full run at per_page=25 (see reve-public.js), so resilience matters more here than usual:
// request()-level retries handle transient failures per page, and streamLocationPages skips
// (rather than aborts on) an individual page that still fails after retries, so one bad page
// doesn't throw away every other page already fetched in that run.

const { createRevePublicClient } = require('./reve-public');
const { SpatialIndex, STATUS_PRIORITY, DEFAULT_THRESHOLD_METERS, haversineMeters } = require('./enrich');

// Strips accents/case so "Repsol, Elorrio" and "REPSOL, ELORRIO" (or minor encoding
// differences) still count as the same name — an exact match after this normalization is
// treated as authoritative and skips the distance check entirely (see enrichStationsExperimental).
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

// Effectively "no cap" — a full sweep is ~582 pages today (see reve-public.js), so this
// just needs to be comfortably above that. Pass options.maxPages yourself to cap a run
// instead (e.g. while testing), but the default here is "walk the whole dataset."
const FULL_SWEEP_MAX_PAGES = 100000;

async function enrichStationsExperimental(stations, options = {}) {
  const {
    thresholdMeters = DEFAULT_THRESHOLD_METERS,
    httpClient,
    logger = console,
    acknowledgeUnsupported,
    filters = {},
    // See reve-public.js: 25 is the confirmed max per_page POST /locations accepts.
    perPage = 25,
    // Defaults to walking every page of the dataset (~582 requests today) every single
    // call — no persistence, no partial coverage across runs. Pass a smaller value
    // yourself if you deliberately want to cap a single run.
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
  const nameIndex = new Map(); // normalizedName -> RevLocation[]
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

    // Exact name match (after accent/case normalization) wins outright — no distance check.
    // If more than one Reve location shares that exact name, proximity breaks the tie.
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
