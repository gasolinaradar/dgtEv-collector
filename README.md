# @gasolinaradar/dgt-ev-collector

<!-- EN -->

A Node.js collector for the **official DGT EV charging station dataset** (Spain). It downloads the public DATE X2/energy-infrastructure XML from the Spanish Directorate-General for Traffic (DGT), parses every charging site (`energyInfrastructureSite`) with its connectors, and returns a **normalized, ready-to-use** array of EV charging stations.

<!-- ES -->

Collector de Node.js para el **dataset oficial de puntos de recarga de vehículos eléctricos de la DGT** (España). Descarga el XML público DATE X2 de infraestructura energética de la Dirección General de Tráfico (DGT), parsea cada punto de recarga (`energyInfrastructureSite`) con sus conectores y devuelve un array de estaciones de recarga **normalizado y listo para usar**.

---

## Features / Características

**EN:**

- Official public source (DGT, Spain).
- Parses the DATE X2/energy-infrastructure XML payload (namespace-prefix agnostic).
- Extracts site name, address (labeled lines), municipality, province and postal code.
- Extracts connectors (`type`, `format`, `mode`, `maxPowerKw`, `voltageV`, `maxCurrentA`), normalizing watts to kilowatts.
- Extracts schedule (`operatingHours.label`) and supplemental services.
- Normalizes coordinates to `[longitude, latitude]` (GeoJSON order).
- Built-in retry with exponential backoff.
- Injectable logger, HTTP client, and URL resolver.
- Progress reporting hook for long runs.
- Zero configuration: works with sensible defaults.

**ES:**

- Fuente pública oficial (DGT, España).
- Parsea el payload XML DATE X2 de infraestructura energética (agnóstico de prefijos de namespace).
- Extrae nombre, dirección (líneas etiquetadas), municipio, provincia y código postal.
- Extrae los conectores (`type`, `format`, `mode`, `maxPowerKw`, `voltageV`, `maxCurrentA`), normalizando vatios a kilovatios.
- Extrae horario (`operatingHours.label`) y servicios complementarios.
- Normaliza las coordenadas a `[longitude, latitude]` (orden GeoJSON).
- Reintentos con backoff exponencial integrados.
- Logger, cliente HTTP y resolución de URL inyectables.
- Hook de reporte de progreso para ejecuciones largas.
- Cero configuración: funciona con valores por defecto sensatos.

---

## Installation / Instalación

```bash
npm install @gasolinaradar/dgt-ev-collector
```

---

## Quick start / Inicio rápido

```js
const { fetchStations } = require('@gasolinaradar/dgt-ev-collector');

async function main() {
  const stations = await fetchStations();
  console.log(`Fetched ${stations.length} EV charging sites`);
  console.log(stations[0]);
}

main();
```

---

## API

### `fetchStations(options?) → Promise<Station[]>`

Downloads the XML, parses the sites and returns normalized EV charging stations in one step.

```js
const { fetchStations } = require('@gasolinaradar/dgt-ev-collector');

const stations = await fetchStations({
  logger: console,
  timeout: 20000,
  retries: 3,
});
```

### `createDgtEvCollector(options?) → Collector`

Returns an object matching the common **collector contract** used by ingestion pipelines:

```js
{ name: 'dgt-ev', country: 'ES', fetch(context) }
```

```js
const { createDgtEvCollector } = require('@gasolinaradar/dgt-ev-collector');

const dgtEvCollector = createDgtEvCollector({
  logger,
});

const stations = await dgtEvCollector.fetch({
  reportProgress(percent, metadata = {}) {
    console.log(`${percent}%`, metadata);
  },
});
```

---

## Options / Opciones

| Option    | Type                     | Default | Description                                                        |
| --------- | ------------------------ | ------- | ------------------------------------------------------------------ |
| `url`     | `string \| () => string` | DGT URL | Dataset URL. As a function, it is evaluated on every fetch.        |
| `country` | `string \| () => string` | `ES`    | Country code attached to every normalized station.                 |
| `timeout` | `number`                 | `20000` | HTTP timeout in milliseconds.                                      |
| `retries` | `number`                 | `3`     | Retry attempts before failing.                                     |
| `logger`  | `{ info, warn, debug }`  | `console` | Injectable logger.                                              |
| `httpClient` | `{ get(url, opts) }`  | `axios` | Injectable HTTP client (useful for tests or custom TLS settings). |

| Opción    | Tipo                        | Por defecto | Descripción                                                         |
| --------- | --------------------------- | ----------- | ------------------------------------------------------------------- |
| `url`     | `string \| () => string`    | URL DGT     | URL del dataset. Como función, se evalúa en cada fetch.             |
| `country` | `string \| () => string`    | `ES`        | Código de país que se añade a cada estación normalizada.            |
| `timeout` | `number`                    | `20000`     | Timeout HTTP en milisegundos.                                       |
| `retries` | `number`                    | `3`         | Intentos de reintento antes de fallar.                              |
| `logger`  | `{ info, warn, debug }`     | `console`   | Logger inyectable.                                                  |
| `httpClient` | `{ get(url, opts) }`     | `axios`     | Cliente HTTP inyectable (útil en tests o para configuración TLS personalizada). |

> **Note:** When `httpClient` is injected, the collector does not build any HTTP client itself. Pass an axios instance with your own TLS settings (e.g. `rejectUnauthorized`) if you need custom certificate validation.

> **Nota:** Cuando se inyecta `httpClient`, el collector no construye ningún cliente HTTP propio. Pasa una instancia de axios con tu propia configuración TLS (p. ej. `rejectUnauthorized`) si necesitas validación de certificados personalizada.

---

## Output schema / Esquema de salida

Each normalized station looks like this / Cada estación normalizada tiene esta forma:

```js
{
  source: 'dgt-ev',
  country: 'ES',
  sourceStationId: 'ID0-1000',
  name: 'Electrolinera Madrid Centro',
  address: 'Calle Mayor 1',
  municipality: 'Madrid',
  province: 'Madrid',
  postalCode: '28013',
  schedule: '24 horas',
  services: ['ev_charging', 'CAFE'],
  connectors: [
    {
      type: 'IEC_62196_T2',
      format: 'SOCKET',
      mode: 'MODE_3',
      maxPowerKw: 22,
      voltageV: 230,
      maxCurrentA: 32,
    },
  ],
  location: {
    type: 'Point',
    coordinates: [-3.7038, 40.4168], // [longitude, latitude]
  },
  prices: undefined,
  lastUpdated: Date,
}
```

Notes / Notas:

- `connectors` is `undefined` when a site declares no connectors.
- Coordinates are `[longitude, latitude]` (GeoJSON order). Sites that cannot be resolved with coordinates are skipped (logged as warnings).
- `prices` is intentionally `undefined` for EV charging sites.

---

## Progress reporting / Reporte de progreso

The collector accepts an optional `context.reportProgress(percent, metadata)` callback:

```js
const stations = await dgtEvCollector.fetch({
  reportProgress(percent, metadata) {
    // percent: 5   -> requesting the dataset
    // percent: 35  -> parsing the XML
    // percent: 70  -> normalizing sites
    // percent: 100 -> completed
    console.log(percent, metadata.stage);
  },
});
```

---

## Data source / Fuente de datos

**EN:** The data is the public EV charging station dataset of the Spanish Directorate-General for Traffic (DGT), published at:

**ES:** Los datos provienen del dataset público de puntos de recarga de vehículos eléctricos de la Dirección General de Tráfico (DGT), publicado en:

- `https://infocar.dgt.es/datex2/v3/miterd/EnergyInfrastructureTablePublication/electrolineras.xml`

This project is **not affiliated with** the Spanish State or DGT. The data belongs to the State and is provided "as is". See the legal documents below.

Este proyecto **no está afiliado** al Estado español ni a la DGT. Los datos pertenecen al Estado y se proporcionan "tal cual". Consulta los documentos legales a continuación.

---

## Legal / Legal

**EN:**

- [LEGAL.md](./LEGAL.md) — Legal notice and disclaimer (bilingual).
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) — Data attribution and third-party licenses.
- [LICENSE](./LICENSE) — MIT License (applies to this software, **not** to the underlying DGT data).

**ES:**

- [LEGAL.md](./LEGAL.md) — Aviso legal y descargo de responsabilidad (bilingüe).
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) — Atribución de datos y licencias de terceros.
- [LICENSE](./LICENSE) — Licencia MIT (aplica a este software, **no** a los datos subyacentes de la DGT).

---

## Tests

```bash
npm test
```

---

## License / Licencia

**EN:** MIT. See [LICENSE](./LICENSE). The DGT data is **not** covered by this license; it is public information of the Spanish State.

**ES:** MIT. Consulta [LICENSE](./LICENSE). Los datos de la DGT **no** están cubiertos por esta licencia; son información pública del Estado español.
