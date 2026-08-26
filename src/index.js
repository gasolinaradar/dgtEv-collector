const { createDgtEvCollector } = require('./collector');
const { fetchStations, streamStations, enrichStations } = require('./fetch');
const { createReveClient } = require('./reve');
const { createReveCache } = require('./cache');
const { createRevePublicClient } = require('./reve-public');
const { enrichStationsExperimental } = require('./enrich-experimental');

module.exports = {
  createDgtEvCollector,
  fetchStations,
  streamStations,
  enrichStations,
  createReveClient,
  createReveCache,
  // Undocumented /api/public/v1 client + enrichment path. See src/reve-public.js —
  // not covered by any stability guarantee, kept separate from the supported exports above.
  experimental: {
    createRevePublicClient,
    enrichStationsExperimental,
  },
};
