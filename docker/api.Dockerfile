FROM node:22-bullseye-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
  libcairo2-dev \
  libpango1.0-dev \
  libjpeg-dev \
  libgif-dev \
  librsvg2-dev \
  pkg-config \
  python3 \
  python3-pip \
  ffmpeg \
  build-essential \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_NO_CACHE_DIR=1
ENV TMPDIR=/tmp/pip-tmp

RUN mkdir -p /tmp/pip-tmp && chmod 1777 /tmp/pip-tmp

RUN python3 -m pip install --upgrade pip
RUN python3 -m pip install --no-cache-dir \
  torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
RUN python3 -m pip install --no-cache-dir \
  opencv-python \
  ultralytics \
  mediapipe \
  openai-whisper

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . ./

EXPOSE 3001

CMD ["npm", "run", "start"]
