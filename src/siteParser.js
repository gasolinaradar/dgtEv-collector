const { SaxesParser } = require('saxes');

const SITE_LOCAL_NAME = 'energyInfrastructureSite';

/**
 * Convierte los atributos que da saxes (con `xmlns: true`) en el mismo formato plano que
 * producía fast-xml-parser con `ignoreAttributes:false, attributeNamePrefix:''`: cada
 * atributo se asigna como propiedad directa del nodo, usando solo su nombre local (sin
 * prefijo de namespace). Las declaraciones `xmlns:*` no llegan aquí con `xmlns:true`, así
 * que no hace falta filtrarlas a mano.
 */
function buildAttributesObject(attributes) {
  const result = {};
  for (const key of Object.keys(attributes)) {
    const attr = attributes[key];
    result[attr.local] = attr.value;
  }
  return result;
}

/**
 * Crea un parser SAX (saxes) que reconstruye ÚNICAMENTE el sub-árbol del
 * `<energyInfrastructureSite>` que está abierto en cada momento, con la misma forma que
 * fast-xml-parser daba para un único site (atributos como propiedades planas, texto en
 * `#text` cuando el nodo también tiene atributos, hojas puras de texto como string plano,
 * tags repetidos como array). Así `normalizeSite()` (normalize.js) se reutiliza sin cambios.
 *
 * Todo lo que quede FUERA de un `energyInfrastructureSite` (feedDescription,
 * publicationTime, el propio energyInfrastructureTable, etc.) se descarta sin asignar
 * memoria: mientras `depthInsideSite` es 0 los eventos no acumulan nada.
 *
 * El matching es por nombre local (`tag.local`), no por prefijo: es robusto frente a
 * namespaces DATEX II (prefijos `egi:`, `fac:`, `loc:`, `locx:`, `com:`...) y también
 * funciona con XML sin namespaces (como el usado en los tests).
 */
function createSiteParser({ onSite, onSiteError }) {
  const parser = new SaxesParser({ xmlns: true });

  let depthInsideSite = 0;
  let stack = []; // pila de frames { node, local, text }

  parser.on('opentag', (tag) => {
    const attrs = buildAttributesObject(tag.attributes);

    if (depthInsideSite === 0) {
      if (tag.local !== SITE_LOCAL_NAME) {
        return;
      }
      stack = [{ node: attrs, local: tag.local, text: '' }];
      depthInsideSite = 1;
      return;
    }

    depthInsideSite += 1;
    stack.push({ node: attrs, local: tag.local, text: '' });
  });

  parser.on('text', (text) => {
    if (depthInsideSite === 0) return;
    stack[stack.length - 1].text += text;
  });

  parser.on('cdata', (text) => {
    if (depthInsideSite === 0) return;
    stack[stack.length - 1].text += text;
  });

  parser.on('closetag', () => {
    if (depthInsideSite === 0) return;

    const frame = stack.pop();
    const trimmedText = frame.text.trim();
    const hasOwnKeys = Object.keys(frame.node).length > 0;

    let value;
    if (trimmedText && !hasOwnKeys) {
      value = trimmedText;
    } else if (trimmedText) {
      value = { ...frame.node, '#text': trimmedText };
    } else if (!hasOwnKeys) {
      value = '';
    } else {
      value = frame.node;
    }

    depthInsideSite -= 1;

    if (depthInsideSite === 0) {
      // Se cerró el propio <energyInfrastructureSite>: emitir y soltar toda referencia al
      // sub-árbol, que a partir de aquí puede recogerlo el GC.
      try {
        onSite(value);
      } catch (error) {
        onSiteError(error, value);
      }
      stack = [];
      return;
    }

    const parent = stack[stack.length - 1].node;
    if (!(frame.local in parent)) {
      parent[frame.local] = value;
    } else if (Array.isArray(parent[frame.local])) {
      parent[frame.local].push(value);
    } else {
      parent[frame.local] = [parent[frame.local], value];
    }
  });

  return parser;
}

/**
 * Variante síncrona para compatibilidad con quien ya llame a `parseSitesFromXml(xmlString)`
 * esperando el array completo de sites crudos. Sigue construyendo todo en memoria (no hay
 * forma de ser incremental si la firma es síncrona y recibe un string ya completo), pero se
 * mantiene por compatibilidad; para datasets grandes usar `createSiteParser` a través del
 * streaming de `fetchStations`/`streamStations`.
 */
function parseSitesFromXml(xml) {
  const sites = [];
  const parser = createSiteParser({
    onSite: (rawSite) => sites.push(rawSite),
    onSiteError: () => {},
  });
  parser.write(xml);
  parser.close();
  return sites;
}

module.exports = {
  createSiteParser,
  parseSitesFromXml,
  SITE_LOCAL_NAME,
};
