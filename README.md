# 🎬 VideoMixer — Ranking Video Factory

> **TikTok / YouTube / Instagram / Kuaishou** থেকে ক্লিপ নামাও, Ranking overlay বসাও, এক ক্লিকে সব platform এ পাঠাও।

---

## 🔥 এটা কী করে?

**"Top 5 Most Embarrassing Moments"**, **"Low IQ Bad Moments"**, **"Cute Moments Compilation"** — এই ধরনের Ranking ভিডিও বানানোর পুরো pipeline এক জায়গায়।

Browser খুলে URL দাও → ক্লিক করো → ভিডিও রেডি। কোনো video editor লাগে না।

---

## ⚡ Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend   | Node.js + Express |
| Processing | FFmpeg (video pipeline) |
| Downloader | yt-dlp + instaloader + KS-Downloader API |
| Rendering  | Python (Pillow) — ranking/title PNG overlay |
| Deploy    | Railway (persistent volume `/app/data`) |
| Font      | HindSiliguri, NotoSansBengali, NotoColorEmoji |

---

## 📁 Project Structure

```
src/
├── server.js                  # Express app, route registration, boot
├── public/
│   ├── index.html             # পুরো UI — single page app
│   └── fonts/                 # Bengali fonts (HindSiliguri, NotoSansBengali)
├── routes/
│   ├── mixer.js               # Job create/status/stream/delete + voiceover
│   ├── upload.js              # FB / TikTok / Instagram / Telegram upload
│   ├── drive.js               # Google Drive upload
│   ├── auth.js                # Google OAuth callback
│   └── setup.js               # Config / Cookies / Sounds API
└── services/
    ├── downloader.js          # Multi-platform video downloader
    ├── merger.js              # FFmpeg processing pipeline
    ├── jobManager.js          # Job queue + SSE log streaming
    ├── titleRenderer.js       # Python Pillow দিয়ে PNG overlay বানায়
    ├── drive.js               # Google Drive API wrapper
    └── xray.js                # VMess/VLess/Trojan proxy management
```

---

## 🎥 Video Processing Pipeline

### ধাপগুলো (একটা Job এ):

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
[Step 2] Overlay — Ranking badge / Heading text (Bengali+emoji)
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

### FFmpeg Settings (env দিয়ে override করা যায়):

| Variable | Default | কাজ |
|----------|---------|-----|
| `VIDEO_WIDTH` | `720` | Output width |
| `VIDEO_HEIGHT` | `1280` | Output height |
| `FFMPEG_PRESET` | `ultrafast` | Encode speed |
| `FFMPEG_CRF` | `23` | Quality (lower = better) |

---

## 📥 Supported Platforms (Download)

| Platform | Method | বিশেষত্ব |
|----------|--------|---------|
| **YouTube** | yt-dlp (3 strategies) | `web_embedded` → `mweb` → `ios` fallback |
| **TikTok** | yt-dlp | Custom API hostname, TikTok cookies support |
| **Instagram** | instaloader | Shortcode extract, Reel/Post/TV |
| **Kuaishou** | KS-Downloader API → GraphQL fallback | Short URL redirect resolve |
| **Facebook** | yt-dlp | Direct URL |

**YouTube Strategies (auto-fallback):**
1. `web_embedded` (150s timeout)
2. `mweb` (300s timeout)
3. `ios` (120s timeout)

যদি সব fail করে → error log এ দেখা যাবে।

---

## 🏆 Ranking Mode

**Countdown (#5 → #1) বা Normal (#1 → #5)**

### 3টা Preset:

**① Left List Style**
- বাম দিকে সব rank number list
- Active rank টা লাল highlight
- প্রতিটা ক্লিপে তার title দেখায়

**② Top-left Badge**
- Corner এ বড় rank number badge
- নিচে clip title
- Clean look

**③ ⭐ Pro Ranking** *(সবচেয়ে ভাইরাল স্টাইল)*
- প্রতিটা ক্লিপের thumbnail extract হয়
- Cinematic zoom-in effect (1.08x → 1.0x, 30 frames)
- Rank thumbnails + badge + title
- যে rank play হচ্ছে সেটা highlight

### Global Title:
```
"Top 5 Funniest|Moments 😂"
       ↑              ↑
   সাদা রং      accent color (green/red/cyan...)
```
`|` দিয়ে দুই অংশ আলাদা — দ্বিতীয় অংশ accent color এ।

---

## 📝 Heading Text

Ranking ছাড়া plain heading বসাতে পারো:
- Position: Top / Center / Bottom
- Font size: 24–96px
- Background box on/off
- Bengali + Emoji সাপোর্ট
- **Platform safe zone auto-adjust** — YouTube Shorts / TikTok / Instagram / Facebook

---

## 🎵 Audio Options

| Mode | কাজ |
|------|-----|
| **Original** | প্রতিটা ভিডিওর নিজস্ব audio রাখে |
| **Mute** | সব audio বাদ দেয় |
| **BGM URL** | YouTube বা যেকোনো URL থেকে audio নামিয়ে বসায় (ভিডিও ছোট হলে loop, বড় হলে cut) |
| **Voiceover** | Processing শেষে ভিডিও দেখতে দেখতে মাইক থেকে রেকর্ড করো — apply হয়ে যায় |

**Audio Library:** BGM URL গুলো save করে রাখো, পরে reuse করো।

---

## 🎬 Transition

**Fade-to-black (xfade)** — ক্লিপের মাঝে 1 সেকেন্ড কালো:
- FFmpeg `xfade=transition=fadeblack` + `acrossfade` audio
- ক্লিপ খুব ছোট হলে auto simple concat এ fallback
- **Transition Sound Library** — upload করা sound effect transition এর সময় play হয় (MP3/WAV/OGG)

---

## 📤 Upload Destinations

### ✈️ Telegram (Bot API)
- Bot Token + Channel ID → Settings এ multiple channel save করো
- Modal এ channel dropdown → caption দাও → পাঠাও
- Private channel এ কাজ করে (bot কে Admin করতে হবে)
- বড় ফাইল stream করে পাঠায়, কোনো extra package লাগে না

### 📘 Facebook (Graph API OAuth)
- Facebook Developer App → OAuth flow
- Page এ Reel/Video upload
- Description সাপোর্ট

### 🎵 TikTok (Official Content API)
- TikTok Developer App → OAuth → Access Token auto-save
- Privacy: Public / Followers / Mutual / Only Me
- Cookies দিয়েও download করা যায়

### 📸 Instagram (Graph API)
- Business/Creator account লাগবে
- Facebook App এ Instagram product enable করতে হবে
- Caption সাপোর্ট

### 📂 Google Drive
- OAuth → যেকোনো folder এ upload
- Folder URL বা ID — দুটোই চলে

---

## ⚙️ Settings Guide

### 🔗 Proxy / Xray
YouTube bot detection bypass:
```
YTDLP_PROXY=socks5://127.0.0.1:10808
VMESS_LINK=vmess://eyJ...
```
VMess/VLess/Trojan link দিলে Xray auto-start হয়।

### 🍪 Cookies
- **YouTube:** Netscape format cookies.txt → Settings এ paste করো
- **TikTok:** TikTok logged-in browser থেকে export
- **Kuaishou:** Browser cookie string (KS_COOKIES)

### 🔑 Google OAuth
```
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

---

## 💾 Data Storage (Railway Volume)

```
/app/data/
├── config.json          # সব settings (env এ load হয়)
├── jobs.json            # Completed jobs persist (restart safe)
├── output/              # Final MP4 files
├── cookies/
│   ├── cookies.txt      # YouTube cookies
│   └── tiktok_cookies.txt
└── sounds/              # Transition sound effects
    └── sounds-meta.json # Selected sound
```

**Railway volume mount:** `/app/data` → persistent। Redeploy এ data যায় না।

---

## 📋 Jobs System

- Max **10 sources** per job
- **SSE (Server-Sent Events)** — real-time log streaming browser এ
- Job states: `pending` → `downloading` → `merging` → `done` / `error`
- Jobs restart safe — done/error jobs disk এ persist হয়
- File এখনো থাকলেই restore হয়, নইলে skip
- Jobs page থেকে delete করা যায় (temp file + output সব মুছে)

---

## 🎙️ Voiceover Feature

1. Job complete হলে ভিডিও preview দেখাবে
2. **Record** চাপো → ভিডিও play করো → কথা বলো
3. **Stop** → preview শোনো
4. **Apply Voiceover** → FFmpeg দিয়ে audio mix → নতুন `_vo.mp4` তৈরি

---

## 🚀 Deploy (Railway)

```bash
# Railway CLI দিয়ে:
railway up

# Environment variables (Railway dashboard):
PORT=3000
OUTPUT_DIR=/app/data/output
TEMP_DIR=/tmp/vmixer
DATA_DIR=/app/data
COOKIES_FILE=/app/data/cookies/cookies.txt
SESSION_SECRET=your-secret-here
```

**Dockerfile দরকার** — FFmpeg, yt-dlp, instaloader, Python, Pillow, Bengali fonts সব থাকতে হবে।

---

## 🔢 API Endpoints

| Method | Path | কাজ |
|--------|------|-----|
| `POST` | `/api/mixer/jobs` | নতুন job তৈরি |
| `GET` | `/api/mixer/jobs` | সব job list |
| `GET` | `/api/mixer/jobs/:id` | Job status |
| `GET` | `/api/mixer/jobs/:id/stream` | SSE live logs |
| `DELETE` | `/api/mixer/jobs/:id` | Job + file delete |
| `GET` | `/api/mixer/duration?url=` | Video duration probe |
| `POST` | `/api/mixer/voiceover` | Voiceover apply |
| `POST` | `/api/upload/telegram` | Telegram এ পাঠাও |
| `POST` | `/api/upload/facebook` | Facebook upload |
| `POST` | `/api/upload/tiktok` | TikTok upload |
| `POST` | `/api/upload/instagram` | Instagram upload |
| `GET` | `/api/setup/config` | Config load |
| `POST` | `/api/setup/config` | Config save |
| `POST` | `/api/setup/cookies` | YT cookies save |
| `GET` | `/api/setup/sounds` | Sound library |
| `POST` | `/api/setup/sounds` | Sound upload |
| `GET` | `/version` | System status |
| `GET` | `/health` | Health check |

---

## ⚠️ Known Limits

- Max 10 sources per job
- Voiceover file max 50MB
- Pro Ranking preset এ transition কাজ করে না (thumbnail extract এর সাথে conflict)
- Telegram এ 50MB+ ফাইল পাঠাতে বেশি সময় লাগে
- Instagram এ personal account কাজ করে না — Business/Creator লাগবে

---

*Built for viral ranking video production — TikTok/YouTube/Instagram/Kuaishou থেকে ক্লিপ নিয়ে এক ক্লিকে factory output।*
