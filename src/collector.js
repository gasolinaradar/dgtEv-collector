const { fetchStations, streamStations } = require('./fetch');

function createDgtEvCollector(options = {}) {
  const country =
    typeof options.country === 'string' && options.country.trim()
      ? options.country.trim().toUpperCase()
      : 'ES';

  return {
    name: 'dgt-ev',
    country,
    // Back-compat: sigue devolviendo un array completo. Desaconsejado en datasets grandes
    // porque vuelve a materializar todo el dataset en memoria; usar `stream()` para eso.
    async fetch(context = {}) {
      const reportProgress =
        typeof context?.reportProgress === 'function' ? context.reportProgress : () => {};
      return fetchStations(options, { reportProgress });
    },
    // Streaming: async generator, memoria O(1) respecto al tamaño del XML de origen. Cada
    // site se yieldea normalizado en cuanto se completa su parseo.
    stream(context = {}) {
      const reportProgress =
        typeof context?.reportProgress === 'function' ? context.reportProgress : () => {};
      return streamStations(options, { reportProgress });
    },
  };
}

module.exports = {
  createDgtEvCollector,
};
