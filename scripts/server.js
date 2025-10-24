import express from "express";
import fetch from "node-fetch";

/**
 * ENV required on Render:
 *   REFRESH_TOKEN = <NadeoLiveServices refresh token>
 * Optional:
 *   CORS_ORIGINS = comma-separated list of extra origins
 */

const app = express();

/* ---------------- CORS ---------------- */
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

/* ---------------- Health ---------------- */
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------------- Auth (refresh -> live access) ---------------- */
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

/* ---------------- Upstreams ---------------- */
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const TMIO_BASE = "https://trackmania.io/api";

/* helper GET with auth */
async function jget(url, accessToken, extraHeaders = {}) {
  const r = await fetch(url, {
    headers: {
      ...(accessToken ? { Authorization: `nadeo_v1 t=${accessToken}` } : {}),
      "User-Agent": "trackmaniaevents.com/1.0 (Render)",
      ...extraHeaders,
    },
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/* ---------------- Fetch map sets (official + TOTD) ---------------- */
async function getAllOfficialCampaigns(accessToken) {
  const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=200`;
  const j = await jget(url, accessToken);
  return j?.campaignList || [];
}

async function getAllTotdSeasons(accessToken) {
  // Try tokened and un-tokened variants defensively
  const candidates = [
    `${LIVE_BASE}/api/token/totd/season?offset=0&length=200`,
    `${LIVE_BASE}/api/totd/season?offset=0&length=200`,
  ];
  for (const url of candidates) {
    try {
      const j = await jget(url, accessToken);
      return j?.seasonList || [];
    } catch (e) {
      console.warn("TOTD season fetch failed for", url, "-", e.message);
    }
  }
  console.warn("TOTD season endpoints unavailable; proceeding without TOTD.");
  return [];
}

function collectAllMapUids(officialCampaigns, totdSeasons) {
  const officialUids = officialCampaigns.flatMap((c) =>
    (c.playlist || []).map((p) => p.mapUid)
  );
  const totdUids = totdSeasons.flatMap((s) =>
    (s.days || []).map((d) => d.mapUid)
  );
  return Array.from(new Set([...officialUids, ...totdUids]));
}

/* ---------------- WR per map ---------------- */
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
      timestamp: Number(top.timestamp) || Date.parse(top.timestamp) || 0,
    };
  } catch (e) {
    return { mapUid, error: e.message || "leaderboard fetch failed" };
  }
}

/* ---------------- Name resolution (multi-source, cached) ---------------- */
const nameCache = new Map(); // accountId -> displayName

function cachePut(id, name) {
  if (!id) return;
  const n = (name || "").trim();
  if (n) nameCache.set(id, n);
}

function cacheGetMissing(ids) {
  const missing = [];
  for (const id of ids) {
    if (!id) continue;
    if (!nameCache.has(id)) missing.push(id);
  }
  return missing;
}

/* Nadeo batch resolver */
async function resolveViaNadeo(accessToken, ids) {
  const out = new Map();
  if (!ids.length) return out;

  const chunk = 100;
  for (let i = 0; i < ids.length; i += chunk) {
    const batch = ids.slice(i, i + chunk);
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${encodeURIComponent(
      batch.join(",")
    )}`;
    try {
      const j = await jget(url, accessToken);
      const arr = j?.displayNames || j || [];
      for (const row of arr) {
        if (row?.accountId && row?.displayName) {
          out.set(row.accountId, row.displayName);
        }
      }
    } catch (e) {
      console.warn("Nadeo name batch failed:", e.message);
    }
  }
  return out;
}

/* trackmania.io batch resolver (fallback) */
async function resolveViaTMIO(ids) {
  const out = new Map();
  if (!ids.length) return out;

  // trackmania.io supports a batch endpoint for display names:
  //   GET /api/accounts/displayNames?accountIds=<comma-separated>
  // (best-effort; if they change it, nothing breaks—just skip)
  const chunk = 100;
  for (let i = 0; i < ids.length; i += chunk) {
    const batch = ids.slice(i, i + chunk);
    const url = `${TMIO_BASE}/accounts/displayNames?accountIds=${encodeURIComponent(
      batch.join(",")
    )}`;
    try {
      const j = await jget(url, null, { Accept: "application/json" });
      // Expecting: [{ accountId, displayName }] (same shape used on the site)
      for (const row of j || []) {
        if (row?.accountId && row?.displayName) {
          out.set(row.accountId, row.displayName);
        }
      }
    } catch (e) {
      console.warn("TMIO name batch failed:", e.message);
    }
  }
  return out;
}

/* High-level resolver with cache + dual backends */
async function resolveDisplayNames(ids) {
  const need = cacheGetMissing(
    Array.from(new Set(ids.filter(Boolean))).slice(0, 5000) // safety cap
  );
  if (!need.length) return;

  const access = await getLiveAccessToken();

  // 1) Try Nadeo first
  const nadeoMap = await resolveViaNadeo(access, need);
  for (const [id, name] of nadeoMap) cachePut(id, name);

  // 2) Fallback to TMIO for anything still missing
  const stillNeed = cacheGetMissing(need);
  if (stillNeed.length) {
    const tmioMap = await resolveViaTMIO(stillNeed);
    for (const [id, name] of tmioMap) cachePut(id, name);
  }

  // 3) As a final fallback, cache self IDs to avoid re-asking (will still show ID)
  const finalStillNeed = cacheGetMissing(need);
  for (const id of finalStillNeed) cachePut(id, id);
}

/* ---------------- Cache & builder ---------------- */
let wrCache = { ts: 0, rows: [] };
const WR_TTL_MS = 10 * 60 * 1000; // 10 min
const CONCURRENCY = 8;

async function buildAllWRs() {
  const access = await getLiveAccessToken();
  const [official, totd] = await Promise.all([
    getAllOfficialCampaigns(access),
    getAllTotdSeasons(access),
  ]);
  const mapUids = collectAllMapUids(official, totd);

  const wrs = [];
  for (let i = 0; i < mapUids.length; i += CONCURRENCY) {
    const part = await Promise.all(
      mapUids
        .slice(i, i + CONCURRENCY)
        .map((uid) => getMapWR(access, uid).catch(() => null))
    );
    for (const r of part) if (r) wrs.push(r);
  }

  // Resolve and attach display names
  await resolveDisplayNames(wrs.map((r) => r.accountId).filter(Boolean));
  for (const r of wrs) {
    r.displayName = r.accountId ? nameCache.get(r.accountId) || r.accountId : "";
  }

  wrs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  wrCache = { ts: Date.now(), rows: wrs };
  return wrs;
}

/* ---------------- API ---------------- */

// Most recent WRs across ALL official campaigns + ALL TOTD seasons
// Optional: ?limit=300  ?search=text
app.get("/api/wr-latest", async (req, res) => {
  try {
    const fresh =
      Date.now() - wrCache.ts < WR_TTL_MS && wrCache.rows.length > 0;
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

    res.json({ rows: out.slice(0, limit), total: out.length, fetchedAt: wrCache.ts });
  } catch (err) {
    console.error("wr-latest:", err);
    if (!res.headersSent)
      res
        .status(500)
        .json({ error: "Failed to load latest world records", detail: err?.message || String(err) });
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
        tally.get(r.accountId) ||
        {
          accountId: r.accountId,
          displayName: nameCache.get(r.accountId) || r.accountId,
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

    list.sort(
      (a, b) => b.wrCount - a.wrCount || b.latestTs - a.latestTs
    );
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
    res.json({ players: list.slice(0, limit), total: list.length, fetchedAt: wrCache.ts });
  } catch (err) {
    console.error("wr-players:", err);
    if (!res.headersSent)
      res
        .status(500)
        .json({ error: "Failed to load WR players", detail: err?.message || String(err) });
  }
});

/* Optional: debug endpoint to check name mapping manually
   /api/resolve-names?ids=<comma-separated-accountIds> */
app.get("/api/resolve-names", async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await resolveDisplayNames(ids);
    const names = {};
    for (const id of ids) names[id] = nameCache.get(id) || id;
    res.json({ names });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ---------------- Start ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ API running on port ${PORT}`)
);
