import express from "express";
import fetch from "node-fetch";

const app = express();

/** ---------- Config ---------- */
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const CORE_BASE = "https://prod.trackmania.core.nadeo.online";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min cache

// Caches
let wrCache = { ts: 0, rows: [] };       // [{mapUid, accountId, displayName, timeMs, timestamp}]
let nameCache = new Map();               // accountId -> displayName

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
// Set in Render → Environment → REFRESH_TOKEN (audience: NadeoLiveServices)
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

// Get *all* official campaigns and all TOTD seasons -> mapUids[]
async function getAllMapUids(token) {
  const [off, totd] = await Promise.all([
    jget(`${LIVE_BASE}/api/campaign/official?offset=0&length=200`, token),
    jget(`${LIVE_BASE}/api/totd/season?offset=0&length=200`, token)
  ]);

  const officialUids = (off.campaignList || []).flatMap(c => (c.playlist || []).map(p => p.mapUid));
  const totdUids = (totd.seasonList || []).flatMap(s => (s.days || []).map(d => d.mapUid));

  // unique
  return Array.from(new Set([...officialUids, ...totdUids]));
}

// Get WR (top 1) for a map using the correct groupUid
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
    timestamp: top.timestamp
  };
}

// Resolve many accountIds -> displayName (batched)
async function resolveDisplayNames(token, accountIds) {
  const ids = Array.from(new Set(accountIds.filter(Boolean).filter(id => !nameCache.has(id))));
  if (!ids.length) return;

  const chunk = 100;
  for (let i = 0; i < ids.length; i += chunk) {
    const batch = ids.slice(i, i + chunk);
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${encodeURIComponent(batch.join(","))}`;
    try {
      const j = await jget(url, token);
      const rows = j?.displayNames || j || [];
      for (const r of rows) {
        if (r?.accountId && r?.displayName) nameCache.set(r.accountId, r.displayName);
      }
    } catch(e) {
      // don't fail whole build on one name fetch; skip
      console.error("name batch failed:", e.message);
    }
  }
}

/** ---------- Build combined WR set (official + TOTD) ---------- */
async function buildAllWRs() {
  const token = await getLiveAccessToken();
  const uids = await getAllMapUids(token);

  const limit = 8; // polite concurrency
  const wrs = [];
  for (let i = 0; i < uids.length; i += limit) {
    const part = await Promise.all(uids.slice(i, i + limit).map(uid => getMapWR(token, uid).catch(() => null)));
    for (const row of part) if (row) wrs.push(row);
  }

  // resolve display names in batches
  await resolveDisplayNames(token, wrs.map(r => r.accountId));
  for (const r of wrs) r.displayName = nameCache.get(r.accountId) || r.accountId;

  // newest first
  wrs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  wrCache = { ts: Date.now(), rows: wrs };
  return wrs;
}

/** ---------- Endpoints ---------- */

// Combined WR list (Official + TOTD)
app.get("/api/wr-leaderboard", async (_req, res) => {
  try {
    const fresh = Date.now() - wrCache.ts < CACHE_TTL_MS && wrCache.rows.length;
    const rows = fresh ? wrCache.rows : await buildAllWRs();
    res.json({ rows, fetchedAt: wrCache.ts });
  } catch (err) {
    console.error("wr-leaderboard:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to load WR leaderboard" });
  }
});

// Who holds the most WRs across combined set
app.get("/api/wr-players", async (req, res) => {
  try {
    if (!wrCache.rows.length || Date.now() - wrCache.ts >= CACHE_TTL_MS) {
      await buildAllWRs();
    }
    const counts = new Map(); // displayName -> {displayName, accountIds:Set, wrCount, latestTs}
    for (const r of wrCache.rows) {
      const name = r.displayName || r.accountId;
      const rec = counts.get(name) || { displayName: name, wrCount: 0, latestTs: 0 };
      rec.wrCount += 1;
      if ((r.timestamp || 0) > rec.latestTs) rec.latestTs = r.timestamp || 0;
      counts.set(name, rec);
    }
    const players = Array.from(counts.values()).sort(
      (a, b) => (b.wrCount - a.wrCount) || (b.latestTs - a.latestTs)
    );
    res.json({ players, fetchedAt: wrCache.ts });
  } catch (err) {
    console.error("wr-players:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to load WR players" });
  }
});

// health
app.get("/", (_req, res) => res.send("OK"));

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on :${PORT}`));
