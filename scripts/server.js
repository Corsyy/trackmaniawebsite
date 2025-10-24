import express from "express";
import fetch from "node-fetch";

/**
 * ENV on Render (you already have these):
 *   REFRESH_TOKEN = <NadeoLiveServices refresh token>
 *   CLIENT_ID = <api.trackmania.com client_id>
 *   CLIENT_SECRET = <api.trackmania.com client_secret>
 * Optional:
 *   CORS_ORIGINS = comma-separated list of extra origins
 */

const app = express();

/* --------------------------- CORS --------------------------- */
const DEFAULT_ORIGINS = new Set([
  "https://trackmaniaevents.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);
const EXTRA = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
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

/* ------------------------- Health -------------------------- */
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* -------------------- Auth (refresh -> access) -------------- */
// Nadeo Live (refresh -> access token) for leaderboards & campaign/month
const NADEO_REFRESH = process.env.REFRESH_TOKEN;
const CORE_REFRESH_URL =
  "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";
let cachedAccess = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedAccess.token && now < cachedAccess.expAt - 30_000)
    return cachedAccess.token;
  if (!NADEO_REFRESH) throw new Error("Missing REFRESH_TOKEN");

  const r = await fetch(CORE_REFRESH_URL, {
    method: "POST",
    headers: {
      Authorization: `nadeo_v1 t=${NADEO_REFRESH}`,
      "Content-Type": "application/json",
      "User-Agent": "trackmaniaevents.com/1.0 (Render)",
    },
    body: "{}",
  });
  if (!r.ok) throw new Error(`refresh failed ${r.status} ${await r.text()}`);
  const j = await r.json();
  const accessToken = j.accessToken || j.access_token;
  const expiresIn = j.expiresIn || j.expires_in || 3600;
  if (!accessToken) throw new Error("no accessToken in refresh response");
  cachedAccess = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
  return cachedAccess.token;
}

/* ---------------- OAuth (api.trackmania.com) ---------------- */
// Public OAuth (client credentials) for display-name resolution
const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;
let cachedOAuth = { token: null, expAt: 0 };

async function getOAuthToken() {
  const now = Date.now();
  if (cachedOAuth.token && now < cachedOAuth.expAt - 30_000)
    return cachedOAuth.token;
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET)
    throw new Error("Missing CLIENT_ID / CLIENT_SECRET");

  const r = await fetch("https://api.trackmania.com/api/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "trackmaniaevents.com/1.0 (Render)",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    }).toString(),
  });
  if (!r.ok) throw new Error(`oauth token failed ${r.status} ${await r.text()}`);
  const j = await r.json();
  const accessToken = j.access_token || j.accessToken;
  const expiresIn = j.expires_in || 3600;
  if (!accessToken) throw new Error("no OAuth access_token");
  cachedOAuth = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
  return cachedOAuth.token;
}

/* ------------------ Live Services helpers ------------------ */
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";

async function jget(url, accessToken) {
  const r = await fetch(url, {
    headers: {
      Authorization: `nadeo_v1 t=${accessToken}`,
      "User-Agent": "trackmaniaevents.com/1.0 (Render)",
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/* ---------------- Official campaigns (Nadeo) --------------- */
async function getAllOfficialCampaigns(accessToken) {
  // length=200 is enough for all seasonal campaigns so far
  const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=200`;
  const j = await jget(url, accessToken);
  return j?.campaignList || [];
}

/* -------------------- TOTD via Live API -------------------- */
/**
 * We list all month entries from 2020-07 to current month using
 * /api/token/campaign/month?length=X&offset=Y
 * Each month has days[].mapUid
 */
function countMonthsFrom2020July() {
  const start = new Date(Date.UTC(2020, 6, 1)); // 2020-07-01
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let count = 0;
  for (
    let d = start;
    d <= end;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  ) {
    count++;
  }
  return count;
}

async function getTotdMonthsFromLive(accessToken) {
  const total = countMonthsFrom2020July();
  const months = [];
  const BATCH = 24; // fetch in chunks (be polite)
  // Offset is zero-based from oldest; we want all, so walk backwards in batches
  for (let offset = total - 1; offset >= 0; offset -= BATCH) {
    const len = Math.min(BATCH, offset + 1);
    const url = `${LIVE_BASE}/api/token/campaign/month?length=${len}&offset=${offset}`;
    const j = await jget(url, accessToken);
    const list = j?.monthList || [];
    months.push(...list);
    // tiny delay to reduce risk of 429 in shared hosting
    await new Promise((r) => setTimeout(r, 60));
  }
  return months;
}

async function getAllTotdMapUidsViaLive(accessToken) {
  const months = await getTotdMonthsFromLive(accessToken);
  const uids = new Set();
  for (const m of months) {
    const days = Array.isArray(m?.days) ? m.days : [];
    for (const d of days) if (d?.mapUid) uids.add(d.mapUid);
  }
  return Array.from(uids);
}

/* -------------------- Map UID collection ------------------- */
function collectAllMapUidsFromOfficialAndTotd(officialCampaigns, totdUidsList) {
  const officialUids = officialCampaigns.flatMap((c) =>
    (c.playlist || []).map((p) => p.mapUid)
  );
  const totdUids = Array.isArray(totdUidsList) ? totdUidsList : [];
  return {
    all: Array.from(new Set([...officialUids, ...totdUids])),
    officialSet: new Set(officialUids),
  };
}

/* ---------------- Time, WR fetch, names -------------------- */
function normalizeToSeconds(val) {
  if (val == null) return 0;
  let n = Number(val);
  if (Number.isFinite(n)) {
    if (n > 1e12) return Math.round(n / 1000); // ms -> s
    return Math.round(n);
  }
  const parsed = Date.parse(String(val));
  if (Number.isFinite(parsed)) {
    return parsed > 1e12 ? Math.round(parsed / 1000) : Math.round(parsed);
  }
  return 0;
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
      timestamp: normalizeToSeconds(top.timestamp),
    };
  } catch (e) {
    return { mapUid, error: e.message || "leaderboard fetch failed" };
  }
}

/* ---------------------- Display names ---------------------- */
const nameCache = new Map(); // accountId -> displayName

// Use public OAuth API (client-credentials) to resolve display names
async function resolveDisplayNames(_liveAccessToken, ids) {
  const all = Array.from(new Set((ids || []).filter(Boolean)));
  const need = all.filter((id) => !nameCache.has(id));
  if (!need.length) return nameCache;

  const oToken = await getOAuthToken();
  const CHUNK = 50; // API supports batch via accountId[]
  for (let i = 0; i < need.length; i += CHUNK) {
    const batch = need.slice(i, i + CHUNK);
    const params = new URLSearchParams();
    for (const id of batch) params.append("accountId[]", id);

    try {
      const r = await fetch(
        `https://api.trackmania.com/api/display-names?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${oToken}`,
            Accept: "application/json",
            "User-Agent": "trackmaniaevents.com/1.0 (Render)",
          },
        }
      );
      if (!r.ok) {
        // map to IDs rather than failing hard
        for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
        continue;
      }
      // Response is an object: { "<accountId>": "DisplayName", ... }
      const j = await r.json();
      for (const id of batch) {
        const dn = j?.[id];
        nameCache.set(id, (typeof dn === "string" && dn) || id);
      }
    } catch {
      // fallback to ids on error
      for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
    }
    // small delay to be gentle
    await new Promise((r) => setTimeout(r, 40));
  }
  return nameCache;
}

/* ------------------------- Cache --------------------------- */
let wrCache = { ts: 0, rows: [] };
const WR_TTL_MS = 10 * 60 * 1000; // 10 min
const CONCURRENCY = 6;

/* --------------- Build ALL WRs (official + TOTD) ----------- */
async function buildAllWRs() {
  const access = await getLiveAccessToken();

  // 1) Official (Nadeo)
  const official = await getAllOfficialCampaigns(access);

  // 2) TOTD UIDs via official Live API (all months since 2020-07)
  const totdUids = await getAllTotdMapUidsViaLive(access);

  // 3) Merge + remember which are official
  const { all: mapUids, officialSet } =
    collectAllMapUidsFromOfficialAndTotd(official, totdUids);

  // 4) Fetch WRs with bounded concurrency
  const wrs = [];
  for (let i = 0; i < mapUids.length; i += CONCURRENCY) {
    const part = await Promise.all(
      mapUids.slice(i, i + CONCURRENCY).map(async (uid) => {
        const row = await getMapWR(access, uid);
        if (!row || row.empty || row.error) return null;
        row.sourceType = officialSet.has(uid) ? "official" : "totd";
        return row;
      })
    );
    wrs.push(...part.filter(Boolean));
  }

  // 5) Resolve names via OAuth Public API
  const idList = wrs.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(access, idList);
  for (const r of wrs) {
    if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;
  }

  // 6) Sort newest first and cache
  wrs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  wrCache = { ts: Date.now(), rows: wrs };
  return wrs;
}

/* ------------------------ Endpoints ------------------------ */

// Most recent WRs across ALL official campaigns + ALL TOTD months
// Optional: ?limit=300  ?search=foo
app.get("/api/wr-latest", async (req, res) => {
  try {
    const fresh = Date.now() - wrCache.ts < WR_TTL_MS && wrCache.rows.length;
    const rows = fresh ? wrCache.rows : await buildAllWRs();

    let out = rows;
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 300));

    const search = (req.query.search || "").toString().trim().toLowerCase();
    if (search) {
      out = out.filter(
        (r) =>
          r.displayName?.toLowerCase().includes(search) ||
          r.accountId?.toLowerCase().includes(search) ||
          r.mapUid?.toLowerCase().includes(search)
      );
    }

    res.json({
      rows: out.slice(0, limit),
      total: out.length,
      fetchedAt: wrCache.ts,
    });
  } catch (err) {
    console.error("wr-latest:", err);
    if (!res.headersSent)
      res.status(500).json({
        error: "Failed to load latest world records",
        detail: err?.message || String(err),
      });
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
      const rec =
        tally.get(r.accountId) || {
          accountId: r.accountId,
          displayName: r.displayName || r.accountId,
          wrCount: 0,
          latestTs: 0,
        };
      rec.wrCount += 1;
      if ((r.timestamp || 0) > rec.latestTs) rec.latestTs = r.timestamp || 0;
      tally.set(r.accountId, rec);
    }

    let list = Array.from(tally.values());
    const q = (req.query.q || "").toString().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.displayName?.toLowerCase().includes(q) ||
          p.accountId?.toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => b.wrCount - a.wrCount || b.latestTs - a.latestTs);
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
    res.json({
      players: list.slice(0, limit),
      total: list.length,
      fetchedAt: wrCache.ts,
    });
  } catch (err) {
    console.error("wr-players:", err);
    if (!res.headersSent)
      res.status(500).json({
        error: "Failed to load WR players",
        detail: err?.message || String(err),
      });
  }
});

/* ---------------- Debug helpers ---------------- */
app.get("/api/debug-names", async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await resolveDisplayNames(null, ids);
    const data = ids.map((id) => ({ id, name: nameCache.get(id) || null }));
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/debug-stats", async (_req, res) => {
  try {
    if (!wrCache.rows.length) await buildAllWRs();
    const rows = wrCache.rows || [];
    const counts = { official: 0, totd: 0 };
    for (const r of rows) {
      if (r.sourceType === "official") counts.official++;
      else if (r.sourceType === "totd") counts.totd++;
    }
    res.json({
      cacheTime: wrCache.ts,
      rows: rows.length,
      counts,
      nameCacheSize: nameCache.size,
      resolvedNamesCount: Array.from(nameCache.values()).filter(
        (v) => v && typeof v === "string" && v !== ""
      ).length,
      unresolvedSample: [],
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ------------------------- Start --------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ API running on port ${PORT}`)
);
