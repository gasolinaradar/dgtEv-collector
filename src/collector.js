const { fetchStations, streamStations, enrichStations } = require('./fetch');

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
    // Si `options.enrich` contiene `reveApiKey`, las estaciones se enriquecen con
    // precios y disponibilidad de la API Reve de Red Eléctrica.
    async fetch(context = {}) {
      const reportProgress =
        typeof context?.reportProgress === 'function' ? context.reportProgress : () => {};
      return fetchStations(options, { reportProgress });
    },
    // Streaming: async generator, memoria O(1) respecto al tamaño del XML de origen. Cada
    // site se yieldea normalizado en cuanto se completa su parseo.
    // NOTA: cuando `options.enrich` está activo, las estaciones se recolectan
    // internamente antes de enriquecerse, por lo que el streaming se vuelve batch.
    stream(context = {}) {
      const reportProgress =
        typeof context?.reportProgress === 'function' ? context.reportProgress : () => {};
      return streamStations(options, { reportProgress });
    },
    // Enriquece un array existente de estaciones con datos de Reve.
    // Útil cuando ya se tienen estaciones y se quiere enriquecer después.
    async enrich(stations, enrichOptions = {}) {
      return enrichStations(stations, enrichOptions);
    },
  };
}

module.exports = {
  createDgtEvCollector,
};
