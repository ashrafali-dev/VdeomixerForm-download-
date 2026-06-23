'use strict';
const router  = require('express').Router();
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function loadConfig() {
  const f = process.env.CONFIG_FILE || '/app/data/config.json';
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch(_) {}
  return {};
}

/** Simple fetch wrapper using built-in https (no extra deps) */
function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   opts.method || 'GET',
      headers:  opts.headers || {},
    };
    const req = mod.request(reqOpts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(_) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Stream a file to an open URL (PUT/POST) */
function streamFileTo(url, filePath, method = 'PUT', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const fileSize = fs.statSync(filePath).size;
    const parsed   = new URL(url);
    const mod      = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Length': fileSize,
        'Content-Type':   'video/mp4',
        ...extraHeaders,
      },
    };
    const req = mod.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(_) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req);
  });
}

// ─────────────────────────────────────────────
// Resolve job filePath from jobId
// ─────────────────────────────────────────────
function resolveFilePath(jobId) {
  if (!jobId) return null;
  try {
    const { getJob } = require('../services/jobManager');
    const job = getJob(jobId);
    if (job && job.result && job.result.filePath) return job.result.filePath;
  } catch(_) {}
  return null;
}

// ═══════════════════════════════════════════════════════════
// FACEBOOK UPLOAD  (Graph API — Resumable Video Upload)
// Docs: https://developers.facebook.com/docs/video-api/guides/reels-publishing
// ═══════════════════════════════════════════════════════════
router.post('/facebook', async (req, res) => {
  try {
    const { jobId, title = '', description = '' } = req.body;
    const cfg = loadConfig();

    const token  = process.env.FB_ACCESS_TOKEN || cfg.FB_ACCESS_TOKEN;
    const pageId = process.env.FB_PAGE_ID      || cfg.FB_PAGE_ID;

    if (!token)  return res.status(400).json({ error: 'FB_ACCESS_TOKEN not set. Configure in Settings → Facebook Upload.' });
    if (!pageId) return res.status(400).json({ error: 'FB_PAGE_ID not set. Configure in Settings → Facebook Upload.' });

    const filePath = resolveFilePath(jobId);
    if (!filePath || !fs.existsSync(filePath))
      return res.status(404).json({ error: 'Video file not found. Make sure the job is completed.' });

    const fileSize = fs.statSync(filePath).size;
    const fileName = path.basename(filePath);
    logger.info(`[FB] Starting upload: ${fileName} (${(fileSize/1024/1024).toFixed(1)} MB)`);

    // ── Step 1: Initialize upload session ──
    const initUrl = `https://graph.facebook.com/v19.0/${pageId}/videos`;
    const initBody = new URLSearchParams({
      upload_phase:   'start',
      file_size:      String(fileSize),
      access_token:   token,
    }).toString();

    const initResp = await fetchJson(initUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(initBody) },
      body:    initBody,
    });

    if (initResp.status !== 200 || !initResp.data.upload_session_id)
      return res.status(502).json({ error: 'Facebook init failed', detail: initResp.data });

    const sessionId = initResp.data.upload_session_id;
    const videoId   = initResp.data.video_id;
    logger.info(`[FB] Session: ${sessionId}, VideoId: ${videoId}`);

    // ── Step 2: Transfer (single chunk for files ≤ 1 GB) ──
    const transferUrl = `https://graph-video.facebook.com/v19.0/${pageId}/videos`;
    const CHUNK_SIZE  = 10 * 1024 * 1024; // 10 MB chunks
    let offset = 0;

    while (offset < fileSize) {
      const end    = Math.min(offset + CHUNK_SIZE, fileSize);
      const chunk  = Buffer.allocUnsafe(end - offset);
      const fd     = fs.openSync(filePath, 'r');
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      fs.closeSync(fd);

      const chunkBody   = chunk;
      const chunkParams = new URLSearchParams({
        upload_phase:      'transfer',
        upload_session_id: sessionId,
        start_offset:      String(offset),
        access_token:      token,
      }).toString();

      await new Promise((resolve, reject) => {
        const parsed = new URL(transferUrl + '?' + chunkParams);
        const req2   = https.request({
          hostname: parsed.hostname,
          path:     parsed.pathname + parsed.search,
          method:   'POST',
          headers: {
            'Content-Type':   'multipart/form-data; boundary=fbupload',
            'Content-Length': chunk.length,
          },
        }, respStream => {
          let body = '';
          respStream.on('data', d => body += d);
          respStream.on('end', () => {
            try {
              const d = JSON.parse(body);
              if (d.error) reject(new Error(d.error.message));
              else resolve(d);
            } catch(_) { resolve(body); }
          });
        });
        req2.on('error', reject);
        req2.write(chunkBody);
        req2.end();
      });

      logger.info(`[FB] Uploaded ${Math.round(end/1024/1024)} / ${Math.round(fileSize/1024/1024)} MB`);
      offset = end;
    }

    // ── Step 3: Finish ──
    const finishParams = new URLSearchParams({
      upload_phase:      'finish',
      upload_session_id: sessionId,
      access_token:      token,
      title:             title || fileName.replace('.mp4',''),
      description:       description,
    }).toString();

    const finishResp = await fetchJson(`${initUrl}?${finishParams}`, {
      method: 'POST',
      headers: { 'Content-Length': '0' },
    });

    if (finishResp.data && finishResp.data.success === true) {
      logger.info(`[FB] Upload complete! Video ID: ${videoId}`);
      return res.json({ ok: true, videoId, url: `https://www.facebook.com/video/${videoId}` });
    }

    return res.json({ ok: true, videoId, detail: finishResp.data });

  } catch (e) {
    logger.error('[FB] Upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// TIKTOK UPLOAD  (Official Content Posting API v2)
// Docs: https://developers.tiktok.com/doc/content-posting-api-get-started-upload-video
// Requires: TIKTOK_ACCESS_TOKEN  (from OAuth 2.0 login)
// ═══════════════════════════════════════════════════════════
router.post('/tiktok', async (req, res) => {
  try {
    const { jobId, title = '', privacy = 'SELF_ONLY' } = req.body;
    // privacy options: PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS | FOLLOWER_OF_CREATOR | SELF_ONLY
    const cfg   = loadConfig();
    const token = process.env.TIKTOK_ACCESS_TOKEN || cfg.TIKTOK_ACCESS_TOKEN;

    if (!token)
      return res.status(400).json({ error: 'TIKTOK_ACCESS_TOKEN not set. Configure in Settings → TikTok Upload.' });

    const filePath = resolveFilePath(jobId);
    if (!filePath || !fs.existsSync(filePath))
      return res.status(404).json({ error: 'Video file not found. Make sure the job is completed.' });

    const fileSize = fs.statSync(filePath).size;
    const fileName = path.basename(filePath);
    logger.info(`[TT] Starting upload: ${fileName} (${(fileSize/1024/1024).toFixed(1)} MB)`);

    // ── Step 1: Initialize upload ──
    const initPayload = JSON.stringify({
      post_info: {
        title:         (title || fileName.replace('.mp4','')).slice(0, 150),
        privacy_level: privacy,
        disable_duet:  false,
        disable_stitch: false,
        disable_comment: false,
      },
      source_info: {
        source:         'FILE_UPLOAD',
        video_size:     fileSize,
        chunk_size:     fileSize,          // single chunk
        total_chunk_count: 1,
      },
    });

    const initResp = await fetchJson('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(initPayload),
      },
      body: initPayload,
    });

    if (!initResp.data || initResp.data.error?.code !== 'ok')
      return res.status(502).json({ error: 'TikTok init failed', detail: initResp.data });

    const publishId  = initResp.data.data.publish_id;
    const uploadUrl  = initResp.data.data.upload_url;
    logger.info(`[TT] publish_id: ${publishId}`);

    // ── Step 2: Upload file (single chunk PUT) ──
    const uploadResp = await streamFileTo(uploadUrl, filePath, 'PUT', {
      'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
    });

    if (uploadResp.status >= 400)
      return res.status(502).json({ error: 'TikTok file upload failed', status: uploadResp.status, detail: uploadResp.data });

    logger.info(`[TT] File uploaded, checking status...`);

    // ── Step 3: Poll publish status ──
    let statusData = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const statusPayload = JSON.stringify({ publish_id: publishId });
      const statusResp = await fetchJson('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json; charset=UTF-8',
          'Content-Length': Buffer.byteLength(statusPayload),
        },
        body: statusPayload,
      });

      const s = statusResp.data?.data?.status;
      logger.info(`[TT] Status poll ${i+1}: ${s}`);

      if (s === 'PUBLISH_COMPLETE') {
        statusData = statusResp.data.data;
        break;
      }
      if (s === 'FAILED') {
        return res.status(502).json({ error: 'TikTok publish failed', detail: statusResp.data });
      }
    }

    if (!statusData)
      return res.json({ ok: true, publishId, status: 'PROCESSING', message: 'Video is being processed by TikTok. Check your profile shortly.' });

    return res.json({
      ok: true,
      publishId,
      status:   'PUBLISH_COMPLETE',
      videoId:  statusData.publicaly_available_post_id?.[0] || null,
    });

  } catch (e) {
    logger.error('[TT] Upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// FACEBOOK OAuth
// ═══════════════════════════════════════════════════════════
router.get('/facebook/auth', (req, res) => {
  const cfg         = loadConfig();
  const appId       = process.env.FB_APP_ID       || cfg.FB_APP_ID;
  const redirectUri = process.env.FB_REDIRECT_URI || cfg.FB_REDIRECT_URI;
  if (!appId || !redirectUri)
    return res.status(400).send('FB_APP_ID and FB_REDIRECT_URI must be set in Settings first.');
  const scope = 'pages_manage_posts,pages_read_engagement,pages_show_list,publish_video';
  const url   = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&response_type=code`;
  res.redirect(url);
});

router.get('/facebook/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  const cfg          = loadConfig();
  const appId        = process.env.FB_APP_ID       || cfg.FB_APP_ID;
  const appSecret    = process.env.FB_APP_SECRET   || cfg.FB_APP_SECRET;
  const redirectUri  = process.env.FB_REDIRECT_URI || cfg.FB_REDIRECT_URI;
  try {
    // Exchange code for token
    const tokenResp = await fetchJson(
      `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`
    );
    if (!tokenResp.data.access_token)
      return res.status(502).send('<h2>❌ Facebook Auth Failed</h2><pre>' + JSON.stringify(tokenResp.data, null, 2) + '</pre>');

    const userToken = tokenResp.data.access_token;

    // Get long-lived token
    const longResp = await fetchJson(
      `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${userToken}`
    );
    const longToken = longResp.data.access_token || userToken;

    // Get pages list — pick first page token
    const pagesResp = await fetchJson(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${longToken}`
    );
    let pageId    = cfg.FB_PAGE_ID || '';
    let pageToken = longToken;
    if (pagesResp.data.data && pagesResp.data.data.length > 0) {
      pageId    = pagesResp.data.data[0].id;
      pageToken = pagesResp.data.data[0].access_token || longToken;
    }

    // Save
    const CONFIG_FILE = process.env.CONFIG_FILE || '/app/data/config.json';
    const current = cfg;
    current.FB_ACCESS_TOKEN = pageToken;
    current.FB_PAGE_ID      = pageId;
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2));
    process.env.FB_ACCESS_TOKEN = pageToken;
    process.env.FB_PAGE_ID      = pageId;
    logger.info(`[FB] OAuth complete. Page ID: ${pageId}`);
    res.send(`<h2>✅ Facebook Connected!</h2><p>Page ID: <b>${pageId}</b> — token saved. Close this tab.</p>`);
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ═══════════════════════════════════════════════════════════
// INSTAGRAM UPLOAD  (Instagram Graph API — Business/Creator)
// Docs: https://developers.facebook.com/docs/instagram-api/guides/reels-publishing
// ═══════════════════════════════════════════════════════════
router.post('/instagram', async (req, res) => {
  try {
    const { jobId, caption = '' } = req.body;
    const cfg     = loadConfig();
    const token   = process.env.IG_ACCESS_TOKEN || cfg.IG_ACCESS_TOKEN;
    const igAccId = process.env.IG_ACCOUNT_ID   || cfg.IG_ACCOUNT_ID;

    if (!token)   return res.status(400).json({ error: 'IG_ACCESS_TOKEN not set. Connect Instagram in Settings.' });
    if (!igAccId) return res.status(400).json({ error: 'IG_ACCOUNT_ID not set. Reconnect Instagram in Settings.' });

    const filePath = resolveFilePath(jobId);
    if (!filePath || !fs.existsSync(filePath))
      return res.status(404).json({ error: 'Video file not found. Make sure the job is completed.' });

    // Instagram Reels upload requires a public URL — serve via /files route
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const fileName = path.basename(filePath);
    const videoUrl = `${baseUrl}/files/${fileName}`;
    logger.info(`[IG] Creating reel container for: ${fileName}`);

    // Step 1: Create media container
    const containerBody = new URLSearchParams({
      media_type:   'REELS',
      video_url:    videoUrl,
      caption:      caption,
      access_token: token,
    }).toString();

    const containerResp = await fetchJson(`https://graph.facebook.com/v19.0/${igAccId}/media`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(containerBody) },
      body:    containerBody,
    });

    if (!containerResp.data.id)
      return res.status(502).json({ error: 'Instagram container creation failed', detail: containerResp.data });

    const containerId = containerResp.data.id;
    logger.info(`[IG] Container ID: ${containerId} — waiting for processing...`);

    // Step 2: Poll until container is ready
    let ready = false;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusResp = await fetchJson(
        `https://graph.facebook.com/v19.0/${containerId}?fields=status_code&access_token=${token}`
      );
      const sc = statusResp.data.status_code;
      logger.info(`[IG] Container status poll ${i+1}: ${sc}`);
      if (sc === 'FINISHED') { ready = true; break; }
      if (sc === 'ERROR')    return res.status(502).json({ error: 'Instagram processing failed', detail: statusResp.data });
    }

    if (!ready) return res.status(504).json({ error: 'Instagram processing timeout. Try again later.' });

    // Step 3: Publish
    const publishBody = new URLSearchParams({
      creation_id:  containerId,
      access_token: token,
    }).toString();

    const publishResp = await fetchJson(`https://graph.facebook.com/v19.0/${igAccId}/media_publish`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(publishBody) },
      body:    publishBody,
    });

    if (publishResp.data.id) {
      logger.info(`[IG] Published! Media ID: ${publishResp.data.id}`);
      return res.json({ ok: true, mediaId: publishResp.data.id });
    }
    return res.status(502).json({ error: 'Instagram publish failed', detail: publishResp.data });

  } catch(e) {
    logger.error('[IG] Upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Instagram OAuth
router.get('/instagram/auth', (req, res) => {
  const cfg         = loadConfig();
  const appId       = process.env.IG_APP_ID       || cfg.IG_APP_ID       || process.env.FB_APP_ID || cfg.FB_APP_ID;
  const redirectUri = process.env.IG_REDIRECT_URI || cfg.IG_REDIRECT_URI;
  if (!appId || !redirectUri)
    return res.status(400).send('IG_APP_ID and IG_REDIRECT_URI must be set in Settings first.');
  const scope = 'instagram_basic,instagram_content_publish,pages_read_engagement';
  const url   = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&response_type=code`;
  res.redirect(url);
});

router.get('/instagram/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  const cfg         = loadConfig();
  const appId       = process.env.IG_APP_ID       || cfg.IG_APP_ID       || process.env.FB_APP_ID || cfg.FB_APP_ID;
  const appSecret   = process.env.IG_APP_SECRET   || cfg.IG_APP_SECRET   || process.env.FB_APP_SECRET || cfg.FB_APP_SECRET;
  const redirectUri = process.env.IG_REDIRECT_URI || cfg.IG_REDIRECT_URI;
  try {
    // Exchange code for token
    const tokenBody = new URLSearchParams({
      client_id:     appId,
      client_secret: appSecret,
      redirect_uri:  redirectUri,
      code,
      grant_type:    'authorization_code',
    }).toString();
    const tokenResp = await fetchJson('https://graph.facebook.com/v19.0/oauth/access_token?' + tokenBody);
    if (!tokenResp.data.access_token)
      return res.status(502).send('<h2>❌ Instagram Auth Failed</h2><pre>' + JSON.stringify(tokenResp.data, null, 2) + '</pre>');

    const userToken = tokenResp.data.access_token;

    // Long-lived token
    const longResp = await fetchJson(
      `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${userToken}`
    );
    const longToken = longResp.data.access_token || userToken;

    // Get Instagram Business Account ID
    const meResp = await fetchJson(`https://graph.facebook.com/v19.0/me/accounts?access_token=${longToken}`);
    let igAccountId = null;
    if (meResp.data.data && meResp.data.data.length > 0) {
      for (const page of meResp.data.data) {
        const igResp = await fetchJson(
          `https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token || longToken}`
        );
        if (igResp.data.instagram_business_account) {
          igAccountId = igResp.data.instagram_business_account.id;
          break;
        }
      }
    }

    // Save
    const CONFIG_FILE = process.env.CONFIG_FILE || '/app/data/config.json';
    const current = cfg;
    current.IG_ACCESS_TOKEN = longToken;
    if (igAccountId) current.IG_ACCOUNT_ID = igAccountId;
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2));
    process.env.IG_ACCESS_TOKEN = longToken;
    if (igAccountId) process.env.IG_ACCOUNT_ID = igAccountId;
    logger.info(`[IG] OAuth complete. Account ID: ${igAccountId}`);
    res.send(`<h2>✅ Instagram Connected!</h2><p>Account ID: <b>${igAccountId || 'not found — check Business account'}</b><br>Token saved. Close this tab.</p>`);
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ─────────────────────────────────────────────
// TikTok OAuth — redirect to get access token
// GET /api/upload/tiktok/auth
// ─────────────────────────────────────────────
router.get('/tiktok/auth', (req, res) => {
  const cfg          = loadConfig();
  const clientKey    = process.env.TIKTOK_CLIENT_KEY    || cfg.TIKTOK_CLIENT_KEY;
  const redirectUri  = process.env.TIKTOK_REDIRECT_URI  || cfg.TIKTOK_REDIRECT_URI;

  if (!clientKey || !redirectUri)
    return res.status(400).send('TIKTOK_CLIENT_KEY and TIKTOK_REDIRECT_URI must be set in Settings first.');

  const scope = 'user.info.basic,video.publish,video.upload';
  const url   = `https://www.tiktok.com/v2/auth/authorize/?client_key=${clientKey}&scope=${encodeURIComponent(scope)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=vmixer`;
  res.redirect(url);
});

// GET /api/upload/tiktok/callback?code=...
router.get('/tiktok/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  const cfg         = loadConfig();
  const clientKey   = process.env.TIKTOK_CLIENT_KEY    || cfg.TIKTOK_CLIENT_KEY;
  const clientSecret= process.env.TIKTOK_CLIENT_SECRET || cfg.TIKTOK_CLIENT_SECRET;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI  || cfg.TIKTOK_REDIRECT_URI;

  try {
    const body = new URLSearchParams({
      client_key:    clientKey,
      client_secret: clientSecret,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  redirectUri,
    }).toString();

    const tokenResp = await fetchJson('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      body,
    });

    if (tokenResp.data && tokenResp.data.access_token) {
      // Save token to config
      const { saveConfigFile } = require('./setup');    // reuse helper if exported, else inline
      const current = cfg;
      current.TIKTOK_ACCESS_TOKEN = tokenResp.data.access_token;
      current.TIKTOK_REFRESH_TOKEN = tokenResp.data.refresh_token || '';
      const CONFIG_FILE = process.env.CONFIG_FILE || '/app/data/config.json';
      const pathMod = require('path');
      fs.mkdirSync(pathMod.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2));
      process.env.TIKTOK_ACCESS_TOKEN = tokenResp.data.access_token;
      logger.info('[TT] OAuth complete, access token saved.');
      res.send('<h2>✅ TikTok Connected!</h2><p>Access token saved. You can close this tab and return to VideoMixer.</p>');
    } else {
      res.status(502).send('<h2>❌ TikTok Auth Failed</h2><pre>' + JSON.stringify(tokenResp.data, null, 2) + '</pre>');
    }
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

module.exports = router;

// ═══════════════════════════════════════════════════════════
// TELEGRAM UPLOAD  (Bot API — sendVideo)
// Bot token + channel_id ফ্রন্টএন্ড থেকে পাঠানো হয়
// ═══════════════════════════════════════════════════════════
const FormData = (() => {
  // Node.js built-in (v18+) বা fallback — আমরা manually multipart বানাবো
  return null; // নিচে manual multipart use করা হয়েছে
})();

router.post('/telegram', async (req, res) => {
  try {
    const { jobId, botToken, channelId, caption = '' } = req.body;

    if (!botToken)  return res.status(400).json({ error: 'Bot Token দাও — Settings → Telegram এ অথবা modal এ।' });
    if (!channelId) return res.status(400).json({ error: 'Channel ID দাও। (e.g. -1001234567890)' });

    const filePath = resolveFilePath(jobId);
    if (!filePath || !fs.existsSync(filePath))
      return res.status(404).json({ error: 'ভিডিও ফাইল পাওয়া যায়নি। Job completed কিনা চেক করো।' });

    const fileSize = fs.statSync(filePath).size;
    const fileName = path.basename(filePath);
    logger.info(`[TG] Sending to ${channelId}: ${fileName} (${(fileSize/1024/1024).toFixed(1)} MB)`);

    // Telegram Bot API sendVideo — multipart/form-data
    const boundary = `----TGBoundary${Date.now()}`;

    // Build multipart body
    const metaParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${channelId}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML`,
      `--${boundary}\r\nContent-Disposition: form-data; name="supports_streaming"\r\n\r\ntrue`,
    ].join('\r\n') + `\r\n--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${fileName}"\r\nContent-Type: video/mp4\r\n\r\n`;

    const metaBuf  = Buffer.from(metaParts, 'utf8');
    const closeBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const totalLen = metaBuf.length + fileSize + closeBuf.length;

    const tgResp = await new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: 'api.telegram.org',
        port:     443,
        path:     `/bot${botToken}/sendVideo`,
        method:   'POST',
        headers: {
          'Content-Type':   `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalLen,
        },
      };

      const req2 = https.request(reqOpts, r => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => {
          try { resolve({ status: r.statusCode, data: JSON.parse(body) }); }
          catch(_) { resolve({ status: r.statusCode, data: body }); }
        });
      });
      req2.on('error', reject);

      req2.write(metaBuf);
      const fileStream = fs.createReadStream(filePath);
      fileStream.on('data', chunk => req2.write(chunk));
      fileStream.on('end',  () => { req2.write(closeBuf); req2.end(); });
      fileStream.on('error', reject);
    });

    if (tgResp.data && tgResp.data.ok) {
      const msgId = tgResp.data.result?.message_id;
      logger.info(`[TG] Sent! message_id: ${msgId}`);
      return res.json({ ok: true, messageId: msgId });
    }

    const errDesc = tgResp.data?.description || JSON.stringify(tgResp.data);
    logger.error(`[TG] Failed: ${errDesc}`);
    return res.status(502).json({ error: `Telegram error: ${errDesc}` });

  } catch(e) {
    logger.error('[TG] Upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

