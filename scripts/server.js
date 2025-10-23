import express from "express";
import fetch from "node-fetch";

/**
 * ENV required on Render:
 *   REFRESH_TOKEN = <your Nadeo refresh token (audience NadeoLiveServices)>
 *
 * Optional:
 *   CORS_ORIGINS = comma-separated list of extra origins allowed to call this API
 */

const app = express();

// ---------- CORS ----------
const DEFAULT_ORIGINS = new Set([
  "https://trackmaniaevents.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
]);
const EXTRA = (process.env.CORS_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const ALLOW = new Set([...DEFAULT_ORIGINS, ...EXTRA]);

app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ALLOW.has(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------- Health ----------
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Auth: refresh -> live access ----------
const NADEO_REFRESH = process.env.REFRESH_TOKEN;
const CORE_REFRESH_URL = "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";
let cachedAccess = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedAccess.token && now < cachedAccess.expAt - 30_000) return cachedAccess.token;
  if (!NADEO_REFRESH) throw new Error("Missing REFRESH_TOKEN");

  const r = await fetch(CORE_REFRESH_URL, {
    method: "POST",
    headers: {
      "Authorization": `nadeo_v1 t=${NADEO_REFRESH}`,
      "Content-Type": "application/json",
      "User-Agent": "trackmaniaevents.com/1.0 (Render)"
    },
    body: "{}"
  });
  if (!r.ok) throw new Error(`refresh failed ${r.status} ${await r.text()}`);
  const j = await r.json();
  const accessToken = j.accessToken || j.access_token;
  const expiresIn = j.expiresIn || j.expires_in || 3600;
  if (!accessToken) throw new Error("no accessToken in refresh response");
  cachedAccess = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
  return cachedAccess.token;
}

// ---------- Live Services helpers ----------
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";

// Current official campaign (v2)
async function getCurrentCampaign(accessToken) {
  const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=1`;
  const r = await fetch(url, {
    headers: { "Authorization": `nadeo_v1 t=${accessToken}`, "User-Agent": "trackmaniaevents.com/1.0 (Render)" }
  });
  if (!r.ok) throw new Error(`campaign fetch ${r.status}`);
  const j = await r.json();
  const c = j?.campaignList?.[0];
  if (!c) throw new Error("no campaign returned");
  return {
    id: c.id,
    name: c.name,
    start: c.startTimestamp,
    end: c.endTimestamp,
    mapUids: (c.playlist || []).map(p => p.mapUid)
  };
}

// World record (top 1 world) for a map (groupUid = Personal_Best)
async function getMapWR(accessToken, mapUid) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${mapUid}/top?onlyWorld=true&length=1`;
  const r = await fetch(url, {
    headers: { "Authorization": `nadeo_v1 t=${accessToken}`, "User-Agent": "trackmaniaevents.com/1.0 (Render)" }
  });
  if (!r.ok) return { mapUid, error: `leaderboard ${r.status}` };
  const j = await r.json();
  const top = j?.tops?.[0]?.top?.[0];
  if (!top) return { mapUid, empty: true };
  return { mapUid, accountId: top.accountId, timeMs: top.score, timestamp: top.timestamp };
}

/**
 * Resolve display names for a batch of accountIds.
 * LiveServices provides a display-name endpoint that accepts a list.
 * If it fails for any reason, we gracefully return the IDs unchanged.
 */
async function resolveDisplayNames(accessToken, ids) {
  const out = new Map();
  const want = Array.from(new Set(ids.filter(Boolean)));
  if (!want.length) return out;

  // Endpoint accepts up to ~100 per call; chunk politely.
  const chunkSize = 100;
  for (let i = 0; i < want.length; i += chunkSize) {
    const batch = want.slice(i, i + chunkSize);
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${encodeURIComponent(batch.join(","))}`;
    const r = await fetch(url, {
      headers: { "Authorization": `nadeo_v1 t=${accessToken}`, "User-Agent": "trackmaniaevents.com/1.0 (Render)" }
    });
    if (!r.ok) continue; // keep IDs if this fails
    const j = await r.json();
    // Expecting { displayNames: [{accountId, displayName}, ...] }
    const arr = j?.displayNames || j || [];
    for (const row of arr) {
      if (row?.accountId && row?.displayName) out.set(row.accountId, row.displayName);
    }
  }
  return out;
}

// ---------- Cache to avoid hammering API ----------
let wrCache = { ts: 0, data: null };
const WR_TTL_MS = 60 * 1000;

// ---------- /api/wr-leaderboard ----------
app.get("/api/wr-leaderboard", async (_req, res) => {
  try {
    const now = Date.now();
    if (wrCache.data && now - wrCache.ts < WR_TTL_MS) {
      return res.json(wrCache.data);
    }

    const access = await getLiveAccessToken();
    const campaign = await getCurrentCampaign(access);

    const mapUids = campaign.mapUids || [];
    const limit = 6;
    const results = [];
    for (let i = 0; i < mapUids.length; i += limit) {
      const part = await Promise.all(mapUids.slice(i, i + limit).map(uid => getMapWR(access, uid)));
      results.push(...part);
    }

    // Resolve display names
    const idList = results.map(r => r.accountId).filter(Boolean);
    const nameMap = await resolveDisplayNames(access, idList);
    for (const r of results) {
      if (r.accountId && nameMap.has(r.accountId)) r.displayName = nameMap.get(r.accountId);
    }

    // Sort by set time DESC so the most recently set WRs are at top
    results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const payload = {
      campaign: { id: campaign.id, name: campaign.name, start: campaign.start, end: campaign.end },
      rows: results,       // [{mapUid, accountId, displayName, timeMs, timestamp, ...}]
      fetchedAt: now
    };

    wrCache = { ts: now, data: payload };
    return res.json(payload);
  } catch (err) {
    console.error("WR leaderboard error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Failed to load leaderboard", detail: err?.message || String(err) });
    }
  }
});

/**
 * NEW: /api/wr-players
 * Aggregates rows by player and returns:
 *   [{ accountId, displayName?, wrCount, latestTs }]
 * Supports search: /api/wr-players?q=partOfName (case-insensitive, matches displayName or accountId).
 */
app.get("/api/wr-players", async (req, res) => {
  try {
    // ensure we have fresh wrCache
    const now = Date.now();
    if (!wrCache.data || now - wrCache.ts >= WR_TTL_MS) {
      // prime by calling the leaderboard route internally
      const access = await getLiveAccessToken();
      const campaign = await getCurrentCampaign(access);
      const mapUids = campaign.mapUids || [];
      const limit = 6;
      const rows = [];
      for (let i = 0; i < mapUids.length; i += limit) {
        const part = await Promise.all(mapUids.slice(i, i + limit).map(uid => getMapWR(access, uid)));
        rows.push(...part);
      }
      const idList = rows.map(r => r.accountId).filter(Boolean);
      const nameMap = await resolveDisplayNames(access, idList);
      for (const r of rows) {
        if (r.accountId && nameMap.has(r.accountId)) r.displayName = nameMap.get(r.accountId);
      }
      wrCache = {
        ts: now,
        data: {
          campaign: { id: campaign.id, name: campaign.name, start: campaign.start, end: campaign.end },
          rows,
          fetchedAt: now
        }
      };
    }

    const q = (req.query.q || "").toString().trim().toLowerCase();
    const tally = new Map();

    for (const r of (wrCache.data.rows || [])) {
      const id = r.accountId || "unknown";
      const name = r.displayName || "";
      const rec = tally.get(id) || { accountId: id, displayName: name, wrCount: 0, latestTs: 0 };
      rec.wrCount += 1;
      rec.displayName = rec.displayName || name;
      if ((r.timestamp || 0) > rec.latestTs) rec.latestTs = r.timestamp || 0;
      tally.set(id, rec);
    }

    let list = Array.from(tally.values());
    // search filter
    if (q) {
      list = list.filter(p =>
        p.displayName?.toLowerCase().includes(q) || p.accountId.toLowerCase().includes(q)
      );
    }

    // sort by WR count desc, then latestTs desc
    list.sort((a, b) => (b.wrCount - a.wrCount) || (b.latestTs - a.latestTs));

    return res.json({ players: list, fetchedAt: wrCache.data.fetchedAt, campaign: wrCache.data.campaign });
  } catch (err) {
    console.error("WR players error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Failed to load WR players", detail: err?.message || String(err) });
    }
  }
});

/**
 * NEW: /api/wr-recent
 * Convenience endpoint: rows sorted by most recently set WRs.
 */
app.get("/api/wr-recent", (_req, res) => {
  if (!wrCache.data) return res.status(503).json({ error: "cache not primed yet" });
  const rows = [...(wrCache.data.rows || [])].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return res.json({ rows, fetchedAt: wrCache.data.fetchedAt, campaign: wrCache.data.campaign });
});

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on port ${PORT}`));
