import express from "express";
import fetch from "node-fetch";

/**
 * ENV required on Render:
 *   REFRESH_TOKEN = <NadeoLiveServices refresh token>
 * Optional:
 *   CORS_ORIGINS = comma-separated list of extra origins
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

// ---------- Auth (refresh -> access) ----------
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

async function jget(url, accessToken) {
  const r = await fetch(url, {
    headers: {
      "Authorization": `nadeo_v1 t=${accessToken}`,
      "User-Agent": "trackmaniaevents.com/1.0 (Render)"
    }
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Official campaigns (many)
async function getAllOfficialCampaigns(accessToken) {
  const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=200`;
  const j = await jget(url, accessToken);
  return (j?.campaignList || []);
}

// TOTD seasons (many)
async function getAllTotdSeasons(accessToken) {
  const url = `${LIVE_BASE}/api/totd/season?offset=0&length=200`;
  const j = await jget(url, accessToken);
  return (j?.seasonList || []);
}

// Extract mapUids from both sets
function collectAllMapUids(officialCampaigns, totdSeasons) {
  const officialUids = officialCampaigns.flatMap(c => (c.playlist || []).map(p => p.mapUid));
  const totdUids = totdSeasons.flatMap(s => (s.days || []).map(d => d.mapUid));
  return Array.from(new Set([...officialUids, ...totdUids]));
}

// WR (top1 world) per map
async function getMapWR(accessToken, mapUid) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${mapUid}/top?onlyWorld=true&length=1`;
  try {
    const j = await jget(url, accessToken);
    const top = j?.tops?.[0]?.top?.[0];
    if (!top) return { mapUid, empty: true };
    return {
      mapUid,
      accountId: top.accountId,
      timeMs: top.score,
      timestamp: Number(top.timestamp) || Date.parse(top.timestamp) || 0
    };
  } catch (e) {
    return { mapUid, error: e.message || "leaderboard fetch failed" };
  }
}

// Display names (batched, best-effort)
async function resolveDisplayNames(accessToken, ids) {
  const out = new Map();
  const want = Array.from(new Set(ids.filter(Boolean)));
  if (!want.length) return out;
  const chunkSize = 100;
  for (let i = 0; i < want.length; i += chunkSize) {
    const batch = want.slice(i, i + chunkSize);
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${encodeURIComponent(batch.join(","))}`;
    try {
      const j = await jget(url, accessToken);
      const arr = j?.displayNames || j || [];
      for (const row of arr) {
        if (row?.accountId && row?.displayName) out.set(row.accountId, row.displayName);
      }
    } catch {
      // keep IDs if this fails; don't kill the request
      for (const id of batch) if (!out.has(id)) out.set(id, id);
    }
  }
  return out;
}

// ---------- Cache ----------
let wrCache = { ts: 0, rows: [] };
const WR_TTL_MS = 10 * 60 * 1000; // 10 min
const CONCURRENCY = 8;

// Build everything (all official + all TOTD)
async function buildAllWRs() {
  const access = await getLiveAccessToken();
  const [official, totd] = await Promise.all([
    getAllOfficialCampaigns(access),
    getAllTotdSeasons(access)
  ]);
  const mapUids = collectAllMapUids(official, totd);

  // fetch WRs with polite concurrency
  const wrs = [];
  for (let i = 0; i < mapUids.length; i += CONCURRENCY) {
    const part = await Promise.all(
      mapUids.slice(i, i + CONCURRENCY).map(uid => getMapWR(access, uid))
    );
    wrs.push(...part.filter(Boolean));
  }

  // best-effort names
  const idList = wrs.map(r => r.accountId).filter(Boolean);
  const nameMap = await resolveDisplayNames(access, idList);
  for (const r of wrs) {
    if (r.accountId) r.displayName = nameMap.get(r.accountId) || r.accountId;
  }

  // newest first
  wrs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  wrCache = { ts: Date.now(), rows: wrs };
  return wrs;
}

// ---------- Endpoints ----------

// Most recent WRs across ALL official campaigns + ALL TOTD seasons
// Optional: ?limit=300  ?source=official|totd  ?search=foo
app.get("/api/wr-latest", async (req, res) => {
  try {
    const fresh = Date.now() - wrCache.ts < WR_TTL_MS && wrCache.rows.length;
    const rows = fresh ? wrCache.rows : await buildAllWRs();

    let out = rows;
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 300));

    // NOTE: since we didn't attach source labels in safe-mode,
    // we skip filtering by sourceType to keep things robust.
    // (We can add sourceType and labels after we’re green.)

    const search = (req.query.search || "").toString().trim().toLowerCase();
    if (search) {
      out = out.filter(r =>
        r.displayName?.toLowerCase().includes(search) ||
        r.accountId?.toLowerCase().includes(search) ||
        r.mapUid?.toLowerCase().includes(search)
      );
    }

    res.json({ rows: out.slice(0, limit), total: out.length, fetchedAt: wrCache.ts });
  } catch (err) {
    console.error("wr-latest:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to load latest world records", detail: err?.message || String(err) });
  }
});

// Players leaderboard across ALL official + TOTD WRs
// Optional: ?limit=200  ?q=search
app.get("/api/wr-players", async (req, res) => {
  try {
    if (!wrCache.rows.length || Date.now() - wrCache.ts >= WR_TTL_MS) {
      await buildAllWRs();
    }

    const tally = new Map(); // accountId -> { accountId, displayName, wrCount, latestTs }
    for (const r of wrCache.rows) {
      if (!r.accountId) continue;
      const rec = tally.get(r.accountId) || { accountId: r.accountId, displayName: r.displayName || r.accountId, wrCount: 0, latestTs: 0 };
      rec.wrCount += 1;
      if ((r.timestamp || 0) > rec.latestTs) rec.latestTs = r.timestamp || 0;
      tally.set(r.accountId, rec);
    }

    let list = Array.from(tally.values());
    const q = (req.query.q || "").toString().trim().toLowerCase();
    if (q) {
      list = list.filter(p =>
        p.displayName?.toLowerCase().includes(q) || p.accountId?.toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => (b.wrCount - a.wrCount) || (b.latestTs - a.latestTs));
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
    res.json({ players: list.slice(0, limit), total: list.length, fetchedAt: wrCache.ts });
  } catch (err) {
    console.error("wr-players:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to load WR players", detail: err?.message || String(err) });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on port ${PORT}`));
