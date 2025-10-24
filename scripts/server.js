import express from "express";
import fetch from "node-fetch";

/**
 * ENV on Render:
 *   REFRESH_TOKEN = <NadeoLiveServices refresh token>
 * Optional:
 *   CORS_ORIGINS = comma-separated list of extra origins
 *   TOTD_START_YEAR = 2020
 *   TOTD_START_MONTH = 7   // 1-12; default is July 2020 (first TM2020 TOTDs)
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ------------------------- Health -------------------------- */
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* -------------------- Auth (refresh -> access) -------------- */
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

/* ------------------ Live Services helpers ------------------ */
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const TMIO_BASE = "https://trackmania.io/api";

async function jget(url, accessToken) {
  const r = await fetch(url, {
    headers: {
      ...(accessToken ? { Authorization: `nadeo_v1 t=${accessToken}` } : {}),
      "User-Agent": "trackmaniaevents.com/1.0 (Render)",
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Official campaigns (many)
async function getAllOfficialCampaigns(accessToken) {
  const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=200`;
  const j = await jget(url, accessToken);
  return j?.campaignList || [];
}

/* ------------------- TOTD month-by-month ------------------- */
/** We AVOID the /totd/season endpoints (they 404 for you).
 *  Instead, we iterate months from start (default: 2020-07) to NOW and
 *  call: /api/token/totd/month?year=YYYY&month=MM (and non-token as fallback)
 *  We cache the full UID set to reduce load.
 */
const TOTD_START_YEAR = Number(process.env.TOTD_START_YEAR || 2020);
const TOTD_START_MONTH = Number(process.env.TOTD_START_MONTH || 7); // 1..12
let totdMapCache = { ts: 0, uids: [] };
const TOTD_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MONTH_FETCH_CONCURRENCY = 3;

function monthRange() {
  const out = [];
  const start = new Date(Date.UTC(TOTD_START_YEAR, TOTD_START_MONTH - 1, 1));
  const now = new Date();
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (cur <= end) {
    out.push({ y: cur.getUTCFullYear(), m: cur.getUTCMonth() + 1 });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

async function fetchTotdMonth(accessToken, y, m) {
  const endpoints = [
    `${LIVE_BASE}/api/token/totd/month?year=${y}&month=${m}`,
    `${LIVE_BASE}/api/totd/month?year=${y}&month=${m}`,
  ];
  for (const url of endpoints) {
    try {
      const j = await jget(url, accessToken);
      if (j?.days && Array.isArray(j.days)) return j.days;
    } catch (e) {
      // ignore and try next variant
    }
  }
  // No data for that month (or endpoint unavailable) -> return empty
  return [];
}

async function getAllTotdMapUids(accessToken) {
  const fresh = Date.now() - totdMapCache.ts < TOTD_CACHE_TTL_MS && totdMapCache.uids.length;
  if (fresh) return totdMapCache.uids;

  const months = monthRange();
  const uids = new Set();
  for (let i = 0; i < months.length; i += MONTH_FETCH_CONCURRENCY) {
    const slice = months.slice(i, i + MONTH_FETCH_CONCURRENCY);
    const parts = await Promise.all(
      slice.map(({ y, m }) => fetchTotdMonth(accessToken, y, m))
    );
    for (const days of parts) {
      for (const d of days || []) {
        if (d?.mapUid) uids.add(d.mapUid);
      }
    }
  }
  totdMapCache = { ts: Date.now(), uids: Array.from(uids) };
  return totdMapCache.uids;
}

/* ---- Collect maps with source tagging so we can debug/filter ---- */
function collectAllMaps(officialCampaigns, totdUids) {
  const seen = new Set();
  const maps = [];

  // Official first (if a map appears in both, keep 'official')
  for (const c of officialCampaigns || []) {
    for (const p of c?.playlist || []) {
      const uid = p.mapUid;
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      maps.push({ mapUid: uid, sourceType: "official" });
    }
  }
  // TOTD next (skip duplicates already marked as official)
  for (const uid of totdUids || []) {
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    maps.push({ mapUid: uid, sourceType: "totd" });
  }
  return maps;
}

// Normalize leaderboard timestamps to seconds since epoch
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

function cacheName(id, maybeName) {
  if (!id) return;
  const next = (maybeName || "").trim();
  if (next && (!nameCache.has(id) || nameCache.get(id) === id)) {
    nameCache.set(id, next);
  }
}

/** TM.io fallback with POST first (avoids 431 on long URLs), then small GETs */
async function resolveViaTMIO(ids) {
  if (!ids.length) return new Map();
  const out = new Map();

  // 1) Try POST in chunks
  const POST_CHUNK = 100;
  for (let i = 0; i < ids.length; i += POST_CHUNK) {
    const batch = ids.slice(i, i + POST_CHUNK);
    try {
      const r = await fetch(`${TMIO_BASE}/accounts/displayNames`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ accountIds: batch }),
      });
      if (!r.ok) throw new Error(`TMIO POST ${r.status}`);
      const j = await r.json();
      for (const row of j || []) {
        const id = row?.accountId;
        const dn =
          row?.displayName || row?.name || row?.userName || row?.username;
        if (id && dn) out.set(id, dn);
      }
    } catch {
      // POST might not be supported — fall back to GET small chunks
      const GET_CHUNK = 25; // small to avoid 431
      for (let k = 0; k < batch.length; k += GET_CHUNK) {
        const mini = batch.slice(k, k + GET_CHUNK);
        const url = `${TMIO_BASE}/accounts/displayNames?accountIds=${encodeURIComponent(
          mini.join(",")
        )}`;
        try {
          const j2 = await jget(url, null);
          for (const row of j2 || []) {
            const id = row?.accountId;
            const dn =
              row?.displayName || row?.name || row?.userName || row?.username;
            if (id && dn) out.set(id, dn);
          }
        } catch (e) {
          console.warn("TMIO fallback failed:", e.message);
        }
      }
    }
  }
  return out;
}

async function resolveDisplayNames(accessToken, ids) {
  const allIds = Array.from(new Set((ids || []).filter(Boolean)));
  const need = allIds.filter((id) => !nameCache.has(id));
  if (!need.length) return nameCache;

  const HJSON = {
    Authorization: `nadeo_v1 t=${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "trackmaniaevents.com/1.0 (Render)",
  };
  const HGET = {
    Authorization: `nadeo_v1 t=${accessToken}`,
    Accept: "application/json",
    "User-Agent": "trackmaniaevents.com/1.0 (Render)",
  };

  async function tryBatchGET_rawComma(batch) {
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${batch.join(
      ","
    )}`;
    const r = await fetch(url, { headers: HGET });
    if (!r.ok) throw new Error(`GET rawComma ${r.status}`);
    return r.json();
  }
  async function tryBatchGET_encoded(batch) {
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${encodeURIComponent(
      batch.join(",")
    )}`;
    const r = await fetch(url, { headers: HGET });
    if (!r.ok) throw new Error(`GET encoded ${r.status}`);
    return r.json();
  }
  async function tryBatchGET_legacy(batch) {
    const url = `${LIVE_BASE}/api/accounts/displayNames?accountIdList=${batch.join(
      ","
    )}`;
    const r = await fetch(url, { headers: HGET });
    if (!r.ok) throw new Error(`GET legacy ${r.status}`);
    return r.json();
  }
  async function tryBatchPOST_array(batch) {
    const url = `${LIVE_BASE}/api/token/accounts/displayNames`;
    const r = await fetch(url, {
      method: "POST",
      headers: HJSON,
      body: JSON.stringify({ accountIdList: batch }),
    });
    if (!r.ok) throw new Error(`POST array ${r.status}`);
    return r.json();
  }
  async function tryBatchPOST_csv(batch) {
    const url = `${LIVE_BASE}/api/token/accounts/displayNames`;
    const r = await fetch(url, {
      method: "POST",
      headers: HJSON,
      body: JSON.stringify({ accountIdList: batch.join(",") }),
    });
    if (!r.ok) throw new Error(`POST csv ${r.status}`);
    return r.json();
  }

  function harvestNames(j) {
    const out = new Map();
    const arr = (j && (j.displayNames || j)) || [];
    for (const row of arr) {
      const id = row?.accountId;
      const dn =
        row?.displayName || row?.name || row?.userName || row?.username;
      if (id && dn) out.set(id, dn);
    }
    return out;
  }

  async function tryPerId(id) {
    const candidates = [
      `${LIVE_BASE}/api/token/accounts/${encodeURIComponent(id)}`,
      `${LIVE_BASE}/api/token/account/${encodeURIComponent(id)}`,
    ];
    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers: HGET });
        if (!r.ok) continue;
        const j = await r.json();
        const o = Array.isArray(j) ? j[0] : j;
        const dn = o?.displayName || o?.name || o?.userName || o?.username;
        if (dn) return dn;
      } catch {}
    }
    return null;
  }

  const CHUNK = 100;
  for (let i = 0; i < need.length; i += CHUNK) {
    const batch = need.slice(i, i + CHUNK);

    let got = new Map();
    const attempts = [
      tryBatchGET_rawComma,
      tryBatchGET_encoded,
      tryBatchPOST_array,
      tryBatchPOST_csv,
      tryBatchGET_legacy,
    ];
    for (const fn of attempts) {
      if (got.size === batch.length) break;
      try {
        const j = await fn(batch);
        const m = harvestNames(j);
        for (const [k, v] of m) got.set(k, v);
      } catch {}
    }

    for (const [id, dn] of got) cacheName(id, dn);

    // Still missing? Try per-id.
    const missingAfterNadeo = batch.filter((id) => !nameCache.has(id));
    if (missingAfterNadeo.length) {
      const limit = 6;
      for (let j = 0; j < missingAfterNadeo.length; j += limit) {
        await Promise.all(
          missingAfterNadeo.slice(j, j + limit).map(async (id) => {
            const dn = await tryPerId(id);
            if (dn) cacheName(id, dn);
          })
        );
      }
    }

    // Still missing? Try TM.io (POST, then small GETs)
    const missingForTMIO = batch.filter((id) => !nameCache.has(id));
    if (missingForTMIO.length) {
      const tmioMap = await resolveViaTMIO(missingForTMIO);
      for (const [id, dn] of tmioMap) cacheName(id, dn);
    }

    for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
  }

  return nameCache;
}

/* ------------------------- Cache --------------------------- */
let wrCache = { ts: 0, rows: [], counts: { officialMaps: 0, totdMaps: 0 } };
const WR_TTL_MS = 10 * 60 * 1000; // 10 min
const CONCURRENCY = 8;

/* --------------- Build ALL WRs (official + TOTD) ----------- */
async function buildAllWRs() {
  const access = await getLiveAccessToken();
  const [official, totdUids] = await Promise.all([
    getAllOfficialCampaigns(access),
    getAllTotdMapUids(access),
  ]);

  const maps = collectAllMaps(official, totdUids);
  const counts = {
    officialMaps: maps.filter((m) => m.sourceType === "official").length,
    totdMaps: maps.filter((m) => m.sourceType === "totd").length,
  };

  const wrs = [];
  for (let i = 0; i < maps.length; i += CONCURRENCY) {
    const slice = maps.slice(i, i + CONCURRENCY);
    const part = await Promise.all(
      slice.map(async ({ mapUid, sourceType }) => {
        const row = await getMapWR(access, mapUid);
        if (row && !row.error && !row.empty) row.sourceType = sourceType;
        return row;
      })
    );
    wrs.push(...part.filter(Boolean));
  }

  // resolve names
  const idList = wrs.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(access, idList);
  for (const r of wrs) {
    if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;
  }

  // newest first
  wrs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  wrCache = { ts: Date.now(), rows: wrs, counts };
  return wrs;
}

/* ------------------------ Endpoints ------------------------ */

// Most recent WRs across ALL official campaigns + ALL TOTD
// Optional: ?limit=300  ?search=foo  ?source=official|totd
app.get("/api/wr-latest", async (req, res) => {
  try {
    const fresh = Date.now() - wrCache.ts < WR_TTL_MS && wrCache.rows.length;
    const rows = fresh ? wrCache.rows : await buildAllWRs();

    const wantSource = String(req.query.source || "").toLowerCase();
    let out = rows;
    if (wantSource === "official" || wantSource === "totd") {
      out = out.filter((r) => r.sourceType === wantSource);
    }

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

/* ---------------------- Debug Utilities -------------------- */

// 1) Stats
app.get("/api/debug-stats", async (_req, res) => {
  try {
    if (!wrCache.rows.length) await buildAllWRs();

    const unresolved = wrCache.rows
      .filter((r) => r.accountId && (!r.displayName || r.displayName === r.accountId))
      .map((r) => r.accountId);

    const sampleMissing = Array.from(new Set(unresolved)).slice(0, 25);

    const bySource = wrCache.rows.reduce(
      (acc, r) => {
        acc[r.sourceType || "unknown"] = (acc[r.sourceType || "unknown"] || 0) + 1;
        return acc;
      },
      {}
    );

    res.json({
      fetchedAt: wrCache.ts,
      counts: wrCache.counts,
      rows: wrCache.rows.length,
      rowsBySource: bySource,
      unresolvedNameCount: new Set(unresolved).size,
      unresolvedSample: sampleMissing,
      nameCacheEntries: nameCache.size,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// 2) Peek rows
app.get("/api/debug-wrs", async (req, res) => {
  try {
    if (!wrCache.rows.length) await buildAllWRs();
    let out = wrCache.rows;
    const src = String(req.query.source || "").toLowerCase();
    if (src === "official" || src === "totd") {
      out = out.filter((r) => r.sourceType === src);
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    res.json({
      fetchedAt: wrCache.ts,
      rows: out.slice(0, limit).map((r) => ({
        mapUid: r.mapUid,
        sourceType: r.sourceType,
        accountId: r.accountId,
        displayName: r.displayName,
        timeMs: r.timeMs,
        timestamp: r.timestamp,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// 3) Force rebuild
app.post("/api/rebuild", async (req, res) => {
  try {
    const clear = String(req.query.clearNames || "") === "1";
    if (clear) nameCache.clear();
    wrCache = { ts: 0, rows: [], counts: { officialMaps: 0, totdMaps: 0 } };
    totdMapCache = { ts: 0, uids: [] };
    await buildAllWRs();
    res.json({ ok: true, clearedNames: clear, fetchedAt: wrCache.ts });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// 4) Name probe
app.get("/api/debug-names", async (req, res) => {
  try {
    const access = await getLiveAccessToken();
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await resolveDisplayNames(access, ids);
    const data = ids.map((id) => ({ id, name: nameCache.get(id) || null }));
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ------------------------- Start --------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ API running on port ${PORT}`)
);
