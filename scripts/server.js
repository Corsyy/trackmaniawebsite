import express from "express";
import fetch from "node-fetch";

/**
 * ENV:
 *   REFRESH_TOKEN = <NadeoLiveServices refresh token>
 *   CLIENT_ID     = <api.trackmania.com client_id>
 *   CLIENT_SECRET = <api.trackmania.com client_secret>
 * Optional:
 *   CORS_ORIGINS          = comma-separated list of extra allowed origins
 *   INCLUDE_CLUB_BY_DEFAULT=false|true
 *   CLUB_MAX_CAMPAIGNS=150
 *   CLUB_DETAIL_CONC=4
 *   WR_CONCURRENCY=8
 *   WR_REFRESH_BATCH=80
 *   WR_REFRESH_EVERY_MS=60000
 *   CLUB_UID_TTL_HOURS=24
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
    const list = j?.monthList || [];
    months.push(...list);
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
/** We must fetch details to get playlist.mapUid (the list endpoint lacks it). */
const CLUB_LIST_BATCH = 100;
const CLUB_DETAIL_CONC =
  Number(process.env.CLUB_DETAIL_CONC || 4);
const CLUB_MAX_CAMPAIGNS =
  Number(process.env.CLUB_MAX_CAMPAIGNS || 150);

// Return minimal refs: [{ clubId, campaignId, updatedAt }]
async function listAllClubCampaignRefs(accessToken) {
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
      if (clubId && campaignId) out.push({ clubId, campaignId, updatedAt });
    }
    if (list.length < CLUB_LIST_BATCH) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  // newest first, cap
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, CLUB_MAX_CAMPAIGNS);
}

async function getClubCampaignMapUids(accessToken, clubId, campaignId) {
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
  const refs = await listAllClubCampaignRefs(accessToken);
  const uids = new Set();
  for (let i = 0; i < refs.length; i += CLUB_DETAIL_CONC) {
    const batch = refs.slice(i, i + CLUB_DETAIL_CONC);
    const results = await Promise.all(
      batch.map((r) =>
        getClubCampaignMapUids(accessToken, r.clubId, r.campaignId)
      )
    );
    for (const arr of results) for (const uid of arr) uids.add(uid);
    await new Promise((r) => setTimeout(r, 80));
  }
  return Array.from(uids);
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
    await new Promise((r) => setTimeout(r, 40)); // gentle
  }
  return nameCache;
}

/* ------------------------- Cache & refresher --------------- */
let wrCache = { ts: 0, rows: [] };

const WR_CONCURRENCY = Number(process.env.WR_CONCURRENCY || 8);
const WR_REFRESH_BATCH = Number(process.env.WR_REFRESH_BATCH || 80);
const WR_REFRESH_EVERY_MS = Number(process.env.WR_REFRESH_EVERY_MS || 60_000);

let clubUidCache = { ts: 0, uids: [] };
const CLUB_UID_TTL =
  Number(process.env.CLUB_UID_TTL_HOURS || 24) * 3600 * 1000;

let lastAllMapUids = [];
let refreshIndex = 0;
let refresherTimer = null;

function includeClubByDefault() {
  return (process.env.INCLUDE_CLUB_BY_DEFAULT || "false").toLowerCase() === "true";
}
function wantClubs(req) {
  const q = (req?.query?.includeClub || req?.query?.type || "")
    .toString()
    .toLowerCase();
  if (q.includes("club") || q === "club") return true;
  return includeClubByDefault();
}

async function getCachedClubUids(access) {
  const fresh =
    Date.now() - clubUidCache.ts < CLUB_UID_TTL && clubUidCache.uids.length;
  if (fresh) return clubUidCache.uids;
  const uids = await getAllClubMapUids(access);
  clubUidCache = { ts: Date.now(), uids };
  return uids;
}

// Refresh a slice of maps and merge into cache
async function refreshSlice(access, mapUids, officialSet, clubSet) {
  if (!mapUids.length) return;
  const start = refreshIndex;
  const end = Math.min(mapUids.length, start + WR_REFRESH_BATCH);
  const slice = mapUids.slice(start, end);

  const part = await Promise.all(
    slice.map(async (uid) => {
      const row = await getMapWR(access, uid);
      if (!row || row.empty || row.error) return null;
      row.sourceType = officialSet.has(uid)
        ? "official"
        : clubSet.has(uid)
        ? "club"
        : "totd";
      return row;
    })
  );

  // merge by mapUid
  const byMap = new Map(wrCache.rows.map((r) => [r.mapUid, r]));
  for (const r of part.filter(Boolean)) byMap.set(r.mapUid, r);
  const merged = Array.from(byMap.values());

  // resolve names for any new ids
  const ids = merged.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(null, ids);
  for (const r of merged)
    if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;

  merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  wrCache = { ts: Date.now(), rows: merged };

  refreshIndex = end >= mapUids.length ? 0 : end;
}

function startRefresher(access, mapUids, officialSet, clubSet) {
  lastAllMapUids = mapUids;
  if (refresherTimer) clearInterval(refresherTimer);
  refresherTimer = setInterval(() => {
    refreshSlice(access, lastAllMapUids, officialSet, clubSet).catch(() => {});
  }, WR_REFRESH_EVERY_MS);
}

/* --------------- Build (two-phase + club UID cache) -------- */
async function buildAllWRs({ includeClub = false } = {}) {
  const access = await getLiveAccessToken();

  // Phase A (fast): official + TOTD
  const [official, totdUids] = await Promise.all([
    getAllOfficialCampaigns(access),
    getAllTotdMapUidsViaLive(access),
  ]);
  const officialSet = new Set(
    official.flatMap((c) => (c.playlist || []).map((p) => p.mapUid))
  );

  // optional clubs
  let clubUids = [];
  if (includeClub) {
    try {
      clubUids = await getCachedClubUids(access);
    } catch {}
  }

  const clubSet = new Set(clubUids);
  const allMapUids = Array.from(
    new Set([...officialSet, ...totdUids, ...clubSet])
  );

  // Seed cache quickly with first chunk so endpoints aren’t empty
  const seed = [];
  for (let i = 0; i < Math.min(allMapUids.length, 300); i += WR_CONCURRENCY) {
    const part = await Promise.all(
      allMapUids.slice(i, i + WR_CONCURRENCY).map(async (uid) => {
        const row = await getMapWR(access, uid);
        if (!row || row.empty || row.error) return null;
        row.sourceType = officialSet.has(uid)
          ? "official"
          : clubSet.has(uid)
          ? "club"
          : "totd";
        return row;
      })
    );
    seed.push(...part.filter(Boolean));
  }

  const ids = seed.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(access, ids);
  for (const r of seed)
    if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;

  seed.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  wrCache = { ts: Date.now(), rows: seed };

  // Start rolling refresher across ALL maps (smooth updates)
  startRefresher(access, allMapUids, officialSet, clubSet);

  // If clubs weren’t included, warm them in background then restart refresher with clubs included
  if (!includeClub) {
    setTimeout(async () => {
      try {
        const club = await getCachedClubUids(access);
        const clubSet2 = new Set(club);
        const all2 = Array.from(new Set([...officialSet, ...totdUids, ...clubSet2]));
        startRefresher(access, all2, officialSet, clubSet2);
      } catch {}
    }, 0);
  }

  return wrCache.rows;
}

/* ------------------------ Endpoints ------------------------ */

// Latest WRs (Campaign + TOTD + Club opt-in)
// Optional: ?limit=300  ?search=foo  ?type=official,totd,club  ?includeClub=true
app.get("/api/wr-latest", async (req, res) => {
  try {
    const includeClub = wantClubs(req);
    const rows = wrCache.rows.length
      ? wrCache.rows
      : await buildAllWRs({ includeClub });

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

// Players leaderboard across ALL sources (reads from rolling cache)
// Optional: ?limit=200  ?q=search
app.get("/api/wr-players", async (req, res) => {
  try {
    if (!wrCache.rows.length) {
      await buildAllWRs({ includeClub: includeClubByDefault() });
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
    if (!wrCache.rows.length) {
      await buildAllWRs({ includeClub: includeClubByDefault() });
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
    if (!wrCache.rows.length) {
      await buildAllWRs({ includeClub: includeClubByDefault() });
    }
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
      unresolvedSample: [],
      refresher: {
        WR_REFRESH_BATCH,
        WR_REFRESH_EVERY_MS,
        nextIndex: refreshIndex,
        allMapsTracked: lastAllMapUids.length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Optional: quick club debug
app.get("/api/debug-clubs", async (_req, res) => {
  try {
    const access = await getLiveAccessToken();
    const refs = await listAllClubCampaignRefs(access);
    const uids = await getAllClubMapUids(access);
    res.json({
      campaignsListed: refs.length,
      mapUidsFound: uids.length,
      sampleCampaign: refs[0] || null,
      sampleUid: uids[0] || null,
      cachedClubUids: { ageMs: Date.now() - clubUidCache.ts, count: clubUidCache.uids.length },
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
