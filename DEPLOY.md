# clipzen-backend — free deployment guide

Production architecture (all free / free-tier):

```
                ┌────────────────────────── Vercel (free) ──────────────────────────┐
   Visitors ──► │  clipzen-website-new  ·  clipzen-portal                            │
                └───────────────────────────────┬───────────────────────────────────┘
                                                 │  HTTPS  (api.clipzen.pro)
                ┌────────────────── ONE VM · docker-compose ──────────────────┐
                │  api      Express  (port 3001, serves /outputs)             │
                │  worker   BullMQ  → ffmpeg · yt-dlp · YOLOv8 · Remotion      │
                │  redis    BullMQ queue (local — never managed, see below)   │
                └───────────────┬─────────────────────────┬──────────────────┘
                                │                          │
                    Neon (managed Postgres, free)   3rd-party APIs:
                                                    Speechmatics · Groq ·
                                                    Pexels · Cloudinary · Resend
```

- **No Whisper, no Ollama in prod** — `IS_WHISPER=false`, `MODEL_PROVIDER=groq`.
  Transcription → Speechmatics; LLM → Groq. Both are API calls, no local models.
- **No GPU** — YOLOv8 + ffmpeg run CPU-only.
- The same Docker image runs `api`, `worker`, and the one-shot `migrate`.

## What's inside the image (`Dockerfile`)

| Need | Provided by |
|---|---|
| API + workers | Node 24 |
| Video | `ffmpeg` / `ffprobe` |
| Download | `yt-dlp` (+ `cookies.txt`) |
| Reframer | Python venv: OpenCV + YOLOv8 (`ultralytics`) + **CPU** torch |
| Captions | Remotion + bundled headless Chromium |
| Images | `node-canvas` (cairo/pango libs) |

---

## Step 0 — Neon (managed Postgres) · do this first, applies to both hosts

1. Sign up at <https://neon.tech> (free, no card). Create a project → you get a
   connection string like:
   ```
   postgresql://USER:PASSWORD@ep-xxx-123.us-east-2.aws.neon.tech/dbname?sslmode=require
   ```
2. You'll translate that into the backend's discrete env vars (Step 1).
3. The `migrate` service creates all tables on first `docker compose up`.

> Neon scales to zero when idle and wakes in ~1–3s. The pool now uses
> `DB_SSL=true` and a 10s connect timeout (`src/db/pool.js`) to handle this.

## Step 1 — the production `.env` (lives on the VM, never committed)

Copy your existing `.env` to the VM and set these for production:

```bash
NODE_ENV=production
PORT=3001

# ── Neon Postgres (from Step 0) ──
DB_HOST=ep-xxx-123.us-east-2.aws.neon.tech
DB_PORT=5432
DB_NAME=dbname
DB_USER=USER
DB_PASSWORD=PASSWORD
DB_SSL=true

# ── Redis is the in-compose container ──  (compose sets REDIS_HOST=redis)

# ── Prod engines: NO whisper / NO ollama ──
IS_WHISPER=false
MODEL_PROVIDER=groq
GROQ_API_KEY=gsk_...
SPEECHMATICS_API_KEY=...

# ── Public URLs (set to your real domains) ──
BACKEND_PUBLIC_URL=https://api.clipzen.pro
FRONTEND_URL=https://portal.clipzen.pro
GOOGLE_REDIRECT_URI=https://api.clipzen.pro/api/auth/google/callback

# ── The rest of your existing keys (unchanged) ──
# CLOUDINARY_*, PEXELS_API_KEY, RESEND_API_KEY, EMAIL_FROM, GOOGLE_CLIENT_*,
# JWT_SECRET, JWT_REFRESH_SECRET, LEMONSQUEEZY_* ...

WORKER_CONCURRENCY=2
```

`docker-compose.yml` already injects `DB_SSL=true`, `REDIS_HOST=redis`,
`IS_WHISPER=false`, and `PYTHON_PATH` — you don't set those manually.

---

# Path A — Oracle Cloud Always Free (ARM · free forever) ★ recommended

**Why:** 4 vCPU / 24 GB RAM, free with no time limit — the most RAM of any free
option, enough to run ffmpeg + YOLOv8 + Chromium + Redis + Node together.

### A1. Create the VM
1. Sign up at <https://cloud.oracle.com> (card for identity check, not charged
   on Always Free).
2. **Compute → Instances → Create**:
   - Image: **Ubuntu 22.04**
   - Shape: **VM.Standard.A1.Flex** (Ampere ARM) → set **4 OCPU / 24 GB**
     (the full Always-Free allowance).
   - Add your SSH public key.
   - Boot volume: bump to **100 GB** (still free; image + torch + outputs).
3. **Networking → Security List / NSG:** add ingress rules for **tcp/80**,
   **tcp/443**, and **tcp/3001** (or just 80/443 if you put a proxy in front).

### A2. Prep the box
```bash
ssh ubuntu@<vm-ip>
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exec sudo su -l $USER   # re-login for group
# Oracle Ubuntu blocks ports by default at the OS firewall too:
sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT
sudo netfilter-persistent save
```

### A3. Get the code + secrets, then build & run
```bash
git clone <your-repo> && cd clipzen-backend     # or scp the folder up
nano .env                                        # paste the Step-1 production env
docker compose up -d --build                     # builds NATIVELY on ARM
```
> Building on the ARM VM means torch/opencv/Chromium resolve their **arm64**
> wheels automatically — no cross-compile, no `platform:` flag needed. First
> build is ~10–15 min (torch is large). Don't build on your x86 laptop and push.

### A4. Verify
```bash
docker compose ps                 # redis/api/worker = Up, migrate = Exited(0)
docker compose logs -f api worker
curl http://localhost:3001/api/health   # or any known route
```
Jump to **"Common — after it's running"** below.

---

# Path B — Google Cloud ($300 credit · x86 · 3 months) — easiest, not forever

**Why:** plain x86, zero ARM friction. Free via $300 credit for ~3 months, then
~$97/mo for `e2-standard-4` (stop the VM when idle — billed per second).

### B1. Create the VM
1. <https://console.cloud.google.com> → enable billing (activates the $300).
2. **Compute Engine → Create instance**:
   - Machine: **e2-standard-4** (4 vCPU / 16 GB). 16 GB is the floor for
     ffmpeg + YOLO + Chromium together.
   - Boot disk: **Ubuntu 22.04 LTS, 50 GB+**.
   - Check **Allow HTTP / HTTPS traffic**.
3. **VPC → Firewall:** add a rule to allow **tcp:3001** (or front with 80/443).

### B2. Prep the box
```bash
gcloud compute ssh <vm>      # or use the browser SSH button
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exec sudo su -l $USER
```

### B3. Get the code + secrets, then build & run
```bash
git clone <your-repo> && cd clipzen-backend
nano .env                                  # paste the Step-1 production env
docker compose up -d --build               # ~10-15 min first build
```

### B4. (Optional) build locally, push to Artifact Registry
Because GCP is x86 like your laptop, you *can* prebuild and push:
```bash
gcloud artifacts repositories create clipzen --repository-format=docker --location=us-central1
gcloud auth configure-docker us-central1-docker.pkg.dev
docker build -t us-central1-docker.pkg.dev/PROJECT/clipzen/backend:latest .
docker push  us-central1-docker.pkg.dev/PROJECT/clipzen/backend:latest
```
Then point `image:` in `docker-compose.yml` at that path and `docker compose up -d`.

---

## Comparison at a glance

| | **Oracle Always Free (A)** | **Google Cloud (B)** |
|---|---|---|
| Cost | **Free forever** | $300 credit, ~3 months, then ~$97/mo |
| Compute | 4 vCPU / **24 GB** | 4 vCPU / 16 GB |
| Arch | ARM64 (build on VM) | x86 (build anywhere) |
| Friction | Oracle console + OS firewall quirks | Smoothest |
| Best when | You want it permanently free | You want the simplest path / are testing |

**Recommendation:** **A (Oracle)** for a real free deployment; **B (GCP)** if you
just want the least-friction path for a few months.

---

## Common — after it's running (both paths)

**Point your frontend + OAuth at the backend's public URL:**
- Vercel env (website-new / portal): set the API base URL to `https://api.clipzen.pro`.
- `.env` on the VM: `BACKEND_PUBLIC_URL`, `FRONTEND_URL`, `GOOGLE_REDIRECT_URI`.
- Google Cloud Console → OAuth client → **Authorized redirect URIs**: add
  `https://api.clipzen.pro/api/auth/google/callback`.
- CORS allow-list lives in `src/index.js` (`allowedOrigins`) — make sure your
  portal/website origins are listed.

**TLS / domain:** point an A record (e.g. `api.clipzen.pro`) at the VM IP. For
HTTPS, put **Caddy** or **nginx** in front of port 3001 (Caddy auto-provisions
Let's Encrypt certs in ~3 lines). Or front it with Cloudflare.

**Everyday ops:**
```bash
docker compose logs -f worker          # follow job processing
docker compose pull && docker compose up -d --build   # deploy an update
docker compose restart worker          # restart just the worker
docker compose down                    # stop (add -v to wipe redis/outputs volumes)
```

## How the moving parts work here

- **Workers:** `videoWorker.js` also loads `publishingWorker` in-process, so the
  single `worker` service handles both video jobs and social publishing.
- **Redis/BullMQ:** the `redis` container is the queue. It stays local because a
  24/7 BullMQ poller would burn a managed Redis free tier's per-command quota.
- **YOLOv8 model:** `yolov8n-face.pt` (~6 MB) downloads on the first reframing
  job into the `modelcache` volume (`/root/.cache`) and is reused after.
- **/outputs:** clips are written to the `outputs` volume, shared between `api`
  and `worker`, and served by Express. (Also mirrored to Cloudinary.) This shared
  persistent volume is why a single VM — not serverless — is required.
- **Remotion:** uses its own bundled Chromium baked into the image; the system
  libs in the Dockerfile satisfy it.

## Cost control (Path B only)

Billing is per-second. `gcloud compute instances stop <vm>` when idle → you pay
only for the disk (~$2/mo). Path A (Oracle) has nothing to watch — it's free.

## Gotchas

- Build **on the VM** for Path A (ARM) — never push an x86 image to it.
- `cookies.txt` is baked into the image for yt-dlp; refresh it if downloads start
  failing with auth errors, then rebuild.
- Neon free tier sleeps when idle; the first request after idle pays a ~1–3s
  wake. The 10s connect timeout in `pool.js` covers it.
- Keep `WORKER_CONCURRENCY` at 2 on a 4-vCPU box — each job spawns ffmpeg +
  Chromium + a YOLO Python process, which are individually CPU-hungry.
