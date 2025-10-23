import express from "express";
import fetch from "node-fetch";

const app = express();

/** ---------- Config ---------- */
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const CORE_BASE = "https://prod.trackmania.core.nadeo.online";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min cache
const MAP_BATCH = 100;               // map info batch size
const NAME_BATCH = 100;              // display name batch size
const CONCURRENCY = 8;               // polite concurrency

// Caches
let wrCache = { ts: 0, rows: [] };   // [{mapUid, accountId, displayName, timeMs, timestamp, mapName, authorName, sourceType, sourceLabel}]
let nameCache = new Map();           // accountId -> displayName
let mapInfoCache = new Map();        // mapUid -> {name, authorName}

/** ---------- CORS (allow your site) ---------- */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allow = new Set([
    "https://trackmaniaevents.com",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
  ]);
  if (origin && allow.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/** ---------- Auth using your REFRESH_TOKEN ---------- */
// NOTE: REFRESH_TOKEN must be for audience: NadeoLiveServices
async function getLiveAccessToken() {
  const refresh = process.env.REFRESH_TOKEN;
  if (!refresh) throw new Error("Missing REFRESH_TOKEN env var");

  const r = await fetch(`${CORE_BASE}/v2/authentication/token/refresh`, {
    method: "POST",
    headers: {
      "Authorization": `nadeo_v1 t=${refresh}`,
      "Content-Type": "application/json",
      "User-Agent": "trackmaniaevents.com/1.0"
    },
    body: "{}"
  });
  if (!r.ok) throw new Error(`refresh failed ${r.status} ${await r.text()}`);
  const j = await r.json();
  const token = j.accessToken || j.access_token;
  if (!token) throw new Error("no accessToken in refresh response");
  return token;
}

/** ---------- helpers ---------- */
async function jget(url, token) {
  const r = await fetch(url, {
    headers: {
      "Authorization": `nadeo_v1 t=${token}`,
      "User-Agent": "trackmaniaevents.com/1.0"
    }
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** ---------- Sources (Official campaigns + TOTD seasons) ---------- */
// Returns an array of { mapUid, sourceType: 'official'|'totd', sourceLabel: 'Fall 2025'|'2024-11 (TOTD)' }
async function getAllMapsWithSource(token) {
  const [official, totd] = await Promise.all([
    jget(`${LIVE_BASE}/api/campaign/official?offset=0&length=200`, token),
    jget(`${LIVE_BASE}/api/totd/season?offset=0&length=200`, token)
  ]);

  const officialRows = (official.campaignList || []).flatMap(c => {
    const label = c.name || c.seasonName || "Official Campaign";
    const playlist = c.playlist || [];
    return playlist.map(p => ({ mapUid: p.mapUid, sourceType: "official", sourceLabel: label }));
  });

  const totdRows = (totd.seasonList || []).flatMap(s => {
    // season label like YYYY-MM (or s.name if present)
    const year = s.year ?? s.seasonYear;
    const month = s.month ?? s.seasonMonth;
    const label = s.name || (year && month ? `${year}-${String(month).padStart(2, "0")} (TOTD)` : "TOTD");
    const days = s.days || [];
    return days.map(d => ({ mapUid: d.mapUid, sourceType: "totd", sourceLabel: label }));
  });

  // unique by mapUid; keep first source label encountered
  const seen = new Set();
  const merged = [];
  for (const r of [...officialRows, ...totdRows]) {
    if (!r.mapUid || seen.has(r.mapUid)) continue;
    seen.add(r.mapUid);
    merged.push(r);
  }
  return merged;
}

/** ---------- Map metadata ---------- */
async function hydrateMapInfo(token, mapUids) {
  const need = mapUids.filter(uid => uid && !mapInfoCache.has(uid));
  if (!need.length) return;

  // live endpoint accepts mapUidList (comma-separated)
  // https://live-services.trackmania.nadeo.live/api/token/map/get-multiple?mapUidList=...
  for (const batch of chunk(need, MAP_BATCH)) {
    const url = `${LIVE_BASE}/api/token/map/get-multiple?mapUidList=${encodeURIComponent(batch.join(","))}`;
    try {
      const j = await jget(url, token);
      const rows = j?.mapList || j || [];
      for (const m of rows) {
        if (m?.mapUid) {
          mapInfoCache.set(m.mapUid, {
            name: m?.name || "Unknown map",
            authorName: m?.authorDisplayName || m?.author || "Unknown"
          });
        }
      }
    } catch (e) {
      console.error("map info batch failed:", e.message);
    }
  }
}

/** ---------- WR for a map ---------- */
// Use global PB group for world leaderboard; onlyWorld=true to restrict to WRs
// Docs: groupUid "Personal_Best" is the global map leaderboard, "onlyWorld=true" exposes WRs. 
async function getMapWR(token, mapUid) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${mapUid}/top?onlyWorld=true&length=1`;
  const j = await jget(url, token);
  const top = j?.tops?.[0]?.top?.[0];
  if (!top) return null;
  return {
    mapUid,
    accountId: top.accountId,
    timeMs: top.score,
    timestamp: top.timestamp // unix ms per API; if ISO, Date.parse works the same in sort below
  };
}

/** ---------- Resolve many accountIds -> displayName ---------- */
async function resolveDisplayNames(token, accountIds) {
  const ids = Array.from(new Set(accountIds.filter(Boolean).filter(id => !nameCache.has(id))));
  if (!ids.length) return;

  for (const batch of chunk(ids, NAME_BATCH)) {
    // NOTE: This Live endpoint commonly works for user tokens. If your token ever stops
    // resolving names, switch to the public OAuth endpoint (api.trackmania.com) instead.
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${encodeURIComponent(batch.join(","))}`;
    try {
      const j = await jget(url, token);
      const rows = j?.displayNames || j || [];
      for (const r of rows) {
        if (r?.accountId && r?.displayName) nameCache.set(r.accountId, r.displayName);
      }
    } catch (e) {
      console.error("name batch failed:", e.message);
      // Fallback: keep IDs (frontend can gray these)
      for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
    }
  }
}

/** ---------- Build combined WR set (official + TOTD) ---------- */
async function buildAllWRs() {
  const token = await getLiveAccessToken();
  const maps = await getAllMapsWithSource(token); // [{mapUid, sourceType, sourceLabel}]
  const uids = maps.map(m => m.mapUid);

  // hydrate map metadata first
  await hydrateMapInfo(token, uids);

  // fetch WRs with gentle concurrency
  const wrs = [];
  for (let i = 0; i < uids.length; i += CONCURRENCY) {
    const part = await Promise.all(
      uids.slice(i, i + CONCURRENCY).map(uid => getMapWR(token, uid).catch(() => null))
    );
    for (const r of part) if (r) wrs.push(r);
  }

  // add map/source meta
  const byUid = new Map(maps.map(m => [m.mapUid, m]));
  for (const r of wrs) {
    const meta = mapInfoCache.get(r.mapUid) || {};
    const src = byUid.get(r.mapUid) || {};
    r.mapName = meta.name || "Unknown map";
    r.authorName = meta.authorName || "Unknown";
    r.sourceType = src.sourceType || "unknown";
    r.sourceLabel = src.sourceLabel || "Unknown";
  }

  // resolve display names
  await resolveDisplayNames(token, wrs.map(r => r.accountId));
  for (const r of wrs) r.displayName = nameCache.get(r.accountId) || r.accountId;

  // newest first (timestamp can be number or ISO; normalize)
  wrs.sort((a, b) => (Number(b.timestamp) || Date.parse(b.timestamp) || 0) - (Number(a.timestamp) || Date.parse(a.timestamp) || 0));

  wrCache = { ts: Date.now(), rows: wrs };
  return wrs;
}

/** ---------- Endpoints ---------- */

// Latest WRs across ALL official campaigns + ALL TOTD seasons.
// Optional query params:
//   ?limit=200  -> limit number of rows (default 200)
//   ?source=official|totd (optional filter)
//   ?search=abc -> case-insensitive substring filter on map name or player name
app.get("/api/wr-latest", async (req, res) => {
  try {
    const fresh = Date.now() - wrCache.ts < CACHE_TTL_MS && wrCache.rows.length;
    const rows = fresh ? wrCache.rows : await buildAllWRs();

    let out = rows;
    const { source, search } = req.query;
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));

    if (source === "official" || source === "totd") {
      out = out.filter(r => r.sourceType === source);
    }
    if (search && typeof search === "string") {
      const q = search.toLowerCase();
      out = out.filter(r =>
        (r.mapName || "").toLowerCase().includes(q) ||
        (r.displayName || "").toLowerCase().includes(q)
      );
    }

    res.json({
      rows: out.slice(0, limit),
      total: out.length,
      fetchedAt: wrCache.ts
    });
  } catch (err) {
    console.error("wr-latest:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to load latest world records" });
  }
});

// Players leaderboard across ALL official + TOTD WRs
// Optional: ?limit=100
app.get("/api/wr-players", async (req, res) => {
  try {
    if (!wrCache.rows.length || Date.now() - wrCache.ts >= CACHE_TTL_MS) {
      await buildAllWRs();
    }

    const counts = new Map(); // displayName -> {displayName, accountId, wrCount, latestTs}
    for (const r of wrCache.rows) {
      const name = r.displayName || r.accountId;
      const rec = counts.get(name) || { displayName: name, accountId: r.accountId, wrCount: 0, latestTs: 0 };
      rec.wrCount += 1;
      const ts = Number(r.timestamp) || Date.parse(r.timestamp) || 0;
      if (ts > rec.latestTs) rec.latestTs = ts;
      counts.set(name, rec);
    }

    const players = Array.from(counts.values()).sort(
      (a, b) => (b.wrCount - a.wrCount) || (b.latestTs - a.latestTs)
    );

    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
    res.json({ players: players.slice(0, limit), total: players.length, fetchedAt: wrCache.ts });
  } catch (err) {
    console.error("wr-players:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to load WR players" });
  }
});

// Simple health
app.get("/", (_req, res) => res.send("OK"));

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on :${PORT}`));
