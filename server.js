const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ROSTER_FILE = path.join(__dirname, 'roster.json');
const PERSIST_DIR = process.env.PERSIST_DIR || '';
const PERSISTED_DATA_FILE = PERSIST_DIR ? path.join(PERSIST_DIR, 'data.json') : DATA_FILE;
const PERSISTED_ROSTER_FILE = PERSIST_DIR ? path.join(PERSIST_DIR, 'roster.json') : ROSTER_FILE;

// If a persistent disk is mounted (PERSIST_DIR set) but hasn't been seeded yet,
// copy the repo's starting data/roster onto it once. After that, all reads and
// writes go to the persistent disk and are never touched by future deploys.
function ensureSeeded() {
  if (!PERSIST_DIR) return;
  try { fs.mkdirSync(PERSIST_DIR, { recursive: true }); } catch (e) {}
  if (!fs.existsSync(PERSISTED_DATA_FILE) && fs.existsSync(DATA_FILE)) {
    fs.copyFileSync(DATA_FILE, PERSISTED_DATA_FILE);
    console.log('Seeded persistent data.json from repo copy (first run on this disk).');
  }
  if (!fs.existsSync(PERSISTED_ROSTER_FILE) && fs.existsSync(ROSTER_FILE)) {
    fs.copyFileSync(ROSTER_FILE, PERSISTED_ROSTER_FILE);
    console.log('Seeded persistent roster.json from repo copy (first run on this disk).');
  }
}
ensureSeeded();
const PIN = process.env.BOARD_PIN || '';
const FULCRUM_TOKEN = process.env.FULCRUM_API_TOKEN || '';
const FULCRUM_BASE = 'https://api.fulcrumpro.com';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}
function writeJsonFile(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function checkPin(req, res, next) {
  if (!PIN) return next();
  const provided = req.get('x-board-pin') || '';
  if (provided !== PIN) {
    return res.status(401).json({ error: 'Invalid or missing PIN' });
  }
  next();
}

app.get('/api/state', checkPin, (req, res) => {
  const state = readJsonFile(PERSISTED_DATA_FILE);
  res.json(state || { active: [], shipped: [], seeded: false });
});

app.post('/api/state', checkPin, (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.active) || !Array.isArray(body.shipped)) {
    return res.status(400).json({ error: 'Malformed state payload' });
  }
  writeJsonFile(PERSISTED_DATA_FILE, body);
  res.json({ ok: true, savedAt: new Date().toISOString() });
});

app.get('/api/roster', checkPin, (req, res) => {
  const roster = readJsonFile(PERSISTED_ROSTER_FILE);
  res.json(roster || { employees: [], startDate: null, numDays: 21, cells: {} });
});

app.post('/api/roster', checkPin, (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.employees) || typeof body.cells !== 'object') {
    return res.status(400).json({ error: 'Malformed roster payload' });
  }
  writeJsonFile(PERSISTED_ROSTER_FILE, body);
  res.json({ ok: true, savedAt: new Date().toISOString() });
});

app.get('/api/pin-required', (req, res) => {
  res.json({ required: !!PIN });
});

// ---- Live Fulcrum active-timers integration ----
// NOTE: the exact endpoint path below (/api/timers/list) is a best-effort guess
// based on Fulcrum's REST conventions (every resource uses POST /api/{resource}/list).
// If this returns an error, the raw Fulcrum response is passed through below so
// the real path/shape can be identified and this fixed in one follow-up edit.
let timerCache = { data: null, error: null, fetchedAt: null };

async function fetchFulcrumTimers() {
  if (!FULCRUM_TOKEN) {
    return { error: 'FULCRUM_API_TOKEN is not set on the server.' };
  }
  try {
    const resp = await fetch(FULCRUM_BASE + '/api/timers/list?Sort.Field=startedOnUtc&Sort.Dir=Descending&Take=100', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + FULCRUM_TOKEN,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({})
    });
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    if (!resp.ok) {
      return { error: 'Fulcrum returned HTTP ' + resp.status, details: parsed };
    }

    const allTimers = (parsed && parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
    const running = allTimers.filter(t => t.isRunning === true);

    // Resolve each running timer's jobId and operator id to human-readable names.
    const jobCache = {};
    const userCache = {};
    for (const t of running) {
      if (t.jobId) {
        if (jobCache[t.jobId] !== undefined) {
          t.resolvedJobName = jobCache[t.jobId];
        } else {
          try {
            const jobResp = await fetch(FULCRUM_BASE + '/api/jobs/' + t.jobId, {
              headers: { 'Authorization': 'Bearer ' + FULCRUM_TOKEN, 'Accept': 'application/json' }
            });
            if (jobResp.ok) {
              const jobData = await jobResp.json();
              const rawName = jobData.name || jobData.jobName || jobData.number || null;
              const name = rawName ? String(rawName).split('-')[0] : null;
              jobCache[t.jobId] = name;
              t.resolvedJobName = name;
            } else {
              jobCache[t.jobId] = null;
              t.resolvedJobName = null;
              t.jobLookupError = 'HTTP ' + jobResp.status;
            }
          } catch (e) {
            t.resolvedJobName = null;
            t.jobLookupError = e.message;
          }
        }
      }
      if (t.startedById) {
        if (userCache[t.startedById] !== undefined) {
          t.resolvedUserName = userCache[t.startedById];
        } else {
          try {
            const userResp = await fetch(FULCRUM_BASE + '/api/users/' + t.startedById, {
              headers: { 'Authorization': 'Bearer ' + FULCRUM_TOKEN, 'Accept': 'application/json' }
            });
            if (userResp.ok) {
              const userData = await userResp.json();
              const name = userData.name || userData.fullName || userData.displayName
                || (userData.firstName && userData.lastName ? (userData.firstName + ' ' + userData.lastName) : null)
                || userData.userName || userData.username || userData.email || null;
              userCache[t.startedById] = name;
              t.resolvedUserName = name;
              if (!name) t.rawUserData = userData;
            } else {
              userCache[t.startedById] = null;
              t.resolvedUserName = null;
              t.userLookupError = 'HTTP ' + userResp.status;
            }
          } catch (e) {
            t.resolvedUserName = null;
            t.userLookupError = e.message;
          }
        }
      }
    }

    return { data: running };
  } catch (e) {
    return { error: 'Request to Fulcrum failed: ' + e.message };
  }
}

app.get('/api/live-timers', checkPin, async (req, res) => {
  const now = Date.now();
  // cache for 20 seconds to avoid hammering Fulcrum on every page load
  if (timerCache.fetchedAt && (now - timerCache.fetchedAt) < 20000) {
    return res.json(timerCache);
  }
  const result = await fetchFulcrumTimers();

  // Filter down to just this app's roster (Foundry people), so the live panel
  // doesn't show everyone clocked in shop-wide (e.g. Fab Shop/welding staff too).
  if (result.data) {
    const roster = readJsonFile(PERSISTED_ROSTER_FILE);
    const rosterTokens = [];
    if (roster && roster.employees) {
      roster.employees.forEach(e => {
        if (e.name) rosterTokens.push(e.name.toLowerCase());
        if (e.aliases) e.aliases.forEach(a => rosterTokens.push(a.toLowerCase()));
      });
    }
    result.data = result.data.filter(t => {
      const name = (t.resolvedUserName || '').toLowerCase();
      if (!name) return false;
      const firstWord = name.split(' ')[0];
      return rosterTokens.some(tok => tok === name || tok === firstWord || tok.split(' ')[0] === firstWord);
    });
  }

  timerCache = { ...result, fetchedAt: now };
  res.json(timerCache);
});

app.listen(PORT, () => {
  console.log('Job priority board listening on port ' + PORT);
  console.log('PIN protection: ' + (PIN ? 'ON' : 'OFF (set BOARD_PIN env var to enable)'));
  console.log('Fulcrum live sync: ' + (FULCRUM_TOKEN ? 'configured' : 'not configured (set FULCRUM_API_TOKEN)'));
});
