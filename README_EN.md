# 🎬 VideoMixer — Ranking Video Factory

> Download clips from **TikTok / YouTube / Instagram / Kuaishou**, add ranking overlays, and publish to every platform in one click.

---

## 🔥 What Is This?

**"Top 5 Most Embarrassing Moments"**, **"Low IQ Bad Moments"**, **"Cute Moments Compilation"** — this is a complete production pipeline for viral ranking videos, all in one place.

Open the browser, paste URLs, click Start. No video editor needed.

---

## ⚡ Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js + Express |
| Processing | FFmpeg |
| Downloader | yt-dlp + instaloader + KS-Downloader API |
| Overlay Rendering | Python (Pillow) — ranking/title PNG |
| Deployment | Railway (persistent volume at `/app/data`) |
| Fonts | HindSiliguri, NotoSansBengali, NotoColorEmoji |

---

## 📁 Project Structure

```
src/
├── server.js                  # Express app, route registration, boot config
├── public/
│   ├── index.html             # Full UI — single page app
│   └── fonts/                 # Bengali fonts (HindSiliguri, NotoSansBengali)
├── routes/
│   ├── mixer.js               # Job create / status / SSE stream / voiceover
│   ├── upload.js              # FB / TikTok / Instagram / Telegram upload
│   ├── drive.js               # Google Drive upload
│   ├── auth.js                # Google OAuth callback
│   └── setup.js               # Config / Cookies / Sounds API
└── services/
    ├── downloader.js          # Multi-platform video downloader
    ├── merger.js              # FFmpeg processing pipeline
    ├── jobManager.js          # Job queue + SSE log streaming
    ├── titleRenderer.js       # Generates PNG overlays via Python Pillow
    ├── drive.js               # Google Drive API wrapper
    └── xray.js                # VMess/VLess/Trojan proxy management
```

---

## 🎥 Video Processing Pipeline

### Steps inside a single Job:

```
URL(s) input
    │
    ▼
[Phase 1] Download — yt-dlp / instaloader / KS API
    │
    ▼
[Step 1] Crop to 9:16 (720×1280) + Speed adjust (0.5x–2x)
    │
    ▼
[Step 2] Overlay — Ranking badge / Heading text (Bengali + emoji)
    │
    ▼
[Step 3] Concat — Simple OR Fade-to-black (xfade) transition
    │         + Transition sound effect mix
    ▼
[Step 4] Audio — Original / Mute / BGM URL / Voiceover
    │
    ▼
Output MP4 (720×1280) + 360p Preview
```

### FFmpeg Settings (overridable via env):

| Variable | Default | Description |
|----------|---------|-------------|
| `VIDEO_WIDTH` | `720` | Output width |
| `VIDEO_HEIGHT` | `1280` | Output height |
| `FFMPEG_PRESET` | `ultrafast` | Encode speed |
| `FFMPEG_CRF` | `23` | Quality (lower = better) |

---

## 📥 Supported Download Platforms

| Platform | Method | Notes |
|----------|--------|-------|
| **YouTube** | yt-dlp (3 strategies) | `web_embedded` → `mweb` → `ios` auto-fallback |
| **TikTok** | yt-dlp | Custom API hostname, TikTok cookies support |
| **Instagram** | instaloader | Shortcode extract, supports Reel / Post / TV |
| **Kuaishou** | KS-Downloader API → GraphQL fallback | Short URL redirect resolution |
| **Facebook** | yt-dlp | Direct URL |

**YouTube Download Strategies (auto-fallback order):**
1. `web_embedded` — 150s timeout
2. `mweb` — 300s timeout
3. `ios` — 120s timeout

If all strategies fail, the full error log is shown in the job stream.

---

## 🏆 Ranking Mode

**Countdown (#5 → #1) or Normal (#1 → #5)**

Each clip gets its own rank title. The playback order is automatically reversed for countdown mode.

### 3 Presets:

**① Left List Style**
- All rank numbers listed on the left side
- Currently playing rank highlighted in red
- Clip title displayed alongside the active rank

**② Top-left Badge**
- Large rank number badge in the corner
- Clip title below the badge
- Clean, minimal look

**③ ⭐ Pro Ranking** *(most viral style)*
- Thumbnail extracted from each clip automatically
- Cinematic zoom-in effect on reveal (1.08x → 1.0x over 30 frames)
- Rank thumbnails + badge + title all visible
- Active rank highlighted as it plays

### Global Title:
```
"Top 5 Funniest|Moments 😂"
        ↑              ↑
    white color    accent color (green/red/cyan...)
```
Split with `|` — everything after it renders in your chosen accent color.

---

## 📝 Heading Text

Add a plain text overlay without ranking:
- Position: Top / Center / Bottom
- Font size: 24–96px
- Background box toggle (on/off)
- Full Bengali + Emoji support
- **Platform-aware safe zones** — auto-adjusts position for YouTube Shorts / TikTok / Instagram / Facebook

---

## 🎵 Audio Options

| Mode | Behavior |
|------|----------|
| **Original** | Keeps each video's own audio track |
| **Mute** | Removes all audio |
| **BGM URL** | Downloads audio from YouTube or any URL and overlays it (loops if shorter than video, cuts if longer) |
| **Voiceover** | After processing, watch the video and record your voice live — it gets mixed in |

**Audio Library:** Save BGM URLs for reuse across multiple jobs.

---

## 🎬 Transition

**Fade-to-black (xfade)** — 1 second of darkness between clips:
- Uses FFmpeg `xfade=transition=fadeblack` + `acrossfade` for audio
- Auto-falls back to simple concat if any clip is too short
- **Transition Sound Library** — upload a sound effect (MP3/WAV/OGG) that plays at each transition point

---

## 📤 Upload Destinations

### ✈️ Telegram (Bot API)
- Save multiple channels in Settings (name + Bot Token + Channel ID)
- Pick a channel from the dropdown in the upload modal, add a caption, send
- Works with private channels (bot must be made Admin)
- Streams large files directly — no extra npm packages required

### 📘 Facebook (Graph API OAuth)
- Create a Facebook Developer App → run the OAuth flow → token auto-saves
- Uploads to your Page as a Reel or Video
- Supports description field

### 🎵 TikTok (Official Content Posting API)
- TikTok Developer App → OAuth → Access Token saved automatically
- Privacy options: Public / Followers / Mutual Friends / Only Me
- Cookies also supported for downloading TikTok content

### 📸 Instagram (Graph API)
- Requires a Business or Creator account
- Uses the same Facebook Developer App (enable Instagram product)
- Caption support

### 📂 Google Drive
- OAuth login → upload to any folder
- Accepts full folder URL or just the folder ID

---

## ⚙️ Settings Guide

### 🔗 Proxy / Xray
Bypass YouTube bot detection:
```
YTDLP_PROXY=socks5://127.0.0.1:10808
VMESS_LINK=vmess://eyJ...
```
Providing a VMess/VLess/Trojan link auto-starts the Xray core in the background.

### 🍪 Cookies
- **YouTube:** Paste Netscape-format `cookies.txt` in Settings
- **TikTok:** Export from a logged-in browser
- **Kuaishou:** Browser cookie string (`KS_COOKIES`)

### 🔑 Google OAuth
```
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

---

## 💾 Data Storage (Railway Volume)

```
/app/data/
├── config.json            # All saved settings (loaded into env on boot)
├── jobs.json              # Completed jobs (survive restarts)
├── output/                # Final MP4 output files
├── cookies/
│   ├── cookies.txt        # YouTube cookies
│   └── tiktok_cookies.txt
└── sounds/                # Transition sound effects
    └── sounds-meta.json   # Tracks the selected sound
```

Mount `/app/data` as a persistent Railway volume. Data survives redeployments.

---

## 📋 Job System

- Max **10 source URLs** per job
- **SSE (Server-Sent Events)** — real-time log streaming directly in the browser
- Job states: `pending` → `downloading` → `merging` → `done` / `error`
- Completed jobs persist to disk and survive server restarts
- Jobs are only restored if the output file still exists on disk
- Delete a job from the Jobs page to remove both the record and the output file

---

## 🎙️ Voiceover

1. Complete a job — the output video loads in a preview player
2. Press **Record**, play the video, and speak into your mic
3. Press **Stop** and preview your recording
4. Press **Apply Voiceover** — FFmpeg mixes the audio in and saves a new `_vo.mp4`

---

## 🚀 Deploy on Railway

```bash
# Deploy via Railway CLI:
railway up

# Required environment variables:
PORT=3000
OUTPUT_DIR=/app/data/output
TEMP_DIR=/tmp/vmixer
DATA_DIR=/app/data
COOKIES_FILE=/app/data/cookies/cookies.txt
SESSION_SECRET=your-secret-here
```

**A Dockerfile is required** — the image must include FFmpeg, yt-dlp, instaloader, Python 3, Pillow, and Bengali fonts.

---

## 🔢 API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/mixer/jobs` | Create a new job |
| `GET` | `/api/mixer/jobs` | List all jobs |
| `GET` | `/api/mixer/jobs/:id` | Get job status + result |
| `GET` | `/api/mixer/jobs/:id/stream` | SSE live log stream |
| `DELETE` | `/api/mixer/jobs/:id` | Delete job + output file |
| `GET` | `/api/mixer/duration?url=` | Probe video duration |
| `POST` | `/api/mixer/voiceover` | Apply recorded voiceover |
| `POST` | `/api/upload/telegram` | Send to Telegram channel |
| `POST` | `/api/upload/facebook` | Upload to Facebook |
| `POST` | `/api/upload/tiktok` | Upload to TikTok |
| `POST` | `/api/upload/instagram` | Upload to Instagram |
| `GET` | `/api/setup/config` | Load saved config |
| `POST` | `/api/setup/config` | Save config values |
| `POST` | `/api/setup/cookies` | Save YouTube cookies |
| `GET` | `/api/setup/sounds` | Get sound library |
| `POST` | `/api/setup/sounds` | Upload a transition sound |
| `GET` | `/version` | System status + tool versions |
| `GET` | `/health` | Health check |

---

## ⚠️ Known Limitations

- Max 10 source URLs per job
- Voiceover upload limit: 50MB
- Pro Ranking preset disables fade transition (conflicts with thumbnail extraction)
- Telegram uploads for large files (50MB+) may take a while depending on server bandwidth
- Instagram uploads require a Business or Creator account — personal accounts are not supported

---

## 🤝 Contributing

Pull requests are welcome. If you build something on top of this — a new platform uploader, a different overlay style, or a scheduler — feel free to open a PR.

---

*Built for high-volume viral ranking video production. Clip from anywhere, render fast, publish everywhere.*
