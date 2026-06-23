'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const fs   = require('fs');
const { downloadVideo, killJob: killDl } = require('./downloader');
const { mergeVideos } = require('./merger');
const { logger } = require('../utils/logger');

const TEMP_DIR   = process.env.TEMP_DIR   || '/tmp/vmixer';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';
const DATA_DIR   = process.env.DATA_DIR   || '/app/data';
const JOBS_FILE  = path.join(DATA_DIR, 'jobs.json');

// ─── Job store ────────────────────────────────────────────────────
const jobs = new Map();

// ─── Persistence helpers ──────────────────────────────────────────
function persistJobs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const serializable = [...jobs.values()]
      .filter(j => j.status === 'done' || j.status === 'error')
      .map(j => ({
        id: j.id, status: j.status, params: j.params,
        result: j.result, error: j.error, createdAt: j.createdAt,
        logs: j.logs.slice(-50), // keep last 50 log lines
      }));
    fs.writeFileSync(JOBS_FILE, JSON.stringify(serializable, null, 2));
  } catch (e) { logger.warn('[jobManager] persist failed: ' + e.message); }
}

function loadPersistedJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    for (const j of data) {
      // Only restore done/error jobs — don't re-run old pending/merging jobs
      if (j.status !== 'done' && j.status !== 'error') continue;
      // Verify output file still exists for done jobs
      if (j.status === 'done' && j.result?.filePath && !fs.existsSync(j.result.filePath)) continue;
      const job = {
        id: j.id, status: j.status, params: j.params,
        result: j.result, error: j.error, createdAt: j.createdAt,
        logs: j.logs || [],
        emitter: new EventEmitter(),
      };
      jobs.set(j.id, job);
    }
    logger.info(`[jobManager] restored ${jobs.size} jobs from disk`);
  } catch (e) { logger.warn('[jobManager] load failed: ' + e.message); }
}

// Load on startup
loadPersistedJobs();

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
    const { sources, heading, ranking, audioOpts, enableTransition } = job.params;
    // sources: [ { url, rankTitle?, startTime?, endTime?, speed? }, ... ]

    // ── Phase 1: Download all sources ──
    job.status = 'downloading';
    job.emitter.emit('status', 'downloading');
    jobLog.info(`📥 Downloading ${sources.length} source(s)...`);

    const videoFiles = [];
    const speeds = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      jobLog.info(`\n[${i+1}/${sources.length}] ${src.url}`);
      const result = await downloadVideo(src.url, `${jobId}_${i}`, jobLog, {
        startTime: src.startTime || null,
        endTime:   src.endTime   || null,
      });
      videoFiles.push(result.filePath);
      speeds.push(parseFloat(src.speed) || 1);
      jobLog.info(`✓ Downloaded: ${result.fileName}`);
    }

    // Optional ranking playback order
    let orderedSources = sources.slice();
    let orderedFiles = videoFiles.slice();
    let orderedSpeeds = speeds.slice();
    if (ranking && ranking.enabled && ranking.direction === 'countdown') {
      orderedSources = orderedSources.slice().reverse();
      orderedFiles = orderedFiles.slice().reverse();
      orderedSpeeds = orderedSpeeds.slice().reverse();
      jobLog.info('🏆 Ranking mode: countdown order enabled (#N → #1)');
    } else if (ranking && ranking.enabled) {
      jobLog.info('🏆 Ranking mode: normal order enabled (#1 → #N)');
    }

    // ── Phase 2: Merge ──
    job.status = 'merging';
    job.emitter.emit('status', 'merging');
    jobLog.info(`\n🎬 Merging ${orderedFiles.length} video(s)...`);

    const mergeResult = await mergeVideos({
      videoFiles: orderedFiles,
      sourcesMeta: orderedSources,
      workDir,
      jobId,
      heading: heading || null,
      ranking: ranking || null,
      audioOpts: audioOpts || { mode: 'original' },
      speeds: orderedSpeeds,
      enableTransition: enableTransition === true,
      jobLog,
    });

    job.status = 'done';
    job.result = mergeResult;
    job.emitter.emit('status', 'done');
    jobLog.info(`\n🎉 Job complete! → ${mergeResult.fileName}`);
    persistJobs();

  } catch (e) {
    job.status = 'error';
    job.error  = e.message;
    job.emitter.emit('status', 'error');
    jobLog.error(`❌ Job failed: ${e.message}`);
    logger.error(`[mixer] job ${jobId} failed`, e);
    persistJobs();
  }
}

// ─── Public API ───────────────────────────────────────────────────
function getJob(jobId) { return jobs.get(jobId) || null; }

function deleteJob(jobId) {
  killDl(jobId);
  const job = jobs.get(jobId);
  if (job) {
    const workDir = path.join(TEMP_DIR, jobId);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    jobs.delete(jobId);
    persistJobs();
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
