'use strict';

const fs = require('fs');
const path = require('path');

const base = (process.env.DASHBOARD_API_BASE || 'https://miso-contract-api.onrender.com').replace(/\/$/, '');
const escaped = base.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const outDir = path.join(__dirname, '..', 'public');
const htmlPath = path.join(outDir, 'index.html');

if (fs.existsSync(htmlPath)) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(
    "window.DASHBOARD_API_BASE = '';",
    "window.DASHBOARD_API_BASE = '" + escaped + "';"
  );
  fs.writeFileSync(htmlPath, html);
  console.log('public/index.html → API_BASE =', base);
} else {
  console.warn('public/index.html not found — run cp index.html public/ first');
}
