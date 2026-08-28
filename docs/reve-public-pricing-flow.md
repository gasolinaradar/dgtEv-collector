# Flujo de precios en la fuente `public` de Reve — para inspeccionar con Postman

Este documento explica, paso a paso y con datos reales capturados contra `mapareve.es`,
exactamente cómo `enrichStations(stations, { source: 'public', acknowledgeUnsupported: true })`
obtiene y calcula el campo `prices[]` que acaba en cada estación. El objetivo es que puedas
reproducir cada petición en Postman y comparar a mano contra lo que hace el código, para
encontrar dónde está el desajuste que ves.

No es documentación de librería (no va en el README ni se publica) — es una chuleta de
depuración.

---

## 1. Resumen del flujo (2 pasos, 2 peticiones distintas)

```
Paso A: descubrir ubicaciones Reve         Paso B: elegir cuál aplica a cada estación DGT
POST /api/public/v1/locations              (esto NO es una petición HTTP — es geometría local)
  → N ubicaciones, cada una con             Para cada estación DGT:
    evses[].connectors[].tariffs[]            buscar la ubicación Reve más cercana
                                               dentro de `thresholdMeters` (50 m por defecto)
        ↓                                             ↓
normalizeRevePublicLocation()              si hay una ubicación Reve dentro del radio:
  aplana tariffs → allConnectors[].prices[]    prices = mergePublicPrices(esa ubicación)
                                             si no hay ninguna dentro del radio:
                                               prices se queda igual que antes (undefined)
```

**Importante**: el `prices` que ves en una estación **no viene de una ubicación Reve con el
mismo id/nombre** que la estación DGT — viene de la ubicación Reve **geográficamente más
cercana**, sea cual sea su nombre. Si sospechas que el precio "no cuadra", esto suele ser
el primer sitio a mirar (sección 6).

---

## 2. Petición A — la que trae los precios (Postman)

```
POST https://www.mapareve.es/api/public/v1/locations?page=1&per_page=25
Content-Type: application/json
Accept: application/json
```

Body (JSON) — el bbox es **obligatorio**, `per_page` **tiene un máximo de 25** (confirmado
en vivo: 10/15/20/25 funcionan, 30/50/100 dan 400):

```json
{
  "latitude_ne": 44,
  "longitude_ne": 4.5,
  "latitude_sw": 27,
  "longitude_sw": -18.5
}
```

- `page` y `per_page` van como **query params**, no en el body.
- El bbox de arriba es "toda España" (el que usa la librería por defecto). Puedes acotarlo a
  una zona concreta para depurar más rápido, p. ej. Barcelona:
  `latitude_ne: 41.45, longitude_ne: 2.25, latitude_sw: 41.35, longitude_sw: 2.10`.
- Filtros opcionales que puedes añadir al mismo body: `cpo_ids`, `power_min`, `power_max`,
  `connector_types`, `energy_price_min`, `energy_price_max`, `payment_methods`, `only_ocpi`,
  `available` — son los mismos que usa el buscador del propio mapa.

cURL equivalente:

```bash
curl -s -X POST "https://www.mapareve.es/api/public/v1/locations?page=1&per_page=10" \
  -H "Content-Type: application/json" \
  -d '{"latitude_ne":44,"longitude_ne":4.5,"latitude_sw":27,"longitude_sw":-18.5}'
```

### Respuesta real (capturada, recortada a 1 ubicación)

```json
{
  "data": [
    {
      "id": "0008eb32-d6c0-4485-a41f-1d81566db05b",
      "status": "CHARGING",
      "name": "Repsol, Elorrio, Vía Pública",
      "address": "Nizeto Urkizu Kalea 4",
      "postal_code": "48230",
      "country": "ESP",
      "owner": {
        "name": "REPSOL SOLUCIONES ENERGÉTICAS SA",
        "website": "WWW.REPSOL.COM",
        "logo": null,
        "phone": "676461625"
      },
      "coordinates": { "latitude": "43.130332", "longitude": "-2.541078" },
      "evses": [
        {
          "evse_id": "ES*REP*E3125*1",
          "physical_reference": "A",
          "status": "BLOCKED",
          "status_updated_at": "2026-08-26T16:56:03.463Z",
          "connectors": [
            {
              "id": "0480510c-2d90-414b-a359-af7e12a386ee",
              "standard": "IEC_62196_T2",
              "format": "SOCKET",
              "max_electric_power": 22080,
              "show_tariffs_details": false,
              "tariffs": [
                {
                  "human": ["0.36 EUR/kWh"],
                  "tariff": {
                    "id": "8b5ac94e-bdd1-49d6-8ac9-23aa18ee1724",
                    "currency": "EUR",
                    "elements": [
                      {
                        "price_components": [
                          { "type": "ENERGY", "price": 0.36, "vat": 21.0, "step_size": 1 }
                        ],
                        "restrictions": null
                      }
                    ]
                  },
                  "tariff_alt_url": null
                }
              ]
            }
          ],
          "payment_methods": ["Lector RFID"]
        },
        {
          "evse_id": "ES*REP*E3125*2",
          "status": "CHARGING",
          "connectors": [
            {
              "id": "84c7e233-0656-4f56-8ec5-83dc221836cb",
              "standard": "IEC_62196_T2",
              "format": "SOCKET",
              "tariffs": [
                { "human": ["0.36 EUR/kWh"], "tariff": { "currency": "EUR", "elements": ["…"] } }
              ]
            }
          ]
        }
      ]
    }
  ],
  "pagination": { "page": 1, "per_page": 25, "total_count": 14550, "total_pages": 582 }
}
```

Fíjate en la ruta exacta de anidación hasta llegar al precio, porque es la que parsea el
código en el paso 3:

```
data[i]
  .evses[j]
    .connectors[k]
      .tariffs[m]
        .tariff
          .elements[n]
            .price_components[p]
              .type, .price, .vat, .step_size
```

Y que `tariff.currency` vive **un nivel por encima** de `price_components` (por eso el
código lo lee de `tariff.currency`, no de `price_components[p].currency` — ese campo no
existe ahí).

---

## 3. Petición alternativa — inspeccionar UNA sola ubicación (más cómodo en Postman)

Si quieres mirar una ubicación concreta sin lidiar con paginación:

```
GET https://www.mapareve.es/api/public/v1/locations/{id}
Accept: application/json
```

```bash
curl -s "https://www.mapareve.es/api/public/v1/locations/0008eb32-d6c0-4485-a41f-1d81566db05b"
```

Devuelve el mismo objeto de arriba pero sin el envoltorio `{data, pagination}` — directamente
el objeto de la ubicación. **Ojo**: `enrichStationsPublic` **no usa este endpoint**
para el enriquecimiento masivo (solo usa el paginado de la sección 2); este GET es útil solo
para que tú inspecciones una ubicación concreta a mano.

---

## 4. Paso 3 (código) — cómo se extrae `prices` de esa respuesta

`src/enrich-public.js`, función `normalizeRevePublicLocation(loc)` (líneas 19-77):

```js
for (const evse of loc.evses) {
  for (const conn of evse.connectors) {
    const prices = [];
    for (const t of conn.tariffs) {              // cada elemento de tariffs[]
      const tariff = t.tariff;                   // t.tariff, NO t directamente
      for (const element of tariff.elements) {    // tariff.elements[]
        for (const comp of element.price_components) {  // element.price_components[]
          prices.push({
            type: comp.type,                      // "ENERGY", "PARKING_TIME", "TIME"...
            price: parseFloat(comp.price) || 0,
            currency: tariff.currency || 'EUR',    // del tariff, no del price_component
            vat: comp.vat != null ? parseFloat(comp.vat) : undefined,
            stepSize: comp.step_size,
          });
        }
      }
    }
    allConnectors.push({ connectorId: conn.id, evseId: evse.evse_id, standard: conn.standard, prices });
  }
}
```

Con el ejemplo de la sección 2, el conector `0480510c-...` produce:

```js
{ connectorId: "0480510c-2d90-414b-a359-af7e12a386ee", evseId: "ES*REP*E3125*1",
  standard: "IEC_62196_T2",
  prices: [{ type: "ENERGY", price: 0.36, currency: "EUR", vat: 21, stepSize: 1 }] }
```

Y esto se repite **por cada conector de cada EVSE de la ubicación** — una ubicación con 6
EVSEs y 1 conector cada uno acaba con 6 entradas en `allConnectors`, cada una con su propio
array `prices`.

---

## 5. Paso 4 (código) — cómo se aplanan/deduplican esos precios

`src/enrich-public.js`, función `mergePublicPrices(reveLoc)` (líneas 79-91):

```js
function mergePublicPrices(reveLoc) {
  const seen = new Set();
  const prices = [];
  for (const conn of reveLoc.allConnectors) {   // TODOS los conectores de la ubicación
    for (const p of conn.prices) {
      const key = `${p.type}:${p.price}:${p.currency}`;
      if (seen.has(key)) continue;               // dedupe por (tipo, precio, moneda)
      seen.add(key);
      prices.push(p);
    }
  }
  return prices.length > 0 ? prices : undefined;
}
```

Puntos que suelen sorprender:

- **No filtra por tipo de conector de la estación DGT.** Aunque la estación DGT tenga un
  conector Tipo 2 y la ubicación Reve tenga también un CCS, el precio del CCS entra igual en
  el array final si no coincide exactamente `type:price:currency` con otro ya visto.
- **La dedupe es por (tipo, precio, moneda) exactos**, no por conector. Si dos conectores
  tienen el mismo precio de `ENERGY`, solo aparece una vez. Si tienen precios *distintos*
  para el mismo `type` (dos tarifas diferentes en la misma ubicación), verás **dos entradas
  `ENERGY`** en el array — no es un bug, es que la ubicación tiene tarifas distintas por
  conector.
- **`step_size` no es siempre 1.** En producción hemos visto `stepSize=1000` para un
  `ENERGY` de 0.35 €/kWh (Westfield Glòries) frente a `stepSize=1` en el ejemplo de Elorrio.
  No asumas una unidad fija al leer este campo.
- **No se sabe con certeza si `price` incluye IVA o no** — el `vat` viaja como campo
  separado (`21.0`), no hay confirmación de si hay que sumarlo, ya viene sumado, o es
  puramente informativo. Esto no se ha verificado contra la documentación oficial; si el
  número final "no cuadra" contra lo que ves en la web de Reve, esto es sospechoso número 1.

---

## 6. Cómo se decide QUÉ ubicación Reve aplica a cada estación (matching)

**Actualizado**: ya no es solo proximidad. Ahora es **nombre exacto primero, proximidad como
respaldo**. `src/enrich-public.js`, dentro de `enrichStationsPublic`:

```js
const nameIndex = new Map(); // nombre normalizado -> [ubicaciones Reve]
for (const loc of normalizedReve) {
  index.insert(loc, loc.lat, loc.lon);
  const key = normalizeStationName(loc.name);
  if (key) nameIndex.set(key, [...(nameIndex.get(key) || []), loc]);
}

for (const station of stations) {
  const nameKey = normalizeStationName(station.name);
  const candidates = nameIndex.get(nameKey);

  if (candidates?.length === 1) {
    reve = candidates[0];                    // nombre único → gana sin mirar distancia
  } else if (candidates?.length > 1) {
    reve = elMasCercanoDe(candidates);        // nombre repetido → desempate por distancia
  } else {
    const hit = index.findNearest(lat, lon, thresholdMeters);  // sin nombre → como antes
    reve = hit?.item;
  }
}
```

`normalizeStationName` compara ignorando mayúsculas y acentos (`"Repsol, Elorrio"` ==
`"REPSOL, ELORRIO"`), pero es **coincidencia exacta** del texto normalizado — no hay
similitud difusa (Levenshtein, etc.) todavía.

- **Si hay nombre exacto, gana sin importar la distancia** (ni siquiera se compara contra
  `thresholdMeters`). Esto es intencional: si detectas que un match "no cuadra" y el nombre
  coincide exacto, el problema no está aquí — está en el precio en sí (sección 5/7) o en que
  el nombre coincide mucho antes en dos sitios que no son el mismo (dos "Repsol" genéricos).
- **Si el nombre se repite en varias ubicaciones Reve**, se desempata por la más cercana de
  esas — no por la más cercana de *todas*.
- **Solo si no hay ningún nombre coincidente** se usa proximidad pura dentro de
  `thresholdMeters` (comportamiento anterior, sigue existiendo como red de seguridad).
- El log `Reve public-API enrichment complete` ahora trae `matchedByName` y
  `matchedByProximity` por separado — mira esos números primero para saber qué vía se usó en
  tu caso concreto antes de rebuscar en Postman.

**Para depurar un caso concreto**: si `matchedByProximity` fue la vía (no había nombre
exacto), coge las `coordinates` exactas de la estación DGT, busca en Postman qué ubicación
Reve devuelve `POST /locations` más cercana a esas coordenadas (o usa `GET /locations/{id}`
si ya sospechas cuál es), y compara **nombre y dirección** de ambas — si no coinciden, el
problema es el radio de matching (`thresholdMeters`), no el cálculo del precio en sí. Si
`matchedByName` fue la vía y aun así "no cuadra", el nombre coincide pero probablemente sean
dos sitios físicos distintos con el mismo nombre genérico (marca sin más contexto).

---

## 7. Checklist rápido para "el precio no me cuadra"

En este orden, de más probable a menos probable:

0. **¿Por qué vía matcheó?** Mira `matchedByName` vs `matchedByProximity` en el log
   `Reve public-API enrichment complete` (sección 6) — te dice directamente si el
   caso que te extraña vino por nombre exacto o por cercanía, antes de investigar nada más.
1. **¿Es la ubicación correcta?** Confirma con `GET /locations/{id}` que el nombre/dirección
   de la ubicación Reve matcheada coincide con la estación DGT esperada (sección 6).
2. **¿Hay varias tarifas mezcladas?** Mira si `prices[]` trae más de una entrada con el mismo
   `type` — significa que la ubicación tiene conectores con precios distintos, no que haya un
   precio "único" incorrecto.
3. **¿El `stepSize` te está despistando?** No asumas que el precio es "por kWh" solo porque
   `type: "ENERGY"` — revisa `stepSize` para la unidad real de facturación.
4. **¿Cuándo se ejecutó la ingesta?** Ya no hay caché entre llamadas — cada ejecución barre
   el dataset entero desde cero, así que el dato debería ser fresco de esa misma ejecución.
   Compara igualmente la hora de tu petición Postman contra la hora del log de esa ingesta,
   por si el precio cambió en `mapareve.es` justo entre medias.
5. **¿IVA incluido o no?** Sin confirmar (punto 5 de la sección 5) — compara el número crudo
   `price` + `vat` contra lo que muestra la web de Reve para esa misma ubicación y decide tú
   si hace falta ajustar el cálculo.

---

## 8. Variables útiles para una colección de Postman

| Variable | Valor |
|---|---|
| `base_url` | `https://www.mapareve.es/api/public/v1` |
| `spain_bbox` | `{"latitude_ne":44,"longitude_ne":4.5,"latitude_sw":27,"longitude_sw":-18.5}` |
| `known_location_id` | `0008eb32-d6c0-4485-a41f-1d81566db05b` (Repsol Elorrio, ejemplo de este doc) |

No hace falta ningún header de autenticación (`x-api-key`, `Authorization`, cookies) para
ninguna de las dos peticiones — es exactamente lo que confirmamos durante la investigación
inicial de este endpoint.

---

## 9. Scripts para auditar offline (`scripts/`)

Tres scripts standalone (no se publican con el paquete):

```bash
node scripts/dump-reve-locations.js --out ./reve-dump.ndjson
node scripts/dump-dgt-stations.js --out ./dgt-dump.ndjson
node scripts/reconcile-dgt-reve.js --dgt ./dgt-dump.ndjson --reve ./reve-dump.ndjson --out ./reconciled.ndjson
```

`reconcile-dgt-reve.js` no reimplementa el matching — llama directamente a
`enrichStations(stations, { source: 'public', acknowledgeUnsupported: true })` de la
librería, con un `httpClient` falso que sirve el JSON de `reve-dump.ndjson` en vez de llamar
a la red. El resultado es exactamente el mismo que produciría una ingesta real con esos
mismos datos, así que sirve para auditar sin gastar peticiones ni depender de que el dataset
en vivo no cambie entre pruebas.
