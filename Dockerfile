FROM node:22-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip curl wget unzip ca-certificates \
    fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp + instaloader
RUN pip install --break-system-packages --no-cache-dir -U \
    "yt-dlp[default]" instaloader \
    && yt-dlp --version \
    && instaloader --version

# Deno (for YouTube JS challenge bypass)
RUN curl -fsSL https://deno.land/install.sh | sh \
    && mv /root/.deno/bin/deno /usr/local/bin/deno \
    && deno --version

# Xray-core
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "amd64" ]; then XARCH="64"; else XARCH="arm64-v8a"; fi \
    && wget -q "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${XARCH}.zip" -O /tmp/xray.zip \
    && unzip -q /tmp/xray.zip -d /tmp/xray \
    && mv /tmp/xray/xray /usr/local/bin/xray \
    && chmod +x /usr/local/bin/xray \
    && rm -rf /tmp/xray.zip /tmp/xray \
    && xray version || true

# App
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

# Dirs
RUN mkdir -p /app/data/output /app/data/cookies /app/data \
    /tmp/vmixer

ENV PORT=3000 \
    TEMP_DIR=/tmp/vmixer \
    OUTPUT_DIR=/app/data/output \
    COOKIES_FILE=/app/data/cookies/cookies.txt \
    CONFIG_FILE=/app/data/config.json \
    NODE_ENV=production

EXPOSE 3000
CMD ["node","src/server.js"]
