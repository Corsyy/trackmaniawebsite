import express from "express";
import fetch from "node-fetch";

/**
 * ENV on Render:
 *   REFRESH_TOKEN = <NadeoLiveServices refresh token>
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

async function jget(url, accessToken) {
  const r = await fetch(url, {
    headers: {
      Authorization: `nadeo_v1 t=${accessToken}`,
      "User-Agent": "trackmaniaevents.com/1.0 (Render)",
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

/* -------------------- Trackmania.io (TOTD months) -------------------- */
const TMIO_BASE = "https://trackmania.io";

// TMIO GET with robust JSON parse (avoid HTML surprises)
async function jgetPublic(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "trackmaniaevents.com/1.0 (Render)" },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${txt?.slice(0, 180)}`);
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`Non-JSON from TMIO at ${url}: ${txt?.slice(0, 180)}`);
  }
}

/**
 * Get list of all TOTD months from TM.io.
 * Tries:
 *  1) /api/totd/months      -> { months: ["YYYY-MM", ...] }
 *  2) /api/totd             -> { months: [...] } or sometimes an array
 */
async function getTmioTotdMonths() {
  const candidates = [`${TMIO_BASE}/api/totd/months`, `${TMIO_BASE}/api/totd`];
  for (const url of candidates) {
    try {
      const j = await jgetPublic(url);
      const arr = Array.isArray(j?.months) ? j.months : Array.isArray(j) ? j : [];
      if (arr.length) return arr.map(String);
    } catch {}
  }
  return [];
}

/**
 * Get a month’s days from TM.io (array of day objects with mapUid).
 * Tries:
 *  1) /api/totd/YYYY/MM     -> { days: [...] }
 *  2) /api/totd?year=YYYY&month=MM
 */
async function getTmioTotdMonthDays(ym) {
  const [year, m] = ym.split("-");
  const mm = String(m).padStart(2, "0");
  const urls = [
    `${TMIO_BASE}/api/totd/${year}/${mm}`,
    `${TMIO_BASE}/api/totd?year=${encodeURIComponent(year)}&month=${encodeURIComponent(mm)}`,
  ];
  for (const url of urls) {
    try {
      const j = await jgetPublic(url);
      const days = Array.isArray(j?.days) ? j.days : Array.isArray(j) ? j : [];
      if (days.length) return days;
    } catch {}
  }
  return [];
}

/** Get ALL TOTD mapUids via TM.io months */
async function getAllTotdMapUidsViaTMIO() {
  const months = await getTmioTotdMonths();
  if (!months.length) return [];

  const uids = new Set();
  const CONC = 6;
  for (let i = 0; i < months.length; i += CONC) {
    const batch = months.slice(i, i + CONC);
    const chunks = await Promise.all(
      batch.map(async (ym) => {
        try {
          return await getTmioTotdMonthDays(ym);
        } catch {
          return [];
        }
      })
    );
    for (const days of chunks) {
      for (const d of days) if (d?.mapUid) uids.add(d.mapUid);
    }
  }
  return Array.from(uids);
}

/* -------------------- Map UID collection (merge) -------------------- */
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

// Robust resolver: multiple batch shapes + per-ID fallback, then cache
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
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${batch.join(",")}`;
    const r = await fetch(url, { headers: HGET });
    if (!r.ok) throw new Error(`GET rawComma ${r.status}`);
    return r.json();
  }
  async function tryBatchGET_encoded(batch) {
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${encodeURIComponent(batch.join(","))}`;
    const r = await fetch(url, { headers: HGET });
    if (!r.ok) throw new Error(`GET encoded ${r.status}`);
    return r.json();
  }
  async function tryBatchGET_legacy(batch) {
    const url = `${LIVE_BASE}/api/accounts/displayNames?accountIdList=${batch.join(",")}`;
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

    for (const [id, dn] of got) nameCache.set(id, dn);

    const missing = batch.filter((id) => !nameCache.has(id));
    if (missing.length) {
      const limit = 6;
      for (let j = 0; j < missing.length; j += limit) {
        await Promise.all(
          missing.slice(j, j + limit).map(async (id) => {
            const dn = await tryPerId(id);
            nameCache.set(id, dn || id);
          })
        );
      }
    }
  }

  for (const id of need) if (!nameCache.has(id)) nameCache.set(id, id);
  return nameCache;
}
/* ------------------------- Cache --------------------------- */
let wrCache = { ts: 0, rows: [] };
const WR_TTL_MS = 10 * 60 * 1000; // 10 min
const CONCURRENCY = 8;

/* --------------- Build ALL WRs (official + TOTD) ----------- */
async function buildAllWRs() {
  const access = await getLiveAccessToken();

  // 1) Official (Nadeo)
  const official = await getAllOfficialCampaigns(access);

  // 2) TOTD UIDs via Trackmania.io months (not Nadeo "season")
  const totdUids = await getAllTotdMapUidsViaTMIO();

  // 3) Merge + remember which are official
  const { all: mapUids, officialSet } =
    collectAllMapUidsFromOfficialAndTotd(official, totdUids);

  // 4) Fetch WRs
  const wrs = [];
  for (let i = 0; i < mapUids.length; i += CONCURRENCY) {
    const part = await Promise.all(
      mapUids.slice(i, i + CONCURRENCY).map(async (uid) => {
        const row = await getMapWR(access, uid);
        if (!row || row.empty || row.error) return null;
        // tag the source for debug/stats
        row.sourceType = officialSet.has(uid) ? "official" : "totd";
        return row;
      })
    );
    wrs.push(...part.filter(Boolean));
  }

  // 5) Resolve names
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

// Quick name check: /api/debug-names?ids=a,b,c
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

// Cache + counts insight
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
      unresolvedSample: [], // populate if you want to log misses
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
