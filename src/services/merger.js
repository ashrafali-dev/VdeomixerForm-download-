```javascript
'use strict';
// =====================================================================
// VideoMixer — FFmpeg Merger Pipeline
// 1. Each video → 9:16 crop (720x1280)
// 2. Optional heading OR ranking overlay
// 3. Audio: original / mute / mute+loop from URL
// 4. Concat all clips → single output
// =====================================================================

const { spawn, spawnSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const { renderTitlePng } = require('./titleRenderer');

function hexToRgba(hex) {
  try {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c+c).join('');
    const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
    return [r, g, b, 255];
  } catch { return null; }
}

const VIDEO_W  = parseInt(process.env.VIDEO_WIDTH  || '720',  10);
const VIDEO_H  = parseInt(process.env.VIDEO_HEIGHT || '1280', 10);
const PRESET   = process.env.FFMPEG_PRESET || 'ultrafast';
const CRF      = process.env.FFMPEG_CRF    || '23';
const OUTPUT_DIR = process.env.OUTPUT_DIR  || '/app/data/output';
const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');

// ─── Helpers ──────────────────────────────────────────────────────
function runFFmpeg(args, jobLog, jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.info('ffmpeg> ' + l)));    proc.stderr.on('data', d => {
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

const COOKIES_FILE = process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt';
const TIKTOK_COOKIES_FILE = process.env.TIKTOK_COOKIES_FILE || '/app/data/cookies/tiktok_cookies.txt';

function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/i.test(url);
}
function isTikTokUrl(url) {
  return /tiktok\.com|vm\.tiktok\.com/i.test(url);
}

function pickBengaliFont(weight = 'bold') {
  const candidates = weight === 'bold' ? [
    path.join(FONT_DIR, 'HindSiliguri-Bold.ttf'),
    path.join(FONT_DIR, 'NotoSansBengali-Bold.ttf'),
    path.join(FONT_DIR, 'HindSiliguri-Regular.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Bold.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf',
  ] : [
    path.join(FONT_DIR, 'HindSiliguri-Regular.ttf'),
    path.join(FONT_DIR, 'NotoSansBengali-Regular.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const sys = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  if (fs.existsSync(sys)) return sys;
  throw new Error('No Bengali font available');
}

function pickEmojiFont() {
  const candidates = [
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/truetype/NotoColorEmoji.ttf',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// Download audio from URL (YT/any) using yt-dlp audio mode
async function downloadAudioFromUrl(url, dest, jobLog) {
  jobLog.info(`🎵 Downloading audio: ${url}`);
  await new Promise((resolve, reject) => {
    const args = [
      '--no-warnings', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '--no-playlist',
      '--retries', '5', '--socket-timeout', '60',
      '-o', dest, url,
    ];
    if (isYouTubeUrl(url)) {
      if (fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100)
        args.push('--cookies', COOKIES_FILE);
      if (process.env.YTDLP_PROXY)
        args.push('--proxy', process.env.YTDLP_PROXY);
    }
    if (isTikTokUrl(url)) {
      if (fs.existsSync(TIKTOK_COOKIES_FILE) && fs.statSync(TIKTOK_COOKIES_FILE).size > 100)
        args.push('--cookies', TIKTOK_COOKIES_FILE);
    }
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.info(`audio> ${l}`)));
    proc.stderr.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.warn(`audio> ${l}`)));
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`audio download failed (exit ${code})`)));
  });
  const mp3 = dest.endsWith('.mp3') ? dest : dest + '.mp3';
  if (fs.existsSync(mp3)) return mp3;
  const dir = path.dirname(dest);
  const base = path.basename(dest, path.extname(dest));
  for (const ext of ['.mp3', '.m4a', '.aac', '.opus']) {
    const f = path.join(dir, base + ext);
    if (fs.existsSync(f)) return f;
  }
  throw new Error('Audio file not found after download');
}

// ─── Step 1: Convert single video to 9:16 ────────────────────────
async function convertTo916(inputPath, outputPath, jobLog, speed = 1) {
  const vf = `scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H}`;
  let vfFull = vf;
  let audioFilter = null;
  if (speed && speed !== 1) {
    const s = parseFloat(speed);
    vfFull = `${vf},setpts=${(1/s).toFixed(4)}*PTS`;
    if (s <= 2) audioFilter = `atempo=${s}`;
    else audioFilter = `atempo=2.0,atempo=${(s/2).toFixed(4)}`;
  }
  const ffArgs = [
    '-i', inputPath,
    '-vf', vfFull,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
  ];
  if (audioFilter) ffArgs.push('-af', audioFilter, '-c:a', 'aac', '-b:a', '128k');
  else ffArgs.push('-c:a', 'aac', '-b:a', '128k');
  ffArgs.push('-r', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath);
  await runFFmpeg(ffArgs, jobLog, null);
}

// ─── Heading renderers ────────────────────────────────────────────
async function addHeadingLegacy(inputPath, outputPath, text, position, fontSize, jobLog) {
  const sanitizedText = String(text).replace(/'/g, '\u2019').replace(/:/g, '\\:');
  const fontPath = pickBengaliFont('bold');
  const yMap = { top: '80', center: '(h/2-text_h/2)', bottom: '(h-text_h-80)' };
  const y = yMap[position] || '80';
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
  ].join(':');

  await runFFmpeg([
    '-i', inputPath,
    '-vf', `drawtext=${drawtext}`,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ], jobLog, null);
}

async function addHeading(inputPath, outputPath, heading, jobLog) {
  const text = typeof heading === 'string' ? heading : heading?.text;
  if (!text || !String(text).trim()) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  const position = (typeof heading === 'object' && heading?.position) || 'top';
  const parsedFontSize = parseInt(typeof heading === 'object' ? heading?.fontSize : '', 10);
  const fontSize = Number.isFinite(parsedFontSize) ? Math.max(24, Math.min(96, parsedFontSize)) : 52;
  const platform = (typeof heading === 'object' && heading?.platform) || 'youtube';

  // Safe zone top padding per platform (720×1280 canvas, scaled from 1080×1920)
  const platformSafeTop = {
    tiktok:    107,
    instagram: 147,
    facebook:  147,
    youtube:   253,
  };
  const platformSafeBottom = {
    tiktok:    320,
    instagram: 280,
    facebook:  280,
    youtube:   253,
  };
  const safeTop    = platformSafeTop[platform]    ?? 253;
  const safeBottom = platformSafeBottom[platform] ?? 253;

  const yMap = {
    top:    String(safeTop),
    center: '(main_h-overlay_h)/2',
    bottom: `(main_h-overlay_h-${safeBottom})`,
  };
  const y = yMap[position] || String(safeTop);

  const titlePng = path.join(path.dirname(outputPath), `heading_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const canvasW = Math.max(420, VIDEO_W - 60);
  const canvasH = Math.max(120, Math.min(260, Math.round(fontSize * 3.8)));

  try {
    const showBg      = heading?.showBg !== false;
    const accentHex   = heading?.accentColor || null;
    const accentColor = accentHex ? hexToRgba(accentHex) : null;

    renderTitlePng({
      text: String(text).trim(),
      width: canvasW,
      height: canvasH,
      fontSize,
      minFontSize: 20,
      maxLines: 4,
      paddingX: 28,
      paddingY: 18,
      lineHeightRatio: 1.22,
      outPath: titlePng,
      fg: [255, 255, 255, 255],
      bg: [0, 0, 0, 145],
      shadow: showBg ? [0, 0, 0, 180, 2, 2] : null,
      fontWeight: 'bold',
      showBg,
      accentColor,
    });

    await runFFmpeg([
      '-i', inputPath,
      '-i', titlePng,
      '-filter_complex', `[0:v][1:v]overlay=x=(main_w-overlay_w)/2:y=${y}:format=auto[v]`,
      '-map', '[v]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ], jobLog, null);
  } catch (err) {
    jobLog.warn(`PNG heading renderer failed, using legacy drawtext fallback: ${err.message}`);
    await addHeadingLegacy(inputPath, outputPath, String(text).trim(), position, fontSize, jobLog);
  } finally {
    try { if (fs.existsSync(titlePng)) fs.unlinkSync(titlePng); } catch (_) {}
  }
}

// ─── Python Ranking Renderer (FIXED: smaller fonts, outline, pro mode with thumbnails) ───
const PY_RANKING_RENDERER = String.raw`
import sys, json, unicodedata
from PIL import Image, ImageDraw, ImageFont

cfg = json.loads(sys.argv[1])
W = int(cfg['width'])
H = int(cfg['height'])
preset = cfg.get('preset', 'left_list')
current_rank = int(cfg.get('current_rank', 1))
total_ranks = max(1, int(cfg.get('total_ranks', 1)))
title = str(cfg.get('title') or '').strip()
global_title = str(cfg.get('global_title') or '').strip()
accent_color_hex = str(cfg.get('accent_color') or '#22c55e').strip()
font_path = cfg['font_path']

def hex_to_rgba(h):
    try:
        h = h.lstrip('#')
        if len(h) == 3: h = ''.join(c*2 for c in h)
        r,g,b = int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)
        return (r,g,b,255)
    except Exception:
        return (34,197,94,255)

emoji_font_path = cfg.get('emoji_font_path')

def _detect_layout(fp):
    basic = ImageFont.Layout.BASIC if hasattr(ImageFont, 'Layout') else (ImageFont.LAYOUT_BASIC if hasattr(ImageFont, 'LAYOUT_BASIC') else 0)
    raqm  = ImageFont.Layout.RAQM  if hasattr(ImageFont, 'Layout') else (ImageFont.LAYOUT_RAQM  if hasattr(ImageFont, 'LAYOUT_RAQM')  else None)
    if raqm is None:
        return basic
    try:
        f = ImageFont.truetype(fp, 20, layout_engine=raqm)
        tmp = Image.new('RGBA', (200, 40))
        d   = ImageDraw.Draw(tmp)
        bb  = d.textbbox((0, 0), '\u09ac\u09be\u0982\u09b2\u09be', font=f)
        if bb[2] - bb[0] < 120:
            return raqm
        return basic
    except Exception:
        return basic

layout = _detect_layout(font_path)
emoji_layout = ImageFont.Layout.BASIC if hasattr(ImageFont, 'Layout') else (ImageFont.LAYOUT_BASIC if hasattr(ImageFont, 'LAYOUT_BASIC') else 0)

img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Font sizes
num_size = 50
active_num_size = 60
small_num_size = 50
active_title_size = 30
badge_title_size = 32
global_title_size = 40

num_font = ImageFont.truetype(font_path, num_size, layout_engine=layout)
active_num_font = ImageFont.truetype(font_path, active_num_size, layout_engine=layout)
small_num_font = ImageFont.truetype(font_path, small_num_size, layout_engine=layout)
active_title_font = ImageFont.truetype(font_path, active_title_size, layout_engine=layout)
badge_title_font = ImageFont.truetype(font_path, badge_title_size, layout_engine=layout)

def make_global_title_font(size):
    return ImageFont.truetype(font_path, size, layout_engine=layout)

EMOJI_NATIVE_SIZE = 109

def make_emoji_font():
    if not emoji_font_path: return None
    try:
        return ImageFont.truetype(emoji_font_path, EMOJI_NATIVE_SIZE, layout_engine=emoji_layout)
    except Exception:
        return None

emoji_font_obj = make_emoji_font()
emoji_font = emoji_font_obj
badge_emoji_font = emoji_font_obj

def is_emoji(ch):
    try:
        cat = unicodedata.category(ch)
        cp = ord(ch)
        return cat in ('So', 'Sm') or (0x1F000 <= cp <= 0x1FFFF) or (0x2600 <= cp <= 0x27BF) or cp in (0xFE0F, 0x200D)
    except Exception:
        return False

def render_emoji_to_img(seq, target_size, emoji_font_obj):
    try:
        kwargs = {'embedded_color': True} if hasattr(ImageFont, 'Layout') else {}
        tmp_d = ImageDraw.Draw(Image.new('RGBA',(10,10)))
        bb = tmp_d.textbbox((0,0), seq, font=emoji_font_obj, **kwargs)
        
        ew = max(1, bb[2]-bb[0])
        eh = max(1, bb[3]-bb[1])
        tmp_e = Image.new('RGBA', (ew + 20, eh + 20), (0,0,0,0))
        de = ImageDraw.Draw(tmp_e)
        de.text((-bb[0]+10, -bb[1]+10), seq, font=emoji_font_obj, **kwargs)
        
        scale = target_size / max(1, eh)
        new_w = max(1, int(ew * scale))
        new_h = max(1, int(target_size))
        resample_method = Image.Resampling.LANCZOS if hasattr(Image, 'Resampling') else Image.LANCZOS
        return tmp_e.resize((new_w + 20, new_h + 20), resample_method), new_w
    except Exception:
        return None, 0

def draw_text_with_outline(draw, cx, y, seq, font, fill):
    stroke_width = 3
    for dx in range(-stroke_width, stroke_width + 1):
        for dy in range(-stroke_width, stroke_width + 1):
            if dx*dx + dy*dy <= stroke_width*stroke_width:
                draw.text((cx + dx, y + dy), seq, font=font, fill=(0, 0, 0, 255))
    draw.text((cx, y), seq, font=font, fill=fill)

def draw_text_with_emoji(draw, x, y, text, main_font, emoji_font_obj, fill, use_outline=True):
    try:
        sample_bb = draw.textbbox((0,0), 'A', font=main_font)
        target_h = max(16, sample_bb[3] - sample_bb[1])
    except Exception:
        target_h = 32
    cx = x
    i = 0
    while i < len(text):
        ch = text[i]
        seq = ch
        j = i + 1
        while j < len(text) and text[j] in ('\uFE0F', '\u200D'):
            seq += text[j]
            j += 1
        if j < len(text) and is_emoji(text[j]) and '\u200D' in seq:
            while j < len(text) and (text[j] in ('\uFE0F', '\u200D') or is_emoji(text[j])):
                seq += text[j]
                j += 1
        use_emoji = emoji_font_obj and any(is_emoji(c) for c in seq)
        if use_emoji:
            emoji_img, ew = render_emoji_to_img(seq, target_h, emoji_font_obj)
            if emoji_img:
                draw._image.paste(emoji_img, (int(cx), int(y-4)), emoji_img)
                cx += ew + 4
                i = j
                continue
        if use_outline:
            draw_text_with_outline(draw, cx, y, seq, main_font, fill)
        else:
            draw.text((cx, y), seq, font=main_font, fill=fill)
        bb = draw.textbbox((0, 0), seq, font=main_font)
        cx += bb[2] - bb[0] + 1
        i = j

def wrap_text_px(text, font, max_w):
    tmp_img = Image.new('RGBA', (max_w * 2 + 100, 100))
    tmp_draw = ImageDraw.Draw(tmp_img)
    words = text.split()
    if not words: return []
    lines = []
    cur = []
    for w in words:
        candidate = ' '.join(cur + [w])
        bb = tmp_draw.textbbox((0, 0), candidate, font=font)
        if bb[2] - bb[0] <= max_w or not cur:
            cur.append(w)
        else:
            lines.append(' '.join(cur))
            cur = [w]
    if cur: lines.append(' '.join(cur))
    return lines

def render_global_title(draw, text, max_w, start_font_size, min_size, y_start, emoji_f):
    fs = start_font_size
    while fs >= min_size:
        f = make_global_title_font(fs)
        ef = None
        if emoji_font_path:
            try: ef = ImageFont.truetype(emoji_font_path, fs, layout_engine=emoji_layout)
            except Exception: ef = emoji_f
        lines = wrap_text_px(text, f, max_w)[:3]
        lh = int(fs * 1.35)
        tmp_img2 = Image.new('RGBA', (max_w + 100, 60))
        tmp_d2 = ImageDraw.Draw(tmp_img2)
        fits = all(tmp_d2.textbbox((0,0), ln, font=f)[2] - tmp_d2.textbbox((0,0), ln, font=f)[0] <= max_w for ln in lines)
        if fits: return f, ef, lines, lh, y_start
        fs -= 1
    f = make_global_title_font(min_size)
    lines = wrap_text_px(text, f, max_w)[:3]
    lh = int(min_size * 1.35)
    return f, emoji_f, lines, lh, y_start

white = (255, 255, 255, 255)
list_colors = [
    (255, 72, 72, 255),
    (255, 165, 0, 255),
    (255, 215, 0, 255),
    (0, 191, 255, 255),
    (50, 205, 50, 255),
    (255, 105, 180, 255),
    (147, 112, 219, 255)
]

title_bottom_y = 0
if global_title:
    pad_x = 32
    pad_y = 140
    max_text_w = W - pad_x * 2
    accent_rgba = hex_to_rgba(accent_color_hex)

    if '|' in global_title:
        part1, part2 = global_title.split('|', 1)
        part1 = part1.strip()
        part2 = part2.strip()
    else:
        part1 = global_title
        part2 = None

    gt_font, gt_ef, _, gt_lh, _ = render_global_title(
        draw, global_title.replace('|', ' '), max_text_w, global_title_size, 26, pad_y, emoji_font
    )

    cy = pad_y
    for part_text, part_color in [(part1, (255,255,255,255)), (part2, accent_rgba)]:
        if not part_text:
            continue
        _, _, gt_lines, _, _ = render_global_title(
            draw, part_text, max_text_w, global_title_size, 26, pad_y, emoji_font
        )
        for ln in gt_lines:
            tmp2 = Image.new('RGBA', (W + 100, gt_lh + 10))
            td2  = ImageDraw.Draw(tmp2)
            bb = td2.textbbox((0, 0), ln, font=gt_font)
            lw = bb[2] - bb[0]
            lx = max(pad_x, (W - lw) // 2 - bb[0])
            draw_text_with_emoji(draw, lx, cy - bb[1], ln, gt_font, gt_ef, part_color, use_outline=True)
            cy += gt_lh
    title_bottom_y = cy + 10

if preset == 'current_badge':
    badge_top = title_bottom_y + 18
    draw.rounded_rectangle((18, badge_top, W - 18, badge_top + 166), radius=28, fill=(0, 0, 0, 135))
    draw_text_with_emoji(draw, 46, badge_top + 36, f'{current_rank}.', small_num_font, badge_emoji_font, list_colors[current_rank % len(list_colors)], use_outline=True)
    if title:
        lines = wrap_text_px(title, badge_title_font, W - 176)[:2]
        ty = badge_top + 32
        for line in lines:
            draw_text_with_emoji(draw, 165, ty, line, badge_title_font, badge_emoji_font, white, use_outline=True)
            ty += 56
elif preset == 'left_list':
    list_top = title_bottom_y + 14
    start_y = list_top + (110 if total_ranks <= 5 else 90)
    gap = 75 if total_ranks <= 5 else 60
    
    tmp_measure = Image.new('RGBA', (200, 100))
    tmp_d = ImageDraw.Draw(tmp_measure)
    max_num_w = 0
    for r in range(1, total_ranks + 1):
        f_ = active_num_font if r == current_rank else num_font
        bb_ = tmp_d.textbbox((0, 0), f'{r}.', font=f_)
        max_num_w = max(max_num_w, bb_[2] - bb_[0])
    num_x = 32
    title_x = num_x + max_num_w + 16

    for rank in range(1, total_ranks + 1):
        y = start_y + (rank - 1) * gap
        is_active = rank == current_rank
        font = active_num_font if is_active else num_font
        color_idx = (rank - 1) % len(list_colors)
        num_fill = list_colors[color_idx]
        
        draw_text_with_emoji(draw, num_x, y, f'{rank}.', font, emoji_font, num_fill, use_outline=True)
        if is_active and title:
            lines = wrap_text_px(title, active_title_font, W - title_x - 16)[:2]
            ty = y + 15
            for line in lines:
                draw_text_with_emoji(draw, title_x, ty, line, active_title_font, emoji_font, white, use_outline=True)
                ty += 40

elif preset == 'pro_ranking':
    # ── Pro Ranking Overlay ──────────────────────────────────────────
    thumbnail_paths = cfg.get('thumbnail_paths') or []

    def make_rounded_mask(size, radius):
        mask = Image.new('L', size, 0)
        md = ImageDraw.Draw(mask)
        md.rounded_rectangle([(0,0),(size[0]-1,size[1]-1)], radius=radius, fill=255)
        return mask

    def draw_gradient_rect(target_img, x0, y0, x1, y1, color_top, color_bot):
        h = max(1, y1 - y0)
        w = max(1, x1 - x0)
        grad = Image.new('RGBA', (w, h))
        for row in range(h):
            t = row / h
            r_ = int(color_top[0] + (color_bot[0]-color_top[0])*t)
            g_ = int(color_top[1] + (color_bot[1]-color_top[1])*t)
            b_ = int(color_top[2] + (color_bot[2]-color_top[2])*t)
            a_ = int(color_top[3] + (color_bot[3]-color_top[3])*t)
            for col in range(w):
                grad.putpixel((col, row), (r_, g_, b_, a_))
        target_img.paste(grad, (x0, y0), grad)

    accent_rgba = hex_to_rgba(accent_color_hex)
    accent_glow = (accent_rgba[0], accent_rgba[1], accent_rgba[2], 60)

    pro_gt_size   = 46
    pro_num_size  = 54
    pro_act_size  = 62
    pro_ttl_size  = 28
    pro_act_ttl_size = 34

    pro_num_font     = ImageFont.truetype(font_path, pro_num_size,     layout_engine=layout)
    pro_act_num_font = ImageFont.truetype(font_path, pro_act_size,     layout_engine=layout)
    pro_ttl_font     = ImageFont.truetype(font_path, pro_ttl_size,     layout_engine=layout)
    pro_act_ttl_font = ImageFont.truetype(font_path, pro_act_ttl_size, layout_engine=layout)

    gt_pad_x  = 30
    gt_pad_y  = 120
    gt_max_w  = W - gt_pad_x * 2
    gt_fs     = pro_gt_size
    gt_min_fs = 26

    while gt_fs >= gt_min_fs:
        gf = ImageFont.truetype(font_path, gt_fs, layout_engine=layout)
        test_lines = wrap_text_px(global_title.replace('|',' '), gf, gt_max_w)[:3]
        tmp3 = Image.new('RGBA', (gt_max_w+100, 60))
        td3  = ImageDraw.Draw(tmp3)
        if all(td3.textbbox((0,0),ln,font=gf)[2]-td3.textbbox((0,0),ln,font=gf)[0] <= gt_max_w for ln in test_lines):
            break
        gt_fs -= 1

    gt_font = ImageFont.truetype(font_path, gt_fs, layout_engine=layout)
    gt_ef   = None
    if emoji_font_path:
        try: gt_ef = ImageFont.truetype(emoji_font_path, gt_fs, layout_engine=emoji_layout)
        except: gt_ef = emoji_font_obj

    gt_lh = int(gt_fs * 1.35)

    if '|' in global_title:
        gt_p1, gt_p2 = global_title.split('|', 1)
        gt_p1 = gt_p1.strip(); gt_p2 = gt_p2.strip()
    else:
        gt_p1 = global_title; gt_p2 = None

    gt_parts = [(gt_p1, (255,255,255,255))]
    if gt_p2:
        gt_parts.append((gt_p2, accent_rgba))

    all_gt_lines = []
    for pt, _ in gt_parts:
        all_gt_lines += wrap_text_px(pt, gt_font, gt_max_w)[:3]
    gt_total_h = len(all_gt_lines) * gt_lh

    strip_pad = 22
    strip_top    = gt_pad_y - strip_pad
    strip_bottom = gt_pad_y + gt_total_h + strip_pad + 10
    draw_gradient_rect(img, 0, strip_top, W, strip_bottom,
                       (0,0,0,185), (0,0,0,120))

    cy_gt = gt_pad_y
    for pt_text, pt_color in gt_parts:
        if not pt_text: continue
        pt_lines = wrap_text_px(pt_text, gt_font, gt_max_w)[:3]
        for ln in pt_lines:
            tmp4 = Image.new('RGBA',(W+100, gt_lh+10))
            td4  = ImageDraw.Draw(tmp4)
            bb4  = td4.textbbox((0,0), ln, font=gt_font)
            lw4  = bb4[2]-bb4[0]
            lx4  = max(gt_pad_x, (W-lw4)//2 - bb4[0])
            draw_text_with_emoji(draw, lx4, cy_gt - bb4[1], ln, gt_font, gt_ef, pt_color, use_outline=True)
            cy_gt += gt_lh

    title_bottom_y = strip_bottom + 12

    THUMB_W   = 72
    THUMB_H   = 128
    THUMB_R   = 6
    ROW_PAD_X = 16
    ROW_H_ACTIVE = 148
    ROW_H_NORMAL = 96
    GAP          = 8

    total_row_h = 0
    for r_ in range(1, total_ranks+1):
        total_row_h += (ROW_H_ACTIVE if r_ == current_rank else ROW_H_NORMAL) + GAP
    total_row_h -= GAP

    rows_top = title_bottom_y
    cy_row   = rows_top

    for rank in range(1, total_ranks + 1):
        is_active = rank == current_rank
        row_h = ROW_H_ACTIVE if is_active else ROW_H_NORMAL
        color_idx  = (rank-1) % len(list_colors)
        rank_color = list_colors[color_idx]

        row_bg_alpha = 160 if is_active else 90
        row_bg_color = (accent_rgba[0], accent_rgba[1], accent_rgba[2], 40) if is_active else (0,0,0, row_bg_alpha)
        row_rect = [(ROW_PAD_X, cy_row), (W - ROW_PAD_X, cy_row + row_h)]

        row_layer = Image.new('RGBA', (W, H), (0,0,0,0))
        row_draw  = ImageDraw.Draw(row_layer)
        row_draw.rounded_rectangle(
            [ROW_PAD_X, cy_row, W-ROW_PAD_X, cy_row+row_h],
            radius=18,
            fill=row_bg_color
        )
        if is_active:
            row_draw.rounded_rectangle(
                [ROW_PAD_X, cy_row, ROW_PAD_X+6, cy_row+row_h],
                radius=4, fill=(accent_rgba[0], accent_rgba[1], accent_rgba[2], 230)
            )
        img.paste(row_layer, (0,0), row_layer)

        row_draw2 = ImageDraw.Draw(img)

        thumb_x = ROW_PAD_X + 10
        thumb_y = cy_row + (row_h - THUMB_H) // 2
        thumb_y = max(cy_row + 4, thumb_y)
        thumb_path = thumbnail_paths[rank-1] if rank-1 < len(thumbnail_paths) else ''
        if thumb_path and os.path.exists(thumb_path):
            try:
                import os
                resample_m = Image.Resampling.LANCZOS if hasattr(Image,'Resampling') else Image.LANCZOS
                th_img = Image.open(thumb_path).convert('RGBA')
                tw, th_orig = th_img.size
                target_ratio = THUMB_W / THUMB_H
                src_ratio = tw / th_orig
                if src_ratio > target_ratio:
                    new_w = int(th_orig * target_ratio)
                    left = (tw - new_w) // 2
                    th_img = th_img.crop((left, 0, left + new_w, th_orig))
                else:
                    new_h = int(tw / target_ratio)
                    top = (th_orig - new_h) // 2
                    th_img = th_img.crop((0, top, tw, top + new_h))
                th_img = th_img.resize((THUMB_W, THUMB_H), resample_m)
                mask_th = make_rounded_mask((THUMB_W, THUMB_H), THUMB_R)
                img.paste(th_img, (thumb_x, thumb_y), mask_th)
                border_layer = Image.new('RGBA', (W,H), (0,0,0,0))
                bd = ImageDraw.Draw(border_layer)
                bd.rounded_rectangle(
                    [thumb_x-2, thumb_y-2, thumb_x+THUMB_W+2, thumb_y+THUMB_H+2],
                    radius=THUMB_R+2, outline=rank_color, width=3
                )
                img.paste(border_layer, (0,0), border_layer)
            except Exception:
                pass

        text_start_x = thumb_x + THUMB_W + 14

        badge_r = 28 if is_active else 22
        badge_cx = text_start_x + badge_r
        badge_cy = cy_row + row_h // 2
        badge_layer = Image.new('RGBA', (W,H), (0,0,0,0))
        bd2 = ImageDraw.Draw(badge_layer)
        bd2.ellipse(
            [badge_cx-badge_r, badge_cy-badge_r, badge_cx+badge_r, badge_cy+badge_r],
            fill=rank_color
        )
        img.paste(badge_layer, (0,0), badge_layer)

        num_font_use = pro_act_num_font if is_active else pro_num_font
        num_str = str(rank)
        tmp5 = Image.new('RGBA',(100,100))
        td5  = ImageDraw.Draw(tmp5)
        nb   = td5.textbbox((0,0), num_str, font=num_font_use)
        nw   = nb[2]-nb[0]; nh = nb[3]-nb[1]
        nx   = badge_cx - nw//2 - nb[0]
        ny   = badge_cy - nh//2 - nb[1]
        draw_text_with_outline(ImageDraw.Draw(img), nx, ny, num_str, num_font_use, (255,255,255,255))

        ttl_font_use = pro_act_ttl_font if is_active else pro_ttl_font
        ttl_x = badge_cx + badge_r + 14
        ttl_max_w = W - ROW_PAD_X - ttl_x - 12
        if title and is_active:
            ttl_lines = wrap_text_px(title, ttl_font_use, ttl_max_w)[:2]
            ttl_lh    = int((pro_act_ttl_size if is_active else pro_ttl_size) * 1.3)
            ttl_total = len(ttl_lines) * ttl_lh
            ty_ttl    = cy_row + (row_h - ttl_total) // 2
            for ln in ttl_lines:
                draw_text_with_emoji(ImageDraw.Draw(img), ttl_x, ty_ttl, ln, ttl_font_use, emoji_font_obj, (255,255,255,255), use_outline=True)
                ty_ttl += ttl_lh

        cy_row += row_h + GAP

img.save(cfg['out'])
print('OK')
`;

function renderRankingPng(opts) {
  const cfg = {
    width: opts.width,
    height: opts.height,
    preset: opts.preset || 'left_list',
    current_rank: opts.currentRank,
    total_ranks: opts.totalRanks,
    title: String(opts.title || ''),
    global_title: String(opts.globalTitle || ''),
    accent_color: String(opts.accentColor || '#22c55e'),
    font_path: pickBengaliFont('bold'),
    emoji_font_path: pickEmojiFont(),
    thumbnail_paths: opts.thumbnailPaths || [],
    out: opts.outPath,
  };
  const r = spawnSync('python3', ['-c', PY_RANKING_RENDERER, JSON.stringify(cfg)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ranking overlay render failed: ${r.stderr || r.stdout || 'python3 exited ' + r.status}`);
  if (!fs.existsSync(opts.outPath)) throw new Error('ranking overlay PNG not created');
  return opts.outPath;
}

function computeRankForIndex(index, total, ranking) {
  return ranking?.direction === 'countdown' ? (total - index) : (index + 1);
}

// Extract first frame from a video as JPEG thumbnail (FIXED: added -update 1 for FFmpeg 5.x)
async function extractThumbnail(videoPath, outJpg, jobLog) {
  try {
    await runFFmpeg([
      '-i', videoPath,
      '-vframes', '1',
      '-update', '1',
      '-vf', `scale=${Math.round(VIDEO_W * 0.22)}:-1`,
      '-q:v', '3',
      outJpg,
    ], jobLog, null);
    return fs.existsSync(outJpg) ? outJpg : '';
  } catch (_) { return ''; }
}

async function addRankingOverlay(inputPath, outputPath, rankingItem, jobLog) {
  if (!rankingItem) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }
  const isPro = rankingItem.preset === 'pro_ranking';
  const overlayPng = path.join(path.dirname(outputPath), `ranking_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  try {
    renderRankingPng({
      width: VIDEO_W,
      height: VIDEO_H,
      preset: rankingItem.preset,
      currentRank: rankingItem.currentRank,
      totalRanks: rankingItem.totalRanks,
      title: rankingItem.title,
      globalTitle: rankingItem.globalTitle || '',
      accentColor: rankingItem.accentColor || '#22c55e',
      thumbnailPaths: rankingItem.thumbnailPaths || [],
      outPath: overlayPng,
    });

    if (isPro) {
      await runFFmpeg([
        '-i', inputPath,
        '-i', overlayPng,
        '-filter_complex',
          `[0:v]zoompan=z='if(lte(on,30),1.08-on*0.08/30,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${VIDEO_W}x${VIDEO_H}:fps=30[zoomed];[zoomed][1:v]overlay=0:0:format=auto[v]`,
        '-map', '[v]',
        '-map', '0:a?',
        '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outputPath,
      ], jobLog, null);
    } else {
      await runFFmpeg([
        '-i', inputPath,
        '-i', overlayPng,
        '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[v]',
        '-map', '[v]',
        '-map', '0:a?',
        '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outputPath,
      ], jobLog, null);
    }
  } finally {
    try { if (fs.existsSync(overlayPng)) fs.unlinkSync(overlayPng); } catch (_) {}
  }
}

function buildRankingItem(sourceMeta, index, total, ranking, thumbnailPaths) {
  if (!ranking || !ranking.enabled) return null;
  const currentRank = computeRankForIndex(index, total, ranking);
  return {
    preset: ranking.preset || 'left_list',
    currentRank,
    totalRanks: total,
    title: sourceMeta?.rankTitle || sourceMeta?.title || `Rank ${currentRank}`,
    globalTitle: ranking.globalTitle || '',
    accentColor: ranking.accentColor || '#22c55e',
    thumbnailPaths: thumbnailPaths || [],
  };
}

// ─── Step 3: Concat all clips ─────────────────────────────────────
async function concatClips(clipPaths, outputPath, jobLog) {
  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], outputPath);
    return;
  }

  const concatFile = outputPath + '.concat.txt';
  fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

  await runFFmpeg([
    '-f', 'concat', '-safe', '0',
    '-i', concatFile,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ], jobLog, null);

  try { fs.unlinkSync(concatFile); } catch (_) {}
}

// ─── Step 4: Apply audio settings ────────────────────────────────
async function applyAudio(inputPath, outputPath, audioOpts, workDir, jobLog) {
  const { mode, audioUrl } = audioOpts;

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

    const getDuration = (filePath) => {
      try {
        const { execSync } = require('child_process');
        const out = execSync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
          { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }
        );
        return parseFloat(out.toString().trim()) || 0;
      } catch (_) { return 0; }
    };

    const videoDuration = getDuration(inputPath);
    const audioDuration = getDuration(audioFile);
    jobLog.info(`📹 Video: ${videoDuration.toFixed(1)}s | 🎵 Audio: ${audioDuration.toFixed(1)}s`);

    let ffmpegArgs;
    if (audioDuration > 0 && audioDuration < videoDuration) {
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

  fs.copyFileSync(inputPath, outputPath);
}

// ─── Main merge pipeline ──────────────────────────────────────────
async function mergeVideos({ videoFiles, sourcesMeta = [], workDir, jobId, heading, ranking, audioOpts, jobLog, speeds = [] }) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const steps = videoFiles.length * 2 + 2;
  let step = 0;
  const progress = () => jobLog.info(`[merge] step ${++step}/${steps}`);

  const croppedPaths = [];
  for (let i = 0; i < videoFiles.length; i++) {
    const cropped = path.join(workDir, `cropped_${i}.mp4`);
    const speed = parseFloat(speeds[i]) || 1;
    jobLog.info(`📐 Cropping ${i + 1}/${videoFiles.length} to 9:16${speed !== 1 ? ` (${speed}x)` : ''}...`);
    await convertTo916(videoFiles[i], cropped, jobLog, speed);
    croppedPaths.push(cropped);
    progress();
  }

  const headedPaths = [];

  // For pro_ranking: extract one thumbnail per cropped clip upfront
  let thumbnailPaths = [];
  if (ranking && ranking.enabled && ranking.preset === 'pro_ranking') {
    jobLog.info(`🖼️ Extracting thumbnails for Pro Ranking...`);
    for (let i = 0; i < croppedPaths.length; i++) {
      const thumbOut = path.join(workDir, `thumb_${i}.jpg`);
      const tp = await extractThumbnail(croppedPaths[i], thumbOut, jobLog);
      thumbnailPaths.push(tp);
    }
  }

  for (let i = 0; i < croppedPaths.length; i++) {
    const headed = path.join(workDir, `headed_${i}.mp4`);
    if (ranking && ranking.enabled) {
      const rankItem = buildRankingItem(sourcesMeta[i], i, croppedPaths.length, ranking, thumbnailPaths);
      jobLog.info(`🏆 Adding ranking overlay ${i + 1}/${croppedPaths.length} → #${rankItem.currentRank}`);
      await addRankingOverlay(croppedPaths[i], headed, rankItem, jobLog);
    } else if (heading) {
      jobLog.info(`📝 Adding heading ${i + 1}/${croppedPaths.length}...`);
      await addHeading(croppedPaths[i], headed, heading, jobLog);
    } else {
      fs.copyFileSync(croppedPaths[i], headed);
    }
    headedPaths.push(headed);
    progress();
  }

  const concatPath = path.join(workDir, 'concat.mp4');
  jobLog.info(`🔗 Concatenating ${headedPaths.length} clips...`);
  await concatClips(headedPaths, concatPath, jobLog);
  progress();

  const timestamp = Date.now();
  const finalName = `merged_${jobId}_${timestamp}.mp4`;
  const finalPath = path.join(OUTPUT_DIR, finalName);
  jobLog.info(`🎵 Applying audio (mode: ${audioOpts?.mode || 'original'})...`);
  await applyAudio(concatPath, finalPath, audioOpts || { mode: 'original' }, workDir, jobLog);
  progress();

  const sizeBytes = fs.statSync(finalPath).size;
  jobLog.info(`✅ Merge complete! (${(sizeBytes/1024/1024).toFixed(2)} MB) → ${finalName}`);

  // Generate 360p preview (first 60s, ~3-5MB) for slow connections
  const previewName = `preview_${jobId}_${timestamp}.mp4`;
  const previewPath = path.join(OUTPUT_DIR, previewName);
  try {
    jobLog.info(`🎞️ Generating 360p preview...`);
    await runFFmpeg([
      '-i', finalPath,
      '-t', '60',
      '-vf', 'scale=360:-2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32',
      '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart',
      previewPath,
    ], jobLog, null);
    const previewSize = fs.statSync(previewPath).size;
    jobLog.info(`✅ Preview ready (${(previewSize/1024/1024).toFixed(2)} MB) → ${previewName}`);
  } catch (e) {
    jobLog.warn(`⚠️ Preview generation failed (non-fatal): ${e.message}`);
  }

  return {
    filePath: finalPath,
    fileName: finalName,
    sizeBytes,
    previewName: fs.existsSync(previewPath) ? previewName : null,
  };
}

module.exports = { mergeVideos, convertTo916, addHeading, addRankingOverlay };
```
