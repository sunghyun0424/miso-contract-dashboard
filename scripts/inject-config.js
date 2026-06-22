'use strict';

const fs = require('fs');
const path = require('path');

const base = (process.env.DASHBOARD_API_BASE || 'https://miso-contract-api.onrender.com').replace(/\/$/, '');
const escaped = base.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const outDir = path.join(__dirname, '..', 'public');
const content = [
  '// build:hosting 시 DASHBOARD_API_BASE 환경변수로 자동 생성됩니다.',
  "window.DASHBOARD_API_BASE = '" + escaped + "';",
  '',
].join('\n');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'config.js'), content);
console.log('public/config.js → API_BASE =', base || '(same origin / local)');
