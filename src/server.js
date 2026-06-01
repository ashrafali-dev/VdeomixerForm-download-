'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');

// Load persisted config
const CONFIG_FILE = process.env.CONFIG_FILE || '/app/data/config.json';
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    for (const [k, v] of Object.entries(cfg))
      if (v && typeof v === 'string') process.env[k] = v;
    console.log(`[boot] loaded ${Object.keys(cfg).length} config keys`);
  }
} catch (e) { console.warn('[boot] config load failed:', e.message); }

const authRoutes  = require('./routes/auth');
const mixerRoutes = require('./routes/mixer');
const driveRoutes = require('./routes/drive');
const setupRoutes = require('./routes/setup');
const xray        = require('./services/xray');
const { logger }  = require('./utils/logger');

const app  = express();
const PORT = process.env.PORT || 3000;

// Ensure directories
const DATA_DIR    = process.env.OUTPUT_DIR  || '/app/data/output';
const TEMP_DIR    = process.env.TEMP_DIR    || '/tmp/vmixer';
const COOKIES_DIR = path.dirname(process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt');
[DATA_DIR, TEMP_DIR, COOKIES_DIR, path.dirname(CONFIG_FILE)].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'vmixer-secret-change-this',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*24*30, httpOnly: true, secure: process.env.NODE_ENV === 'production' }
}));
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/version', (_, res) => {
  const tryCmd = cmd => { try { return execSync(cmd).toString().trim(); } catch { return 'n/a'; } };
  res.json({
    app: 'VideoMixer',
    ffmpeg:  tryCmd('ffmpeg -version 2>&1 | head -n1'),
    ytdlp:   tryCmd('yt-dlp --version 2>&1'),
    deno:    tryCmd('deno --version 2>&1 | head -n1'),
    xray:    tryCmd('xray version 2>&1 | head -n1'),
    instaloader: tryCmd('instaloader --version 2>&1'),
    python:  tryCmd('python3 --version 2>&1'),
    node:    process.version,
    cookies: fs.existsSync(process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt'),
    ks_cookies: !!(process.env.KS_COOKIES),
    proxy:   !!(process.env.YTDLP_PROXY),
    vmess:   !!(process.env.VMESS_LINK),
    google_oauth: !!(process.env.GOOGLE_CLIENT_ID),
  });
});

app.use('/auth',        authRoutes);
app.use('/api/mixer',   mixerRoutes);
app.use('/api/drive',   driveRoutes);
app.use('/api/setup',   setupRoutes);
app.use('/files', express.static(DATA_DIR, { setHeaders: r => r.set('Cache-Control','no-store') }));

app.use((err, req, res, next) => {
  logger.error('Unhandled:', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  logger.info(`🎬 VideoMixer running on port ${PORT}`);
  if (process.env.VMESS_LINK) setTimeout(() => xray.startXray(), 1000);
});

['SIGTERM','SIGINT'].forEach(sig => process.on(sig, () => { xray.stopXray(); process.exit(0); }));
