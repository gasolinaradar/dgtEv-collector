const { enrichStations: enrichStationsExternal } = require('./enrich');
const { enrichStationsPublic } = require('./enrich-public');

function resolveSource(options) {
  if (options.source === 'public') return 'public';
  if (options.source === 'external') return 'external';
  return options.reveApiKey ? 'external' : 'public';
}

async function enrichStations(stations, options = {}) {
  const source = resolveSource(options);

  if (source === 'public') {
    return enrichStationsPublic(stations, options);
  }

  return enrichStationsExternal(stations, options);
}

module.exports = { enrichStations };
