'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const fs   = require('fs');
const { downloadVideo, killJob: killDl } = require('./downloader');
const { mergeVideos } = require('./merger');
const { logger } = require('../utils/logger');

const TEMP_DIR   = process.env.TEMP_DIR   || '/tmp/vmixer';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';

// ─── Job store ────────────────────────────────────────────────────
const jobs = new Map();

function makeJobLog(jobId) {
  const logs = [];
  const emit = (level, msg) => {
    const entry = { ts: Date.now(), level, msg: String(msg) };
    logs.push(entry);
    const job = jobs.get(jobId);
    if (job) { job.logs = logs; job.emitter.emit('log', entry); }
  };
  return {
    info:  m => emit('info',  m),
    warn:  m => emit('warn',  m),
    error: m => emit('error', m),
    getLogs: () => logs,
  };
}

// ─── Create job ───────────────────────────────────────────────────
function createJob(params) {
  const jobId = `mix_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const job = {
    id:       jobId,
    status:   'pending',   // pending | downloading | merging | done | error
    params,
    logs:     [],
    result:   null,
    error:    null,
    createdAt: Date.now(),
    emitter:  new EventEmitter(),
  };
  jobs.set(jobId, job);
  setImmediate(() => runJob(jobId));
  return jobId;
}

// ─── Run job ──────────────────────────────────────────────────────
async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  const jobLog = makeJobLog(jobId);
  const workDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const { sources, heading, audioOpts } = job.params;
    // sources: [ { url, startTime?, endTime? }, ... ]

    // ── Phase 1: Download all sources ──
    job.status = 'downloading';
    job.emitter.emit('status', 'downloading');
    jobLog.info(`📥 Downloading ${sources.length} source(s)...`);

    const videoFiles = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      jobLog.info(`\n[${i+1}/${sources.length}] ${src.url}`);
      const result = await downloadVideo(src.url, `${jobId}_${i}`, jobLog, {
        startTime: src.startTime || null,
        endTime:   src.endTime   || null,
      });
      videoFiles.push(result.filePath);
      jobLog.info(`✓ Downloaded: ${result.fileName}`);
    }

    // ── Phase 2: Merge ──
    job.status = 'merging';
    job.emitter.emit('status', 'merging');
    jobLog.info(`\n🎬 Merging ${videoFiles.length} video(s)...`);

    const mergeResult = await mergeVideos({
      videoFiles,
      workDir,
      jobId,
      heading: heading || null,
      audioOpts: audioOpts || { mode: 'original' },
      jobLog,
    });

    job.status = 'done';
    job.result = mergeResult;
    job.emitter.emit('status', 'done');
    jobLog.info(`\n🎉 Job complete! → ${mergeResult.fileName}`);

  } catch (e) {
    job.status = 'error';
    job.error  = e.message;
    job.emitter.emit('status', 'error');
    jobLog.error(`❌ Job failed: ${e.message}`);
    logger.error(`[mixer] job ${jobId} failed`, e);
  }
}

// ─── Public API ───────────────────────────────────────────────────
function getJob(jobId) { return jobs.get(jobId) || null; }

function deleteJob(jobId) {
  killDl(jobId);
  const job = jobs.get(jobId);
  if (job) {
    // cleanup temp
    const workDir = path.join(TEMP_DIR, jobId);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    jobs.delete(jobId);
  }
}

function listJobs() {
  return [...jobs.values()].map(j => ({
    id: j.id, status: j.status, error: j.error,
    result: j.result, createdAt: j.createdAt,
    logCount: j.logs.length,
  }));
}

module.exports = { createJob, getJob, deleteJob, listJobs };
