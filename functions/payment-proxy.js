'use strict';

const UPSTREAM = 'https://api.getmiso.com/v3/backoffice/payment-transactions';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

async function proxyPayment(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Authorization header required' });

  const url = new URL(req.url, 'http://localhost');
  const upstream = UPSTREAM + (url.search || '');

  try {
    const r = await fetch(upstream, { headers: { Authorization: auth } });
    const text = await r.text();
    const ct = r.headers.get('content-type') || 'application/json';
    res.status(r.status).set('Content-Type', ct).send(text);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Upstream error' });
  }
}

module.exports = { proxyPayment };
