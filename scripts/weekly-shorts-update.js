/* scripts/weekly-shorts-update.js
   Node 20+
   Outputs:
     data/weekly-shorts/weeks/<n>.json
     data/weekly-shorts/aggregate.json
     data/weekly-shorts/changelog.json
   Also maintains:
     data/weekly-shorts/name-cache.json       (accountId -> displayName)
     data/weekly-shorts/wr-end-snapshots.json (week -> WR at endedAt)
*/

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();

const BASE_DIR = path.join(ROOT, "data", "weekly-shorts");
const WEEKS_INDEX_PATH = path.join(BASE_DIR, "weeks.json");
const WEEKS_DIR = path.join(BASE_DIR, "weeks");

const NAME_CACHE_PATH = path.join(BASE_DIR, "name-cache.json");
const SNAPSHOT_PATH = path.join(BASE_DIR, "wr-end-snapshots.json");
const CHANGELOG_PATH = path.join(BASE_DIR, "changelog.json");
const AGG_PATH = path.join(BASE_DIR, "aggregate.json");

// ---- helpers ----
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function isoNow() {
  return new Date().toISOString();
}

function msToTime(ms) {
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const t = total % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(t).padStart(3, "0")}`;
}

// ---- Trackmania OAuth: accountId -> display name ----
// Docs: OAuth accounts id-to-name supports up to 50 IDs per request. :contentReference[oaicite:4]{index=4}
async function getTrackmaniaOAuthToken() {
  const clientId = process.env.TM_OAUTH_CLIENT_ID;
  const clientSecret = process.env.TM_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing TM_OAUTH_CLIENT_ID / TM_OAUTH_CLIENT_SECRET (GitHub secrets).");
  }

  // Official auth is OAuth2. :contentReference[oaicite:5]{index=5}
  // Client credentials grant is supported by the public Trackmania API for server-to-server use cases.
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const r = await fetch("https://api.trackmania.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`OAuth token failed: ${r.status} ${txt}`);
  }

  const j = await r.json();
  if (!j.access_token) throw new Error("OAuth token response missing access_token");
  return j.access_token;
}

async function resolveNames(accountIds, oauthToken) {
  // Returns map: { accountId: displayName }
  // Uses the OAuth API “id-to-name” endpoint. :contentReference[oaicite:6]{index=6}

  const out = {};
  const ids = [...new Set(accountIds)].filter(Boolean);

  // batch <= 50
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);

    // The Openplanet doc shows an id-to-name route; the official public API also offers display name lookup. :contentReference[oaicite:7]{index=7}
    // We’ll use the public API route:
    // GET /api/display-names/account-ids?accountId[]=... (documented in official doc)
    const url = new URL("https://api.trackmania.com/api/display-names/account-ids");
    for (const id of batch) url.searchParams.append("accountId[]", id);

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${oauthToken}` },
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Name resolve failed: ${r.status} ${txt}`);
    }

    const j = await r.json();

    // The response format can vary; normalize:
    // Expect either [{accountId, displayName}] or {accountId: displayName}
    if (Array.isArray(j)) {
      for (const row of j) {
        if (row && row.accountId && row.displayName) out[row.accountId] = row.displayName;
      }
    } else if (j && typeof j === "object") {
      for (const [k, v] of Object.entries(j)) {
        if (typeof v === "string") out[k] = v;
        else if (v && typeof v === "object" && typeof v.displayName === "string") out[k] = v.displayName;
      }
    }
  }

  return out;
}

// ---- Nadeo Live Leaderboard fetch ----
// You already fetch TOTD data, so you already have a working Nadeo auth approach.
// Plug your existing token logic into this function.
// The leaderboard endpoint is part of the Live API. :contentReference[oaicite:8]{index=8}
async function getNadeoLiveToken() {
  // OPTION A (recommended): copy/paste/reuse whatever your scripts/totd-fetcher.js uses.
  // If your TOTD fetcher writes a token to env or a file, read it here.
  //
  // For now, we support a simple environment variable:
  //   NADEO_LIVE_TOKEN = already-built bearer token
  const token = process.env.NADEO_LIVE_TOKEN;
  if (!token) {
    throw new Error(
      "Missing NADEO_LIVE_TOKEN. Easiest fix: set it the same way your totd-fetcher.js does, or export NADEO_LIVE_TOKEN in the workflow."
    );
  }
  return token;
}

async function fetchTopRecordsForMap(mapUid, nadeoLiveToken, length = 10) {
  // Using Openplanet Live API docs: “Get map leaderboards” / “top records”. :contentReference[oaicite:9]{index=9}
  // Typical pattern:
  //   GET https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/Personal_Best/map/{mapUid}/top?onlyWorld=true&length=10&offset=0
  // Response includes accountId + score/time.
  const url = `https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(
    mapUid
  )}/top?onlyWorld=true&length=${length}&offset=0`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${nadeoLiveToken}` },
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Leaderboard fetch failed for map ${mapUid}: ${r.status} ${txt}`);
  }

  const j = await r.json();

  // Normalize to [{rank, accountId, timeMs}]
  // Many responses look like { tops: [{position, accountId, score}] } where score is time in ms.
  const rows =
    (j && Array.isArray(j.tops) && j.tops) ||
    (j && Array.isArray(j.top) && j.top) ||
    (Array.isArray(j) ? j : []);

  return rows
    .map((row) => ({
      rank: row.position ?? row.rank ?? row.pos ?? null,
      accountId: row.accountId ?? row.playerId ?? row.account_id ?? null,
      timeMs: row.score ?? row.time ?? row.timeMs ?? null,
    }))
    .filter((x) => x.rank != null && x.accountId && x.timeMs != null)
    .sort((a, b) => a.rank - b.rank);
}

// ---- Aggregation ----
function buildAggregate(weekFiles) {
  const byPlayer = new Map();

  for (const wf of weekFiles) {
    const week = wf.week;
    const mapUid = wf.mapUid;

    const entries = wf.entries || [];
    for (const e of entries) {
      const name = e.player;
      if (!name) continue;

      if (!byPlayer.has(name)) {
        byPlayer.set(name, {
          player: name,
          wins: 0,
          wrs: 0,
          top5: 0,
          weeksWon: [],
          wrWeeks: [],
          top5Weeks: [],
        });
      }

      const p = byPlayer.get(name);

      if (e.rank === 1) {
        p.wins += 1;
        p.weeksWon.push(week);
      }
      if (e.isWr) {
        p.wrs += 1;
        p.wrWeeks.push({ week, mapUid, timeMs: e.timeMs });
      }
      if (e.rank <= 5) {
        p.top5 += 1;
        p.top5Weeks.push({ week, mapUid, rank: e.rank, timeMs: e.timeMs });
      }
    }
  }

  // sort / stable output
  const players = [...byPlayer.values()].map((p) => ({
    ...p,
    weeksWon: [...new Set(p.weeksWon)].sort((a, b) => a - b),
  }));

  return {
    generatedAt: isoNow(),
    players,
  };
}

function pickWrEntry(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  // assuming rank 1 is WR (global pb leaderboard)
  const first = entries.find((e) => e.rank === 1);
  return first || entries[0];
}

// ---- Main ----
async function main() {
  ensureDir(BASE_DIR);
  ensureDir(WEEKS_DIR);

  const weeksIndex = readJson(WEEKS_INDEX_PATH, null);
  if (!weeksIndex || !Array.isArray(weeksIndex.weeks)) {
    throw new Error(`Missing or invalid ${path.relative(ROOT, WEEKS_INDEX_PATH)} (needs {"weeks":[...]})`);
  }

  const nameCache = readJson(NAME_CACHE_PATH, {});
  const snapshots = readJson(SNAPSHOT_PATH, {});
  const changelog = readJson(CHANGELOG_PATH, { items: [] });

  const nadeoLiveToken = await getNadeoLiveToken();
  const oauthToken = await getTrackmaniaOAuthToken();

  const weekOutputs = [];

  for (const w of weeksIndex.weeks) {
    const weekNum = w.week;
    const mapUid = w.mapUid;
    const mapName = w.mapName || `Week ${weekNum}`;
    const endedAt = w.endedAt;

    if (!weekNum || !mapUid) continue;

    const records = await fetchTopRecordsForMap(mapUid, nadeoLiveToken, 10);

    // resolve accountIds -> names (cached)
    const missing = records.map((r) => r.accountId).filter((id) => !nameCache[id]);
    if (missing.length) {
      const resolved = await resolveNames(missing, oauthToken);
      for (const [id, nm] of Object.entries(resolved)) nameCache[id] = nm;
      // any remaining unknown ids just stay as id (still deterministic)
      for (const id of missing) if (!nameCache[id]) nameCache[id] = id;
    }

    const entries = records.map((r) => ({
      rank: r.rank,
      player: nameCache[r.accountId] || r.accountId,
      timeMs: r.timeMs,
      isWr: r.rank === 1,
      isWinner: r.rank === 1,
    }));

    // write week file
    const weekJson = {
      week: weekNum,
      mapUid,
      mapName,
      endedAt,
      entries,
    };

    const weekPath = path.join(WEEKS_DIR, `${weekNum}.json`);
    writeJson(weekPath, weekJson);
    weekOutputs.push(weekJson);

    // WR-at-end snapshot + post-week improvement detection
    if (endedAt) {
      const now = Date.now();
      const endedMs = new Date(endedAt).getTime();

      const wrNow = pickWrEntry(entries);
      if (wrNow && !Number.isNaN(endedMs) && now >= endedMs) {
        const snapKey = String(weekNum);
        const snap = snapshots[snapKey];

        // if no snapshot exists, create it (WR at end moment, first time we see it after endedAt)
        if (!snap) {
          snapshots[snapKey] = {
            week: weekNum,
            mapUid,
            mapName,
            endedAt,
            player: wrNow.player,
            timeMs: wrNow.timeMs,
            capturedAt: isoNow(),
          };
        } else {
          // if WR improved after week end, log it
          if (wrNow.timeMs < snap.timeMs) {
            const item = {
              at: isoNow(),
              type: "WR_IMPROVED_AFTER_WEEK",
              week: weekNum,
              mapUid,
              playerNew: wrNow.player,
              timeNewMs: wrNow.timeMs,
              playerPrev: snap.player,
              timePrevMs: snap.timeMs,
            };
            changelog.items = Array.isArray(changelog.items) ? changelog.items : [];
            changelog.items.push(item);

            // update snapshot to new best for subsequent comparisons
            snapshots[snapKey] = {
              ...snap,
              player: wrNow.player,
              timeMs: wrNow.timeMs,
              capturedAt: isoNow(),
            };
          }
        }
      }
    }
  }

  // write caches + aggregate + changelog
  writeJson(NAME_CACHE_PATH, nameCache);
  writeJson(SNAPSHOT_PATH, snapshots);

  const agg = buildAggregate(weekOutputs);
  writeJson(AGG_PATH, agg);

  // keep changelog newest-first on disk
  if (Array.isArray(changelog.items)) {
    changelog.items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }
  writeJson(CHANGELOG_PATH, changelog);

  console.log("Weekly Shorts update complete.");
  console.log(`Wrote: ${path.relative(ROOT, AGG_PATH)}`);
  console.log(`Wrote: ${path.relative(ROOT, CHANGELOG_PATH)}`);
  console.log(`Weeks: ${weekOutputs.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
