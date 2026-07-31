const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { normalizeSite, extractText, toArray } = require('./normalize');
const { retry } = require('./retry');

const DEFAULT_DGT_EV_URL =
  'https://infocar.dgt.es/datex2/v3/miterd/EnergyInfrastructureTablePublication/electrolineras.xml';
const DEFAULT_COUNTRY = 'ES';
const DEFAULT_TIMEOUT = 20000;
const DEFAULT_RETRIES = 3;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
});

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

function findEnergyInfrastructureTable(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  if (node.energyInfrastructureTable || node['egi:energyInfrastructureTable']) {
    return node;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findEnergyInfrastructureTable(value);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function parseSitesFromXml(xml) {
  const parsed = xmlParser.parse(xml);
  const container = findEnergyInfrastructureTable(parsed);
  const table = container?.energyInfrastructureTable ?? container?.['egi:energyInfrastructureTable'];
  const sites = toArray(table?.energyInfrastructureSite ?? table?.['egi:energyInfrastructureSite']);
  return sites;
}

async function fetchXml(httpClient, logger, url, timeout) {
  logger.info('Requesting DGT EV charging dataset', { url });
  const response = await httpClient.get(url, {
    timeout,
    responseType: 'text',
    headers: {
      Accept: 'application/xml, text/xml;q=0.9',
      'User-Agent': 'GasolinaRadarBot/1.0 (+https://gasolinaradar.example)',
    },
  });

  logger.info('Received DGT EV charging dataset', {
    url,
    status: response.status,
    contentLength: Number(response.headers['content-length']) || undefined,
  });

  if (!response.data) {
    throw new Error('Empty DGT EV dataset response');
  }

  return response.data;
}

async function fetchStations(options = {}, hooks = {}) {
  const logger = resolveLogger(options.logger);
  const httpClient = resolveHttpClient(options.httpClient);
  const url = resolveUrl(options.url, DEFAULT_DGT_EV_URL);
  const country = resolveCountry(options.country);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const reportProgress =
    typeof hooks.reportProgress === 'function' ? hooks.reportProgress : () => {};

  reportProgress(5, { stage: 'requesting_dataset' });
  const xml = await retry(() => fetchXml(httpClient, logger, url, timeout), {
    retries,
    minTimeoutMs: 1000,
    logger,
  });

  reportProgress(35, { stage: 'parsing_dataset' });
  const sites = parseSitesFromXml(xml);
  reportProgress(70, { stage: 'normalizing_dataset', siteCount: sites.length });

  const normalized = sites
    .map((site) => {
      try {
        return normalizeSite(site, country);
      } catch (error) {
        logger.warn('Failed to normalize DGT EV site', {
          error: error?.message || 'unknown-error',
          siteId: extractText(site?.id) || null,
        });
        return null;
      }
    })
    .filter(Boolean);

  logger.info(`Fetched ${normalized.length} EV charging sites from DGT`);
  reportProgress(100, { stage: 'completed', siteCount: normalized.length });
  return normalized;
}

module.exports = {
  fetchStations,
  fetchXml,
  parseSitesFromXml,
  DEFAULT_DGT_EV_URL,
  DEFAULT_TIMEOUT,
};
