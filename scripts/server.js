// server.js
import express from "express";
import fetch from "node-fetch";
import compression from "compression";
import fs from "fs/promises";
import path from "path";

/**
 * ENV:
 *   REFRESH_TOKEN = <NadeoLiveServices refresh token>
 *   CLIENT_ID     = <api.trackmania.com client_id>
 *   CLIENT_SECRET = <api.trackmania.com client_secret>
 * Optional:
 *   CORS_ORIGINS  = comma-separated list of extra allowed origins
 *   CACHE_DIR     = override cache directory (default: /data/cache or /tmp/cache)
 *   WR_CONCURRENCY         = override WR fetch concurrency (default 6)
 *   WR_TTL_MS              = in-memory TTL before rebuild (default 10 min)
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

/* --------------------- Perf niceties ------------------------ */
app.use(compression());
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.endsWith(".json")) {
    res.setHeader("Cache-Control", "public, max-age=30, must-revalidate");
  }
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

/* ---------------- OAuth (api.trackmania.com) ---------------- */
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
  const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=200`;
  const j = await jget(url, accessToken);
  return j?.campaignList || [];
}

/* -------------------- TOTD via Live API -------------------- */
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
  const BATCH = 24;
  for (let offset = total - 1; offset >= 0; offset -= BATCH) {
    const len = Math.min(BATCH, offset + 1);
    const url = `${LIVE_BASE}/api/token/campaign/month?length=${len}&offset=${offset}`;
    const j = await jget(url, accessToken);
    months.push(...(j?.monthList || []));
    await new Promise((r) => setTimeout(r, 60)); // gentle
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

/* -------------------- Club campaigns (Live) ---------------- */
const CLUB_BATCH = 100;

async function getAllClubCampaigns(accessToken) {
  const all = [];
  for (let offset = 0; ; offset += CLUB_BATCH) {
    const url = `${LIVE_BASE}/api/token/club/campaign?length=${CLUB_BATCH}&offset=${offset}`;
    const j = await jget(url, accessToken);
    const list = j?.clubCampaignList || [];
    if (!list.length) break;
    all.push(...list);
    if (list.length < CLUB_BATCH) break;
    await new Promise((r) => setTimeout(r, 60)); // gentle
  }
  return all;
}

function collectClubMapUids(clubCampaigns) {
  return clubCampaigns.flatMap((cc) =>
    (cc?.campaign?.playlist || []).map((p) => p.mapUid).filter(Boolean)
  );
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

async function resolveDisplayNames(_liveAccessToken, ids) {
  const all = Array.from(new Set((ids || []).filter(Boolean)));
  const need = all.filter((id) => !nameCache.has(id));
  if (!need.length) return nameCache;

  const oToken = await getOAuthToken();
  const CHUNK = 50;
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
        for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
        continue;
      }
      const j = await r.json(); // { "<accountId>": "DisplayName", ... }
      for (const id of batch) {
        const dn = j?.[id];
        nameCache.set(id, (typeof dn === "string" && dn) || id);
      }
    } catch {
      for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return nameCache;
}

/* ------------------------- Cache --------------------------- */
let wrCache = { ts: 0, rows: [] };
const WR_TTL_MS = Number(process.env.WR_TTL_MS || 10 * 60 * 1000); // 10 min
const CONCURRENCY = Number(process.env.WR_CONCURRENCY || 6);

/* --------------------- Disk persistence -------------------- */
/**
 * Prefer /data/cache if a persistent disk is mounted; else /tmp/cache.
 */
let CACHE_DIR = process.env.CACHE_DIR;
if (!CACHE_DIR) {
  try {
    await fs.stat("/data");
    CACHE_DIR = "/data/cache";
  } catch {
    CACHE_DIR = "/tmp/cache";
  }
}
const CACHE_FILE = path.join(CACHE_DIR, "wr-cache.json");
const NAMES_FILE = path.join(CACHE_DIR, "name-cache.json");

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}
}

async function writeJsonAtomic(file, obj) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj), "utf8");
  await fs.rename(tmp, file);
}
async function readJsonSafe(file, fallback = null) {
  try {
    const txt = await fs.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

let lastWrite = 0;
async function saveCachesToDisk() {
  const now = Date.now();
  if (now - lastWrite < 3000) return; // throttle writes
  lastWrite = now;

  try {
    await writeJsonAtomic(CACHE_FILE, wrCache);
  } catch (e) {
    console.log("WARN: failed to save WR cache:", e?.message || e);
  }
  try {
    const namesObj = Object.fromEntries(nameCache.entries());
    await writeJsonAtomic(NAMES_FILE, { names: namesObj });
  } catch (e) {
    console.log("WARN: failed to save name cache:", e?.message || e);
  }
}

async function loadCachesFromDisk() {
  try {
    const snap = await readJsonSafe(CACHE_FILE);
    if (snap && Array.isArray(snap.rows)) {
      wrCache = { ts: snap.ts || Date.now(), rows: snap.rows };
      console.log(`✅ Loaded WR cache from disk: ${wrCache.rows.length} rows`);
    } else {
      console.log("ℹ️ No WR cache file found.");
    }
  } catch (e) {
    console.log("ℹ️ Could not read WR cache:", e?.message || e);
  }
  try {
    const names = await readJsonSafe(NAMES_FILE);
    if (names && names.names && typeof names.names === "object") {
      for (const [k, v] of Object.entries(names.names)) nameCache.set(k, v);
      console.log(`✅ Loaded name cache from disk: ${nameCache.size} entries`);
    }
  } catch (e) {
    console.log("ℹ️ Could not read name cache:", e?.message || e);
  }
}

/* --------------- Build ALL WRs (official + TOTD + CLUB) --- */
async function buildAllWRs() {
  const access = await getLiveAccessToken();

  // 1) Official (seasons)
  const official = await getAllOfficialCampaigns(access);

  // 2) TOTD (all months)
  const totdUids = await getAllTotdMapUidsViaLive(access);

  // 3) Club campaigns
  const clubCampaigns = await getAllClubCampaigns(access);
  const clubUids = collectClubMapUids(clubCampaigns);

  // 4) Merge + tag sets
  const officialUids = new Set(
    official.flatMap((c) => (c.playlist || []).map((p) => p.mapUid))
  );
  const clubUidSet = new Set(clubUids);
  const allMapUids = Array.from(
    new Set([...officialUids, ...totdUids, ...clubUidSet])
  );

  // 5) Fetch WRs
  const wrs = [];
  for (let i = 0; i < allMapUids.length; i += CONCURRENCY) {
    const part = await Promise.all(
      allMapUids.slice(i, i + CONCURRENCY).map(async (uid) => {
        const row = await getMapWR(access, uid);
        if (!row || row.empty || row.error) return null;
        row.sourceType = officialUids.has(uid)
          ? "official"
          : clubUidSet.has(uid)
          ? "club"
          : "totd";
        return row;
      })
    );
    wrs.push(...part.filter(Boolean));
  }

  // 6) Resolve names
  const idList = wrs.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(access, idList);
  for (const r of wrs) {
    if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;
  }

  // 7) Sort newest first and cache + persist
  wrs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  wrCache = { ts: Date.now(), rows: wrs };
  await saveCachesToDisk();
  return wrs;
}

/* ------------------------ Endpoints ------------------------ */

// Latest WRs (Campaign + TOTD + Club)
// Optional: ?limit=300  ?search=foo  ?type=official,totd,club
app.get("/api/wr-latest", async (req, res) => {
  try {
    // warm load from disk prevents cold rebuilds
    if (!wrCache.rows.length) {
      await loadCachesFromDisk();
    }
    const fresh = Date.now() - wrCache.ts < WR_TTL_MS && wrCache.rows.length;
    const rows = fresh && wrCache.rows.length ? wrCache.rows : await buildAllWRs();

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

    const type = (req.query.type || "all").toString().trim().toLowerCase();
    if (type !== "all") {
      const allow = new Set(
        type.split(",").map((s) => s.trim()).filter(Boolean)
      );
      out = out.filter((r) => allow.has(r.sourceType));
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

// Players leaderboard across ALL sources (Campaign + TOTD + Club)
// Optional: ?limit=200  ?q=search
app.get("/api/wr-players", async (req, res) => {
  try {
    if (!wrCache.rows.length) await loadCachesFromDisk();
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

// Top players in last N days (defaults: 7 days, top 3)
app.get("/api/top-weekly", async (req, res) => {
  try {
    if (!wrCache.rows.length) await loadCachesFromDisk();
    if (!wrCache.rows.length || Date.now() - wrCache.ts >= WR_TTL_MS) {
      await buildAllWRs();
    }
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 3));
    const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 3600;

    const tally = new Map(); // accountId -> { accountId, displayName, wrs, bySource, latestTs }
    for (const r of wrCache.rows) {
      if (!r.accountId) continue;
      if (!r.timestamp || r.timestamp < cutoff) continue;

      const rec = tally.get(r.accountId) || {
        accountId: r.accountId,
        displayName: r.displayName || r.accountId,
        wrs: 0,
        bySource: { official: 0, totd: 0, club: 0 },
        latestTs: 0,
      };
      rec.wrs += 1;
      rec.bySource[r.sourceType] = (rec.bySource[r.sourceType] || 0) + 1;
      if (r.timestamp > rec.latestTs) rec.latestTs = r.timestamp;
      tally.set(r.accountId, rec);
    }

    const top = Array.from(tally.values())
      .sort((a, b) => b.wrs - a.wrs || b.latestTs - a.latestTs)
      .slice(0, limit);

    res.json({ rangeDays: days, top, generatedAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
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
    if (!wrCache.rows.length) await loadCachesFromDisk();
    const rows = wrCache.rows || [];
    const counts = { official: 0, totd: 0, club: 0 };
    for (const r of rows) {
      counts[r.sourceType] = (counts[r.sourceType] || 0) + 1;
    }
    res.json({
      cacheTime: wrCache.ts,
      rows: rows.length,
      counts,
      nameCacheSize: nameCache.size,
      resolvedNamesCount: Array.from(nameCache.values()).filter(
        (v) => v && typeof v === "string" && v !== ""
      ).length,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ---------------- Snapshot endpoints ---------------- */
app.get("/wr-snapshot.json", async (_req, res) => {
  try {
    const snap = await readJsonSafe(CACHE_FILE);
    if (!snap || !Array.isArray(snap.rows)) {
      return res.status(503).json({ error: "No snapshot yet" });
    }
    res.setHeader("Cache-Control", "public, max-age=30, must-revalidate");
    res.setHeader("ETag", `"${snap.ts}"`);
    res.json(snap);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/save-snapshot", async (_req, res) => {
  try {
    await saveCachesToDisk();
    res.json({ ok: true, savedAt: Date.now(), rows: wrCache.rows.length });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ------------------------- Start --------------------------- */
const PORT = process.env.PORT || 3000;

// Load caches before starting the server
await loadCachesFromDisk();

app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ API running on port ${PORT} (cache dir: ${CACHE_DIR})`)
);
