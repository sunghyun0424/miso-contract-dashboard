'use strict';

/** Render 전용 — 결제 API CORS 우회 프록시만 제공 */
const http = require('http');

const PORT = Number(process.env.PORT || 4000);
const UPSTREAM = 'https://api.getmiso.com/v3/backoffice/payment-transactions';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

const server = http.createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, role: 'payment-proxy', ts: new Date().toISOString() }));
  }

  if (url.pathname === '/api/payment-transactions' && req.method === 'GET') {
    const auth = req.headers.authorization;
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Authorization header required' }));
    }
    try {
      const r = await fetch(UPSTREAM + url.search, { headers: { Authorization: auth } });
      const text = await r.text();
      res.writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(text);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message || 'Upstream error' }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log('Miso payment proxy: port ' + PORT);
});
