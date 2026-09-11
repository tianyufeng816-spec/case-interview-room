# Case Interview Room (self-hosted)

A mock product-case interview chatbot for your students. This version is a
small Node/Express app: it serves the practice page and proxies chat/eval
requests to your AI Builders account server-side, so your API key never
reaches students' browsers.

This exists because the original version (a Claude Artifact) can only call
Claude on each visitor's own account — it cannot call any outside API,
including your AI Builders key, no matter how the request is made. That's a
platform restriction (Artifacts can't make outbound network calls except to
the viewer's own Claude account), not a bug. This app is the workaround:
a real backend, hosted somewhere with your key set as a server-side secret.

## What's in here

- `server.js` — Express server. Serves `public/` and exposes:
  - `GET /api/health` — health check
  - `GET /api/questions` — the 2 seed questions
  - `POST /api/chat` — proxies one interview turn to AI Builders
  - `POST /api/evaluate` — proxies the end-of-interview evaluation
- `public/index.html` — the student-facing page (single file, no build step).
- `package.json` — one dependency (`express`).
- `.env.example` — the environment variables you need to set.

## Before you deploy: rotate your key

The `AI_BUILDER_TOKEN` you shared earlier in this conversation has been
pasted in plaintext multiple times. Please rotate it at
https://space.ai-builders.com before putting the new one into a real
deployment, so the old value stops working.

## One important caveat

The API base URL this app calls (`https://space.ai-builders.com/backend`)
is what your account's own `/openapi.json` documents — I read the spec, but
I have not been able to make a live test call to it end-to-end (my sandbox's
network policy blocks that host). It's very likely correct, but the first
real deploy is the actual test. If `/api/chat` errors out, the error message
returned will include the upstream status/body, which should say what's wrong
(bad path, auth format, etc.) — send that back to me and I'll adjust
`server.js`.

## Deploying

You need any host that can run a small Node app and let you set environment
variables. A few options, roughly easiest first:

### Option A — AI Builder Space's own deploy feature

You already have an account there, and its API documents a
`POST /v1/deployments` endpoint (repo_url, service_name, branch, port,
env_vars) — which suggests it can deploy a small app like this one directly
from a git repo, inside your existing account. This is worth trying first
since everything then lives in one place. Steps:

1. Push this folder to a GitHub repo (private is fine).
2. In the AI Builder Space deployments UI (or via its API), point it at that
   repo, and set the environment variable `AI_BUILDER_TOKEN` to your
   (rotated) key.
3. Tell me the port it expects / any build command it asks for and I'll
   adjust `package.json` or add a `Dockerfile` if needed — I haven't used
   this feature myself so I can't pre-fill those details confidently.

### Option B — Render / Railway / Fly.io (generic Node hosting)

All three offer a free or cheap tier, a web UI, and "deploy from GitHub":

1. Push this folder to a GitHub repo.
2. Create a new "Web Service" (Render/Railway) or "app" (Fly.io) from that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Set the environment variable `AI_BUILDER_TOKEN` (rotated key) in the
   host's dashboard — not in any file you commit.
5. Once deployed you'll get a public URL like `https://your-app.onrender.com`
   — that's the link to share with students.

### Option C — Run it yourself on a server you already have

```bash
npm install
export AI_BUILDER_TOKEN=sk_your_rotated_token
npm start
```

Put it behind a reverse proxy (nginx/Caddy) with HTTPS if it's reachable
from the internet.

## After it's deployed

1. Open the URL yourself and run through one full interview to confirm the
   AI Builders call works end-to-end (this is the first real test of the
   `/v1/chat/completions` proxy).
2. Update `student-instructions.md` (from the earlier `interview_bot/`
   folder) with the real link, and send it to your class.
3. Keep an eye on usage/cost via `GET /v1/usage/summary` on your AI Builders
   account (the same API also has a `cost_ceiling_usd` field if you want a
   hard cap) — with ~100 students this is worth checking after the first
   day.

## Local testing

```bash
npm install
export AI_BUILDER_TOKEN=sk_your_token
npm start
# open http://localhost:8080
```
