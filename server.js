'use strict';
/*
 * BlueMatrix Scheduler - pengelola cron untuk Linux OpenStick
 * Tanpa dependensi eksternal (hanya modul bawaan Node.js >= 8).
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { execFile, spawn } = require('child_process');

// ---------- Konfigurasi ----------
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_USER = process.env.AUTH_USER || 'username';
const AUTH_PASS = process.env.AUTH_PASS || 'password';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SCRIPT_DIR = path.join(DATA_DIR, 'scripts');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

const BEGIN = '# >>> BLUEMATRIX SCHEDULER (dikelola otomatis, jangan diedit manual) >>>';
const END = '# <<< BLUEMATRIX SCHEDULER <<<';
const MAX_LOG = 512 * 1024;
const KEEP_LOG = 200 * 1024;

[DATA_DIR, SCRIPT_DIR, LOG_DIR].forEach(function (d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ---------- Parser cron (validasi) ----------
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const SPECIAL = {
  '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *'
};

function parseField(f, min, max, names) {
  const set = new Set();
  const parts = f.split(',');
  for (let k = 0; k < parts.length; k++) {
    const m = /^([^\/]+)(?:\/(\d+))?$/.exec(parts[k]);
    if (!m) return null;
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (step < 1) return null;
    let a, b;
    if (m[1] === '*') { a = min; b = max; }
    else {
      const ends = m[1].split('-');
      if (ends.length > 2) return null;
      const conv = function (x) {
        const key = x.toLowerCase();
        if (names && names[key] !== undefined) return names[key];
        return /^\d+$/.test(x) ? parseInt(x, 10) : NaN;
      };
      a = conv(ends[0]);
      b = ends.length === 2 ? conv(ends[1]) : (m[2] ? max : a);
      if (isNaN(a) || isNaN(b) || a < min || b > max || a > b) return null;
    }
    for (let i = a; i <= b; i += step) set.add(i);
  }
  return set;
}

function validateSchedule(s) {
  if (typeof s !== 'string') return 'Jadwal wajib diisi';
  s = s.trim().replace(/\s+/g, ' ');
  if (s === '@reboot' || SPECIAL[s]) return null;
  const p = s.split(' ');
  if (p.length !== 5) return 'Jadwal harus 5 kolom (menit jam tanggal bulan hari) atau @reboot/@daily/dll';
  const spec = [[0, 59], [0, 23], [1, 31], [1, 12, MON], [0, 7, DOW]];
  const labels = ['menit', 'jam', 'tanggal', 'bulan', 'hari'];
  for (let i = 0; i < 5; i++) {
    if (!parseField(p[i], spec[i][0], spec[i][1], spec[i][2])) return 'Kolom ' + labels[i] + ' tidak valid: ' + p[i];
  }
  return null;
}

// ---------- Penyimpanan job ----------
let jobs = [];
function loadJobs() {
  try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); if (!Array.isArray(jobs)) jobs = []; }
  catch (e) { jobs = []; }
}
function saveJobs() {
  const tmp = JOBS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, JOBS_FILE);
}
const scriptPath = function (id) { return path.join(SCRIPT_DIR, id + '.sh'); };
const logPath = function (id) { return path.join(LOG_DIR, id + '.log'); };

function writeScript(job) {
  const body = [
    '#!/bin/sh',
    'echo "=== $(date \'+%Y-%m-%d %H:%M:%S\') ==="',
    '(',
    job.command.replace(/\r\n/g, '\n'),
    ')',
    'echo "--- exit: $? ---"',
    ''
  ].join('\n');
  fs.writeFileSync(scriptPath(job.id), body, { mode: 493 });
  try { fs.chmodSync(scriptPath(job.id), 493); } catch (e) { /* abaikan */ }
}

// ---------- Sinkron crontab ----------
function shQ(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function readCrontab() {
  return new Promise(function (resolve, reject) {
    execFile('crontab', ['-l'], { timeout: 10000 }, function (err, out) {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error('Perintah "crontab" tidak ditemukan. Install cron: apt install cron'));
        return resolve(''); // "no crontab for user"
      }
      resolve(out || '');
    });
  });
}

function writeCrontab(text) {
  return new Promise(function (resolve, reject) {
    let child;
    try { child = spawn('crontab', ['-']); } catch (e) { return reject(e); }
    let errOut = '';
    child.stderr.on('data', function (d) { errOut += d; });
    child.on('error', function (e) {
      reject(e.code === 'ENOENT' ? new Error('Perintah "crontab" tidak ditemukan. Install cron: apt install cron') : e);
    });
    child.on('close', function (code) {
      if (code === 0) resolve(); else reject(new Error('crontab gagal (' + code + '): ' + errOut.trim()));
    });
    child.stdin.on('error', function () { /* ditangani oleh close */ });
    child.stdin.end(text);
  });
}

function stripBlock(text) {
  const a = text.indexOf(BEGIN);
  if (a === -1) return text;
  const b = text.indexOf(END, a);
  if (b === -1) return text.slice(0, a);
  let rest = text.slice(b + END.length);
  if (rest[0] === '\n') rest = rest.slice(1);
  return text.slice(0, a) + rest;
}

function buildBlock() {
  const lines = [BEGIN, 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'];
  jobs.forEach(function (j) {
    if (!j.enabled) return;
    const sched = j.schedule.trim().replace(/\s+/g, ' ');
    lines.push('# bm:' + j.id + ' ' + String(j.name).replace(/[\r\n]/g, ' '));
    lines.push((sched + ' /bin/sh ' + shQ(scriptPath(j.id)) + ' >> ' + shQ(logPath(j.id)) + ' 2>&1').replace(/%/g, '\\%'));
  });
  lines.push(END);
  return lines.join('\n') + '\n';
}

let syncChain = Promise.resolve();
function syncCrontab() {
  const run = function () {
    return readCrontab().then(function (cur) {
      let base = stripBlock(cur).replace(/\n+$/, '');
      const next = (base ? base + '\n' : '') + buildBlock();
      return writeCrontab(next);
    });
  };
  const p = syncChain.then(run, run);
  syncChain = p.catch(function () { /* jangan putus rantai */ });
  return p;
}

// ---------- Deteksi daemon cron ----------
function cronRunning() {
  try {
    const pids = fs.readdirSync('/proc').filter(function (x) { return /^\d+$/.test(x); });
    for (let i = 0; i < pids.length; i++) {
      let cmd;
      try { cmd = fs.readFileSync('/proc/' + pids[i] + '/cmdline', 'utf8'); } catch (e) { continue; }
      const args = cmd.split('\0').filter(Boolean).slice(0, 2);
      for (let k = 0; k < args.length; k++) {
        const b = path.basename(args[k]);
        if (b === 'cron' || b === 'crond') return true;
      }
    }
  } catch (e) { return null; }
  return false;
}

function crontabAvailable() {
  return new Promise(function (resolve) {
    execFile('crontab', ['-l'], { timeout: 5000 }, function (err) {
      resolve(!(err && err.code === 'ENOENT'));
    });
  });
}

// ---------- Log ----------
function readTail(file, max) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), size: st.size };
  } catch (e) { return { text: '', size: 0 }; }
}

function rotateLogs() {
  try {
    fs.readdirSync(LOG_DIR).forEach(function (f) {
      const p = path.join(LOG_DIR, f);
      const st = fs.statSync(p);
      if (st.size > MAX_LOG) {
        const t = readTail(p, KEEP_LOG).text;
        fs.writeFileSync(p, '[... log dipangkas ...]\n' + t);
      }
    });
  } catch (e) { /* abaikan */ }
}

function logInfo(id) {
  try { const st = fs.statSync(logPath(id)); return { logSize: st.size, logMtime: st.mtimeMs }; }
  catch (e) { return { logSize: 0, logMtime: null }; }
}

// ---------- Auth ----------
const sha = function (s) { return crypto.createHash('sha256').update(s).digest(); };
const failures = {};
function authenticate(req, res) {
  const ip = req.socket.remoteAddress || '?';
  const f = failures[ip];
  if (f && f.until && f.until > Date.now()) {
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
    res.end('Terlalu banyak percobaan gagal. Coba lagi sebentar.');
    return false;
  }
  const h = req.headers.authorization || '';
  let ok = false;
  if (h.indexOf('Basic ') === 0) {
    const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i !== -1) {
      const u = raw.slice(0, i), p = raw.slice(i + 1);
      const a = crypto.timingSafeEqual(sha(u), sha(AUTH_USER));
      const b = crypto.timingSafeEqual(sha(p), sha(AUTH_PASS));
      ok = a && b;
    }
  }
  if (ok) { delete failures[ip]; return true; }
  if (h) {
    const x = failures[ip] || { n: 0 };
    x.n++;
    if (x.n >= 10) { x.until = Date.now() + 60000; x.n = 0; }
    failures[ip] = x;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="BlueMatrix Scheduler", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Autentikasi diperlukan');
  return false;
}

// ---------- Helper HTTP ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > 200 * 1024) { reject(new Error('Body terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON tidak valid')); }
    });
    req.on('error', reject);
  });
}

function cleanInput(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) {
    const n = String(b.name === undefined ? '' : b.name).trim();
    if (!n) return { error: 'Nama job wajib diisi' };
    if (n.length > 80) return { error: 'Nama maksimal 80 karakter' };
    out.name = n;
  }
  if (!partial || b.schedule !== undefined) {
    const err = validateSchedule(b.schedule);
    if (err) return { error: err };
    out.schedule = b.schedule.trim().replace(/\s+/g, ' ');
  }
  if (!partial || b.command !== undefined) {
    const c = String(b.command === undefined ? '' : b.command);
    if (!c.trim()) return { error: 'Perintah wajib diisi' };
    if (c.length > 8000) return { error: 'Perintah maksimal 8000 karakter' };
    if (c.indexOf('\0') !== -1) return { error: 'Perintah mengandung karakter tidak valid' };
    out.command = c;
  }
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  return { value: out };
}

function publicJob(j) { return Object.assign({}, j, logInfo(j.id)); }
const findJob = function (id) { return jobs.filter(function (j) { return j.id === id; })[0]; };

function afterChange(res, job, code) {
  saveJobs();
  syncCrontab().then(function () {
    send(res, code, { job: job ? publicJob(job) : null, synced: true });
  }).catch(function (e) {
    send(res, code, { job: job ? publicJob(job) : null, synced: false, warning: e.message });
  });
}

// ---------- Router ----------
const server = http.createServer(function (req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!authenticate(req, res)) return;

  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, { error: 'URL tidak valid' }); }
  const p = u.pathname;
  const method = req.method;

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    fs.readFile(INDEX_FILE, function (err, data) {
      if (err) { res.writeHead(500); return res.end('index.html tidak ditemukan'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }
  if (p.indexOf('/api/') !== 0) { res.writeHead(404); return res.end('Not found'); }

  // Perlindungan CSRF untuk request yang mengubah data
  if (method !== 'GET') {
    const ct = req.headers['content-type'] || '';
    if (ct.indexOf('application/json') === -1) return send(res, 415, { error: 'Content-Type harus application/json' });
    const origin = req.headers.origin;
    if (origin) {
      let oh = '';
      try { oh = new URL(origin).host; } catch (e) { /* kosong */ }
      if (oh !== req.headers.host) return send(res, 403, { error: 'Origin ditolak' });
    }
  }

  let m;
  if (method === 'GET' && p === '/api/status') {
    Promise.all([crontabAvailable(), readCrontab().catch(function () { return ''; })]).then(function (r) {
      let user = '';
      try { user = os.userInfo().username; } catch (e) { /* abaikan */ }
      let tzName = process.env.TZ || '';
      if (!tzName) { try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* abaikan */ } }
      send(res, 200, {
        crontabAvailable: r[0], cronRunning: cronRunning(), crontab: r[1],
        serverNow: Date.now(), tzOffset: -new Date().getTimezoneOffset(), tzName: tzName,
        hostname: os.hostname(), user: user, uptime: os.uptime(), load: os.loadavg()[0],
        node: process.version
      });
    });
    return;
  }

  if (method === 'GET' && p === '/api/jobs') return send(res, 200, { jobs: jobs.map(publicJob) });

  readBody(req).then(function (body) {
    if (method === 'POST' && p === '/api/jobs') {
      const c = cleanInput(body, false);
      if (c.error) return send(res, 400, { error: c.error });
      const job = {
        id: crypto.randomBytes(4).toString('hex'), name: c.value.name, schedule: c.value.schedule,
        command: c.value.command, enabled: c.value.enabled !== false, createdAt: Date.now(), lastManualRun: null
      };
      jobs.push(job); writeScript(job);
      return afterChange(res, job, 201);
    }
    if (method === 'POST' && p === '/api/sync') {
      return afterChange(res, null, 200);
    }
    if ((m = /^\/api\/jobs\/([a-f0-9]{8})(?:\/(toggle|run|log))?$/.exec(p))) {
      const job = findJob(m[1]);
      if (!job) return send(res, 404, { error: 'Job tidak ditemukan' });
      const action = m[2];

      if (!action && method === 'PUT') {
        const c = cleanInput(body, true);
        if (c.error) return send(res, 400, { error: c.error });
        Object.assign(job, c.value); writeScript(job);
        return afterChange(res, job, 200);
      }
      if (!action && method === 'DELETE') {
        jobs = jobs.filter(function (j) { return j.id !== job.id; });
        [scriptPath(job.id), logPath(job.id)].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { /* abaikan */ } });
        return afterChange(res, null, 200);
      }
      if (action === 'toggle' && method === 'POST') {
        job.enabled = !job.enabled;
        return afterChange(res, job, 200);
      }
      if (action === 'run' && method === 'POST') {
        writeScript(job);
        fs.appendFileSync(logPath(job.id), '[dijalankan manual]\n');
        const fd = fs.openSync(logPath(job.id), 'a');
        const child = spawn('/bin/sh', [scriptPath(job.id)], { detached: true, stdio: ['ignore', fd, fd] });
        child.on('error', function () { /* abaikan */ });
        child.unref(); fs.closeSync(fd);
        job.lastManualRun = Date.now(); saveJobs();
        return send(res, 200, { started: true });
      }
      if (action === 'log' && method === 'GET') {
        const t = readTail(logPath(job.id), 64 * 1024);
        return send(res, 200, { log: t.text, size: t.size });
      }
      if (action === 'log' && method === 'DELETE') {
        try { fs.writeFileSync(logPath(job.id), ''); } catch (e) { /* abaikan */ }
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: 'Endpoint tidak ditemukan' });
  }).catch(function (e) { send(res, 400, { error: e.message }); });
});

// ---------- Mulai ----------
loadJobs();
jobs.forEach(function (j) { try { writeScript(j); } catch (e) { /* abaikan */ } });
rotateLogs();
setInterval(rotateLogs, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, function () {
  console.log('BlueMatrix Scheduler berjalan di http://' + HOST + ':' + PORT);
  console.log('Data: ' + DATA_DIR);
  syncCrontab().then(function () { console.log('Crontab tersinkron.'); })
    .catch(function (e) { console.warn('Peringatan sinkron crontab: ' + e.message); });
});
