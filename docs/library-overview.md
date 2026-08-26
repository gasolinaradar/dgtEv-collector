# `@gasolinaradar/dgt-ev-collector` — funcionalidad completa

Documento de referencia para el equipo que integra esta librería en el backend. Cubre todo
lo que hace, todos los datos que produce, y cómo se comporta en cada caso. Todo lo descrito
aquí está verificado contra el código real de la versión indicada abajo — nada es
aspiracional.

**Versión actual**: `1.5.0-experimental.8`, publicada bajo el dist-tag npm `experimental`
(`npm install @gasolinaradar/dgt-ev-collector@experimental`) — **no** es todavía la versión
`latest`. El código ya está limpio/unificado (esto es justo lo que documenta este archivo),
pero se sigue publicando como prerelease para poder probarlo en PRE antes de promoverlo.

---

## 1. Qué hace

Dos cosas, en dos capas independientes:

1. **Descarga y normaliza el dataset oficial de electrolineras de la DGT** (España) —
   dataset público, sin autenticación, sin límite de peticiones documentado.
2. **Opcionalmente enriquece esas estaciones** con precios y disponibilidad en tiempo real
   de Reve (Red Eléctrica / mapareve.es), usando **una de dos fuentes** por debajo:
   - `/api/external/v1` — API documentada por Reve, requiere API key, 5 peticiones/hora.
   - `/api/public/v1` — API interna del propio mapa web de mapareve.es, no documentada,
     sin autenticación ni límite conocido, descubierta por ingeniería inversa.

El enriquecimiento es completamente opcional: sin configurarlo, la librería solo hace (1).

---

## 2. Instalación y exports

```bash
npm install @gasolinaradar/dgt-ev-collector@experimental
```

```js
const {
  fetchStations,          // descarga + normaliza todo el dataset DGT (array completo)
  streamStations,         // igual, pero streaming (memoria O(1)) — recomendado
  createDgtEvCollector,   // wrapper con el contrato { name, country, fetch(), stream(), enrich() }
  enrichStations,         // enriquecimiento con Reve — decide external vs public según opciones
  createReveClient,       // cliente de bajo nivel de /api/external/v1 (uso avanzado)
  createReveCache,        // caché en disco usada por el enriquecimiento external
  createRevePublicClient, // cliente de bajo nivel de /api/public/v1 (uso avanzado)
} = require('@gasolinaradar/dgt-ev-collector');
```

Para el 95% de los casos de uso solo hacen falta `fetchStations`/`streamStations` (con o sin
`options.enrich`) o `createDgtEvCollector`. El resto son piezas de bajo nivel para
integraciones más específicas.

---

## 3. Flujo general

```
fetchStations() / streamStations()
  └── descarga XML DATEX II de la DGT (streaming, SAX) → Station[] normalizado

  si options.enrich está presente:
      enrichStations(stations, options.enrich)
        │
        ├── ¿reveApiKey presente Y source !== 'public'?
        │     └── SÍ → fuente EXTERNAL (/api/external/v1, documentada, con key)
        │
        └── ¿reveApiKey ausente, O source === 'public'?
              └── SÍ → fuente PUBLIC (/api/public/v1, no documentada, sin key)

  → Station[] (igual que antes, con reveLocationId/operator/prices/availability
    rellenos si hubo match; +reveData si la fuente fue public)
```

`createDgtEvCollector(options).fetch(context)` / `.stream(context)` hacen exactamente esto
por debajo. `collector.enrich(stations, enrichOptions)` permite enriquecer un array ya
existente sin volver a descargar la DGT.

---

## 4. Modelo de datos: `Station`

Cada elemento del array devuelto tiene esta forma. Los campos bajo "Reve" están `undefined`
hasta que se enriquece.

```js
{
  // --- De la DGT, siempre presentes ---
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
    { type: 'IEC_62196_T2', format: 'SOCKET', mode: 'MODE_3', maxPowerKw: 22, voltageV: 230, maxCurrentA: 32 },
  ],
  typeOfSite: 'onstreet',            // si el XML de la DGT lo trae
  authenticationMethods: ['rfid'],   // idem
  operator: { name: 'Wenea', website: 'www.wenea.es' }, // idem (se sobrescribe si hay match Reve)
  location: { type: 'Point', coordinates: [-3.7038, 40.4168] }, // [lon, lat], orden GeoJSON
  lastUpdated: Date,

  // --- De Reve, solo si hay match tras enrichStations() ---
  reveLocationId: 'uuid-de-la-ubicacion-reve',
  prices: [
    { type: 'ENERGY', price: 0.35, currency: 'EUR', vat: 21, stepSize: 1 },
  ],
  availability: {
    status: 'AVAILABLE', // AVAILABLE | CHARGING | RESERVED | BLOCKED | INOPERATIVE | OUTOFORDER | PLANNED | REMOVED | UNKNOWN
    evseCount: 2,
    lastUpdated: '2026-08-26T10:00:00Z',
  },

  // --- Solo si el match vino de la fuente PUBLIC ---
  reveData: { /* objeto crudo devuelto por POST /api/public/v1/locations, sin procesar:
                 id, name, address, postal_code, country, owner{name,website,logo,phone},
                 coordinates{latitude,longitude}, facilities[], opening_times{...},
                 evses[{evse_id, status, status_updated_at, connectors[{id, standard,
                 format, max_electric_power, tariffs[{human, tariff:{currency, elements[
                 {price_components[{type, price, vat, step_size}]}]}}]}], payment_methods}] */ },
}
```

`prices`/`availability` no distinguen entre EVSEs/conectores concretos de la estación DGT —
son el conjunto (deduplicado) de precios/estado de **todos** los conectores de la ubicación
Reve matcheada. `reveData` sí trae el detalle completo por EVSE/conector si hace falta bajar
a ese nivel.

---

## 5. `enrichStations(stations, options)` — selección de fuente

```js
function resolveSource(options) {
  if (options.source === 'public') return 'public';
  if (options.source === 'external') return 'external';
  return options.reveApiKey ? 'external' : 'public';
}
```

| Situación | Fuente usada |
|---|---|
| `{ reveApiKey: '...' }` | `external` |
| `{ }` (nada) | `public` — **requiere `acknowledgeUnsupported: true` o lanza error** |
| `{ acknowledgeUnsupported: true }` | `public` |
| `{ reveApiKey: '...', source: 'public', acknowledgeUnsupported: true }` | `public` (forzado, ignora la key) |
| `{ source: 'external' }` (sin key) | `external` → no-op, devuelve las estaciones sin tocar (igual que si no se llamara a `enrichStations`) |

**Cambio de comportamiento importante respecto a versiones anteriores**: antes, no pasar
`reveApiKey` hacía que el enriquecimiento no hiciera nada (no-op silencioso). Ahora, no pasar
`reveApiKey` **intenta la fuente `public`** por defecto, y como esa fuente exige
`acknowledgeUnsupported: true`, **lanza una excepción si no se pasa**. Si en algún sitio del
backend se llama a `enrichStations(stations, {})` esperando el no-op de siempre, hay que
añadir `{ source: 'external' }` explícito para conservar ese comportamiento.

`fetchStations`/`streamStations`/`createDgtEvCollector` solo invocan el enriquecimiento si
`options.enrich` está presente **y** trae `reveApiKey` o `source: 'public'` — si no se pasa
ningún `enrich`, no hay ningún riesgo de este cambio (el enriquecimiento simplemente no se
intenta).

### 5.1 Fuente `external` — documentada, estable, con límite

- Requiere `reveApiKey` (gratuita, solicitar en mapareve.es/api-contacto).
- Backend real: AWS API Gateway + Lambda.
- **Límite duro: 5 peticiones/hora**, compartidas entre locations/status/tariffs (locations
  siempre tiene prioridad).
- Con `cacheDir`: persiste en disco y **acumula** cobertura entre llamadas (una carga inicial
  completa de ~14.500 ubicaciones tarda varios ciclos horarios).
- Sin `cacheDir`: cada llamada solo usa lo que consiga traer esa vez, sin acumular.
- Opciones: `reveApiKey` (obligatoria), `cacheDir`, `thresholdMeters` (50 por defecto),
  `onlyDynamicInfo`, `dateFrom`, `httpClient`, `logger`.

### 5.2 Fuente `public` — no documentada, sin key, sin límite conocido

- No requiere ninguna clave — **requiere `acknowledgeUnsupported: true`** como confirmación
  explícita de que es un endpoint no soportado por Reve (puede cambiar o desaparecer sin
  aviso; su uso automatizado fuera de un navegador puede no encajar con los términos de uso
  del sitio).
- Backend real: Rails/Puma detrás de CloudFront, distinto del backend de `external`.
- **Sin caché ni cursor persistente**: cada llamada recorre **todas** las páginas del
  dataset, de la 1 a la última, siempre desde cero. Con `per_page` en su máximo confirmado
  (25), eso son **~582 peticiones secuenciales** (~14.550 ubicaciones ÷ 25) — cada vez que
  se llama, incluido cada disparo de un cron si esto se automatiza.
- `maxPages` deja de tener un tope bajo por defecto: por defecto se recorren **todas** las
  páginas que la propia API informe (`DEFAULT_MAX_PAGES` ya no es una barrera de seguridad
  baja, es efectivamente "sin límite" — el límite real lo pone `total_pages`, que informa la
  API en cada respuesta). Pasar `maxPages` explícito solo tiene sentido para acotar una
  ejecución concreta (pruebas, depuración).
- **Resiliencia por página**: una página que falla (timeout, error de red, HTTP 429/5xx) se
  reintenta con backoff exponencial (`retries`, 3 por defecto) antes de darse por vencida
  **solo con esa página** — no aborta todo el barrido. Si fallan `maxConsecutivePageFailures`
  páginas seguidas (3 por defecto) incluso tras sus reintentos, el barrido para antes de
  tiempo (señal de algo sistémico: WAF, caída del sitio). HTTP 400 y 403 nunca se reintentan.
- **Matching nombre → proximidad**: para cada estación, si hay una ubicación Reve cuyo
  `name` coincide exactamente (ignorando mayúsculas/acentos), se usa esa sin mirar distancia;
  si varias comparten nombre, gana la más cercana de esas; si no hay ningún nombre
  coincidente, cae al comportamiento de solo-proximidad (`thresholdMeters`, 50 m por
  defecto).
- Opciones: `acknowledgeUnsupported` (obligatoria), `maxPages`, `perPage` (25 máximo
  confirmado), `filters` (bbox/otros filtros del body de `POST /locations`),
  `thresholdMeters`, `httpClient`, `logger`.

---

## 6. Logs que emite (para monitorización/alertas)

Todos en inglés, vía el `logger` inyectado (`{ info, warn }`, por defecto `console`).

**DGT** (`fetchStations`/`streamStations`):
`Requesting DGT EV charging dataset`, `Receiving DGT EV charging dataset` (con `status`,
`contentLength`), `Streamed N EV charging sites from DGT`, `Retry attempt N after failure: ...`
(warn), `Failed to parse/normalize DGT EV site` (warn, por site individual).

**Fuente external** (`enrichStations` → external): `Fetching Reve locations/operational
status/tariffs` (info, con `dateFrom`), `Failed to fetch Reve locations/status/tariffs`
(warn, con `error`), `Building spatial index for Reve locations` (info, con `count`),
`Enrichment complete` (info, con `totalStations, matched, withPrices, withAvailability`).

**Fuente public** (`enrichStations` → public): `Requesting Reve public locations sweep`
(info, con `maxPages, perPage`), `Requesting Reve public locations page N` / `Received Reve
public locations page N` (info, por página, con `count, ms, totalPages, totalCount`),
`Reve public API request failed (...)`, retry N/N (warn, si hay reintento), `Failed to fetch
Reve public locations page N after retries — skipping it` (warn), `Reve public API: N
consecutive page failures — stopping sweep early` (warn), `Reve public API: stopped at
maxPages (N) — dataset is partial` (warn, solo si `maxPages` explícito lo cortó),
`Reve public locations sweep complete` (info, con `fetched, normalized`), `Building spatial
index for Reve public locations` (info, con `count`), `Reve public-API enrichment complete`
(info, con `totalStations, matched, matchedByName, matchedByProximity, withPrices,
withAvailability`).

Para auditar si el enriquecimiento realmente está corriendo y con qué resultado, el log a
vigilar es el último de cada fuente (`Enrichment complete` / `Reve public-API enrichment
complete`) — trae el ratio `matched`/`totalStations` y cuántos quedaron con precio/disponibilidad.

---

## 7. Limitaciones y cosas a tener en cuenta

- **`source: 'public'` es un endpoint no documentado de un tercero.** Puede cambiar sin
  aviso. Los valores confirmados en este documento (per_page máximo 25, bbox obligatorio,
  etc.) están verificados a fecha de este documento, no garantizados a futuro.
- **Sin `cacheDir` para `public`**: no hay forma de acotar el volumen de peticiones entre
  llamadas salvo pasando `maxPages` uno mismo. Si esto corre en un cron automático, hay que
  decidir con criterio cada cuánto y con qué `maxPages`/`filters` correrlo — por defecto
  intentará las ~582 peticiones completas cada vez.
- **El matching (ambas fuentes) es aproximado**: por proximidad (radio configurable) o por
  nombre exacto normalizado — no hay un id compartido entre el dataset DGT y Reve. Puede
  haber falsos positivos si dos ubicaciones físicas distintas están muy cerca o comparten
  nombre genérico (p. ej. una marca sin más contexto).
- **`prices`/`availability` son agregados de todos los conectores de la ubicación Reve
  matcheada**, no filtrados por el tipo de conector concreto de la estación DGT.

---

## 8. Scripts de auditoría offline (`scripts/`, no se publican con el paquete)

```bash
node scripts/dump-reve-locations.js --out ./reve-dump.ndjson       # vuelca /api/public/v1 a NDJSON
node scripts/dump-dgt-stations.js --out ./dgt-dump.ndjson          # vuelca el dataset DGT a NDJSON
node scripts/reconcile-dgt-reve.js --dgt ./dgt-dump.ndjson --reve ./reve-dump.ndjson --out ./reconciled.ndjson
```

`reconcile-dgt-reve.js` llama directamente a `enrichStations(stations, { source: 'public',
acknowledgeUnsupported: true, httpClient: <cliente falso que sirve el NDJSON local> })` — es
el mismo código de producción, alimentado con datos ya descargados, para poder auditar
resultados sin gastar peticiones ni depender de que el dataset en vivo no cambie entre
pruebas.

Detalle completo del flujo de precios de la fuente `public` (para depurar con Postman, con
ejemplos reales de request/response): `docs/reve-public-pricing-flow.md`.

---

## 9. Estado de publicación

- Versión publicada bajo el dist-tag `experimental` (`npm install ...@experimental`) — no es
  `latest`. Pensado para probar en PRE antes de decidir promoverlo.
- El código en sí (esto que documenta este archivo) ya está en su forma "limpia" — no hay
  namespace `experimental` en la API pública ni nada marcado como tal en el código; lo único
  que sigue siendo "experimental" es la etiqueta de publicación en npm, a la espera de
  validación en PRE.
