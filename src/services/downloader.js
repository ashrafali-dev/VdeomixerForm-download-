'use strict';
// =====================================================================
// VideoMixer — Multi-platform downloader
// Platforms: YouTube, Instagram, TikTok, Kuaishou
// =====================================================================

const { spawn, execSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const http  = require('https');
const urllib = require('url');

const TEMP_DIR   = process.env.TEMP_DIR   || '/tmp/vmixer';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';
const COOKIES_FILE = process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt';

// ─── Platform detection ───────────────────────────────────────────
function getPlatform(url) {
  if (/instagram\.com/i.test(url))            return 'instagram';
  if (/tiktok\.com|vm\.tiktok\.com/i.test(url)) return 'tiktok';
  if (/kuaishou\.com|v\.kuaishou\.com|ks\.com/i.test(url)) return 'kuaishou';
  return 'youtube';
}

function extractPhotoId(url) {
  const m = url.match(/\/(?:short-video|video|photo)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// Short link (v.kuaishou.com) redirect follow করে real photoId বের করে
async function resolveKuaishoulUrl(url) {
  // Already a full URL with photoId?
  const direct = extractPhotoId(url);
  if (direct) return url;

  // Follow redirect
  return new Promise((resolve) => {
    try {
      const parsed = new urllib.URL(url);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      };
      const req = http.request(options, (res) => {
        // Follow redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(res.headers.location);
        } else {
          resolve(url); // no redirect, return as-is
        }
        res.resume();
      });
      req.on('error', () => resolve(url));
      req.setTimeout(10000, () => { req.destroy(); resolve(url); });
      req.end();
    } catch (_) { resolve(url); }
  });
}

function extractInstaShortcode(url) {
  const m = url.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// ─── Process tracking ─────────────────────────────────────────────
const RUNNING = new Map();
function trackProc(jobId, proc) {
  if (!RUNNING.has(jobId)) RUNNING.set(jobId, new Set());
  RUNNING.get(jobId).add(proc);
  proc.on('close', () => {
    const s = RUNNING.get(jobId);
    if (s) { s.delete(proc); if (!s.size) RUNNING.delete(jobId); }
  });
}
function killJob(jobId) {
  const s = RUNNING.get(jobId);
  if (!s) return 0;
  let n = 0;
  for (const p of s) { try { p.kill('SIGKILL'); n++; } catch (_) {} }
  RUNNING.delete(jobId);
  return n;
}

// ─── Helpers ──────────────────────────────────────────────────────
function safeMove(src, dst) {
  try { fs.renameSync(src, dst); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  fs.copyFileSync(src, dst);
  try { fs.unlinkSync(src); } catch (_) {}
}

function sanitize(s) {
  return String(s || '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

let DENO_BIN = null;
function detectDeno() {
  if (DENO_BIN !== null) return DENO_BIN;
  for (const c of ['/usr/local/bin/deno', '/usr/bin/deno', 'deno']) {
    try { execSync(`${c} --version`, { stdio: 'pipe' }); DENO_BIN = c; return c; } catch (_) {}
  }
  DENO_BIN = ''; return '';
}

function detectProxyType() {
  const link = process.env.VMESS_LINK || '';
  if (/^vmess:/i.test(link))  return 'vmess';
  if (/^vless:/i.test(link))  return 'vless';
  if (/^trojan:/i.test(link)) return 'trojan';
  const proxy = process.env.YTDLP_PROXY || '';
  if (/^socks5/i.test(proxy)) return 'socks5';
  if (/^https?:\/\//i.test(proxy)) return 'http-proxy';
  return 'direct';
}

// ─── YouTube strategies ───────────────────────────────────────────
const YT_STRATEGIES = [
  { name: 'web_embedded', client: 'web_embedded', maxSec: 150 },
  { name: 'mweb',         client: 'mweb',         maxSec: 300 },
  { name: 'ios',          client: 'ios',          maxSec: 120 },
  { name: 'android',      client: 'android',      maxSec: 120 },
  { name: 'web_safari',   client: 'web_safari',   maxSec: 150 },
  { name: 'tv_simply',    client: 'tv_simply',    maxSec: 60  },
  { name: 'android_vr',   client: 'android_vr',   maxSec: 60  },
];

// useProxy=true only for YouTube — TikTok breaks under SOCKS5/Xray proxy
function buildYtdlpBase(jobLog, useProxy = false) {
  const denoBin = detectDeno();
  const args = [
    '--no-warnings', '--progress', '--newline', '--no-playlist',
    '--retries', '10', '--fragment-retries', '10', '--retry-sleep', '3',
    '--socket-timeout', '60',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--geo-bypass',
    '--hls-prefer-native', '--concurrent-fragments', '4', '-N', '4', '--http-chunk-size', '10M',
  ];
  if (denoBin) args.push('--extractor-args', 'youtube:jsruntime=deno');
  if (fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100)
    args.push('--cookies', COOKIES_FILE);
  if (useProxy && process.env.YTDLP_PROXY) {
    args.push('--proxy', process.env.YTDLP_PROXY);
    if (jobLog) jobLog.info(`✓ proxy: ${process.env.YTDLP_PROXY.replace(/:[^:@]*@/, ':***@')} (youtube only)`);
  }
  return args;
}

function runYtdlp(args, jobLog, jobId, maxMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (jobId) trackProc(jobId, proc);
    let stderr = '', done = false;
    const timer = maxMs ? setTimeout(() => { if (!done) { try { proc.kill('SIGKILL'); } catch(_){} } }, maxMs) : null;
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => { if (l) jobLog.info(`yt-dlp> ${l}`); }));
    proc.stderr.on('data', d => { stderr += d.toString(); d.toString().split(/\r?\n/).forEach(l => { if (l) jobLog.warn(`yt-dlp> ${l}`); }); });
    proc.on('error', e => { done=true; if(timer) clearTimeout(timer); reject(e); });
    proc.on('close', code => {
      done=true; if(timer) clearTimeout(timer);
      if (code === 0) resolve({ stderr });
      else reject(Object.assign(new Error(`yt-dlp exit ${code}`), { code, stderr }));
    });
  });
}

function pickLargestFile(dir, prefix) {
  let pick = null, pickSize = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(prefix) || f.endsWith('.part') || f.endsWith('.ytdl')) continue;
      const sz = fs.statSync(path.join(dir, f)).size;
      if (sz > pickSize) { pickSize = sz; pick = f; }
    }
  } catch (_) {}
  return { pick, pickSize };
}

// ─── YouTube / TikTok download ────────────────────────────────────
async function downloadYtdlp(url, jobId, jobLog, opts = {}) {
  const platform = getPlatform(url);
  const isYT     = platform === 'youtube';
  const workDir  = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Timestamp clip support
  const startTime = opts.startTime || null; // "00:01:30"
  const endTime   = opts.endTime   || null; // "00:02:45"
  const hasClip   = startTime && endTime;

  // Format
  const fmt = 'b[height<=720][ext=mp4][protocol*=https]/bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b';
  const tmpTpl = path.join(workDir, 'dl_%(id)s.%(ext)s');

  // Metadata
  let title = 'video', meta = {};
  try {
    const margs = [...buildYtdlpBase(jobLog, isYT), '--skip-download', '--print', '%(.{id,title,duration})j', url];
    await new Promise((res, rej) => {
      const p = spawn('yt-dlp', margs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', d => out += d);
      p.on('close', () => {
        try { const l = out.trim().split('\n').find(x => x.startsWith('{')); if (l) meta = JSON.parse(l); } catch (_) {}
        res();
      });
    });
    title = meta.title || title;
  } catch (_) {}

  const strategies = isYT ? YT_STRATEGIES : [{ name: 'direct', client: null, maxSec: 180 }];
  const errors = [];

  for (const strategy of strategies) {
    // Clean temp
    try { for (const f of fs.readdirSync(workDir)) if (f.startsWith('dl_')) fs.unlinkSync(path.join(workDir, f)); } catch (_) {}

    const args = [
      ...buildYtdlpBase(jobLog, isYT),
      ...(isYT && strategy.client ? ['--extractor-args', `youtube:player_client=${strategy.client}`] : []),
      ...(platform === 'tiktok' ? ['--extractor-args', 'tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com'] : []),
      '-f', fmt,
      '--merge-output-format', 'mp4',
      ...(hasClip ? ['--download-sections', `*${startTime}-${endTime}`] : []),
      '--referer', isYT ? 'https://www.youtube.com/' : url,
      '-o', tmpTpl,
      url,
    ];

    jobLog.info(`━━ [${strategy.name}] ${platform} ${hasClip ? `(${startTime}→${endTime})` : ''} ━━`);

    const startMs = Date.now();
    let err = null;
    try { await runYtdlp(args, jobLog, jobId, strategy.maxSec * 1000); } catch (e) { err = e; }

    const { pick, pickSize } = pickLargestFile(workDir, 'dl_');
    if (pick && pickSize > 50 * 1024) {
      const ext      = path.extname(pick).slice(1) || 'mp4';
      const suffix   = hasClip ? ` [${startTime.replace(/:/g,'')}-${endTime.replace(/:/g,'')}]` : '';
      const fileName = sanitize(title) + suffix + '.' + ext;
      const finalPath = path.join(OUTPUT_DIR, fileName);
      safeMove(path.join(workDir, pick), finalPath);
      jobLog.info(`✅ ${strategy.name} OK (${(pickSize/1024/1024).toFixed(2)} MB) → ${fileName}`);
      return { filePath: finalPath, fileName, title, platform, strategy: strategy.name,
               sizeBytes: pickSize, durationMs: Date.now() - startMs };
    }
    errors.push(`[${strategy.name}] ${(err?.message || 'no output').slice(0,150)}`);
  }
  throw new Error(`All strategies failed:\n${errors.join('\n')}`);
}

// ─── Instagram download ───────────────────────────────────────────
async function downloadInstagram(url, jobId, jobLog) {
  const shortcode = extractInstaShortcode(url);
  if (!shortcode) throw new Error(`Cannot extract shortcode from: ${url}`);

  const workDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  jobLog.info(`📸 Instagram shortcode: ${shortcode}`);

  const igUser = process.env.IG_USERNAME || '';
  const igPass = process.env.IG_PASSWORD || '';

  const args = [
    '--no-metadata-json', '--no-captions', '--no-video-thumbnails',
    '--dirname-pattern', workDir,
    '--filename-pattern', shortcode,
  ];

  if (igUser && igPass) {
    args.push('--login', igUser, '--password', igPass);
    jobLog.info(`📸 Instagram: logging in as ${igUser}`);
  } else {
    jobLog.warn('⚠ No IG_USERNAME/IG_PASSWORD — may fail for some posts. Add in Settings.');
  }

  args.push('--', `-${shortcode}`);

  await new Promise((resolve) => {
    const proc = spawn('instaloader', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    trackProc(jobId, proc);
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.info(`instaloader> ${l}`)));
    proc.stderr.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.info(`instaloader> ${l}`)));
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 180_000);
    proc.on('close', () => { clearTimeout(timer); resolve(); });
  });

  const { pick, pickSize } = pickLargestFile(workDir, shortcode);
  if (!pick || pickSize < 50 * 1024) throw new Error('instaloader: no usable mp4 found');

  const fileName  = `instagram_${shortcode}.mp4`;
  const finalPath = path.join(OUTPUT_DIR, fileName);
  safeMove(path.join(workDir, pick), finalPath);
  jobLog.info(`✅ Instagram OK (${(pickSize/1024/1024).toFixed(2)} MB)`);
  return { filePath: finalPath, fileName, title: shortcode, platform: 'instagram',
           strategy: 'instaloader', sizeBytes: pickSize, durationMs: 0 };
}

// ─── Kuaishou download ────────────────────────────────────────────
// Strategy: 1) KS-Downloader API (localhost:5557)  2) GraphQL fallback

// KS-Downloader API ready check — max 10s, no spam
async function waitForKsApi(jobLog, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch('http://localhost:5557/docs', { signal: AbortSignal.timeout(2000) });
      if (res.ok) { jobLog.info('[KS] KS-Downloader API ready ✓'); return true; }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  jobLog.info('[KS] KS-Downloader API not available — trying GraphQL fallback');
  return false;
}

// Primary: KS-Downloader API
async function downloadKuaishouViaApi(url, jobId, jobLog) {
  const ksCookies = (process.env.KS_COOKIES || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  const proxy     = (process.env.KS_PROXY || '').trim() || null;

  jobLog.info('[KS] Trying KS-Downloader API...');
  if (proxy) jobLog.info(`[KS] Using proxy: ${proxy}`);

  const bodyObj = { text: url, cookie: ksCookies || null };
  if (proxy) bodyObj.proxy = proxy;
  const body = JSON.stringify(bodyObj);

  let resp, json;
  try {
    resp = await fetch('http://localhost:5557/detail/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal:  AbortSignal.timeout(60000),
    });
    json = await resp.json();
  } catch (e) {
    throw new Error(`KS-API fetch error: ${e.message}`);
  }

  jobLog.info(`[KS-API] response: ${JSON.stringify(json).slice(0, 300)}`);

  const data = json?.data;
  if (!data) throw new Error(`KS-API: no data — ${json?.message || 'unknown'}`);

  // download field: array of URLs or space-separated string
  let videoUrl = '';
  if (Array.isArray(data.download)) {
    videoUrl = data.download[0];
  } else if (typeof data.download === 'string') {
    videoUrl = data.download.split(' ')[0];
  }
  if (!videoUrl) throw new Error('KS-API: no download URL in response');

  const caption  = data.caption || data.photoId || 'kuaishou';
  const photoId  = data.photoId || url.split('/').pop().split('?')[0];

  return { videoUrl, caption, photoId };
}

// Fallback: GraphQL direct
async function downloadKuaishouViaGraphQL(photoId, ksCookies, jobLog) {
  jobLog.info('[KS] Trying GraphQL fallback...');
  const proxy = (process.env.KS_PROXY || '').trim() || null;
  if (proxy) jobLog.info(`[KS-GQL] Using proxy: ${proxy}`);

  const payload = JSON.stringify({
    operationName: 'visionVideoDetail',
    variables: { photoId, page: 'detail' },
    query: 'query visionVideoDetail($photoId: String, $page: String) { visionVideoDetail(photoId: $photoId, page: $page) { photo { id caption photoUrl duration } } }',
  });

  const curlArgs = [
    '-s', '--max-time', '45', '--connect-timeout', '15',
    ...(proxy ? ['-x', proxy] : []),
    '-X', 'POST', 'https://www.kuaishou.com/graphql',
    '-H', 'Content-Type: application/json',
    '-H', `Cookie: ${ksCookies}`,
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '-H', `Referer: https://www.kuaishou.com/short-video/${photoId}`,
    '-H', 'Origin: https://www.kuaishou.com',
    '-H', 'Accept: */*',
    '--data-raw', payload,
  ];

  const runCurl = (args) => new Promise((res) => {
    const proc = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => res({ code, out, err }));
  });

  // Try with proxy first, then direct
  let result = await runCurl(curlArgs);
  if (result.code !== 0 || !result.out.trim()) {
    jobLog.info(`[KS] Proxy curl failed (exit ${result.code}) — retrying direct`);
    const directArgs = curlArgs.filter((a, i) => a !== '-x' && curlArgs[i-1] !== '-x');
    result = await runCurl(directArgs);
  }

  if (!result.out.trim()) {
    throw new Error(`GraphQL: empty response (curl exit ${result.code}) — proxy timeout or blocked`);
  }
  let json;
  try { json = JSON.parse(result.out); }
  catch(e) { throw new Error(`GraphQL: invalid JSON — ${result.out.slice(0,100)}`); }
  jobLog.info(`[KS-GQL] raw: ${JSON.stringify(json).slice(0, 300)}`);
  const videoUrl = json?.data?.visionVideoDetail?.photo?.photoUrl;
  if (!videoUrl) throw new Error(`GraphQL: no photoUrl — ${json?.errors?.[0]?.message || 'captcha or expired cookie'}`);
  return videoUrl;
}

async function downloadKuaishou(url, jobId, jobLog) {
  // KS_COOKIES optional — KS-Downloader works without login cookie
  const ksCookies = (process.env.KS_COOKIES || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();

  const workDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let videoUrl, photoId, caption, strategy;

  // ── Strategy 1: KS-Downloader API ─────────────────────────────
  const apiReady = await waitForKsApi(jobLog, 60000);
  if (apiReady) {
    try {
      const r = await downloadKuaishouViaApi(url, jobId, jobLog);
      videoUrl = r.videoUrl;
      photoId  = r.photoId;
      caption  = r.caption;
      strategy = 'ks-downloader-api';
    } catch (e) {
      jobLog.info(`[KS] API failed: ${e.message} — falling back to GraphQL`);
    }
  }

  // ── Strategy 2: GraphQL fallback ──────────────────────────────
  if (!videoUrl) {
    // Resolve short link for GraphQL
    const resolvedUrl = await resolveKuaishoulUrl(url);
    if (resolvedUrl !== url) jobLog.info(`[KS] Redirected → ${resolvedUrl}`);
    photoId = extractPhotoId(resolvedUrl);
    if (!photoId) throw new Error(`Cannot extract photoId from: ${resolvedUrl}`);
    jobLog.info(`🎬 Kuaishou photoId: ${photoId}`);
    videoUrl = await downloadKuaishouViaGraphQL(photoId, ksCookies, jobLog);
    strategy = 'graphql';
  }

  // ── Download the mp4 ──────────────────────────────────────────
  jobLog.info(`[KS] Downloading via ${strategy}...`);
  const fileName  = `kuaishou_${photoId || Date.now()}.mp4`;
  const finalPath = path.join(OUTPUT_DIR, fileName);

  await new Promise((resolve, reject) => {
    const file  = fs.createWriteStream(finalPath);
    const dlReq = http.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.kuaishou.com/',
      },
    }, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    dlReq.on('error', e => { fs.unlink(finalPath, () => {}); reject(e); });
    dlReq.setTimeout(120000, () => { dlReq.destroy(); reject(new Error('KS download timeout')); });
  });

  const sizeBytes = fs.statSync(finalPath).size;
  jobLog.info(`✅ Kuaishou OK (${(sizeBytes/1024/1024).toFixed(2)} MB) via ${strategy}`);
  return { filePath: finalPath, fileName, title: caption || photoId, platform: 'kuaishou',
           strategy, sizeBytes, durationMs: 0 };
}

// ─── Main entry ───────────────────────────────────────────────────
async function downloadVideo(url, jobId, jobLog, opts = {}) {
  const platform = getPlatform(url);
  jobLog.info(`[downloader] platform=${platform} url=${url}`);
  switch (platform) {
    case 'instagram': return downloadInstagram(url, jobId, jobLog);
    case 'kuaishou':  return downloadKuaishou(url, jobId, jobLog);
    default:          return downloadYtdlp(url, jobId, jobLog, opts);
  }
}

module.exports = { downloadVideo, getPlatform, killJob, detectProxyType, YT_STRATEGIES };
