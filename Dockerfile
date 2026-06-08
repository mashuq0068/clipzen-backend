# ── clipzen-backend image ────────────────────────────────────────────────────
# One image, three roles (api / worker / publishing) — selected via the compose
# `command:`. CPU-only. Contains: Node 24, ffmpeg, yt-dlp, Python (OpenCV +
# YOLOv8/ultralytics with CPU torch), Remotion headless Chromium, node-canvas.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHON_PATH=/opt/venv/bin/python \
    PATH=/opt/venv/bin:$PATH \
    NODE_ENV=production \
    # Remotion downloads its own chrome-headless-shell at build (see below);
    # these libs are its runtime dependencies.
    REMOTION_DISABLE_HEADLESS_WARNING=1

# ── System packages ──────────────────────────────────────────────────────────
#  ffmpeg/ffprobe            → all media processing
#  python3 + venv + pip      → reframer (cv2/YOLO) and yt-dlp
#  node-canvas runtime libs  → cairo / pango / jpeg / gif / rsvg
#  build tools               → in case node-canvas compiles from source
#  Remotion/Chromium libs    → nss, atk, gtk, gbm, asound, xkb, drm, etc.
#  fonts                     → captions render with real glyphs
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 python3-venv python3-pip \
      build-essential pkg-config \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpangocairo-1.0-0 libgtk-3-0 libx11-xcb1 \
      fonts-liberation fonts-noto-color-emoji fonts-dejavu-core \
      ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# ── Python deps (CPU-only torch first, then the rest) ─────────────────────────
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/venv/bin/pip install --no-cache-dir \
       --index-url https://download.pytorch.org/whl/cpu torch torchvision \
  && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

WORKDIR /app

# ── Node deps (cached layer) ─────────────────────────────────────────────────
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Remotion render uses its own bundled Chromium (no browserExecutable is set in
# captionBurner.js) — bake it into the image so the first render isn't a cold
# download. The system libs above satisfy its dependencies.
RUN npx remotion browser ensure || echo "remotion browser ensure skipped"

# remotion-captions is a nested Remotion project with its own deps.
COPY remotion-captions/package.json remotion-captions/package-lock.json ./remotion-captions/
RUN cd remotion-captions && npm ci --omit=dev || echo "remotion-captions install skipped"

# ── App source ───────────────────────────────────────────────────────────────
COPY . .

# Pre-create the runtime dirs (also bind-mounted as volumes in compose).
RUN mkdir -p uploads outputs tmp

EXPOSE 3001

# Default role = API. Worker/publishing override `command:` in compose.
CMD ["node", "src/index.js"]
