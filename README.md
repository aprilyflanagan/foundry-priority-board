# Foundry Priority Board & 3-Week Schedule (shared, hosted version)

A small Node/Express app that serves the job priority board to your whole team
from one URL. Everyone who opens that URL sees and edits the same shared list.

## What's in here
- `server.js` — the backend. Two endpoints: `GET /api/state` and `POST /api/state`,
  backed by a single `data.json` file.
- `public/index.html` — the board UI (same one from the Claude artifact, adapted
  to talk to this server instead of Claude's storage).
- `data.json` — pre-seeded with the current 40-job Master schedule.

## Important limitation — read this first
`data.json` is a plain file on disk. That's fine for a small internal tool, but:
- **On Render's free tier, the disk is wiped on every redeploy** (and the service
  sleeps after 15 min of inactivity, which is usually fine, just a few seconds of
  cold-start delay on the first request after a nap).
- If you need the data to survive redeploys permanently, either add Render's
  **persistent disk** add-on (paid, a few dollars/month) and point `DATA_FILE` at
  that mounted path, or swap `data.json` for a real database later. For a shop
  floor tool that gets edited constantly and rarely redeployed, the plain-file
  version is genuinely fine to start with — just know a redeploy resets it.

## Optional: PIN protection
Since this will be reachable from any browser with the URL, you can gate it with
a shared PIN. Set an environment variable `BOARD_PIN` (e.g. `4127`) when you
deploy. If you don't set it, the board is open to anyone with the link — fine if
it's only shared internally and not indexed anywhere.

## Deploy to Render (free tier, ~5 minutes)

1. **Push this folder to a GitHub repo.**
   - Create a new repo (private is fine) on github.com.
   - From this folder: `git init && git add . && git commit -m "job board" && git remote add origin <your-repo-url> && git push -u origin main`

2. **Create the Render service.**
   - Go to https://dashboard.render.com → New → Web Service.
   - Connect your GitHub account and pick this repo.
   - Environment: **Node**.
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free is fine to start.

3. **(Optional) Set the PIN.**
   - In the Render service → Environment → Add Environment Variable:
     `BOARD_PIN` = whatever PIN you want your team to use.

4. **Deploy.** Render gives you a URL like `https://job-priority-board.onrender.com`.
   Share that URL with your team — that's the whole app.

## Running it locally first (optional, to try before deploying)
```
npm install
npm start
```
Then open http://localhost:3000 in your browser.

## Adding real persistence later
If you outgrow the plain JSON file (e.g. want history, multiple boards, user
accounts), the cleanest next step is swapping `readState()`/`writeState()` in
`server.js` for calls to a small hosted database (Render Postgres has a free
tier). The API shape (`GET`/`POST /api/state`) doesn't need to change — only
those two functions would.
