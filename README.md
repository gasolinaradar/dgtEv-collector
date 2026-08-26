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
- Extracts `typeOfSite`, `authenticationMethods`, and `operator` from DGT XML.
- Normalizes coordinates to `[longitude, latitude]` (GeoJSON order).
- Built-in retry with exponential backoff.
- Injectable logger, HTTP client, and URL resolver.
- Progress reporting hook for long runs.
- Zero configuration: works with sensible defaults.
- **Streaming parser** (`streamStations`/`collector.stream()`): the ~80+ MB XML is never
  fully loaded into memory. It's downloaded as an HTTP stream and parsed incrementally
  with a SAX parser (`saxes`), yielding one normalized station at a time as soon as its
  `energyInfrastructureSite` closes. Peak memory stays roughly constant regardless of file
  size (measured: ~19 MB heap / ~77 MB RSS streaming the full real dataset, vs. a DOM-based
  parse that would need 100+ MB just to hold the XML as a JS string before parsing anything).
- **Reve API enrichment** (optional): enrich stations with real-time prices and availability
  from Red Eléctrica's Reve API. Matches DGT stations to Reve locations by geographic proximity,
  caches Reve data on disk for incremental refreshes (5 req/h rate limit).

**ES:**

- Fuente pública oficial (DGT, España).
- Parsea el payload XML DATE X2 de infraestructura energética (agnóstico de prefijos de namespace).
- Extrae nombre, dirección (líneas etiquetadas), municipio, provincia y código postal.
- Extrae los conectores (`type`, `format`, `mode`, `maxPowerKw`, `voltageV`, `maxCurrentA`), normalizando vatios a kilovatios.
- Extrae horario (`operatingHours.label`) y servicios complementarios.
- Extrae `typeOfSite`, `authenticationMethods` y `operator` del XML de la DGT.
- Normaliza las coordenadas a `[longitude, latitude]` (orden GeoJSON).
- Reintentos con backoff exponencial integrados.
- Logger, cliente HTTP y resolución de URL inyectables.
- Hook de reporte de progreso para ejecuciones largas.
- Cero configuración: funciona con valores por defecto sensatos.
- **Enriquecimiento con API Reve** (opcional): enriquece estaciones con precios y disponibilidad
  en tiempo real de la API Reve de Red Eléctrica. Relaciona estaciones DGT con ubicaciones Reve
  por proximidad geográfica, cachea datos Reve en disco para refreshes incrementales (límite 5 req/h).

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
{ name: 'dgt-ev', country: 'ES', fetch(context), stream(context) }
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

### `streamStations(options?, hooks?) → AsyncGenerator<Station>` (recommended for large runs)

Downloads and parses the XML as a stream and `yield`s each normalized station as soon as
it's ready, without ever materializing the full document or the full result array in
memory. Backpressure is automatic: the generator only reads more of the HTTP response once
you consume the previous `yield`, so it's safe to pair with e.g. batched DB upserts.

```js
const { streamStations } = require('@gasolinaradar/dgt-ev-collector');
// equivalently: createDgtEvCollector(options).stream(context)

let batch = [];
for await (const station of streamStations({ logger })) {
  batch.push(station);
  if (batch.length >= 250) {
    await upsertBatch(batch); // your own idempotent, batched persistence
    batch = [];
  }
}
if (batch.length > 0) {
  await upsertBatch(batch);
}
```

`fetchStations()` is still available and internally just drains `streamStations()` into an
array — kept for backwards compatibility, but it re-materializes the whole dataset in
memory, so prefer `streamStations`/`collector.stream()` for the real ~80+ MB feed.

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
| `enrich`  | `object`                 | `undefined` | Enrichment options for Reve API. See [Enrichment](#enrichment--enriquecimiento). |

| Opción    | Tipo                        | Por defecto | Descripción                                                         |
| --------- | --------------------------- | ----------- | ------------------------------------------------------------------- |
| `url`     | `string \| () => string`    | URL DGT     | URL del dataset. Como función, se evalúa en cada fetch.             |
| `country` | `string \| () => string`    | `ES`        | Código de país que se añade a cada estación normalizada.            |
| `timeout` | `number`                    | `20000`     | Timeout HTTP en milisegundos.                                       |
| `retries` | `number`                    | `3`         | Intentos de reintento antes de fallar.                              |
| `logger`  | `{ info, warn, debug }`     | `console`   | Logger inyectable.                                                  |
| `httpClient` | `{ get(url, opts) }`     | `axios`     | Cliente HTTP inyectable (útil en tests o para configuración TLS personalizada). |
| `enrich`  | `object`                    | `undefined` | Opciones de enriquecimiento con API Reve. Ver [Enriquecimiento](#enrichment--enriquecimiento). |

> **Note:** When `httpClient` is injected, the collector does not build any HTTP client itself. Pass an axios instance with your own TLS settings (e.g. `rejectUnauthorized`) if you need custom certificate validation. The collector requests `responseType: 'stream'`; a custom client may resolve `response.data` either as a real stream (Readable / any async-iterable of chunks) for true O(1)-memory streaming, or as a plain string/Buffer (e.g. simple test doubles) — both are supported transparently.

> **Nota:** Cuando se inyecta `httpClient`, el collector no construye ningún cliente HTTP propio. Pasa una instancia de axios con tu propia configuración TLS (p. ej. `rejectUnauthorized`) si necesitas validación de certificados personalizada. El collector pide `responseType: 'stream'`; un cliente personalizado puede resolver `response.data` bien como un stream real (Readable / cualquier async-iterable de trozos) para streaming real con memoria O(1), o bien como un string/Buffer plano (p. ej. dobles de test sencillos) — ambos casos se soportan de forma transparente.

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
  typeOfSite: 'onstreet',           // from DGT XML, if present
  authenticationMethods: ['rfid'],   // from DGT XML, if present
  operator: { name: 'Wenea', website: 'www.wenea.es' }, // from DGT XML, if present
  location: {
    type: 'Point',
    coordinates: [-3.7038, 40.4168], // [longitude, latitude]
  },
  prices: undefined,                 // populated by Reve enrichment
  availability: undefined,           // populated by Reve enrichment
  reveLocationId: undefined,         // populated by Reve enrichment
  lastUpdated: Date,
}
```

When enriched with Reve data (`enrich.reveApiKey`), the fields are populated:

```js
{
  // ... all DGT fields above ...
  typeOfSite: 'onstreet',
  operator: { name: 'Wenea', website: 'www.wenea.es' },
  reveLocationId: 'reve-abc-123',
  prices: [
    { type: 'ENERGY', price: 0.35, currency: 'EUR', vat: 21, stepSize: 1 },
    { type: 'TIME', price: 0.02, currency: 'EUR', stepSize: 60 },
  ],
  availability: {
    status: 'AVAILABLE',   // AVAILABLE | CHARGING | RESERVED | BLOCKED | INOPERATIVE | OUTOFORDER | UNKNOWN
    evseCount: 2,
    lastUpdated: '2026-08-25T10:00:00Z',
  },
}
```

Notes / Notas:

- `connectors` is `undefined` when a site declares no connectors.
- Coordinates are `[longitude, latitude]` (GeoJSON order). Sites that cannot be resolved with coordinates are skipped (logged as warnings).
- `prices`, `availability`, and `reveLocationId` are `undefined` until enrichment is enabled.
- `typeOfSite`, `authenticationMethods`, and `operator` are extracted from DGT XML when present.

---

## Progress reporting / Reporte de progreso

The collector accepts an optional `context.reportProgress(percent, metadata)` callback:

```js
const stations = await dgtEvCollector.fetch({
  reportProgress(percent, metadata) {
    // percent: 5   -> requesting the dataset
    // percent: 35  -> streaming/parsing the XML has started
    // percent: 70  -> the whole response has been read (final sites still being yielded)
    // percent: 100 -> completed
    console.log(percent, metadata.stage);
  },
});
```

---

## Enrichment / Enriquecimiento

The collector can enrich DGT stations with **real-time prices and availability** from
[Red Eléctrica's Reve API](https://www.mapareve.es/). This requires a free API key
(request at [mapareve.es/api-contacto](https://www.mapareve.es/api-contacto)).

El collector puede enriquecer las estaciones DGT con **precios y disponibilidad en tiempo real**
desde la [API Reve de Red Eléctrica](https://www.mapareve.es/). Requiere una API key gratuita
(solicitar en [mapareve.es/api-contacto](https://www.mapareve.es/api-contacto)).

### How it works / Cómo funciona

1. Fetches Reve **locations first** (see Rate limit below for why), then operational status,
   then tariffs — all paginated, 100/page.
2. Caches Reve data on disk for incremental refreshes. Locations, status and tariffs all
   **accumulate** across calls (each call merges into what's already cached instead of
   replacing it), since a single call rarely has enough rate-limit budget to fetch everything.
3. Builds a spatial index from the **full accumulated set of cached locations** (not just what
   this call fetched).
4. Matches each DGT station to the nearest Reve location by geographic proximity.
5. Merges prices, availability, and operator data into the station object, resolving prices/
   availability from the full accumulated status/tariffs cache too (not just this call's fetch).

### Rate limit / Límite de velocidad

The Reve API allows **5 requests per hour**, shared across locations + status + tariffs in that
order — **locations first**, always, because without a location there's nothing to match a DGT
station against regardless of how much status/tariff data is available. status/tariffs get
whatever budget remains after locations, which can be zero.

The collector:
- Uses `date_from` for incremental refreshes on subsequent calls (locations, status and tariffs
  each track their own last-successful-fetch date independently).
- Falls back to cached data if the API is rate-limited or fails.
- A full initial load of ~14,500 locations takes multiple hourly cycles at 5 req/h (each cycle
  fetches as many pages as the remaining budget allows and merges them into the cache — coverage
  grows cycle over cycle, it isn't lost between calls).
- A locations fetch that fails does **not** advance its cached "last fetch" date, so a failed
  attempt doesn't cause the next attempt to (incorrectly) ask Reve for only what changed since
  the failed attempt's timestamp.

### Usage / Uso

```js
const { fetchStations, streamStations, createDgtEvCollector } = require('@gasolinaradar/dgt-ev-collector');

// With fetchStations
const stations = await fetchStations({
  enrich: {
    reveApiKey: process.env.REVE_API_KEY,
    cacheDir: './cache/reve',         // where to store Reve data on disk
    thresholdMeters: 100,             // max distance to match (default: 50m)
  },
});

// With streaming
for await (const station of streamStations({
  enrich: {
    reveApiKey: process.env.REVE_API_KEY,
    cacheDir: '/tmp/reve-cache',
  },
})) {
  if (station.prices) {
    console.log(`${station.name}: €${station.prices[0].price}/kWh`);
  }
  if (station.availability) {
    console.log(`Status: ${station.availability.status}`);
  }
}

// With collector contract
const collector = createDgtEvCollector({
  enrich: {
    reveApiKey: process.env.REVE_API_KEY,
    cacheDir: './cache/reve',
  },
});
const stations = await collector.fetch(context);

// Or enrich an existing array
const enriched = await collector.enrich(existingStations, {
  reveApiKey: process.env.REVE_API_KEY,
  cacheDir: './cache/reve',
});
```

### Enrich options / Opciones de enriquecimiento

| Option             | Type      | Default | Description                                                                                                  |
| ------------------ | --------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `reveApiKey`       | `string`  | —       | **Required.** Reve API key from mapareve.es.                                                                 |
| `cacheDir`         | `string`  | —       | Directory for Reve data cache files. Enables incremental refresh and cross-call accumulation.                 |
| `thresholdMeters`  | `number`  | `50`    | Max distance (meters) to match a DGT station to a Reve location.                                             |
| `onlyDynamicInfo`  | `boolean` | —       | When set, filters the locations fetch to only locations with dynamic (price/availability) data, saving requests on incremental refreshes. Leave unset on the first call to get the full location set. |

---

## Experimental: undocumented public API / Experimental: API pública no documentada

**EN:** `experimental.createRevePublicClient` and `experimental.enrichStationsExperimental`
talk to `https://www.mapareve.es/api/public/v1` — the internal, unauthenticated API the
mapareve.es map itself uses in the browser, reverse-engineered from its JS bundle (not the
documented `/api/external/v1` used by the rest of this library). It needs **no API key**
and no documented rate limit was observed, and it returns status and tariffs already
embedded per location (one paginated call instead of three separate feeds).

None of that makes it supported: it is not published by Red Eléctrica, can change or
disappear without notice, and automated use outside a browser may fall outside the site's
terms of use. It is kept **separate from the stable exports** for exactly that reason —
use it to evaluate parity with `/api/external/v1`, not as a production dependency.

```js
const { experimental } = require('@gasolinaradar/dgt-ev-collector');

const enriched = await experimental.enrichStationsExperimental(stations, {
  acknowledgeUnsupported: true, // required — you're opting into an unsupported endpoint
});
```

`acknowledgeUnsupported: true` is required by both `createRevePublicClient(...)` and
`enrichStationsExperimental(stations, ...)` — omitting it throws. Output fields
(`reveLocationId`, `operator`, `prices`, `availability`) match `enrichStations()` exactly,
so it's a drop-in comparison for the same `stations` array.

**⚠️ Request volume — no caching, full sweep every call.** There is no on-disk cache or
resumable cursor: every call walks every page of the dataset, from page 1 through the last
one, fresh. `POST /locations` caps `per_page` at **25** (confirmed live — 10/15/20/25 all
work, 30/50/100 all 400) and requires a bounding box (defaults to all of Spain if you don't
pass one via `filters`), so a full run is **~582 sequential requests** (~14,550 locations ÷
25) against an endpoint with no documented rate limit or SLA — **every single time**,
including on every cron tick if this runs on a schedule. Pass `maxPages` yourself to cap a
single run (e.g. while testing) if you don't want that.

**Resilience**: a single page failing (timeout, network error, HTTP 429/5xx) is retried
with exponential backoff (`retries`, default 3) before giving up on *that page only* — it
doesn't abort the run, so one bad page doesn't throw away every other page already fetched.
If `maxConsecutivePageFailures` pages in a row fail even after their own retries (default
3), the sweep stops early instead of grinding through the rest of the dataset blind — that
many failures in a row means something systemic (the WAF, an outage), not a blip. HTTP 400
(bad request) and 403 (most likely the Incapsula WAF) are never retried — a 400 won't fix
itself, and retrying/evading a WAF block automatically is out of scope for this client.

**Matching: exact name first, proximity as fallback.** For each station, if a Reve location
exists whose `name` matches exactly (case/accent-insensitive) it's used regardless of
distance; if more than one Reve location shares that exact name, the nearest of those wins.
Only when there's no name match at all does it fall back to nearest-within-`thresholdMeters`.
The enrichment-complete log reports `matchedByName` vs `matchedByProximity` so you can see
which one fired.

**ES:** `experimental.createRevePublicClient` y `experimental.enrichStationsExperimental`
hablan con `https://www.mapareve.es/api/public/v1` — la API interna y sin autenticación que
usa el propio mapa de mapareve.es en el navegador, obtenida por ingeniería inversa de su
bundle JS (no la `/api/external/v1` documentada que usa el resto de esta librería). No
requiere API key, no se observó ningún límite de peticiones documentado, y devuelve el
estado y las tarifas ya embebidos por emplazamiento en cada página.

**⚠️ Volumen de peticiones — sin caché, barrido completo en cada llamada.** No hay caché en
disco ni cursor reanudable: cada llamada recorre todas las páginas del dataset, de la 1 a la
última, siempre desde cero. `POST /locations` limita `per_page` a **25 como máximo**
(confirmado en vivo — 10/15/20/25 funcionan, 30/50/100 dan 400) y exige un bounding box (por
defecto, toda España si no pasas uno vía `filters`), así que un barrido completo son **~582
peticiones secuenciales** (~14.550 ubicaciones ÷ 25) contra un endpoint sin límite ni SLA
documentados — **cada vez**, incluido cada disparo del cron si esto corre en uno. Pasa
`maxPages` tú mismo si quieres acotar una ejecución concreta (p. ej. para probar).

**Resiliencia**: si una página falla (timeout, error de red, HTTP 429/5xx) se reintenta con
backoff exponencial (`retries`, 3 por defecto) antes de rendirse **solo con esa página** —
no aborta la ejecución entera, así que una página mala no tira todas las demás ya
conseguidas. Si `maxConsecutivePageFailures` páginas seguidas fallan incluso tras sus propios
reintentos (3 por defecto), el barrido para antes de tiempo en vez de machacar el resto del
dataset a ciegas — tantos fallos seguidos indican algo sistémico (el WAF, una caída), no un
bache puntual. Un HTTP 400 (petición inválida) o 403 (probablemente el WAF de Incapsula)
nunca se reintentan — un 400 no se arregla solo, y reintentar/evadir un bloqueo del WAF
automáticamente queda fuera del alcance de este cliente.

**Matching: primero nombre exacto, proximidad como respaldo.** Para cada estación, si existe
una ubicación Reve cuyo `name` coincide exactamente (ignorando mayúsculas/acentos) se usa
sin importar la distancia; si varias ubicaciones Reve comparten ese nombre exacto, gana la
más cercana de esas. Solo si no hay ningún nombre coincidente cae al comportamiento anterior
(más cercana dentro de `thresholdMeters`). El log de fin de enriquecimiento reporta
`matchedByName` vs `matchedByProximity` para que veas cuál se disparó.

Nada de eso la hace soportada: no está publicada por Red Eléctrica, puede cambiar o
desaparecer sin aviso, y su uso automatizado fuera del navegador puede quedar fuera de los
términos de uso del sitio. Se mantiene **separada de los exports estables** precisamente
por eso — úsala para evaluar la paridad con `/api/external/v1`, no como dependencia de
producción.

`acknowledgeUnsupported: true` es obligatorio tanto en `createRevePublicClient(...)` como en
`enrichStationsExperimental(stations, ...)` — omitirlo lanza un error. Los campos de salida
(`reveLocationId`, `operator`, `prices`, `availability`) coinciden exactamente con los de
`enrichStations()`, así que es una comparación directa para el mismo array `stations`.

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
npm test                 # unit tests (mocked HTTP) — includes the experimental client/enrichment
npm run test:live        # live: real DGT dataset
npm run test:live-public # live: real /api/public/v1 (experimental), no key needed (~5 requests)
REVE_API_KEY=xxx npm run test:live-compare  # live: side-by-side vs /api/external/v1 (spends 1 of its 5 req/h)
```

---

## License / Licencia

**EN:** MIT. See [LICENSE](./LICENSE). The DGT data is **not** covered by this license; it is public information of the Spanish State.

**ES:** MIT. Consulta [LICENSE](./LICENSE). Los datos de la DGT **no** están cubiertos por esta licencia; son información pública del Estado español.
