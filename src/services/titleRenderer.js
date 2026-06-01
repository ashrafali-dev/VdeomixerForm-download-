'use strict';

// =====================================================================
// Title pre-renderer v2.5 — Pillow + libraqm + harfbuzz + fribidi
//
// IMPROVEMENTS in v2.5:
//   - Aggressive auto font-size shrinking (1px steps)
//   - Pixel-precise word wrap (not char count)
//   - Larger safety padding (text never touches edges)
//   - Verifies actual rendered height vs canvas height
//   - 5-line max for very long titles
// =====================================================================

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');

const PY_RENDERER = `
import sys, json
from PIL import Image, ImageDraw, ImageFont

cfg = json.loads(sys.argv[1])
W = cfg['width']; H = cfg['height']
font_path = cfg['font_path']
emoji_font_path = cfg.get('emoji_font_path', None)
text = cfg['text'].strip() or ' '
fg = tuple(cfg.get('fg', [255,255,255,255]))
bg = tuple(cfg.get('bg', [0,0,0,0]))
shadow = cfg.get('shadow', None)
target_font_size = cfg['font_size']
min_font_size = cfg.get('min_font_size', 18)
align = cfg.get('align', 'center')
out_path = cfg['out']
padding_x = cfg.get('padding_x', 30)
padding_y = cfg.get('padding_y', 20)
max_lines = cfg.get('max_lines', 5)
line_height_ratio = cfg.get('line_height_ratio', 1.30)

try:
    layout = ImageFont.Layout.RAQM
except AttributeError:
    layout = ImageFont.LAYOUT_RAQM if hasattr(ImageFont, 'LAYOUT_RAQM') else ImageFont.LAYOUT_BASIC

words = text.split()

def wrap_by_pixel(words, font, max_w, draw):
    lines = []
    cur = []
    for w in words:
        candidate = ' '.join(cur + [w])
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if bbox[2] - bbox[0] <= max_w or not cur:
            cur.append(w)
        else:
            lines.append(' '.join(cur))
            cur = [w]
    if cur:
        lines.append(' '.join(cur))
    return lines

def measure(font_size):
    font = ImageFont.truetype(font_path, font_size, layout_engine=layout)
    tmp = Image.new('RGBA', (10, 10))
    draw = ImageDraw.Draw(tmp)
    max_w = W - 2 * padding_x
    lines = wrap_by_pixel(words, font, max_w, draw)
    line_h = int(font_size * line_height_ratio)
    total_h = line_h * len(lines)
    max_line_w = 0
    max_descent = 0
    for ln in lines:
        bb = draw.textbbox((0, 0), ln, font=font)
        max_line_w = max(max_line_w, bb[2] - bb[0])
        max_descent = max(max_descent, bb[3])
    # Add descender extra to total_h
    total_h_real = total_h + max_descent // 4
    return font, lines, line_h, total_h_real, max_line_w

# Auto-shrink: 1px steps for accurate fit
font_size = target_font_size
final = None
while font_size >= min_font_size:
    font, lines, line_h, total_h, max_line_w = measure(font_size)
    fits_h = total_h <= H - 2 * padding_y
    fits_w = max_line_w <= W - 2 * padding_x
    fits_n = len(lines) <= max_lines
    if fits_h and fits_w and fits_n:
        final = (font, lines, line_h, total_h, font_size)
        break
    font_size -= 1

if final is None:
    font_size = min_font_size
    font, lines, line_h, total_h, _ = measure(font_size)
    final = (font, lines, line_h, total_h, font_size)

font, lines, line_h, total_h, used_size = final

img = Image.new('RGBA', (W, H), bg)
draw = ImageDraw.Draw(img)

# Vertical centering with safe top padding
y_start = max(padding_y, (H - total_h) // 2)

import unicodedata

def is_emoji(ch):
    try:
        cat = unicodedata.category(ch)
        cp = ord(ch)
        return cat in ('So', 'Sm') or (0x1F000 <= cp <= 0x1FFFF) or (0x2600 <= cp <= 0x27BF) or cp in (0xFE0F, 0x200D)
    except:
        return False

def draw_text_with_emoji(draw, x, y, text, main_font, emoji_font, fill, shadow=None):
    cx = x
    i = 0
    while i < len(text):
        ch = text[i]
        # Handle ZWJ sequences and variation selectors
        seq = ch
        j = i + 1
        while j < len(text) and text[j] in ('\uFE0F', '\u200D') or (j < len(text) and is_emoji(text[j]) and j > i and text[j-1] == '\u200D'):
            seq += text[j]
            j += 1
        use_emoji = emoji_font and any(is_emoji(c) for c in seq)
        font = emoji_font if use_emoji else main_font
        if shadow:
            sr, sg, sb, sa, sox, soy = shadow
            draw.text((cx + sox, y + soy), seq, font=font, fill=(sr, sg, sb, sa))
        draw.text((cx, y), seq, font=font, fill=fill)
        bb = draw.textbbox((0, 0), seq, font=font)
        cx += bb[2] - bb[0] + 1
        i = j

emoji_font = None
if emoji_font_path:
    try:
        emoji_font = ImageFont.truetype(emoji_font_path, font_size, layout_engine=ImageFont.Layout.BASIC if hasattr(ImageFont, 'Layout') else ImageFont.LAYOUT_BASIC)
    except:
        emoji_font = None

for i, ln in enumerate(lines):
    bbox = draw.textbbox((0, 0), ln, font=font)
    lw = bbox[2] - bbox[0]
    if align == 'center':
        x = (W - lw) // 2 - bbox[0]
    elif align == 'right':
        x = W - lw - padding_x - bbox[0]
    else:
        x = padding_x - bbox[0]
    y = y_start + i * line_h - bbox[1]
    draw_text_with_emoji(draw, x, y, ln, font, emoji_font, fg, shadow)

img.save(out_path)
print('OK', img.size, 'lines=', len(lines), 'final_font=', used_size)
`;

function pickFont(weight = 'bold') {
  const candidates = weight === 'bold' ? [
    path.join(FONT_DIR, 'HindSiliguri-Bold.ttf'),
    path.join(FONT_DIR, 'NotoSansBengali-Bold.ttf'),
    path.join(FONT_DIR, 'HindSiliguri-Regular.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Bold.ttf',
  ] : [
    path.join(FONT_DIR, 'HindSiliguri-Regular.ttf'),
    path.join(FONT_DIR, 'NotoSansBengali-Regular.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Bengali font available');
}

function pickEmojiFont() {
  const candidates = [
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/truetype/NotoColorEmoji.ttf',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null; // emoji font not available, will skip
}

function renderTitlePng(opts) {
  const {
    text, width, height, fontSize, outPath,
    fg = [255, 255, 255, 255],
    bg = [0, 0, 0, 0],
    shadow = null,
    fontWeight = 'bold',
    minFontSize = 20,
    maxLines = 5,
    paddingX = 30,
    paddingY = 20,
    lineHeightRatio = 1.30,
  } = opts;

  const cfg = {
    width, height,
    font_size: fontSize,
    min_font_size: minFontSize,
    font_path: pickFont(fontWeight),
    emoji_font_path: pickEmojiFont(),
    text: String(text || ' '),
    fg, bg, shadow,
    out: outPath,
    align: 'center',
    padding_x: paddingX,
    padding_y: paddingY,
    max_lines: maxLines,
    line_height_ratio: lineHeightRatio,
  };

  const r = spawnSync('python3', ['-c', PY_RENDERER, JSON.stringify(cfg)], {
    encoding: 'utf8',
  });

  if (r.status !== 0) {
    throw new Error(`title render failed: ${r.stderr || r.stdout || 'python3 exited ' + r.status}`);
  }
  if (!fs.existsSync(outPath)) {
    throw new Error('title render: output PNG not created');
  }
  return outPath;
}

module.exports = { renderTitlePng, pickFont, pickEmojiFont };
