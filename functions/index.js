const { onRequest } = require('firebase-functions/v2/https');
const { handleApiRequest } = require('./api.js');

exports.api = onRequest(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  (req, res) => handleApiRequest(req, res)
);
