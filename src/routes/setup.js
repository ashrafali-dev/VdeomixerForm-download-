'use strict';
const router = require('express').Router();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { spawn, execSync } = require('child_process');
const { logger } = require('../utils/logger');
const xray   = require('../services/xray');

const COOKIES_FILE = process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt';
const CONFIG_FILE  = process.env.CONFIG_FILE  || '/app/data/config.json';
const upload = multer({ dest: '/tmp/', limits: { fileSize: 10*1024*1024 } });

const ALLOWED_CONFIG_KEYS = new Set([
  'YTDLP_PROXY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI','VMESS_LINK','KS_COOKIES',
  'TG_BOT_TOKEN','TG_CHAT_ID','YT_ACCESS_TOKEN',
  'IG_APP_ID','IG_APP_SECRET','IG_REDIRECT_URI','IG_ACCESS_TOKEN','IG_ACCOUNT_ID',
  'FB_APP_ID','FB_APP_SECRET','FB_REDIRECT_URI','FB_ACCESS_TOKEN','FB_PAGE_ID',
  'TIKTOK_SESSION_ID',
  'TIKTOK_CLIENT_KEY','TIKTOK_CLIENT_SECRET','TIKTOK_REDIRECT_URI','TIKTOK_ACCESS_TOKEN','TIKTOK_REFRESH_TOKEN',
  'DRIVE_FOLDER_ID',
]);

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); } catch(_) {}
  return {};
}
function saveConfigFile(obj) {
  fs.mkdirSync(path.dirname(CONFIG_FILE),{recursive:true});
  fs.writeFileSync(CONFIG_FILE,JSON.stringify(obj,null,2));
}

router.get('/config', (req,res) => {
  const cfg = loadConfig();
  if (cfg.GOOGLE_CLIENT_SECRET) cfg.GOOGLE_CLIENT_SECRET = true;
  if (cfg.KS_COOKIES) cfg.KS_COOKIES = cfg.KS_COOKIES.slice(0,30)+'…';
  res.json(cfg);
});

router.post('/config', (req,res) => {
  try {
    const incoming = req.body || {};
    const current  = loadConfig();
    let xrayChanged = false;
    for (const [k,v] of Object.entries(incoming)) {
      if (!ALLOWED_CONFIG_KEYS.has(k)) continue;
      if (v===''||v===null) { delete current[k]; delete process.env[k]; }
      else {
        // KS_COOKIES এ newline/tab থাকলে Cookie header crash করে
        const clean = k === 'KS_COOKIES'
          ? v.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()
          : v.trim();
        current[k] = clean; process.env[k] = clean;
      }
      if (k==='VMESS_LINK'||k==='YTDLP_PROXY') xrayChanged=true;
    }
    saveConfigFile(current);
    if (xrayChanged) { try { process.env.VMESS_LINK ? xray.startXray() : xray.stopXray(); } catch(_){} }
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Cookies — support both file upload AND raw text body
router.post('/cookies', upload.single('cookies'), (req,res) => {
  try {
    let content = '';
    if (req.file) {
      content = fs.readFileSync(req.file.path,'utf8');
      fs.unlinkSync(req.file.path);
    } else if (req.body && req.body.cookies) {
      content = req.body.cookies;
    } else return res.status(400).json({error:'cookies required'});

    fs.mkdirSync(path.dirname(COOKIES_FILE),{recursive:true});
    // Auto-add Netscape header if missing
    if (!content.startsWith('# Netscape')) content = '# Netscape HTTP Cookie File\n'+content;
    fs.writeFileSync(COOKIES_FILE, content);
    const size = fs.statSync(COOKIES_FILE).size;
    logger.info(`✓ cookies.txt saved (${size} bytes)`);
    res.json({ok:true,size});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete('/cookies', (req,res) => {
  try { if(fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE); res.json({ok:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// Proxy health
function probe(url,proxyUrl,timeoutSec=30) {
  return new Promise(resolve=>{
    const start=Date.now();
    const proc=spawn('curl',['-x',proxyUrl,'-s','-I','--max-time',String(timeoutSec),'--connect-timeout','15','-o','/dev/null','-w','%{http_code}',url],{stdio:['ignore','pipe','pipe']});
    let out='';
    proc.stdout.on('data',d=>out+=d.toString());
    proc.on('close',code=>{
      const httpCode=parseInt((out||'').trim(),10)||0;
      resolve({ok:code===0&&httpCode>=200&&httpCode<600,httpCode,latency:Date.now()-start});
    });
    proc.on('error',()=>resolve({ok:false,httpCode:0,latency:Date.now()-start}));
  });
}

router.post('/proxy-test', async(req,res)=>{
  if (!process.env.YTDLP_PROXY) return res.json({ok:false,error:'No proxy configured'});
  const proxy=process.env.YTDLP_PROXY;
  const p1=await probe('https://api.ipify.org',proxy,30);
  const p2=p1.ok?p1:await probe('https://www.youtube.com',proxy,30);
  let ip=null;
  if(p2.ok){try{ip=execSync(`curl -x "${proxy}" -s --max-time 20 https://api.ipify.org`).toString().trim();}catch(_){}}
  res.json({ok:p2.ok,ip,proxy:proxy.replace(/:[^:@]*@/,':***@')});
});

router.get('/status', (req,res)=>{
  const cookies=fs.existsSync(COOKIES_FILE);
  res.json({
    cookies:{exists:cookies,size:cookies?fs.statSync(COOKIES_FILE).size:0},
    ks_cookies:!!(process.env.KS_COOKIES),
    proxy:{configured:!!(process.env.YTDLP_PROXY),url:(process.env.YTDLP_PROXY||'').replace(/:[^:@]*@/,':***@')},
    vmess:{set:!!(process.env.VMESS_LINK)},
    google:{client_id:!!(process.env.GOOGLE_CLIENT_ID),client_secret:!!(process.env.GOOGLE_CLIENT_SECRET)},
  });
});

// TikTok cookies — separate file
const TIKTOK_COOKIES_FILE = process.env.TIKTOK_COOKIES_FILE || '/app/data/cookies/tiktok_cookies.txt';

router.post('/tiktok-cookies', upload.single('cookies'), (req, res) => {
  try {
    let text = '';
    if (req.file) {
      text = fs.readFileSync(req.file.path, 'utf8');
      try { fs.unlinkSync(req.file.path); } catch(_) {}
    } else if (req.body?.cookies) {
      text = String(req.body.cookies);
    }
    if (!text.trim()) return res.status(400).json({ error: 'empty' });
    fs.mkdirSync(path.dirname(TIKTOK_COOKIES_FILE), { recursive: true });
    fs.writeFileSync(TIKTOK_COOKIES_FILE, text.trim() + '\n');
    res.json({ ok: true, size: text.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Audio library — persisted JSON list
const AUDIO_LIB_FILE = path.join(path.dirname(CONFIG_FILE), 'audio-lib.json');

router.get('/audio-lib', (req, res) => {
  try {
    if (!fs.existsSync(AUDIO_LIB_FILE)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(AUDIO_LIB_FILE, 'utf8')));
  } catch(_) { res.json([]); }
});

router.post('/audio-lib', (req, res) => {
  try {
    const data = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'array expected' });
    fs.mkdirSync(path.dirname(AUDIO_LIB_FILE), { recursive: true });
    fs.writeFileSync(AUDIO_LIB_FILE, JSON.stringify(data, null, 2));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Sound Library (transition sounds) ────────────────────────────
const SOUNDS_DIR      = path.join(path.dirname(CONFIG_FILE), 'sounds');
const SOUNDS_META_FILE = path.join(path.dirname(CONFIG_FILE), 'sounds-meta.json');
const soundUpload = multer({ dest: '/tmp/', limits: { fileSize: 20*1024*1024 } });

function loadSoundsMeta() {
  try { if (fs.existsSync(SOUNDS_META_FILE)) return JSON.parse(fs.readFileSync(SOUNDS_META_FILE,'utf8')); } catch(_) {}
  return { selected: null, files: [] };
}
function saveSoundsMeta(meta) {
  fs.mkdirSync(path.dirname(SOUNDS_META_FILE), { recursive: true });
  fs.writeFileSync(SOUNDS_META_FILE, JSON.stringify(meta, null, 2));
}

// List all sounds + selected
router.get('/sounds', (req, res) => {
  const meta = loadSoundsMeta();
  // verify files still exist
  meta.files = (meta.files || []).filter(f => fs.existsSync(path.join(SOUNDS_DIR, f.filename)));
  saveSoundsMeta(meta);
  res.json(meta);
});

// Upload a sound file
router.post('/sounds', soundUpload.single('sound'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const ext = path.extname(req.file.originalname).toLowerCase() || '.mp3';
    if (!['.mp3','.wav','.ogg','.m4a'].includes(ext))
      return res.status(400).json({ error: 'Only mp3/wav/ogg/m4a allowed' });

    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    const filename = `sound_${Date.now()}${ext}`;
    fs.renameSync(req.file.path, path.join(SOUNDS_DIR, filename));

    const meta = loadSoundsMeta();
    meta.files = meta.files || [];
    meta.files.push({ filename, originalName: req.file.originalname, addedAt: Date.now() });
    saveSoundsMeta(meta);
    res.json({ ok: true, filename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Select a sound for transition
router.post('/sounds/select', (req, res) => {
  try {
    const { filename } = req.body;
    const meta = loadSoundsMeta();
    if (filename && !meta.files.find(f => f.filename === filename))
      return res.status(404).json({ error: 'Not found' });
    meta.selected = filename || null;
    saveSoundsMeta(meta);
    res.json({ ok: true, selected: meta.selected });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete a sound
router.delete('/sounds/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    const meta = loadSoundsMeta();
    const filePath = path.join(SOUNDS_DIR, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    meta.files = (meta.files || []).filter(f => f.filename !== filename);
    if (meta.selected === filename) meta.selected = null;
    saveSoundsMeta(meta);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Serve sound files
router.get('/sounds/file/:filename', (req, res) => {
  const filePath = path.join(SOUNDS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

module.exports = router;
