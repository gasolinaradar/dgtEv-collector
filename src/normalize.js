const decimalCommaRegex = /,/g;

function normalizeCoordinate(value) {
  if (value === null || value === undefined) {
    throw new Error('Missing coordinate value');
  }

  const raw = typeof value === 'number' ? value.toString() : String(value).trim();
  if (!raw) {
    throw new Error('Empty coordinate value');
  }

  const normalized = raw.replace(decimalCommaRegex, '.');
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid coordinate value: ${value}`);
  }

  return parsed;
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function extractText(node) {
  if (node === null || node === undefined) {
    return '';
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).trim();
  }

  if (Array.isArray(node)) {
    return extractText(node[0]);
  }

  if (typeof node === 'object') {
    if (node.values !== undefined) {
      return extractText(node.values);
    }
    if (node.value !== undefined) {
      return extractText(node.value);
    }
    if (node.text !== undefined) {
      return extractText(node.text);
    }
    if (node._ !== undefined) {
      return extractText(node._);
    }
    if (node['#text'] !== undefined) {
      return extractText(node['#text']);
    }
  }

  return '';
}

function normalizeAddress(addressNode = {}) {
  const addressLines = toArray(addressNode.addressLine);
  const freeTextParts = [];
  let municipality = '';
  let province = '';
  let streetAddress = '';

  addressLines.forEach((line) => {
    const text = extractText(line?.text || line);

    if (!text) {
      return;
    }

    const normalized = text.trim();
    const labeledMatch = normalized.match(
      /^(Direcci[oó]n|Municipio|Provincia|Comunidad Aut[oó]noma)\s*:?\s*(.+)$/i,
    );

    if (labeledMatch) {
      const [, label, value] = labeledMatch;
      const cleanedValue = value.trim();

      switch (label.toLowerCase()) {
        case 'dirección':
        case 'direccion':
          streetAddress ||= cleanedValue;
          return;
        case 'municipio':
          municipality ||= cleanedValue;
          return;
        case 'provincia':
          province ||= cleanedValue;
          return;
        default:
          break;
      }
    }

    freeTextParts.push(normalized);
  });

  const postalCode = extractText(addressNode.postcode) || undefined;
  const address = [streetAddress, ...freeTextParts].filter(Boolean).join(', ');

  return {
    address: address || municipality || province || 'Desconocido',
    municipality: municipality || 'Desconocido',
    province: province || 'Desconocido',
    postalCode,
  };
}

function normalizeServices(site) {
  const supplemental = toArray(site?.supplementalFacility);
  const services = supplemental
    .map((facility) => extractText(facility?.serviceFacilityType))
    .filter(Boolean);

  if (services.length === 0) {
    return ['ev_charging'];
  }

  const unique = Array.from(new Set(['ev_charging', ...services]));
  return unique;
}

function normalizeSchedule(site) {
  const label = extractText(site?.operatingHours?.label);
  return label || undefined;
}

function toNumber(value) {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || raw === null || raw === undefined) {
    return undefined;
  }
  const number = Number(raw);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeConnector(connectorNode) {
  if (!connectorNode) {
    return null;
  }

  const type = extractText(connectorNode.connectorType);
  const format = extractText(connectorNode.connectorFormat);
  const mode = extractText(connectorNode.chargingMode);
  const maxPowerRaw = toNumber(extractText(connectorNode.maxPowerAtSocket));
  const voltageV = toNumber(extractText(connectorNode.voltage));
  const maxCurrentA = toNumber(extractText(connectorNode.maximumCurrent));

  const maxPowerKw =
    maxPowerRaw !== undefined
      ? Math.round(
          ((maxPowerRaw >= 1000 ? maxPowerRaw / 1000 : maxPowerRaw) + Number.EPSILON) * 10,
        ) / 10
      : undefined;

  if (
    !type &&
    !format &&
    !mode &&
    maxPowerKw === undefined &&
    voltageV === undefined &&
    maxCurrentA === undefined
  ) {
    return null;
  }

  const connector = {};
  if (type) connector.type = type;
  if (format) connector.format = format;
  if (mode) connector.mode = mode;
  if (maxPowerKw !== undefined) connector.maxPowerKw = maxPowerKw;
  if (voltageV !== undefined) connector.voltageV = voltageV;
  if (maxCurrentA !== undefined) connector.maxCurrentA = maxCurrentA;

  return connector;
}

function normalizeConnectors(site) {
  const stations = toArray(site?.energyInfrastructureStation);
  const connectors = [];

  stations.forEach((station) => {
    const refillPoints = toArray(station?.refillPoint);
    refillPoints.forEach((refillPoint) => {
      const connectorNodes = toArray(refillPoint?.connector);
      connectorNodes.forEach((connectorNode) => {
        const connector = normalizeConnector(connectorNode);
        if (connector) {
          connectors.push(connector);
        }
      });
    });
  });

  if (connectors.length === 0) {
    return undefined;
  }

  return connectors;
}

function normalizeTypeOfSite(site) {
  const raw = extractText(site?.typeOfSite);
  return raw || undefined;
}

function normalizeAuthenticationMethods(site) {
  const raw = site?.authenticationAndIdentificationMethods;
  if (!raw) return undefined;

  const methods = toArray(raw).map(extractText).filter(Boolean);
  return methods.length > 0 ? methods : undefined;
}

function normalizeOperator(site) {
  const operator = site?.operator;
  if (!operator) return undefined;

  const name = extractText(operator?.name);
  if (!name) return undefined;

  const website = extractText(operator?.website) || undefined;
  return { name, website };
}

function normalizeSite(site, country) {
  if (!site) {
    return null;
  }

  const sourceStationId = extractText(site.id);
  if (!sourceStationId) {
    return null;
  }

  const coordinates = site?.locationReference?.coordinatesForDisplay ?? {};
  const latitude = normalizeCoordinate(coordinates.latitude);
  const longitude = normalizeCoordinate(coordinates.longitude);

  const { address, municipality, province, postalCode } = normalizeAddress(
    site?.locationReference?._locationReferenceExtension?.facilityLocation?.address,
  );

  const name = extractText(site?.name) || 'Desconocido';

  const schedule = normalizeSchedule(site);
  const services = normalizeServices(site);
  const connectors = normalizeConnectors(site);
  const typeOfSite = normalizeTypeOfSite(site);
  const authenticationMethods = normalizeAuthenticationMethods(site);
  const operator = normalizeOperator(site);
  const lastUpdatedRaw = extractText(site?.lastUpdated);
  const lastUpdated = lastUpdatedRaw ? new Date(lastUpdatedRaw) : new Date();

  return {
    source: 'dgt-ev',
    country,
    sourceStationId,
    name,
    address,
    municipality,
    province,
    postalCode,
    schedule,
    services,
    connectors,
    typeOfSite,
    authenticationMethods,
    operator,
    location: {
      type: 'Point',
      coordinates: [longitude, latitude],
    },
    prices: undefined,
    availability: undefined,
    reveLocationId: undefined,
    lastUpdated,
  };
}

module.exports = {
  normalizeCoordinate,
  toArray,
  extractText,
  normalizeAddress,
  normalizeServices,
  normalizeSchedule,
  toNumber,
  normalizeConnector,
  normalizeConnectors,
  normalizeTypeOfSite,
  normalizeAuthenticationMethods,
  normalizeOperator,
  normalizeSite,
};
