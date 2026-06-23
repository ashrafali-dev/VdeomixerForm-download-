'use strict';
const express = require('express');
const router  = express.Router();
const { createJob, getJob, deleteJob, listJobs } = require('../services/jobManager');

// POST /api/mixer/jobs — create new job
router.post('/jobs', (req, res) => {
  try {
    const { sources, heading, ranking, audioOpts, enableTransition } = req.body;
    if (!Array.isArray(sources) || sources.length === 0)
      return res.status(400).json({ error: 'sources[] required' });
    if (sources.length > 10)
      return res.status(400).json({ error: 'max 10 sources' });
    // Extract URL from mixed text (e.g. Kuaishou share text)
    for (const s of sources) {
      if (!s.url || typeof s.url !== 'string')
        return res.status(400).json({ error: 'each source needs a url' });
      // Pull first URL out of pasted share text
      const m = s.url.trim().match(/https?:\/\/[^\s"'<>]+/);
      s.url = m ? m[0] : s.url.trim();
    }
    const jobId = createJob({ sources, heading, ranking, audioOpts, enableTransition: enableTransition === true });
    res.json({ jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mixer/jobs — list all jobs
router.get('/jobs', (req, res) => res.json(listJobs()));

// GET /api/mixer/jobs/:id — job status
router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json({
    id: job.id, status: job.status,
    error: job.error, result: job.result,
    createdAt: job.createdAt,
    logs: job.logs,
  });
});

// GET /api/mixer/jobs/:id/stream — SSE live logs
router.get('/jobs/:id/stream', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send existing logs
  for (const entry of job.logs) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  if (job.status === 'done' || job.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'close', status: job.status })}\n\n`);
    return res.end();
  }

  const onLog    = entry => res.write(`data: ${JSON.stringify(entry)}\n\n`);
  const onStatus = status => {
    res.write(`data: ${JSON.stringify({ type: 'status', status })}\n\n`);
    if (status === 'done' || status === 'error') {
      cleanup(); res.end();
    }
  };

  job.emitter.on('log',    onLog);
  job.emitter.on('status', onStatus);

  const cleanup = () => {
    job.emitter.off('log',    onLog);
    job.emitter.off('status', onStatus);
  };
  req.on('close', cleanup);
});

// DELETE /api/mixer/jobs/:id
router.delete('/jobs/:id', (req, res) => {
  deleteJob(req.params.id);
  res.json({ ok: true });
});

// GET /api/mixer/duration?url=... — probe video duration via yt-dlp
router.get('/duration', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { spawn } = require('child_process');
    const args = ['--no-warnings', '--skip-download', '--print', '%(duration)s', '--no-playlist', url];
    // Add cookies for YouTube
    const fs = require('fs');
    const COOKIES_FILE = process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt';
    if (/youtube|youtu\.be/i.test(url) && fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100)
      args.push('--cookies', COOKIES_FILE);
    let out = '';
    await new Promise((resolve) => {
      const p = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.on('data', d => out += d.toString());
      p.on('close', resolve);
      setTimeout(() => { try { p.kill(); } catch(_){} resolve(); }, 15000);
    });
    const secs = parseFloat(out.trim());
    if (!secs || isNaN(secs)) return res.json({ duration: null });
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    const fmt = h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${m}:${String(s).padStart(2,'0')}`;
    res.json({ duration: secs, formatted: fmt });
  } catch(e) { res.json({ duration: null }); }
});

module.exports = router;

// POST /api/mixer/voiceover — apply recorded voiceover to merged video
const multer = require('multer');
const upload = multer({ dest: '/tmp/vmixer_vo/', limits: { fileSize: 50*1024*1024 } });
const { spawn } = require('child_process');

router.post('/voiceover', upload.single('voiceover'), async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId || !req.file) return res.status(400).json({ error: 'jobId and voiceover file required' });

    const job = getJob(jobId);
    if (!job || !job.result) return res.status(404).json({ error: 'Job not found or not done' });

    const videoPath = job.result.filePath;
    const audioPath = req.file.path;
    const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';
    const outName = job.result.fileName.replace('.mp4', '_vo.mp4');
    const outPath = require('path').join(OUTPUT_DIR, outName);

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-i', videoPath,
        '-i', audioPath,
        '-map', '0:v',
        '-map', '1:a',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        outPath,
      ];
      const proc = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    });

    try { require('fs').unlinkSync(audioPath); } catch(_) {}
    const sizeBytes = require('fs').statSync(outPath).size;
    res.json({ ok: true, fileName: outName, sizeBytes });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
