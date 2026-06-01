'use strict';
// =====================================================================
// VideoMixer — FFmpeg Merger Pipeline
// 1. Each video → 9:16 crop (720x1280)
// 2. Optional heading text overlay (white bold, top)
// 3. Audio: original / mute / mute+loop from URL
// 4. Concat all clips → single output
// =====================================================================

const { spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const https = require('https');

const VIDEO_W  = parseInt(process.env.VIDEO_WIDTH  || '720',  10);
const VIDEO_H  = parseInt(process.env.VIDEO_HEIGHT || '1280', 10);
const PRESET   = process.env.FFMPEG_PRESET || 'ultrafast';
const CRF      = process.env.FFMPEG_CRF    || '23';
const OUTPUT_DIR = process.env.OUTPUT_DIR  || '/app/data/output';

// ─── Helpers ──────────────────────────────────────────────────────
function runFFmpeg(args, jobLog, jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.info(`ffmpeg> ${l}`)));
    proc.stderr.on('data', d => {
      const t = d.toString(); stderr += t;
      t.split(/\r?\n/).forEach(l => {
        if (!l) return;
        if (/time=/.test(l) && onProgress) onProgress(l);
        else if (/error|invalid/i.test(l)) jobLog.error(`ffmpeg> ${l}`);
        else jobLog.info(`ffmpeg> ${l}`);
      });
    });
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}\n${stderr.slice(-500)}`)));
  });
}

// Download audio from URL (YT/any) using yt-dlp audio mode
async function downloadAudioFromUrl(url, dest, jobLog) {
  jobLog.info(`🎵 Downloading audio: ${url}`);
  await new Promise((resolve, reject) => {
    const args = [
      '--no-warnings', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '--no-playlist', '-o', dest, url,
    ];
    if (process.env.YTDLP_PROXY) args.push('--proxy', process.env.YTDLP_PROXY);
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.info(`audio> ${l}`)));
    proc.stderr.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.warn(`audio> ${l}`)));
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`audio download failed (exit ${code})`)));
  });
  // yt-dlp adds .mp3 extension automatically
  const mp3 = dest.endsWith('.mp3') ? dest : dest + '.mp3';
  if (fs.existsSync(mp3)) return mp3;
  // fallback: find any audio file in same dir
  const dir = path.dirname(dest);
  const base = path.basename(dest, path.extname(dest));
  for (const ext of ['.mp3', '.m4a', '.aac', '.opus']) {
    const f = path.join(dir, base + ext);
    if (fs.existsSync(f)) return f;
  }
  throw new Error('Audio file not found after download');
}

// ─── Step 1: Convert single video to 9:16 ────────────────────────
async function convertTo916(inputPath, outputPath, jobLog) {
  // Smart crop: scale to fill 720x1280 then crop center
  const vf = `scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H}`;
  await runFFmpeg([
    '-i', inputPath,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
    '-c:a', 'aac', '-b:a', '128k',
    '-r', '30', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ], jobLog, null);
}

// ─── Step 2: Add heading text overlay ────────────────────────────
// Style: white bold text, top center, semi-transparent bg bar
async function addHeading(inputPath, outputPath, text, position, jobLog) {
  if (!text || !text.trim()) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  const sanitizedText = text.replace(/'/g, "\u2019").replace(/:/g, '\\:');
  const fontPath = '/app/fonts/HindSiliguri-Bold.ttf';
  const fontSize = 52;

  // Y position
  const yMap = { top: '80', center: '(h/2-text_h/2)', bottom: '(h-text_h-80)' };
  const y = yMap[position] || '80';

  // drawtext with background box
  const drawtext = [
    `fontfile=${fontPath}`,
    `text='${sanitizedText}'`,
    `fontsize=${fontSize}`,
    `fontcolor=white`,
    `x=(w-text_w)/2`,
    `y=${y}`,
    `box=1`,
    `boxcolor=black@0.55`,
    `boxborderw=18`,
    `font_bold=1`,
  ].join(':');

  await runFFmpeg([
    '-i', inputPath,
    '-vf', `drawtext=${drawtext}`,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ], jobLog, null);
}

// ─── Step 3: Concat all clips ─────────────────────────────────────
async function concatClips(clipPaths, outputPath, jobLog) {
  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], outputPath);
    return;
  }

  const concatFile = outputPath + '.concat.txt';
  fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));

  await runFFmpeg([
    '-f', 'concat', '-safe', '0',
    '-i', concatFile,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ], jobLog, null);

  try { fs.unlinkSync(concatFile); } catch (_) {}
}

// ─── Step 4: Apply audio settings ────────────────────────────────
async function applyAudio(inputPath, outputPath, audioOpts, workDir, jobLog) {
  const { mode, audioUrl } = audioOpts;
  // mode: 'original' | 'mute' | 'audio_url'

  if (mode === 'original') {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  if (mode === 'mute') {
    await runFFmpeg([
      '-i', inputPath,
      '-c:v', 'copy', '-an',
      outputPath,
    ], jobLog, null);
    return;
  }

  if (mode === 'audio_url' && audioUrl) {
    const audioDest = path.join(workDir, 'bg_audio');
    const audioFile = await downloadAudioFromUrl(audioUrl, audioDest, jobLog);

    // Get durations
    const getDuration = (filePath) => {
      try {
        const { execSync } = require('child_process');
        const out = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`).toString().trim();
        return parseFloat(out) || 0;
      } catch (_) { return 0; }
    };

    const videoDuration = getDuration(inputPath);
    const audioDuration = getDuration(audioFile);
    jobLog.info(`📹 Video: ${videoDuration.toFixed(1)}s | 🎵 Audio: ${audioDuration.toFixed(1)}s`);

    let ffmpegArgs;
    if (audioDuration > 0 && audioDuration < videoDuration) {
      // Audio SHORTER → loop করো
      jobLog.info(`🔁 Audio shorter — looping to fill ${videoDuration.toFixed(1)}s`);
      ffmpegArgs = [
        '-i', inputPath,
        '-stream_loop', '-1', '-i', audioFile,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-t', String(videoDuration),
        '-movflags', '+faststart', outputPath,
      ];
    } else {
      // Audio LONGER বা equal → cut করো video duration এ
      jobLog.info(`✂️ Audio longer/equal — cutting at ${videoDuration.toFixed(1)}s`);
      ffmpegArgs = [
        '-i', inputPath, '-i', audioFile,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-movflags', '+faststart', outputPath,
      ];
    }

    await runFFmpeg(ffmpegArgs, jobLog, null);
    return;
  }

  // Fallback: copy
  fs.copyFileSync(inputPath, outputPath);
}

// ─── Main merge pipeline ──────────────────────────────────────────
async function mergeVideos({ videoFiles, workDir, jobId, heading, audioOpts, jobLog }) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const steps = videoFiles.length * 2 + 2; // crop + heading + concat + audio
  let step = 0;
  const progress = () => jobLog.info(`[merge] step ${++step}/${steps}`);

  // Step 1: Convert each video to 9:16
  const croppedPaths = [];
  for (let i = 0; i < videoFiles.length; i++) {
    const cropped = path.join(workDir, `cropped_${i}.mp4`);
    jobLog.info(`📐 Cropping ${i + 1}/${videoFiles.length} to 9:16...`);
    await convertTo916(videoFiles[i], cropped, jobLog);
    croppedPaths.push(cropped);
    progress();
  }

  // Step 2: Add heading overlay to each
  const headedPaths = [];
  for (let i = 0; i < croppedPaths.length; i++) {
    const headed = path.join(workDir, `headed_${i}.mp4`);
    if (heading && heading.text && heading.text.trim()) {
      jobLog.info(`📝 Adding heading ${i + 1}/${croppedPaths.length}...`);
      await addHeading(croppedPaths[i], headed, heading.text, heading.position || 'top', jobLog);
    } else {
      fs.copyFileSync(croppedPaths[i], headed);
    }
    headedPaths.push(headed);
    progress();
  }

  // Step 3: Concat
  const concatPath = path.join(workDir, `concat.mp4`);
  jobLog.info(`🔗 Concatenating ${headedPaths.length} clips...`);
  await concatClips(headedPaths, concatPath, jobLog);
  progress();

  // Step 4: Audio
  const timestamp = Date.now();
  const finalName = `merged_${jobId}_${timestamp}.mp4`;
  const finalPath = path.join(OUTPUT_DIR, finalName);
  jobLog.info(`🎵 Applying audio (mode: ${audioOpts?.mode || 'original'})...`);
  await applyAudio(concatPath, finalPath, audioOpts || { mode: 'original' }, workDir, jobLog);
  progress();

  const sizeBytes = fs.statSync(finalPath).size;
  jobLog.info(`✅ Merge complete! (${(sizeBytes/1024/1024).toFixed(2)} MB) → ${finalName}`);
  return { filePath: finalPath, fileName: finalName, sizeBytes };
}

module.exports = { mergeVideos, convertTo916, addHeading };
