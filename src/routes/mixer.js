'use strict';
const express = require('express');
const router  = express.Router();
const { createJob, getJob, deleteJob, listJobs } = require('../services/jobManager');

// POST /api/mixer/jobs — create new job
router.post('/jobs', (req, res) => {
  try {
    const { sources, heading, audioOpts } = req.body;
    if (!Array.isArray(sources) || sources.length === 0)
      return res.status(400).json({ error: 'sources[] required' });
    if (sources.length > 10)
      return res.status(400).json({ error: 'max 10 sources' });
    for (const s of sources) {
      if (!s.url || typeof s.url !== 'string')
        return res.status(400).json({ error: 'each source needs a url' });
    }
    const jobId = createJob({ sources, heading, audioOpts });
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

module.exports = router;
