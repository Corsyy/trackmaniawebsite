import express from "express";
import fetch from "node-fetch";
import fs from "fs";

/**
 * ENV:
 *   REFRESH_TOKEN = <NadeoLiveServices refresh token>
 *   CLIENT_ID     = <api.trackmania.com client_id>
 *   CLIENT_SECRET = <api.trackmania.com client_secret>
 * Optional:
 *   CORS_ORIGINS            = comma-separated list of extra allowed origins
 *   INCLUDE_CLUB_BY_DEFAULT = true|false   (default true)
 *   AUTO_UID_REFRESH        = true|false   (default true; discover NEW maps on requests)
 *   WR_CONCURRENCY          = 8
 *   QUICK_REFRESH_COUNT     = 100          (# recent maps to re-check on requests)
 *   CLUB_MAX_CAMPAIGNS      = 200
 *   CLUB_DETAIL_CONC        = 4
 *   CLUB_UID_TTL_HOURS      = 24
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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
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
  const start = new Date(Date.UTC(2020, 6, 1));
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
/** Prefer playlist from list; fall back to campaign-details if missing. */
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
      const updatedAt =
        new Date(it?.updated || it?.updatedAt || 0).getTime() || 0;
      const playlist = (it?.campaign?.playlist || it?.playlist || [])
        .map((p) => p?.mapUid)
        .filter(Boolean);
      if (clubId && campaignId)
        out.push({ clubId, campaignId, updatedAt, playlist });
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
      batch.map((r) =>
        fetchClubCampaignPlaylist(accessToken, r.clubId, r.campaignId)
      )
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
  if (Number.isFinite(parsed))
    return parsed > 1e12 ? Math.round(parsed / 1000) : Math.round(parsed);
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
      const j = await r.json(); // { "<accountId>": "DisplayName" }
      for (const id of batch) {
        const dn = j?.[id];
        nameCache.set(id, (typeof dn === "string" && dn) || id);
      }
    } catch {
      for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
    }
    await new Promise((r) => setTimeout(r, 40)); // gentle
  }
  return nameCache;
}

/* ------------------------- Cache & disk -------------------- */
let wrCache = { ts: 0, rows: [] }; // rows: [{ mapUid, accountId, displayName, timeMs, timestamp, sourceType }]
let metaCache = { officialSet: new Set(), clubSet: new Set(), allMapUids: [] };

const WR_CONCURRENCY = Number(process.env.WR_CONCURRENCY || 8);
const CLUB_UID_TTL = Number(process.env.CLUB_UID_TTL_HOURS || 24) * 3600 * 1000;
const QUICK_REFRESH_COUNT = Number(process.env.QUICK_REFRESH_COUNT || 100);
const AUTO_UID_REFRESH =
  (process.env.AUTO_UID_REFRESH ?? "true").toLowerCase() === "true";

const DISK_WR = "/tmp/wr_cache.json";
const DISK_CLUB = "/tmp/club_uids.json";

function loadJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
function saveJson(path, obj) {
  try {
    fs.writeFileSync(path, JSON.stringify(obj));
  } catch {}
}

/* --------------------- Build utilities --------------------- */
function includeClubByDefault() {
  return (process.env.INCLUDE_CLUB_BY_DEFAULT ?? "true").toLowerCase() === "true";
}

async function computeAllMapUids(access, { includeClub }) {
  const [official, totdUids] = await Promise.all([
    getAllOfficialCampaigns(access),
    getAllTotdMapUidsViaLive(access),
  ]);
  const officialSet = new Set(
    official.flatMap((c) => (c.playlist || []).map((p) => p.mapUid))
  );

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

  const allMapUids = Array.from(
    new Set([...officialSet, ...totdUids, ...clubSet])
  );
  return { officialSet, clubSet, allMapUids };
}

async function fetchAllWRs(access, allMapUids, officialSet, clubSet) {
  const wrs = [];
  for (let i = 0; i < allMapUids.length; i += WR_CONCURRENCY) {
    const part = await Promise.all(
      allMapUids.slice(i, i + WR_CONCURRENCY).map(async (uid) => {
        // retry once for flakiness
        let row = await getMapWR(access, uid);
        if (!row || row.empty || row.error) {
          await new Promise((r) => setTimeout(r, 60));
          row = await getMapWR(access, uid);
        }
        if (!row || row.empty || row.error) return null;
        row.sourceType = officialSet.has(uid)
          ? "official"
          : clubSet.has(uid)
          ? "club"
          : "totd";
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

/* ---------------------- Full build (one-shot) -------------- */
async function buildAllWRs({ includeClub = true } = {}) {
  const access = await getLiveAccessToken();
  const { officialSet, clubSet, allMapUids } = await computeAllMapUids(access, {
    includeClub,
  });

  const wrs = await fetchAllWRs(access, allMapUids, officialSet, clubSet);

  const ids = wrs.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(access, ids);
  for (const r of wrs)
    if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;

  swapCache(wrs);
  metaCache = { officialSet, clubSet, allMapUids };
  return wrCache.rows;
}

/* ------------- Rebuild but only apply actual changes ------- */
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
  for (const r of newRows)
    if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;

  const { merged, updatedCount } = diffAndMergeByMap(
    wrCache.rows || [],
    newRows
  );
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

/* ----------- Quick refresh (only when requested) ----------- */
// Re-check the most recent N maps to catch new WRs cheaply.
async function quickRefreshRecent({ count = QUICK_REFRESH_COUNT } = {}) {
  if (!wrCache.rows.length) return;
  const access = await getLiveAccessToken();

  const recent = wrCache.rows.slice(0, Math.min(count, wrCache.rows.length));
  const part = await Promise.all(
    recent.map(async (prev) => {
      const row = await getMapWR(access, prev.mapUid);
      if (!row || row.empty || row.error) return null;
      row.sourceType = prev.sourceType; // keep tag
      return row;
    })
  );
  const fresh = part.filter(Boolean);

  // merge only if changed
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

  // resolve new names if any
  const ids = fresh.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(null, ids);
  for (const r of byMap.values())
    if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;

  const merged = Array.from(byMap.values()).sort(
    (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
  );
  wrCache = { ts: Date.now(), rows: merged };
}

/* --- Auto-discover NEW map UIDs on requests (cheap) -------- */
async function maybeRefreshUidUniverse() {
  if (!AUTO_UID_REFRESH) return;
  if (!metaCache.allMapUids.length) return;

  const access = await getLiveAccessToken();

  // 1) OFFICIAL — current playlist set
  const official = await getAllOfficialCampaigns(access);
  const latestOfficialSet = new Set(
    official.flatMap((c) => (c.playlist || []).map((p) => p.mapUid))
  );

  // 2) TOTD — last 2 months only
  const months = await getTotdMonthsFromLive(access);
  const last2 = months.slice(-2);
  const latestTotdSet = new Set();
  for (const m of last2) {
    const days = Array.isArray(m?.days) ? m.days : [];
    for (const d of days) if (d?.mapUid) latestTotdSet.add(d.mapUid);
  }

  // 3) CLUB — sample the newest ~100 campaigns
  const recentClubRefs = await listAllClubCampaignRefsWithPlaylists(access);
  const latestClubSet = new Set();
  for (const r of recentClubRefs.slice(0, 100)) {
    const list = r.playlist?.length
      ? r.playlist
      : await fetchClubCampaignPlaylist(access, r.clubId, r.campaignId);
    for (const uid of list || []) latestClubSet.add(uid);
  }

  // Diff vs known universe
  const oldSet = new Set(metaCache.allMapUids);
  const candidates = new Set([
    ...latestOfficialSet,
    ...latestTotdSet,
    ...latestClubSet,
  ]);
  const newUids = Array.from(candidates).filter((u) => !oldSet.has(u));
  if (!newUids.length) return;

  // Expand tagging sets
  const officialSet = new Set([...metaCache.officialSet, ...latestOfficialSet]);
  const clubSet = new Set([...metaCache.clubSet, ...latestClubSet]);

  // Fetch WRs only for the new UIDs
  const freshRows = [];
  for (let i = 0; i < newUids.length; i += WR_CONCURRENCY) {
    const part = await Promise.all(
      newUids.slice(i, i + WR_CONCURRENCY).map(async (uid) => {
        let row = await getMapWR(access, uid);
        if (!row || row.empty || row.error) {
          await new Promise((r) => setTimeout(r, 60));
          row = await getMapWR(access, uid);
        }
        if (!row || row.empty || row.error) return null;
        row.sourceType = officialSet.has(uid)
          ? "official"
          : clubSet.has(uid)
          ? "club"
          : "totd";
        return row;
      })
    );
    freshRows.push(...part.filter(Boolean));
  }
  if (!freshRows.length) return;

  // Resolve names for just new rows
  const ids = freshRows.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(null, ids);
  for (const r of freshRows)
    if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;

  // Merge rows + update meta
  const byMap = new Map(wrCache.rows.map((r) => [r.mapUid, r]));
  for (const r of freshRows) byMap.set(r.mapUid, r);
  const merged = Array.from(byMap.values()).sort(
    (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
  );
  wrCache = { ts: Date.now(), rows: merged };

  const combined = new Set([...metaCache.allMapUids, ...newUids]);
  metaCache = {
    officialSet,
    clubSet,
    allMapUids: Array.from(combined),
  };
}

/* -------------------- Warm start from disk ----------------- */
(function warmStart() {
  const disk = loadJson(DISK_WR);
  if (disk && Array.isArray(disk.rows) && disk.rows.length) {
    wrCache = { ts: disk.ts || Date.now(), rows: disk.rows };
    console.log(`♻️  Warm-started cache from disk: ${wrCache.rows.length} rows`);
  } else {
    console.log("⚠️  No disk cache found; first request will trigger full build.");
  }
})();

/* ------------------------ Endpoints ------------------------ */

// Latest WRs (read from cache). Auto-discover new UIDs + quick refresh on request.
// Optional: ?limit=300  ?search=foo  ?type=official,totd,club
app.get("/api/wr-latest", async (req, res) => {
  try {
    if (!wrCache.rows.length) {
      await buildAllWRs({ includeClub: includeClubByDefault() });
    }

    await maybeRefreshUidUniverse();
    await quickRefreshRecent({ count: QUICK_REFRESH_COUNT });

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
    res.status(500).json({
      error: "Failed to load latest world records",
      detail: err?.message || String(err),
    });
  }
});

// Players leaderboard (read from cache). Auto-discover new UIDs + quick refresh.
app.get("/api/wr-players", async (req, res) => {
  try {
    if (!wrCache.rows.length) {
      await buildAllWRs({ includeClub: includeClubByDefault() });
    }

    await maybeRefreshUidUniverse();
    await quickRefreshRecent({ count: QUICK_REFRESH_COUNT });

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
    res.status(500).json({
      error: "Failed to load WR players",
      detail: err?.message || String(err),
    });
  }
});

// Top players in last N days (read from cache). Auto-discover + quick refresh.
// Optional: ?days=7  ?limit=3
app.get("/api/top-weekly", async (req, res) => {
  try {
    if (!wrCache.rows.length) {
      await buildAllWRs({ includeClub: includeClubByDefault() });
    }

    await maybeRefreshUidUniverse();
    await quickRefreshRecent({ count: QUICK_REFRESH_COUNT });

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

/* ---------------- Debug & control ---------------- */
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
    if (!wrCache.rows.length)
      await buildAllWRs({ includeClub: includeClubByDefault() });
    const rows = wrCache.rows || [];
    const counts = { official: 0, totd: 0, club: 0 };
    for (const r of rows) counts[r.sourceType] = (counts[r.sourceType] || 0) + 1;
    res.json({
      cacheTime: wrCache.ts,
      rows: rows.length,
      counts,
      nameCacheSize: nameCache.size,
      resolvedNamesCount: Array.from(nameCache.values()).filter(
        (v) => v && typeof v === "string" && v !== ""
      ).length,
      allMapsTracked: metaCache.allMapUids.length,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Force a full diff-based rebuild (use for manual/cron refresh)
// Optional: ?includeClub=true|false
app.post("/api/rebuild-now", async (req, res) => {
  try {
    const includeClubParam = (req.query.includeClub ?? "")
      .toString()
      .toLowerCase();
    const includeClub =
      includeClubParam === "true"
        ? true
        : includeClubParam === "false"
        ? false
        : includeClubByDefault();

    const result = await rebuildNow({ includeClub });
    res.json({ ok: true, fetchedAt: wrCache.ts, ...result });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Quick club check
app.get("/api/debug-clubs", async (_req, res) => {
  try {
    const access = await getLiveAccessToken();
    const refs = await listAllClubCampaignRefsWithPlaylists(access);
    const uids = await getAllClubMapUids(access);
    const disk = loadJson(DISK_CLUB);
    res.json({
      campaignsListed: refs.length,
      mapUidsFound: uids.length,
      cachedClubUids: {
        count: disk?.uids?.length || 0,
        ageMs: disk?.ts ? Date.now() - disk.ts : null,
      },
      sampleUid: uids[0] || null,
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
