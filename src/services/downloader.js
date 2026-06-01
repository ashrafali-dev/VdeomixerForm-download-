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
  if (/kuaishou\.com|ks\.com/i.test(url))     return 'kuaishou';
  return 'youtube';
}

function extractPhotoId(url) {
  const m = url.match(/\/(?:short-video|video|photo)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
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

function buildYtdlpBase(jobLog) {
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
  if (process.env.YTDLP_PROXY)
    args.push('--proxy', process.env.YTDLP_PROXY);
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
    const margs = [...buildYtdlpBase(jobLog), '--skip-download', '--print', '%(.{id,title,duration})j', url];
    if (!isYT) {
      // remove youtube-specific headers for TikTok
      const refIdx = margs.indexOf('--referer');
      if (refIdx >= 0) margs.splice(refIdx, 2);
    }
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
      ...buildYtdlpBase(jobLog),
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

  const args = [
    '--no-metadata-json', '--no-captions', '--no-video-thumbnails',
    '--dirname-pattern', workDir,
    '--filename-pattern', shortcode,
    '--', `-${shortcode}`,
  ];

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
async function downloadKuaishou(url, jobId, jobLog) {
  const photoId = extractPhotoId(url);
  if (!photoId) throw new Error(`Cannot extract photoId from: ${url}`);

  const ksCookies = process.env.KS_COOKIES || '';
  if (!ksCookies) throw new Error('KS_COOKIES not set — add via Settings tab');

  jobLog.info(`🎬 Kuaishou photoId: ${photoId}`);

  const workDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // GraphQL fetch
  const payload = JSON.stringify({
    operationName: 'visionVideoDetail',
    variables: { photoId, page: 'detail' },
    query: 'query visionVideoDetail($photoId: String, $page: String) { visionVideoDetail(photoId: $photoId, page: $page) { photo { id caption photoUrl duration } } }',
  });

  const videoUrl = await new Promise((resolve, reject) => {
    const opts = {
      hostname: 'www.kuaishou.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': `https://www.kuaishou.com/short-video/${photoId}`,
        'Origin': 'https://www.kuaishou.com',
        'Accept': '*/*',
        'Cookie': ksCookies,
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const pUrl = json?.data?.visionVideoDetail?.photo?.photoUrl;
          if (!pUrl) return reject(new Error('No photoUrl in response — cookie may be expired'));
          resolve(pUrl);
        } catch (e) { reject(new Error(`KS parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('KS GraphQL timeout')); });
    req.write(payload);
    req.end();
  });

  jobLog.info(`✓ Got CDN URL, downloading...`);

  // Download the mp4
  const fileName  = `kuaishou_${photoId}.mp4`;
  const finalPath = path.join(OUTPUT_DIR, fileName);

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(finalPath);
    const dlReq = http.get(videoUrl, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.kuaishou.com/',
    }}, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    dlReq.on('error', e => { fs.unlink(finalPath, () => {}); reject(e); });
    dlReq.setTimeout(60000, () => { dlReq.destroy(); reject(new Error('KS download timeout')); });
  });

  const sizeBytes = fs.statSync(finalPath).size;
  jobLog.info(`✅ Kuaishou OK (${(sizeBytes/1024/1024).toFixed(2)} MB)`);
  return { filePath: finalPath, fileName, title: photoId, platform: 'kuaishou',
           strategy: 'graphql', sizeBytes, durationMs: 0 };
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
