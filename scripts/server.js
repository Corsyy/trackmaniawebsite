import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import compression from "compression";
import http from "http";
import https from "https";

/**
 * Required ENV:
 *   REFRESH_TOKEN         = <Nadeo refresh token>  (raw token only; no "nadeo_v1 t=")
 *   CLIENT_ID             = <api.trackmania.com client_id>
 *   CLIENT_SECRET         = <api.trackmania.com client_secret>
 *
 * Optional ENV (recommended):
 *   ADMIN_SECRET            = <random string to secure /api/admin/set-refresh>
 *   REFRESH_TOKEN_FILE      = /data/nadeo_refresh_token.txt
 *   CACHE_PATH_WR           = /data/wr_cache.json
 *   CACHE_PATH_CLUB         = /data/club_uids.json
 *   CORS_ORIGINS            = comma-separated list of extra allowed origins
 *   INCLUDE_CLUB_BY_DEFAULT = true|false (default true)
 *   AUTO_UID_REFRESH        = true|false (default true)
 *   WR_CONCURRENCY          = 8
 *   QUICK_REFRESH_COUNT     = 100
 *   CLUB_MAX_CAMPAIGNS      = 200
 *   CLUB_DETAIL_CONC        = 4
 *   CLUB_UID_TTL_HOURS      = 24
 *   MAX_WR_MS               = (defaults to 24h in ms)
 *   RESPONSE_TTL_SECONDS    = 3  (small LRU TTL for route responses)
 *
 * Weekly Shorts ENV (required for WS to work):
 *   WS_CLUB_ID              = club id hosting Weekly Shorts (ex: 24231)
 *   WS_CAMPAIGN_ID          = club campaign id for Weekly Shorts (ex: 691919)
 *
 * Weekly Shorts optional ENV:
 *   WS_START_ISO            = ISO timestamp for Week 1 start (default: 2025-01-01T00:00:00Z)
 *   WS_MAPS_PER_WEEK        = maps per week (default: 5)
 *   WS_CACHE_TTL_SECONDS    = seconds for WS cached computations (default: 600)
 *   WS_CHANGELOG_PATH       = disk path for changelog persistence (default: /tmp/ws_changelog.json)
 */

const app = express();

/* ------------------------------ Perf -------------------------------- */
app.use(compression({ level: 6 }));

/* --------------------- HTTP/HTTPS keep-alive ------------------------ */
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const baseFetch = (url, opts = {}) =>
  fetch(url, {
    agent: ((parsedUrl) =>
      String(parsedUrl).startsWith("https:") ? keepAliveHttpsAgent : keepAliveHttpAgent)(url),
    ...opts,
  });

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ------------------------- Health -------------------------- */
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* -------------------- Helpers: timeouts -------------------- */
function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return baseFetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

/* -------------------- Refresh token engine ---------------- */
function cleanToken(s) {
  if (!s) return "";
  let t = s.trim();
  if (t.toLowerCase().startsWith("nadeo_v1 t=")) t = t.slice("nadeo_v1 t=".length).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    t = t.slice(1, -1);
  return t;
}
const REFRESH_TOKEN_FILE = process.env.REFRESH_TOKEN_FILE || "/data/nadeo_refresh_token.txt";
let runtimeRefreshToken = cleanToken(process.env.REFRESH_TOKEN || "");

function getRefreshToken() {
  try {
    if (fs.existsSync(REFRESH_TOKEN_FILE)) {
      const v = cleanToken(fs.readFileSync(REFRESH_TOKEN_FILE, "utf8"));
      if (v) return v;
    }
  } catch {}
  return runtimeRefreshToken;
}
function persistRefreshToken(rt) {
  try {
    if (!rt) return;
    fs.mkdirSync(path.dirname(REFRESH_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(REFRESH_TOKEN_FILE, rt, "utf8");
    runtimeRefreshToken = rt;
  } catch (e) {
    console.error("⚠️ Failed to persist refresh token:", e?.message || e);
  }
}

/* -------------------- Auth (refresh -> access) -------------- */
const CORE_REFRESH_URL =
  "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";
let cachedAccess = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedAccess.token && now < cachedAccess.expAt - 30_000) return cachedAccess.token;

  const refresh = getRefreshToken();
  if (!refresh) throw new Error("Missing REFRESH_TOKEN");

  const r = await fetchWithTimeout(
    CORE_REFRESH_URL,
    {
      method: "POST",
      headers: {
        Authorization: `nadeo_v1 t=${refresh}`,
        "Content-Type": "application/json",
        "User-Agent": "trackmaniaevents.com/1.0 (Render)",
      },
      body: "{}",
    },
    15000
  );

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `refresh failed ${r.status} ${body || "(no body)"} [len=${refresh.length}]`
    );
  }

  const j = await r.json();
  const accessToken = j.accessToken || j.access_token;
  const expiresIn = j.expiresIn || j.expires_in || 3600;
  const newRefresh = j.refreshToken || j.refresh_token;

  if (!accessToken) throw new Error("no accessToken in refresh response");

  if (typeof newRefresh === "string" && newRefresh.trim()) {
    persistRefreshToken(cleanToken(newRefresh));
  }

  cachedAccess = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
  return cachedAccess.token;
}

/* ---------------- OAuth (api.trackmania.com) ---------------- */
const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;
let cachedOAuth = { token: null, expAt: 0 };

async function getOAuthToken() {
  const now = Date.now();
  if (cachedOAuth.token && now < cachedOAuth.expAt - 30_000) return cachedOAuth.token;
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET)
    throw new Error("Missing CLIENT_ID / CLIENT_SECRET");

  const r = await fetchWithTimeout(
    "https://api.trackmania.com/api/access_token",
    {
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
    },
    15000
  );
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
  const r = await fetchWithTimeout(
    url,
    {
      headers: {
        Authorization: `nadeo_v1 t=${accessToken}`,
        "User-Agent": "trackmaniaevents.com/1.0 (Render)",
        Accept: "application/json",
      },
    },
    15000
  );
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
  const start = new Date(Date.UTC(2020, 6, 1));
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let count = 0;
  for (
    let d = start;
    d <= end;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  )
    count++;
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
    const list = j?.monthList || [];
    months.push(...list);
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

/* -------------------- Club campaigns (Live) ---------------- */
const CLUB_LIST_BATCH = 100;
const CLUB_DETAIL_CONC = Number(process.env.CLUB_DETAIL_CONC || 4);
const CLUB_MAX_CAMPAIGNS = Number(process.env.CLUB_MAX_CAMPAIGNS || 200);

async function listAllClubCampaignRefsWithPlaylists(accessToken) {
  const out = [];
  for (let offset = 0; ; offset += CLUB_LIST_BATCH) {
    const url = `${LIVE_BASE}/api/token/club/campaign?length=${CLUB_LIST_BATCH}&offset=${offset}`;
    const j = await jget(url, accessToken);
    const list = j?.clubCampaignList || j?.campaignList || [];
    if (!list.length) break;

    for (const it of list) {
      const clubId = it?.clubId ?? it?.campaign?.clubId ?? it?.club?.id;
      const campaignId = it?.id ?? it?.campaignId ?? it?.campaign?.id;
      const updatedAt = new Date(it?.updated || it?.updatedAt || 0).getTime() || 0;
      const playlist = (it?.campaign?.playlist || it?.playlist || [])
        .map((p) => p?.mapUid)
        .filter(Boolean);
      if (clubId && campaignId) out.push({ clubId, campaignId, updatedAt, playlist });
    }

    if (list.length < CLUB_LIST_BATCH) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, CLUB_MAX_CAMPAIGNS);
}

async function fetchClubCampaignPlaylist(accessToken, clubId, campaignId) {
  const url = `${LIVE_BASE}/api/token/club/${encodeURIComponent(
    clubId
  )}/campaign/${encodeURIComponent(campaignId)}`;
  try {
    const j = await jget(url, accessToken);
    const playlist = j?.campaign?.playlist || j?.playlist || [];
    return playlist.map((p) => p?.mapUid).filter(Boolean);
  } catch {
    return [];
  }
}

async function getAllClubMapUids(accessToken) {
  const refs = await listAllClubCampaignRefsWithPlaylists(accessToken);
  const uids = new Set();
  const missing = [];
  for (const r of refs) {
    if (r.playlist?.length) r.playlist.forEach((uid) => uids.add(uid));
    else missing.push(r);
  }
  for (let i = 0; i < missing.length; i += CLUB_DETAIL_CONC) {
    const batch = missing.slice(i, i + CLUB_DETAIL_CONC);
    const results = await Promise.all(
      batch.map((r) => fetchClubCampaignPlaylist(accessToken, r.clubId, r.campaignId))
    );
    for (const arr of results) arr.forEach((uid) => uids.add(uid));
    await new Promise((r) => setTimeout(r, 80));
  }
  return Array.from(uids);
}

/* ---------------- Time, WR fetch, names -------------------- */
function normalizeToSeconds(val) {
  if (val == null) return 0;
  let n = Number(val);
  if (Number.isFinite(n)) return n > 1e12 ? Math.round(n / 1000) : Math.round(n);
  const parsed = Date.parse(String(val));
  if (Number.isFinite(parsed)) return parsed > 1e12 ? Math.round(parsed / 1000) : Math.round(parsed);
  return 0;
}

const MAX_WR_MS = Number(process.env.MAX_WR_MS || 24 * 3600 * 1000);
function isValidTimeMs(ms) {
  return Number.isFinite(ms) && ms > 0 && ms < MAX_WR_MS;
}
function sanitizeRow(row) {
  if (!row || row.empty || row.error) return null;
  const ms = Number(row.timeMs);
  if (!isValidTimeMs(ms)) return null;
  if (!row.accountId || typeof row.accountId !== "string") return null;
  return { ...row, timeMs: ms };
}

// (keep) your original official-campaign debug endpoint (handy)
app.get("/api/ws-debug", async (req, res) => {
  const access = await getLiveAccessToken();
  const list = await getAllOfficialCampaigns(access);
  res.json(
    list.map((c) => ({
      id: c.id,
      name: c.name,
    }))
  );
});

// NEW: debug your WS club campaign directly
app.get("/api/ws-debug-club-campaign", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const clubId = String(process.env.WS_CLUB_ID || "").trim();
    const campaignId = String(process.env.WS_CAMPAIGN_ID || "").trim();
    if (!clubId || !campaignId) {
      return res.status(400).json({ error: "Missing WS_CLUB_ID / WS_CAMPAIGN_ID" });
    }
    const access = await getLiveAccessToken();
    const url = `${LIVE_BASE}/api/token/club/${encodeURIComponent(clubId)}/campaign/${encodeURIComponent(
      campaignId
    )}`;
    const j = await jget(url, access);
    const playlist = j?.campaign?.playlist || j?.playlist || [];
    res.json({
      ok: true,
      clubId,
      campaignId,
      campaignName: j?.campaign?.name || j?.name || null,
      playlistCount: Array.isArray(playlist) ? playlist.length : 0,
      sample: (playlist || []).slice(0, 5).map((p) => ({ mapUid: p?.mapUid || null })),
    });
  } catch (e) {
    res.status(500).json({ error: "debug failed", detail: e?.message || String(e) });
  }
});

async function getMapWR(accessToken, mapUid) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${mapUid}/top?onlyWorld=true&length=1`;
  try {
    const j = await jget(url, accessToken);
    const top = j?.tops?.[0]?.top?.[0];
    if (!top) return { mapUid, empty: true };

    const timeMs = Number(top.score);
    if (!isValidTimeMs(timeMs)) return { mapUid, empty: true };

    return { mapUid, accountId: top.accountId, timeMs, timestamp: normalizeToSeconds(top.timestamp) };
  } catch (e) {
    return { mapUid, error: e.message || "leaderboard fetch failed" };
  }
}

/* ---------------------- Display names ---------------------- */
const nameCache = new Map();

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
      const r = await fetchWithTimeout(
        `https://api.trackmania.com/api/display-names?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${oToken}`,
            Accept: "application/json",
            "User-Agent": "trackmaniaevents.com/1.0 (Render)",
          },
        },
        15000
      );
      if (!r.ok) {
        for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
        continue;
      }
      const j = await r.json();
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

/* ------------------------- Cache & disk -------------------- */
let wrCache = { ts: 0, rows: [] };
let metaCache = { officialSet: new Set(), clubSet: new Set(), allMapUids: [] };

const WR_CONCURRENCY = Number(process.env.WR_CONCURRENCY || 8);
const CLUB_UID_TTL = Number(process.env.CLUB_UID_TTL_HOURS || 24) * 3600 * 1000;
const QUICK_REFRESH_COUNT = Number(process.env.QUICK_REFRESH_COUNT || 100);
const AUTO_UID_REFRESH = (process.env.AUTO_UID_REFRESH ?? "true").toLowerCase() === "true";

const DISK_WR = process.env.CACHE_PATH_WR || "/tmp/wr_cache.json";
const DISK_CLUB = process.env.CACHE_PATH_CLUB || "/tmp/club_uids.json";

function loadJson(pathname) {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}
function saveJson(pathname, obj) {
  try {
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, JSON.stringify(obj));
  } catch {}
}

function includeClubByDefault() {
  return (process.env.INCLUDE_CLUB_BY_DEFAULT ?? "true").toLowerCase() === "true";
}

async function computeAllMapUids(access, { includeClub }) {
  const [official, totdUids] = await Promise.all([
    getAllOfficialCampaigns(access),
    getAllTotdMapUidsViaLive(access),
  ]);
  const officialSet = new Set(official.flatMap((c) => (c.playlist || []).map((p) => p.mapUid)));

  let clubUids = [];
  let clubSet = new Set();

  if (includeClub) {
    const disk = loadJson(DISK_CLUB);
    const fresh =
      disk &&
      Date.now() - (disk.ts || 0) < CLUB_UID_TTL &&
      Array.isArray(disk.uids) &&
      disk.uids.length;
    if (fresh) {
      clubUids = disk.uids;
    } else {
      clubUids = await getAllClubMapUids(access);
      saveJson(DISK_CLUB, { ts: Date.now(), uids: clubUids });
    }
    clubSet = new Set(clubUids);
  }

  const allMapUids = Array.from(new Set([...officialSet, ...totdUids, ...clubSet]));
  return { officialSet, clubSet, allMapUids };
}

async function fetchAllWRs(access, allMapUids, officialSet, clubSet) {
  const wrs = [];
  for (let i = 0; i < allMapUids.length; i += WR_CONCURRENCY) {
    const part = await Promise.all(
      allMapUids.slice(i, i + WR_CONCURRENCY).map(async (uid) => {
        let row = sanitizeRow(await getMapWR(access, uid));
        if (!row) {
          await new Promise((r) => setTimeout(r, 60));
          row = sanitizeRow(await getMapWR(access, uid));
        }
        if (!row) return null;
        row.sourceType = officialSet.has(uid) ? "official" : clubSet.has(uid) ? "club" : "totd";
        return row;
      })
    );
    wrs.push(...part.filter(Boolean));
  }
  return wrs;
}

function swapCache(rows) {
  rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  wrCache = { ts: Date.now(), rows };
  saveJson(DISK_WR, wrCache);
}

async function buildAllWRs({ includeClub = true } = {}) {
  const access = await getLiveAccessToken();
  const { officialSet, clubSet, allMapUids } = await computeAllMapUids(access, { includeClub });
  const wrs = await fetchAllWRs(access, allMapUids, officialSet, clubSet);

  const ids = wrs.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(access, ids);
  for (const r of wrs) if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;

  swapCache(wrs);
  metaCache = { officialSet, clubSet, allMapUids };
  return wrCache.rows;
}

function diffAndMergeByMap(oldRows, newRows) {
  const byOld = new Map(oldRows.map((r) => [r.mapUid, r]));
  const byNew = new Map(newRows.map((r) => [r.mapUid, r]));
  const updated = [];

  for (const [uid, n] of byNew) {
    const o = byOld.get(uid);
    if (
      !o ||
      o.accountId !== n.accountId ||
      o.timeMs !== n.timeMs ||
      (o.timestamp || 0) !== (n.timestamp || 0)
    ) {
      updated.push(n);
    }
  }
  const merged = [...byOld.values()];
  for (const u of updated) {
    const idx = merged.findIndex((r) => r.mapUid === u.mapUid);
    if (idx >= 0) merged[idx] = u;
    else merged.push(u);
  }
  merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return { merged, updatedCount: updated.length };
}

async function rebuildNow({ includeClub }) {
  const access = await getLiveAccessToken();

  let { officialSet, clubSet, allMapUids } = metaCache;
  if (!allMapUids.length || (includeClub && clubSet.size === 0)) {
    const meta = await computeAllMapUids(access, { includeClub });
    officialSet = meta.officialSet;
    clubSet = meta.clubSet;
    allMapUids = meta.allMapUids;
    metaCache = { officialSet, clubSet, allMapUids };
  }

  const newRows = await fetchAllWRs(access, allMapUids, officialSet, clubSet);
  const ids = newRows.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(access, ids);
  for (const r of newRows) if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;

  const { merged, updatedCount } = diffAndMergeByMap(wrCache.rows || [], newRows);
  wrCache = { ts: Date.now(), rows: merged };
  saveJson(DISK_WR, wrCache);

  return {
    updated: updatedCount,
    total: merged.length,
    counts: {
      official: merged.filter((r) => r.sourceType === "official").length,
      totd: merged.filter((r) => r.sourceType === "totd").length,
      club: merged.filter((r) => r.sourceType === "club").length,
    },
  };
}

async function quickRefreshRecent({ count = QUICK_REFRESH_COUNT } = {}) {
  if (!wrCache.rows.length) return;
  const access = await getLiveAccessToken();

  const recent = wrCache.rows.slice(0, Math.min(count, wrCache.rows.length));
  const part = await Promise.all(
    recent.map(async (prev) => {
      const row = sanitizeRow(await getMapWR(access, prev.mapUid));
      if (!row) return null;
      row.sourceType = prev.sourceType;
      return row;
    })
  );
  const fresh = part.filter(Boolean);

  const byMap = new Map(wrCache.rows.map((r) => [r.mapUid, r]));
  let changed = 0;
  for (const r of fresh) {
    const prev = byMap.get(r.mapUid);
    if (
      !prev ||
      prev.accountId !== r.accountId ||
      prev.timeMs !== r.timeMs ||
      (prev.timestamp || 0) !== (r.timestamp || 0)
    ) {
      byMap.set(r.mapUid, r);
      changed++;
    }
  }
  if (!changed) return;

  const ids = fresh.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(null, ids);
  for (const r of byMap.values()) if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;

  const merged = Array.from(byMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  wrCache = { ts: Date.now(), rows: merged };
}

async function maybeRefreshUidUniverse() {
  if (!AUTO_UID_REFRESH) return;
  if (!metaCache.allMapUids.length) return;

  const access = await getLiveAccessToken();

  const official = await getAllOfficialCampaigns(access);
  const latestOfficialSet = new Set(official.flatMap((c) => (c.playlist || []).map((p) => p.mapUid)));

  const months = await getTotdMonthsFromLive(access);
  const last2 = months.slice(-2);
  const latestTotdSet = new Set();
  for (const m of last2) {
    const days = Array.isArray(m?.days) ? m.days : [];
    for (const d of days) if (d?.mapUid) latestTotdSet.add(d.mapUid);
  }

  const recentClubRefs = await listAllClubCampaignRefsWithPlaylists(access);
  const latestClubSet = new Set();
  for (const r of recentClubRefs.slice(0, 100)) {
    const list = r.playlist?.length ? r.playlist : await fetchClubCampaignPlaylist(access, r.clubId, r.campaignId);
    for (const uid of list || []) latestClubSet.add(uid);
  }

  const oldSet = new Set(metaCache.allMapUids);
  const candidates = new Set([...latestOfficialSet, ...latestTotdSet, ...latestClubSet]);
  const newUids = Array.from(candidates).filter((u) => !oldSet.has(u));
  if (!newUids.length) return;

  const officialSet = new Set([...metaCache.officialSet, ...latestOfficialSet]);
  const clubSet = new Set([...metaCache.clubSet, ...latestClubSet]);

  const freshRows = [];
  for (let i = 0; i < newUids.length; i += WR_CONCURRENCY) {
    const part = await Promise.all(
      newUids.slice(i, i + WR_CONCURRENCY).map(async (uid) => {
        let row = sanitizeRow(await getMapWR(access, uid));
        if (!row) {
          await new Promise((r) => setTimeout(r, 60));
          row = sanitizeRow(await getMapWR(access, uid));
        }
        if (!row) return null;
        row.sourceType = officialSet.has(uid) ? "official" : clubSet.has(uid) ? "club" : "totd";
        return row;
      })
    );
    freshRows.push(...part.filter(Boolean));
  }
  if (!freshRows.length) return;

  const ids = freshRows.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(null, ids);
  for (const r of freshRows) if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;

  const byMap = new Map(wrCache.rows.map((r) => [r.mapUid, r]));
  for (const r of freshRows) byMap.set(r.mapUid, r);
  const merged = Array.from(byMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  wrCache = { ts: Date.now(), rows: merged };

  const combined = new Set([...metaCache.allMapUids, ...newUids]);
  metaCache = { officialSet, clubSet, allMapUids: Array.from(combined) };
}

/* -------------------- Warm start & background build -------- */
(function warmStart() {
  const disk = loadJson(DISK_WR);
  if (disk && Array.isArray(disk.rows) && disk.rows.length) {
    wrCache = { ts: disk.ts || Date.now(), rows: disk.rows };
    console.log(`♻️  Warm-started cache from disk: ${wrCache.rows.length} rows`);
  } else {
    console.log("⚠️  No disk cache found; a background build will prepare it.");
  }
})();

let building = false;
async function warmBuildInBackground() {
  if (wrCache.rows.length || building) return;
  try {
    building = true;
    await buildAllWRs({ includeClub: includeClubByDefault() });
  } catch (e) {
    console.error("Warm build failed:", e?.message || e);
  } finally {
    building = false;
  }
}
warmBuildInBackground();
setInterval(() => warmBuildInBackground(), 30 * 60 * 1000);
setInterval(() => {
  getLiveAccessToken().catch(() => {});
}, 6 * 60 * 60 * 1000);

/* -------------------- Debounced refresh guards ------------- */
function makeDebounced(fn, waitMs) {
  let last = 0,
    running = false,
    pending = false;
  return async function wrapped(...args) {
    const now = Date.now();
    if (running) {
      pending = true;
      return;
    }
    if (now - last < waitMs) return;
    running = true;
    try {
      await fn(...args);
    } finally {
      last = Date.now();
      running = false;
      if (pending) {
        pending = false;
        wrapped(...args);
      }
    }
  };
}
const debouncedQuickRefresh = makeDebounced(
  () => quickRefreshRecent({ count: QUICK_REFRESH_COUNT }),
  15_000
);
const debouncedUidRefresh = makeDebounced(() => maybeRefreshUidUniverse(), 60_000);

/* -------------------- Small response cache ----------------- */
const RESPONSE_TTL_SECONDS = Number(process.env.RESPONSE_TTL_SECONDS || 3);
const respCache = new Map();
function cacheKey(req) {
  return req.originalUrl || req.url;
}
function getCached(req) {
  const k = cacheKey(req);
  const v = respCache.get(k);
  if (!v) return null;
  if (Date.now() - v.ts > RESPONSE_TTL_SECONDS * 1000) {
    respCache.delete(k);
    return null;
  }
  return v.body;
}
function setCached(req, payload) {
  const k = cacheKey(req);
  respCache.set(k, { ts: Date.now(), body: payload });
  if (respCache.size > 200) {
    const first = respCache.keys().next().value;
    if (first) respCache.delete(first);
  }
}

/* ------------------------ Endpoints ------------------------ */

// Readiness & auth probes
app.get("/api/ready", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: !!wrCache.rows.length,
    building,
    rows: wrCache.rows.length,
    fetchedAt: wrCache.ts || null,
  });
});

app.get("/api/debug-auth", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const token = await getLiveAccessToken();
    res.json({ ok: true, accessTokenPreview: token?.slice(0, 12) || null });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e) });
  }
});

// Admin: rotate refresh token live (no redeploy)
const ADMIN_SECRET = process.env.ADMIN_SECRET;
app.post("/api/admin/set-refresh", express.json(), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = req.headers["x-admin-secret"] || req.query.secret;
  if (!ADMIN_SECRET || auth !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  const { token } = req.body || {};
  const cleaned = cleanToken(String(token || ""));
  if (!cleaned) return res.status(400).json({ ok: false, error: "missing token" });

  try {
    fs.mkdirSync(path.dirname(REFRESH_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(REFRESH_TOKEN_FILE, cleaned, "utf8");
    runtimeRefreshToken = cleaned;
    cachedAccess = { token: null, expAt: 0 };
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Common middleware: ensure cache once; never block responses later
async function ensureCacheOnce(_req, res, next) {
  try {
    if (!wrCache.rows.length) {
      await buildAllWRs({ includeClub: includeClubByDefault() });
    }
    return next();
  } catch (e) {
    return res.status(503).json({ error: "AuthUnavailable", detail: String(e || "") });
  }
}

// Utility: time format
const detroitDate = (tsMs) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Detroit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(tsMs))
    .replaceAll("/", "-");

/* ---------------- WR endpoints ---------------- */

app.get("/api/wr-latest", ensureCacheOnce, async (req, res) => {
  const cached = getCached(req);
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=3, stale-while-revalidate=60");
    return res.json(cached);
  }

  try {
    debouncedUidRefresh();
    debouncedQuickRefresh();

    let out = wrCache.rows;
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
      const allow = new Set(type.split(",").map((s) => s.trim()).filter(Boolean));
      out = out.filter((r) => allow.has(r.sourceType));
    }

    out = out.filter((r) => isValidTimeMs(Number(r.timeMs)));

    const payload = {
      rows: out.slice(0, limit),
      total: out.length,
      fetchedAt: wrCache.ts,
      generatedAt: new Date(wrCache.ts).toISOString(),
      date: detroitDate(wrCache.ts),
    };
    setCached(req, payload);
    res.setHeader("Cache-Control", "public, max-age=3, stale-while-revalidate=60");
    res.json(payload);
  } catch (err) {
    console.error("wr-latest:", err);
    res.status(500).json({
      error: "Failed to load latest world records",
      detail: err?.message || String(err),
    });
  }
});

app.get("/api/wr-players", ensureCacheOnce, async (req, res) => {
  const cached = getCached(req);
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=3, stale-while-revalidate=60");
    return res.json(cached);
  }

  try {
    debouncedUidRefresh();
    debouncedQuickRefresh();

    const safeRows = (wrCache.rows || []).filter((r) => isValidTimeMs(Number(r.timeMs)));

    const tally = new Map();
    for (const r of safeRows) {
      if (!r.accountId) continue;
      const rec = tally.get(r.accountId) || {
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
          p.displayName?.toLowerCase().includes(q) || p.accountId?.toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => b.wrCount - a.wrCount || b.latestTs - a.latestTs);
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));

    const payload = { players: list.slice(0, limit), total: list.length, fetchedAt: wrCache.ts };
    setCached(req, payload);
    res.setHeader("Cache-Control", "public, max-age=3, stale-while-revalidate=60");
    res.json(payload);
  } catch (err) {
    console.error("wr-players:", err);
    res.status(500).json({ error: "Failed to load WR players", detail: err?.message || String(err) });
  }
});

app.get("/api/top-weekly", ensureCacheOnce, async (req, res) => {
  const cached = getCached(req);
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=60");
    return res.json(cached);
  }

  try {
    debouncedUidRefresh();
    debouncedQuickRefresh();

    const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 3));
    const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 3600;

    const safeRows = (wrCache.rows || []).filter((r) => isValidTimeMs(Number(r.timeMs)));

    const tally = new Map();
    for (const r of safeRows) {
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

    const payload = { rangeDays: days, top, generatedAt: Date.now() };
    setCached(req, payload);
    res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=60");
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ---------------- Debug & control ---------------- */

app.get("/api/debug-names", async (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=120");
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
  res.setHeader("Cache-Control", "public, max-age=10");
  try {
    if (!wrCache.rows.length) await buildAllWRs({ includeClub: includeClubByDefault() });
    const rows = wrCache.rows || [];
    const counts = { official: 0, totd: 0, club: 0 };
    for (const r of rows) counts[r.sourceType] = (counts[r.sourceType] || 0) + 1;
    res.json({
      cacheTime: wrCache.ts,
      rows: rows.length,
      counts,
      nameCacheSize: nameCache.size,
      resolvedNamesCount: Array.from(nameCache.values()).filter((v) => v && typeof v === "string" && v !== "").length,
      allMapsTracked: metaCache.allMapUids.length,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/rebuild-now", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const includeClubParam = (req.query.includeClub ?? "").toString().toLowerCase();
    const includeClub =
      includeClubParam === "true"
        ? true
        : includeClubParam === "false"
        ? false
        : includeClubByDefault();

    const result = await rebuildNow({ includeClub });
    respCache.clear();
    res.json({ ok: true, fetchedAt: wrCache.ts, ...result });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/* ========================= WEEKLY SHORTS (AUTO / LIVE) =========================
   Endpoints:
     GET /api/weekly-shorts/weeks
     GET /api/weekly-shorts/week/:week
     GET /api/weekly-shorts/aggregate
     GET /api/weekly-shorts/changelog
=============================================================================== */

const WS_CACHE_TTL_SECONDS = Number(process.env.WS_CACHE_TTL_SECONDS || 600);
const WS_CACHE_TTL_MS = WS_CACHE_TTL_SECONDS * 1000;

const WS_CLUB_ID = String(process.env.WS_CLUB_ID || "").trim();
const WS_CAMPAIGN_ID = String(process.env.WS_CAMPAIGN_ID || "").trim();

const WS_START_ISO = String(process.env.WS_START_ISO || "2025-01-01T00:00:00Z").trim();
const WS_MAPS_PER_WEEK = Number(process.env.WS_MAPS_PER_WEEK || 5);

const WS_CHANGELOG_PATH = process.env.WS_CHANGELOG_PATH || "/tmp/ws_changelog.json";

// in-memory cache
let ws = {
  ts: 0,
  weeksIndex: null, // { generatedAt, weeks:[{week,mapUids[],endedAt,weekStart}] }
  weekCache: new Map(), // weekNum -> weekJson
  aggregate: null, // { generatedAt, players:[...] }
  changelog: { items: [] }, // { items:[...] }
  snapshot: new Map(), // weekNum -> { byMapUid: Map(mapUid -> {player,timeMs}) }
};

// load changelog from disk once (best-effort)
(function loadWsChangelog() {
  try {
    if (fs.existsSync(WS_CHANGELOG_PATH)) {
      const j = JSON.parse(fs.readFileSync(WS_CHANGELOG_PATH, "utf8"));
      if (j && Array.isArray(j.items)) ws.changelog = { items: j.items };
    }
  } catch {}
})();

function saveWsChangelog() {
  try {
    fs.mkdirSync(path.dirname(WS_CHANGELOG_PATH), { recursive: true });
    fs.writeFileSync(WS_CHANGELOG_PATH, JSON.stringify(ws.changelog), "utf8");
  } catch {}
}

function wsExpired() {
  return !ws.ts || Date.now() - ws.ts > WS_CACHE_TTL_MS;
}

function parseStartMs() {
  const ms = Date.parse(WS_START_ISO);
  if (!Number.isFinite(ms)) throw new Error(`Invalid WS_START_ISO: ${WS_START_ISO}`);
  return ms;
}

async function fetchWeeklyShortsPlaylistMapUids(access) {
  if (!WS_CLUB_ID || !WS_CAMPAIGN_ID) {
    throw new Error("Weekly Shorts missing WS_CLUB_ID / WS_CAMPAIGN_ID env vars");
  }
  const url = `${LIVE_BASE}/api/token/club/${encodeURIComponent(WS_CLUB_ID)}/campaign/${encodeURIComponent(
    WS_CAMPAIGN_ID
  )}`;
  const j = await jget(url, access);
  const playlist = j?.campaign?.playlist || j?.playlist || [];
  return playlist.map((p) => p?.mapUid).filter(Boolean);
}

function buildWsWeeksFromPlaylist(mapUids) {
  const startMs = parseStartMs();
  if (!Number.isFinite(WS_MAPS_PER_WEEK) || WS_MAPS_PER_WEEK <= 0) {
    throw new Error(`Invalid WS_MAPS_PER_WEEK: ${WS_MAPS_PER_WEEK}`);
  }

  const weeks = [];
  const now = Date.now();

  // each week spans 7 days from startMs
  for (let w = 0; ; w++) {
    const weekStart = startMs + w * 7 * 24 * 3600 * 1000;
    const weekEndExclusive = startMs + (w + 1) * 7 * 24 * 3600 * 1000;

    const idx0 = w * WS_MAPS_PER_WEEK;
    const chunk = mapUids.slice(idx0, idx0 + WS_MAPS_PER_WEEK);

    // stop when we're far into the future and no maps exist there
    if (!chunk.length && weekStart > now + 21 * 24 * 3600 * 1000) break;

    weeks.push({
      week: w + 1,
      weekStart: new Date(weekStart).toISOString(),
      endedAt: new Date(weekEndExclusive - 1).toISOString(),
      mapUids: chunk, // usually 5
    });
  }

  return weeks;
}

async function fetchWsTop10(access, mapUid) {
  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}` +
    `/top?onlyWorld=true&length=10&offset=0`;

  const j = await jget(url, access);
  const rows = j?.tops?.[0]?.top;
  const topArr = Array.isArray(rows) ? rows : [];

  const parsed = topArr
    .map((x, idx) => {
      const rank = Number(x.position ?? (idx + 1));
      const accountId = x.accountId;
      const timeMs = Number(x.score);
      if (!accountId || !isValidTimeMs(timeMs)) return null;
      return { rank, accountId, timeMs };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);

  await resolveDisplayNames(access, parsed.map((r) => r.accountId));

  return parsed.map((r) => ({
    rank: r.rank,
    player: nameCache.get(r.accountId) || r.accountId,
    timeMs: r.timeMs,
    isWr: r.rank === 1,
    isWinner: r.rank === 1,
  }));
}

function buildWsAggregate(allWeekJson) {
  // Aggregate across ALL maps in ALL weeks
  const by = new Map();

  for (const w of allWeekJson) {
    const weekNum = Number(w.week);
    const maps = Array.isArray(w.maps) ? w.maps : [];

    for (const m of maps) {
      const mapUid = m.mapUid;
      const entries = Array.isArray(m.entries) ? m.entries : [];
      for (const e of entries) {
        const player = e.player;
        if (!player) continue;

        const rec =
          by.get(player) || {
            player,
            wins: 0,
            wrs: 0,
            top5: 0,
            weeksWon: [],
            wrWeeks: [],
            top5Weeks: [],
          };

        if (e.rank === 1) {
          rec.wins += 1;
          rec.wrs += 1;
          rec.weeksWon.push(weekNum);
          rec.wrWeeks.push({ week: weekNum, mapUid, timeMs: e.timeMs });
        }
        if (e.rank <= 5) {
          rec.top5 += 1;
          rec.top5Weeks.push({ week: weekNum, mapUid, rank: e.rank, timeMs: e.timeMs });
        }

        by.set(player, rec);
      }
    }
  }

  const players = Array.from(by.values()).map((p) => ({
    ...p,
    weeksWon: Array.from(new Set(p.weeksWon)).sort((a, b) => a - b),
  }));

  players.sort(
    (a, b) =>
      b.wins - a.wins ||
      b.wrs - a.wrs ||
      b.top5 - a.top5 ||
      a.player.localeCompare(b.player)
  );

  return { generatedAt: new Date().toISOString(), players };
}

function updateWsChangelogIfEndedWeek(weekJson) {
  const weekNum = Number(weekJson?.week);
  const endedAt = weekJson?.endedAt;
  if (!weekNum || !endedAt) return;

  const endedMs = Date.parse(endedAt);
  if (!Number.isFinite(endedMs)) return;
  if (Date.now() < endedMs) return; // not ended yet

  // snapshot per map
  const snap = ws.snapshot.get(weekNum) || { byMapUid: new Map() };

  for (const m of weekJson.maps || []) {
    const mapUid = m.mapUid;
    const winner = (m.entries || []).find((e) => e.rank === 1);
    if (!mapUid || !winner) continue;

    const prev = snap.byMapUid.get(mapUid);
    if (!prev) {
      snap.byMapUid.set(mapUid, { player: winner.player, timeMs: winner.timeMs });
      continue;
    }

    // WR improved after end (on this map)
    if (Number(winner.timeMs) < Number(prev.timeMs)) {
      ws.changelog.items.push({
        at: new Date().toISOString(),
        type: "WR_IMPROVED_AFTER_WEEK",
        week: weekNum,
        mapUid,
        playerNew: winner.player,
        timeNewMs: winner.timeMs,
        playerPrev: prev.player,
        timePrevMs: prev.timeMs,
      });

      snap.byMapUid.set(mapUid, { player: winner.player, timeMs: winner.timeMs });
    }
  }

  ws.snapshot.set(weekNum, snap);

  if (ws.changelog.items.length) {
    ws.changelog.items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    saveWsChangelog();
  }
}

async function rebuildWsCacheIfNeeded() {
  if (!wsExpired() && ws.weeksIndex) return;

  const access = await getLiveAccessToken();
  const playlistMapUids = await fetchWeeklyShortsPlaylistMapUids(access);
  const weeks = buildWsWeeksFromPlaylist(playlistMapUids);

  const allWeekJson = [];
  const newWeekCache = new Map();

  for (const w of weeks) {
    const maps = [];
    for (const mapUid of w.mapUids || []) {
      const entries = await fetchWsTop10(access, mapUid);
      maps.push({
        mapUid,
        mapName: null,
        entries,
      });
      await new Promise((r) => setTimeout(r, 70));
    }

    const weekJson = {
      week: w.week,
      weekStart: w.weekStart,
      endedAt: w.endedAt,
      mapUids: w.mapUids || [],
      maps,
      // compatibility: expose the first map in old shape so the current UI doesn't crash
      mapUid: (w.mapUids || [])[0] || null,
      mapName: `Week ${w.week}`,
      entries: (maps[0]?.entries || []),
    };

    updateWsChangelogIfEndedWeek(weekJson);

    allWeekJson.push(weekJson);
    newWeekCache.set(String(w.week), weekJson);
  }

  ws.weeksIndex = {
    generatedAt: new Date().toISOString(),
    clubId: WS_CLUB_ID,
    campaignId: WS_CAMPAIGN_ID,
    mapsPerWeek: WS_MAPS_PER_WEEK,
    startIso: WS_START_ISO,
    weeks: weeks.map((x) => ({
      week: x.week,
      weekStart: x.weekStart,
      endedAt: x.endedAt,
      mapUids: x.mapUids || [],
      // compatibility fields
      mapUid: (x.mapUids || [])[0] || null,
      mapName: `Week ${x.week}`,
    })),
  };

  ws.weekCache = newWeekCache;
  ws.aggregate = buildWsAggregate(allWeekJson);
  ws.ts = Date.now();
}

// WS endpoints
app.get("/api/weekly-shorts/weeks", async (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=120");
  const cached = getCached(req);
  if (cached) return res.json(cached);

  try {
    await rebuildWsCacheIfNeeded();
    const payload = ws.weeksIndex || { generatedAt: new Date().toISOString(), weeks: [] };
    setCached(req, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "Failed to load weeks", detail: e?.message || String(e) });
  }
});

app.get("/api/weekly-shorts/week/:week", async (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=120");
  const cached = getCached(req);
  if (cached) return res.json(cached);

  try {
    await rebuildWsCacheIfNeeded();
    const weekNum = String(req.params.week || "").trim();
    const w = ws.weekCache.get(weekNum);
    if (!w) return res.status(404).json({ error: "Week not found" });

    setCached(req, w);
    res.json(w);
  } catch (e) {
    res.status(500).json({ error: "Failed to load week", detail: e?.message || String(e) });
  }
});

app.get("/api/weekly-shorts/aggregate", async (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=120");
  const cached = getCached(req);
  if (cached) return res.json(cached);

  try {
    await rebuildWsCacheIfNeeded();
    const payload = ws.aggregate || { generatedAt: new Date().toISOString(), players: [] };
    setCached(req, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "Failed to load aggregate", detail: e?.message || String(e) });
  }
});

app.get("/api/weekly-shorts/changelog", async (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=120");
  const cached = getCached(req);
  if (cached) return res.json(cached);

  try {
    const payload = ws.changelog || { items: [] };
    setCached(req, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "Failed to load changelog", detail: e?.message || String(e) });
  }
});

/* ------------------------- Start --------------------------- */
process.on("unhandledRejection", (err) => console.error("UNHANDLED_REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT_EXCEPTION:", err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on port ${PORT}`));
