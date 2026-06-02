'use strict';
const router  = require('express').Router();
const path    = require('path');
const fs      = require('fs');
const { uploadFile, extractFolderId } = require('../services/drive');
const { getJob } = require('../services/jobManager');
const { logger } = require('../utils/logger');

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';

function requireAuth(req, res, next) {
  if (!req.session.googleTokens)
    return res.status(401).json({ error: 'Not authenticated. Go to /auth/google first.' });
  next();
}

router.post('/upload', requireAuth, async (req, res) => {
  try {
    const { jobId, folderUrl } = req.body || {};
    if (!jobId)     return res.status(400).json({ error: 'jobId required' });
    if (!folderUrl) return res.status(400).json({ error: 'folderUrl required' });

    const folderId = extractFolderId(folderUrl);
    if (!folderId) return res.status(400).json({ error: 'Cannot parse Drive folder ID from URL' });

    const job = getJob(jobId);
    if (!job)   return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done' || !job.result)
      return res.status(400).json({ error: 'Job not done yet' });

    const filePath = job.result.filePath;
    const fileName = job.result.fileName;

    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: 'Output file not found on disk' });

    const r = await uploadFile(req.session.googleTokens, filePath, folderId, fileName, '');
    res.json({ ok: true, id: r.id, name: r.name, link: r.webViewLink });

  } catch (e) {
    logger.error('Drive upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
