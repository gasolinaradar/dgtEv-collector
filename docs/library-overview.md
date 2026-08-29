# `@gasolinaradar/dgt-ev-collector` — funcionalidad completa

Documento de referencia para el equipo que integra esta librería en el backend. Cubre todo
lo que hace, todos los datos que produce, y cómo se comporta en cada caso. Todo lo descrito
aquí está verificado contra el código real de la versión indicada abajo — nada es
aspiracional.

**Versión actual**: `1.5.0`, versión definitiva — ya es la `latest` en npm, promovida tras
validar en PRE toda la serie `1.5.0-experimental.0` a `.15` (fetch/enrich unificado,
enriquecimiento `public` opt-in, fixes de memoria/paginación, desglose por EVSE, `connectors[]`
reconciliado con el estado en vivo, `restrictions` en `prices[]`, progreso durante el
enriquecimiento).

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
npm install @gasolinaradar/dgt-ev-collector
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

**`context.reportProgress(percent, metadata)`**: si se pasa un callback y `options.enrich`
está presente, se invoca **también** durante la fase de enriquecimiento Reve, no solo
durante la descarga de DGT (antes de esta versión solo cubría la parte de DGT, por eso el
`%` se quedaba "parado en 100" mientras el barrido de Reve seguía corriendo en silencio por
detrás — hasta ~582 peticiones secuenciales en `source: 'public'`). Son **dos barridos 0→100
independientes** sobre el mismo callback (uno para DGT, otro para Reve) — hay que usar
`metadata.stage` para distinguirlos, no asumir que el número es monótonamente creciente de
principio a fin. Detalle completo de los `stage` y en qué `%` dispara cada uno, en el README
(`## Progress reporting`).

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
    // status/evseId se añaden aquí (best-effort) cuando hay match tras enrichStations() —
    // ver explicación después del bloque de ejemplo
    { type: 'IEC_62196_T2', format: 'SOCKET', mode: 'MODE_3', maxPowerKw: 22, voltageV: 230, maxCurrentA: 32,
      status: 'AVAILABLE', evseId: 'ES*ACM*E000001*1' },
  ],
  typeOfSite: 'onstreet',            // si el XML de la DGT lo trae
  authenticationMethods: ['rfid'],   // idem
  operator: { name: 'Wenea', website: 'www.wenea.es' }, // idem (se sobrescribe si hay match Reve)
  location: { type: 'Point', coordinates: [-3.7038, 40.4168] }, // [lon, lat], orden GeoJSON
  lastUpdated: Date,

  // --- De Reve, solo si hay match tras enrichStations() ---
  reveLocationId: 'uuid-de-la-ubicacion-reve',
  prices: [               // cada entrada lleva el evseId/connectorId del conector Reve del que sale
    { type: 'ENERGY', price: 0.35, currency: 'EUR', vat: 21, stepSize: 1, evseId: 'ES*ACM*E000001*1', connectorId: 'conn-1' },
    // dos entradas PARKING_TIME del mismo conector con precio distinto NO son un duplicado:
    // cada una aplica bajo su propio `restrictions` (aquí, gratis la primera hora, después 3€/min)
    { type: 'PARKING_TIME', price: 0, currency: 'EUR', stepSize: 60, restrictions: { max_duration: 3600 }, evseId: 'ES*ACM*E000001*1', connectorId: 'conn-1' },
    { type: 'PARKING_TIME', price: 3, currency: 'EUR', stepSize: 60, evseId: 'ES*ACM*E000001*1', connectorId: 'conn-1' },
  ],
  availability: {
    status: 'AVAILABLE', // AVAILABLE | CHARGING | RESERVED | BLOCKED | INOPERATIVE | OUTOFORDER | PLANNED | REMOVED | UNKNOWN
                          // el de mayor prioridad entre todos los EVSEs (ver STATUS_PRIORITY más abajo)
    evseCount: 2,
    lastUpdated: '2026-08-26T10:00:00Z',
    evses: [               // desglose por EVSE — permite distinguir p. ej. "el rápido está roto,
                            // el lento libre" en vez de perder ese detalle en el status resumen
      { evseId: 'ES*ACM*E000001*1', status: 'AVAILABLE', connectors: [{ connectorId: 'conn-1', standard: 'IEC_62196_T2', powerType: 'AC_3_PHASE', maxPowerW: 22000 }] },
      { evseId: 'ES*ACM*E000001*2', status: 'OUTOFORDER', connectors: [{ connectorId: 'conn-2', standard: 'IEC_62196_T2_COMBO', powerType: 'DC', maxPowerW: 150000 }] },
    ],
  },

  // --- Solo si el match vino de la fuente PUBLIC ---
  reveData: { /* rebanada reducida de la ubicacion de POST /api/public/v1/locations, con
                 solo los campos que consume el enriquecimiento (no el objeto crudo completo):
                 evses[{evse_id, status, connectors[{id, standard, format, power_type,
                 max_electric_power, tariffs[{tariff:{currency, elements[{restrictions,
                 price_components[{type, price, vat, step_size}]}]}}]} ]}] */ },
}
```

Cada entrada de `prices` lleva `evseId`/`connectorId` — el mismo identificador que aparece en
`availability.evses[].connectors[].connectorId` — así que sí se puede relacionar un precio con
un conector físico concreto de la ubicación Reve. El deduplicado ahora es solo dentro de las
tarifas de un mismo conector (un mismo elemento tarifario puede repetirse por franjas horarias),
ya no colapsa entre conectores distintos como en versiones anteriores a `1.5.0-experimental.13`.

Desde `1.5.0-experimental.14`, cada entrada también lleva `restrictions` cuando el elemento de
tarifa OCPI del que sale declara alguna (`max_duration`, `start_time`/`end_time`, etc., tal cual
las reporta Reve, sin transformar). Antes este campo se descartaba al aplanar `tariff.elements[]`
a `prices[]` — por eso un mismo `connectorId` podía mostrar, p. ej., dos entradas `PARKING_TIME`
con precios distintos (0€ y 3€) sin ninguna pista de por qué: eran dos tramos de la misma
tarifa (gratis la primera hora, de pago después), no un duplicado ni un dato contradictorio.
Sin `restrictions` no hay forma de saber cuál aplica cuándo — ahora sí la hay. Ausencia de
`restrictions` en una entrada significa que aplica sin condición.

El `connectors` de arriba, el de nivel superior parseado directo del XML de la DGT, sigue sin
tener ID propio en el XML fuente — pero desde `1.5.0-experimental.14`, `enrichStations()`
(ambas fuentes) le añade `status` (y `evseId`, cuando no es ambiguo) cruzándolo con
`availability.evses[]`: `mergeConnectorStatus()` en `src/enrich.js` mapea el vocabulario propio
de la DGT (`iec62196T2`, `chademo`, `iec62196T2COMBO`, ...) al estándar OCPI que usa Reve
(`IEC_62196_T2`, `CHADEMO`, `IEC_62196_T2_COMBO`, ...) vía `DGT_TO_OCPI_CONNECTOR_TYPE`, y casa
por tipo + potencia (con margen del 5%/500W para el redondeo kW↔W). Un conector se deja **sin**
`status`/`evseId` cuando: su tipo DGT no está en la tabla de equivalencias, o casa con varios
conectores Reve que no están de acuerdo en el estado (p. ej. el XML de la DGT trae el mismo
conector duplicado y cada duplicado casa con un EVSE distinto) — en ambos casos, la ausencia de
`status` en un conector **no** significa que esté averiado, hay que mirar `availability.evses[]`
para el estado real.

`availability.status` es un resumen: el estado de mayor prioridad entre todos los EVSEs de
la ubicación (significado de cada valor, estándar OCPI):

| Status | Significado |
|---|---|
| `AVAILABLE` | Libre, listo para iniciar una carga. |
| `CHARGING` | Ocupado, hay un vehículo cargando ahora mismo. |
| `RESERVED` | Reservado por un usuario concreto. |
| `BLOCKED` | Ocupado sin sesión activa (bloqueado físicamente, cable puesto sin cargar). |
| `INOPERATIVE` | Temporalmente no disponible, sin estar averiado (mantenimiento, aún no activo). |
| `OUTOFORDER` | Averiado / fuera de servicio. |
| `PLANNED` | Instalación planificada, todavía no operativa. |
| `REMOVED` | Dado de baja. |
| `UNKNOWN` | Reve no reporta estado para ese EVSE. |

Prioridad usada para elegir el resumen: `CHARGING > AVAILABLE > RESERVED > BLOCKED >
INOPERATIVE > OUTOFORDER > UNKNOWN > PLANNED > REMOVED` — nunca oculta un estado "bueno"
detrás de uno peor, pero por sí solo no dice cuántos EVSEs están en cada estado, ni con qué
conector (p. ej. si el punto rápido está averiado y solo queda libre el lento).

Para eso está `availability.evses`: un desglose por EVSE con su `status` individual y el
resumen de sus conectores (`connectorId`, `standard`, `powerType`, `maxPowerW`), para poder
distinguir en la UI "3 de 4 libres, el averiado es el rápido" en vez de depender solo del
resumen.
`reveData` sigue disponible (solo fuente `public`) como rebanada reducida con los evses/
conectores/tarifas que usa el enriquecimiento, por si hace falta bajar a un nivel de detalle
que el resumen no cubre (tarifas por conector, etc.). No incluye los campos que esa
enriquecimiento no consume (horarios, métodos de pago, owner completo), que se descartan al
reducir para acotar la memoria.

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
`Reve public locations sweep complete` (info, con `fetched, kept` — `fetched` es el total
visto, `kept` cuántas se llegaron a parsear del todo en algún momento del barrido; ver
sección 7 sobre memoria), `Building spatial index for Reve public locations`
(info, con `count`), `Reve public-API enrichment complete` (info, con `totalStations,
matched, matchedByName, matchedByProximity, withPrices, withAvailability`).

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
- **`prices` es un agregado de todos los conectores de la ubicación Reve matcheada**, no
  filtrado por el tipo de conector concreto de la estación DGT. `availability.status`
  también es un resumen, pero `availability.evses` sí da el desglose por EVSE individual
  (ver sección 5) — no hace falta caer a `reveData` solo para saber qué EVSE está en qué
  estado.
- **Memoria en `public`**: las ubicaciones se reciben en streaming, página a página, y se
  emparejan contra las estaciones de entrada al vuelo — como máximo se retiene **una**
  ubicación Reve por estación de entrada (su mejor coincidencia actual), y solo se parsea
  del todo cuando va a sustituir a la que esa estación ya tenía guardada; el resto se
  descarta o ni siquiera se parsea. Esto acota la memoria del conjunto de candidatos al
  **número de estaciones de entrada**, no al volumen de ubicaciones Reve que pasan el filtro
  (amplio, a nivel nacional) de `thresholdMeters`/nombre — una cantidad fija y conocida de
  antemano, no una fracción variable del dataset completo de Reve (~14.500 ubicaciones con
  sus tarifas/EVSEs anidados; el diseño anterior, que sí acumulaba todo lo que pasaba el
  filtro sin límite mientras durara el barrido, es lo que agotó el heap de Node en PRE antes
  de terminar). El log `fetched` vs `kept` sigue existiendo para ver cuánto trabajo hace el
  emparejado, pero ya no representa memoria retenida simultáneamente. Aun así no es una
  garantía absoluta: un proceso que ya vaya muy justo de memoria antes de arrancar el barrido
  (por otro estado de la app, drivers de BD, etc.) puede seguir agotándola — si eso ocurre,
  combinar con un `maxPages` menor por llamada o más memoria de contenedor.

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

- `1.5.0` es la versión definitiva, publicada como `latest` en npm (`npm install
  @gasolinaradar/dgt-ev-collector`) — ya no hay dist-tag `experimental` que pedir aparte. Se
  promovió tras validar en PRE, estación a estación, cada cambio de la serie
  `1.5.0-experimental.0`–`.15`.
- El código en sí (esto que documenta este archivo) está en su forma "limpia" — no hay
  namespace `experimental` en la API pública ni nada marcado como tal en el código.
