const axios = require('axios');
const { normalizeSite, extractText } = require('./normalize');
const { createSiteParser, parseSitesFromXml } = require('./siteParser');
const { enrichStations } = require('./reve-enrich');

const DEFAULT_DGT_EV_URL =
  'https://infocar.dgt.es/datex2/v3/miterd/EnergyInfrastructureTablePublication/electrolineras.xml';
const DEFAULT_COUNTRY = 'ES';
const DEFAULT_TIMEOUT = 20000;
const DEFAULT_RETRIES = 3;

function resolveLogger(loggerOption) {
  return loggerOption && typeof loggerOption.info === 'function' ? loggerOption : console;
}

function resolveHttpClient(httpClientOption) {
  return httpClientOption && typeof httpClientOption.get === 'function' ? httpClientOption : axios;
}

function resolveUrl(urlOption, fallback) {
  const value = typeof urlOption === 'function' ? urlOption() : urlOption;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function resolveCountry(countryOption) {
  const value = typeof countryOption === 'function' ? countryOption() : countryOption;
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : DEFAULT_COUNTRY;
}

/**
 * Normaliza cualquier forma de `response.data` a un generador async de "trozos" de texto.
 * Soporta tanto un body ya completo (string, como el que devuelven los httpClient de test o
 * un axios con `responseType:'text'`) como un stream real (Readable de Buffers, el que da
 * axios con `responseType:'stream'`). Esto mantiene compatible el contrato público de
 * `httpClient` (documentado en el README) sin romper a quien inyecte un cliente que
 * devuelva el body como string, y a la vez habilita streaming real de memoria O(1) cuando
 * el cliente inyectado sí soporta stream.
 */
async function* iterateXmlChunks(data) {
  if (data === null || data === undefined || data === '') {
    return;
  }
  if (typeof data === 'string' || Buffer.isBuffer(data)) {
    yield data;
    return;
  }
  // Readable de Node (u otro async iterable de chunks).
  for await (const chunk of data) {
    yield chunk;
  }
}

/**
 * Descarga y parsea el XML de la DGT como stream, sin cargarlo nunca entero en memoria:
 * cada `<energyInfrastructureSite>` se normaliza y se emite (`yield`) en cuanto su tag
 * cierra, y su sub-árbol crudo se descarta inmediatamente después.
 *
 * El backpressure es automático: al hacer `yield` de un site normalizado dentro del bucle
 * que consume `response.data`, la ejecución se suspende hasta que quien consuma este
 * generador pida el siguiente (`.next()`), así que no se le piden más bytes a la conexión
 * HTTP hasta que el site anterior ya se procesó.
 *
 * Si falla a mitad de stream, se reintenta la conexión ENTERA desde el principio (un
 * parser SAX no se puede "reanudar" a mitad de documento). Es seguro porque el consumidor
 * habitual hace upsert idempotente por (source, sourceStationId): reprocesar sites ya
 * vistos en un intento fallido no duplica nada.
 */
async function* streamStations(options = {}, hooks = {}) {
  const logger = resolveLogger(options.logger);
  const httpClient = resolveHttpClient(options.httpClient);
  const url = resolveUrl(options.url, DEFAULT_DGT_EV_URL);
  const country = resolveCountry(options.country);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const reportProgress =
    typeof hooks.reportProgress === 'function' ? hooks.reportProgress : () => {};

  async function* connectAndStream() {
    logger.info('Requesting DGT EV charging dataset', { url });
    const response = await httpClient.get(url, {
      timeout,
      responseType: 'stream',
      headers: {
        Accept: 'application/xml, text/xml;q=0.9',
        'User-Agent': 'GasolinaRadarBot/1.0 (+https://gasolinaradar.example)',
      },
    });

    logger.info('Receiving DGT EV charging dataset', {
      url,
      status: response.status,
      contentLength: Number(response.headers?.['content-length']) || undefined,
    });

    if (!response.data) {
      throw new Error('Empty DGT EV dataset response');
    }

    reportProgress(35, { stage: 'parsing_dataset' });

    const decoder = new TextDecoder('utf-8');
    let pendingSites = [];
    let parserError = null;
    let sawAnyChunk = false;

    const parser = createSiteParser({
      onSite: (rawSite) => pendingSites.push(rawSite),
      onSiteError: (error, rawSite) => {
        logger.warn('Failed to parse DGT EV site subtree', {
          error: error?.message || 'unknown-error',
          siteId: extractText(rawSite?.id) || null,
        });
      },
    });
    parser.on('error', (error) => {
      parserError = error;
    });

    let count = 0;

    function* drainNormalized() {
      while (pendingSites.length > 0) {
        const rawSite = pendingSites.shift();
        let normalized = null;
        try {
          normalized = normalizeSite(rawSite, country);
        } catch (error) {
          logger.warn('Failed to normalize DGT EV site', {
            error: error?.message || 'unknown-error',
            siteId: extractText(rawSite?.id) || null,
          });
        }
        if (normalized) {
          count += 1;
          yield normalized;
        }
      }
    }

    try {
      for await (const chunk of iterateXmlChunks(response.data)) {
        sawAnyChunk = true;
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        parser.write(text);
        if (parserError) throw parserError;

        yield* drainNormalized();
      }

      if (!sawAnyChunk) {
        throw new Error('Empty DGT EV dataset response');
      }

      const finalText = decoder.decode();
      if (finalText) parser.write(finalText);
      parser.close();
      if (parserError) throw parserError;

      yield* drainNormalized();
    } finally {
      if (typeof response.data?.destroy === 'function' && !response.data.destroyed) {
        response.data.destroy();
      }
    }

    reportProgress(70, { stage: 'normalizing_dataset' });
    reportProgress(100, { stage: 'completed', siteCount: count });
    logger.info(`Streamed ${count} EV charging sites from DGT`);
  }

  reportProgress(5, { stage: 'requesting_dataset' });

  let attempt = 0;
  let delay = 1000;

  for (;;) {
    try {
      yield* connectAndStream();
      return;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      attempt += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Retry attempt ${attempt} after failure: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/**
 * Back-compat: colecciona el stream en un array completo. Se mantiene por compatibilidad
 * con quien no haya migrado, pero vuelve a cargar todo el dataset en memoria — no usar con
 * datasets grandes; para eso usar `streamStations` (o `collector.stream()`).
 *
 * Si se proporciona `options.enrich` (con `reveApiKey`), las estaciones se enriquecen
 * con precios y disponibilidad de la API Reve antes de devolverlas.
 */
async function fetchStations(options = {}, hooks = {}) {
  const logger = resolveLogger(options.logger);
  const enrichOpts = options.enrich;

  const normalized = [];
  for await (const station of streamStations(options, hooks)) {
    normalized.push(station);
  }

  if (enrichOpts && (enrichOpts.reveApiKey || enrichOpts.source === 'public')) {
    logger.info('Enriching stations with Reve data');
    return enrichStations(normalized, {
      ...enrichOpts,
      httpClient: resolveHttpClient(options.httpClient),
      logger,
      reportProgress: hooks.reportProgress,
    });
  }

  return normalized;
}

module.exports = {
  fetchStations,
  streamStations,
  parseSitesFromXml,
  enrichStations,
  DEFAULT_DGT_EV_URL,
  DEFAULT_TIMEOUT,
};
