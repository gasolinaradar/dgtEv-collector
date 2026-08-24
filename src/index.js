const { createDgtEvCollector } = require('./collector');
const { fetchStations, streamStations } = require('./fetch');

module.exports = {
  createDgtEvCollector,
  fetchStations,
  streamStations,
};
