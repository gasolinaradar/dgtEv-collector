const { test } = require('node:test');
const assert = require('node:assert');
const { createDgtEvCollector, fetchStations } = require('../src');
const { extractText, normalizeConnector, normalizeSite, normalizeAddress } = require('../src/normalize');
const { parseSitesFromXml, DEFAULT_DGT_EV_URL } = require('../src/fetch');

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d2:EnergyInfrastructureTablePublication xmlns:d2="http://datex2.eu/schema/3/core" xmlns:e="http://datex2.eu/schema/3/energyInfrastructure">
  <payload>
    <energyInfrastructureTable>
      <energyInfrastructureSite id="ID0-1000">
        <name>Electrolinera Madrid Centro</name>
        <locationReference>
          <coordinatesForDisplay>
            <latitude>40.4168</latitude>
            <longitude>-3.7038</longitude>
          </coordinatesForDisplay>
          <_locationReferenceExtension>
            <facilityLocation>
              <address>
                <addressLine><text>Dirección: Calle Mayor 1</text></addressLine>
                <addressLine><text>Municipio: Madrid</text></addressLine>
                <addressLine><text>Provincia: Madrid</text></addressLine>
                <postcode>28013</postcode>
              </address>
            </facilityLocation>
          </_locationReferenceExtension>
        </locationReference>
        <energyInfrastructureStation>
          <refillPoint>
            <connector>
              <connectorType>IEC_62196_T2</connectorType>
              <connectorFormat>SOCKET</connectorFormat>
              <chargingMode>MODE_3</chargingMode>
              <maxPowerAtSocket>22000</maxPowerAtSocket>
              <voltage>230</voltage>
              <maximumCurrent>32</maximumCurrent>
            </connector>
          </refillPoint>
        </energyInfrastructureStation>
        <supplementalFacility>
          <serviceFacilityType>CAFE</serviceFacilityType>
        </supplementalFacility>
        <operatingHours>
          <label>24 horas</label>
        </operatingHours>
        <lastUpdated>2026-07-31T10:00:00+02:00</lastUpdated>
      </energyInfrastructureSite>
      <energyInfrastructureSite id="ID0-2000">
        <name>Electrolinera Bilbao</name>
        <locationReference>
          <coordinatesForDisplay>
            <latitude>43.263</latitude>
            <longitude>-2.935</longitude>
          </coordinatesForDisplay>
          <_locationReferenceExtension>
            <facilityLocation>
              <address>
                <addressLine><text>Dirección: Gran Vía 1</text></addressLine>
                <addressLine><text>Municipio: Bilbao</text></addressLine>
                <addressLine><text>Provincia: Bizkaia</text></addressLine>
                <postcode>48001</postcode>
              </address>
            </facilityLocation>
          </_locationReferenceExtension>
        </locationReference>
      </energyInfrastructureSite>
    </energyInfrastructureTable>
  </payload>
</d2:EnergyInfrastructureTablePublication>`;

function createFakeClient(xml, captured = {}) {
  return {
    get: async (url) => {
      captured.url = url;
      return {
        status: 200,
        data: xml,
        headers: { 'content-length': String(xml.length) },
      };
    },
  };
}

test('fetchStations returns normalized EV charging stations', async () => {
  const captured = {};
  const stations = await fetchStations({
    httpClient: createFakeClient(SAMPLE_XML, captured),
    logger: silentLogger,
  });

  assert.equal(captured.url, DEFAULT_DGT_EV_URL);
  assert.equal(stations.length, 2);

  const [a, b] = stations;
  assert.equal(a.source, 'dgt-ev');
  assert.equal(a.country, 'ES');
  assert.equal(a.sourceStationId, 'ID0-1000');
  assert.equal(a.name, 'Electrolinera Madrid Centro');
  assert.equal(a.address, 'Calle Mayor 1');
  assert.equal(a.municipality, 'Madrid');
  assert.equal(a.province, 'Madrid');
  assert.equal(a.postalCode, '28013');
  assert.equal(a.schedule, '24 horas');
  assert.deepEqual(a.services, ['ev_charging', 'CAFE']);
  assert.deepEqual(a.connectors, [
    {
      type: 'IEC_62196_T2',
      format: 'SOCKET',
      mode: 'MODE_3',
      maxPowerKw: 22,
      voltageV: 230,
      maxCurrentA: 32,
    },
  ]);
  assert.deepEqual(a.location, { type: 'Point', coordinates: [-3.7038, 40.4168] });
  assert.equal(a.prices, undefined);
  assert.ok(a.lastUpdated instanceof Date);

  assert.equal(b.sourceStationId, 'ID0-2000');
  assert.equal(b.name, 'Electrolinera Bilbao');
  assert.equal(b.municipality, 'Bilbao');
  assert.equal(b.province, 'Bizkaia');
  assert.deepEqual(b.services, ['ev_charging']);
  assert.equal(b.connectors, undefined);
  assert.equal(b.schedule, undefined);
});

test('uses a custom url when provided', async () => {
  const captured = {};
  await fetchStations({
    url: 'https://example.test/custom.xml',
    httpClient: createFakeClient(SAMPLE_XML, captured),
    logger: silentLogger,
  });

  assert.equal(captured.url, 'https://example.test/custom.xml');
});

test('createDgtEvCollector exposes the collector contract', async () => {
  const collector = createDgtEvCollector({
    httpClient: createFakeClient(SAMPLE_XML),
    logger: silentLogger,
  });

  assert.equal(collector.name, 'dgt-ev');
  assert.equal(collector.country, 'ES');
  assert.equal(typeof collector.fetch, 'function');

  const stations = await collector.fetch({});
  assert.equal(stations.length, 2);
});

test('reports progress through the context hook', async () => {
  const collector = createDgtEvCollector({
    httpClient: createFakeClient(SAMPLE_XML),
    logger: silentLogger,
  });
  const steps = [];

  const stations = await collector.fetch({
    reportProgress(percent, metadata = {}) {
      steps.push({ percent, metadata });
    },
  });

  assert.equal(stations.length, 2);
  assert.equal(steps[0].percent, 5);
  assert.equal(steps[0].metadata.stage, 'requesting_dataset');
  assert.ok(steps.some((step) => step.percent === 35 && step.metadata.stage === 'parsing_dataset'));
  assert.ok(
    steps.some((step) => step.percent === 70 && step.metadata.stage === 'normalizing_dataset'),
  );
  assert.equal(steps[steps.length - 1].percent, 100);
  assert.equal(steps[steps.length - 1].metadata.stage, 'completed');
});

test('throws on empty DGT EV dataset response', async () => {
  const emptyClient = { get: async () => ({ status: 200, data: '', headers: {} }) };
  await assert.rejects(
    () => fetchStations({ httpClient: emptyClient, retries: 0, logger: silentLogger }),
    /Empty DGT EV dataset response/,
  );
});

test('parseSitesFromXml extracts energyInfrastructureSite nodes', () => {
  const sites = parseSitesFromXml(SAMPLE_XML);
  assert.equal(sites.length, 2);
  assert.equal(extractText(sites[0].id), 'ID0-1000');
  assert.equal(extractText(sites[0].name), 'Electrolinera Madrid Centro');
});

test('normalizeSite returns null when the site has no id', () => {
  assert.equal(normalizeSite({ name: 'Sin id' }, 'ES'), null);
  assert.equal(normalizeSite(null, 'ES'), null);
});

test('normalizeConnector converts maxPowerAtSocket watts to kilowatts', () => {
  assert.deepEqual(
    normalizeConnector({ maxPowerAtSocket: '22000', voltage: '230', maximumCurrent: '32' }),
    { maxPowerKw: 22, voltageV: 230, maxCurrentA: 32 },
  );
  assert.deepEqual(normalizeConnector({ maxPowerAtSocket: '50' }), { maxPowerKw: 50 });
  assert.equal(normalizeConnector({}), null);
  assert.equal(normalizeConnector(null), null);
});

test('normalizeAddress parses labeled address lines', () => {
  assert.deepEqual(
    normalizeAddress({
      addressLine: [
        { text: 'Dirección: Calle Mayor 1' },
        { text: 'Municipio: Madrid' },
        { text: 'Provincia: Madrid' },
      ],
      postcode: '28013',
    }),
    {
      address: 'Calle Mayor 1',
      municipality: 'Madrid',
      province: 'Madrid',
      postalCode: '28013',
    },
  );
});
