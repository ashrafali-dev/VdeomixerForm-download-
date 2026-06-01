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
      else { current[k]=v.trim(); process.env[k]=v.trim(); }
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

module.exports = router;
