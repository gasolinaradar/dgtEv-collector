const { fetchStations } = require('./fetch');

function createDgtEvCollector(options = {}) {
  const country =
    typeof options.country === 'string' && options.country.trim()
      ? options.country.trim().toUpperCase()
      : 'ES';

  return {
    name: 'dgt-ev',
    country,
    async fetch(context = {}) {
      const reportProgress =
        typeof context?.reportProgress === 'function' ? context.reportProgress : () => {};
      return fetchStations(options, { reportProgress });
    },
  };
}

module.exports = {
  createDgtEvCollector,
};
