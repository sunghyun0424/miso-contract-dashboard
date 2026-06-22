const { onRequest } = require('firebase-functions/v2/https');
const { proxyPayment } = require('./payment-proxy.js');

/** 결제 API만 프록시 — api.getmiso.com은 rfq-admin.miso.kr CORS만 허용 */
exports.paymentProxy = onRequest(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  proxyPayment
);
